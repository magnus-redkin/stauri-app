//! Shared send path through the status-go Router.
//!
//! ENS registration and token swaps use the same mechanism: build a route,
//! build transactions, sign, send. Only the route parameters differ
//! (`sendType`, tokens, amount), so both operations share this module instead
//! of keeping two copies of the signal handling.
//!
//! Unlike `transfer.rs`, which is three synchronous calls, two of the four steps
//! here are asynchronous: `buildTransactionsFromRoute` and
//! `sendRouterTransactionsWithSignatures` return nothing and deliver the result
//! as a status-go signal, so each of them is awaited on a signal subscription.
//!
//! Signing happens here rather than in the webview. The Router can return
//! several transactions (approve + swap, for instance), and `wallet_signMessage`
//! signs any 32 bytes without knowing what they are, so a foreign script holding
//! the hashes could ask for a signature on any of them. Hashes, password and
//! signature parsing never leave Rust.

use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::backend::Backend;
use crate::error::{AppError, AppResult};

/// `fees.GasFeeMode`: Low=0, Medium=1, High=2.
pub const GAS_FEE_MEDIUM: u64 = 1;

/// Signal carrying the hashes that need signing.
const SIGNAL_ROUTER_TXS: &str = "wallet.router.sign-transactions";

/// Signal reporting that the transactions were sent.
const SIGNAL_TXS_SENT: &str = "wallet.router.transactions-sent";

/// How long to wait for the backend.
///
/// Route building goes to the network for gas and the provider price before
/// waiting for signatures; on a slow network, or a swap through an aggregator,
/// that is not quick.
const SIGNAL_TIMEOUT: Duration = Duration::from_secs(120);

/// Checks for an EVM address: `0x` followed by exactly 40 hex digits.
pub fn is_address(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 42
        && bytes[0] == b'0'
        && (bytes[1] == b'x' || bytes[1] == b'X')
        && bytes[2..].iter().all(|b| b.is_ascii_hexdigit())
}

/// Removes the `0x` prefix, if present.
pub fn strip_hex_prefix(value: &str) -> &str {
    value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .unwrap_or(value)
}

/// Reads a hex number from a backend reply (`0x…` or bare hex).
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] when the value is not a valid hex number.
pub fn hex_u128(value: &str) -> AppResult<u128> {
    u128::from_str_radix(strip_hex_prefix(value), 16)
        .map_err(|e| AppError::backend(format!("invalid hex number from backend: {e}")))
}

/// Splits a 65-byte signature into the components status-go expects.
///
/// `SignatureDetails.Validate` requires exactly 64 hex characters in `r`, 64 in
/// `s` and 2 in `v`, and it reads `v` as "one only when the string is `01`", so
/// an Ethereum-style 27/28 would mean `0` there. The recovery id is normalised
/// to 0/1 here.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] when the signature is not 130 hex characters
/// after the prefix, or when `v` is outside 0/1 and 27/28.
pub fn split_signature(signature: &str) -> AppResult<(String, String, String)> {
    let raw = strip_hex_prefix(signature);
    if raw.len() != 130 {
        return Err(AppError::backend(format!(
            "unexpected signature length: {} hex chars, expected 130",
            raw.len()
        )));
    }

    let r = raw[0..64].to_string();
    let s = raw[64..128].to_string();

    let v_byte = u8::from_str_radix(&raw[128..130], 16)
        .map_err(|e| AppError::backend(format!("invalid signature v: {e}")))?;
    // 0/1 is the raw recovery id status-go signs with, 27/28 the Ethereum
    // variant; both are reduced to one form.
    let v = match v_byte {
        0 | 1 => v_byte,
        27 | 28 => v_byte - 27,
        other => {
            return Err(AppError::backend(format!(
                "unexpected signature v: {other}"
            )));
        }
    };

    Ok((r, s, format!("{v:02x}")))
}

/// Builds a request identifier for the Router.
///
/// The backend keeps only the most recent route, so uniqueness within the
/// process is enough. Random bytes are safer than a counter: a counter would
/// restart at zero after a restart and could collide between two concurrent
/// requests.
pub fn unique_uuid() -> String {
    let mut buf = [0u8; 8];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom")
        && std::io::Read::read_exact(&mut f, &mut buf).is_ok()
    {
        let hex: String = buf.iter().map(|b| format!("{b:02x}")).collect();
        return format!("stauri-{hex}");
    }

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("stauri-{nanos:x}")
}

/// Waits for a signal of the given type that belongs to `uuid`.
///
/// Signals of other requests (another uuid) are skipped: the subscription carries
/// every signal status-go emits, and the first message to arrive may not be ours.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] on timeout, when the signal channel
/// closes, and when the backend reports an error in `sendDetails.errorResponse`.
async fn wait_for_signal(
    rx: &mut broadcast::Receiver<String>,
    signal_type: &str,
    uuid: &str,
) -> AppResult<Value> {
    let deadline = tokio::time::Instant::now() + SIGNAL_TIMEOUT;

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(AppError::backend(
                "the backend did not respond in time; the transaction may still be pending",
            ));
        }

        let raw = match tokio::time::timeout(remaining, rx.recv()).await {
            Err(_) => {
                return Err(AppError::backend(
                    "the backend did not respond in time; the transaction may still be pending",
                ));
            }
            Ok(Err(broadcast::error::RecvError::Lagged(skipped))) => {
                // The subscription fell behind; a later signal may still match.
                tracing::warn!(skipped, "signal subscription lagged");
                continue;
            }
            Ok(Err(broadcast::error::RecvError::Closed)) => {
                return Err(AppError::backend("signal channel closed unexpectedly"));
            }
            Ok(Ok(raw)) => raw,
        };

        let parsed: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if parsed.get("type").and_then(|t| t.as_str()) != Some(signal_type) {
            continue;
        }

        let event = parsed.get("event").cloned().unwrap_or(Value::Null);
        // The uuid sits in sendDetails; a signal for another request is not ours.
        let matches_uuid = event
            .get("sendDetails")
            .and_then(|d| d.get("uuid"))
            .and_then(|u| u.as_str())
            .map(|u| u == uuid)
            .unwrap_or(false);
        if !matches_uuid {
            continue;
        }

        // The backend puts the error in sendDetails.errorResponse.
        if let Some(err) = event
            .get("sendDetails")
            .and_then(|d| d.get("errorResponse"))
            .filter(|e| !e.is_null())
        {
            let details = err
                .get("details")
                .and_then(|d| d.as_str())
                .or_else(|| err.get("message").and_then(|m| m.as_str()))
                .unwrap_or("the backend rejected the route");
            return Err(AppError::backend(details.to_string()));
        }

        return Ok(event);
    }
}

/// Runs a route end to end and returns the hashes of the sent transactions.
///
/// The subscription is opened before the first request: building a route can
/// answer faster than a later subscription could be set up, and the signal would
/// then be delivered to nobody.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Internal`] when `params` carries no uuid, and
/// [`crate::error::ErrorKind::Backend`] when signals are unavailable for the backend or any
/// round step fails.
pub async fn execute_route(
    backend: Backend,
    params: Value,
    from: &str,
    password: &str,
) -> AppResult<Vec<String>> {
    let uuid = params
        .get("uuid")
        .and_then(|u| u.as_str())
        .ok_or_else(|| AppError::internal("route params have no uuid"))?
        .to_string();

    // Subscribe before the first call: the channel does not replay, and route
    // building can answer faster than a later subscription could be set up.
    let mut rx = backend.subscribe();
    let sent = execute_round(&mut rx, backend, Some(params), &uuid, from, password).await?;

    Ok(sent.into_iter().map(|tx| tx.hash).collect())
}

/// A sent transaction from the `wallet.router.transactions-sent` signal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentTx {
    pub hash: String,
    /// This is an `approve`, not the main operation.
    pub is_approval: bool,
}

/// One round of build → sign → send.
///
/// Params are optional because `wallet_getSuggestedRoutes` stores the route in
/// the backend under `uuid`. A second round (a swap after the `approve` is
/// mined) reuses the **same** route and the same `uuid`, so it needs no
/// parameters: requesting the route again would recompute it and replace the
/// price the user agreed to.
///
/// A round can return only the `approve`. LiFi builds the main swap transaction
/// only once the approval is in a block
/// (`transaction_manager_route.go`: "we cannot build the swap tx before the
/// approval tx is mined"), so the first round of a swap with an ERC-20 input
/// returns a single transaction and the caller must wait for it to be mined and
/// run the round again.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] when a route step fails, when no transactions
/// come back to sign, when no signature or hash is returned, or when the
/// signals connection fails.
pub async fn execute_round(
    rx: &mut broadcast::Receiver<String>,
    backend: Backend,
    params: Option<Value>,
    uuid: &str,
    from: &str,
    password: &str,
) -> AppResult<Vec<SentTx>> {
    // 1. Route. First round only.
    if let Some(params) = params {
        backend
            .call("wallet_getSuggestedRoutes", json!([params]))
            .await?;
    }

    // 2. Build the transactions.
    backend
        .call("wallet_buildTransactionsFromRoute", json!([uuid]))
        .await?;

    let built = wait_for_signal(rx, SIGNAL_ROUTER_TXS, uuid).await?;

    let hashes = signing_hashes(&built);
    if hashes.is_empty() {
        return Err(AppError::backend(
            "the backend returned no transactions to sign",
        ));
    }

    // 3. Sign each hash. The password lives only inside this loop.
    let mut signatures = serde_json::Map::new();
    for hash in &hashes {
        let signature = backend
            .call("wallet_signMessage", json!([hash, from, password]))
            .await?
            .as_str()
            .ok_or_else(|| AppError::backend("backend returned no signature"))?
            .to_string();

        let (r, s, v) = split_signature(&signature)?;
        // The key is the hash exactly as the Router returned it: the backend
        // matches a signature to a transaction by it.
        signatures.insert(hash.clone(), json!({ "r": r, "s": s, "v": v }));
    }

    // 4. Send.
    backend
        .call(
            "wallet_sendRouterTransactionsWithSignatures",
            json!([{ "uuid": uuid, "signatures": signatures }]),
        )
        .await?;

    let sent = wait_for_signal(rx, SIGNAL_TXS_SENT, uuid).await?;

    let txs = sent_transactions(&sent);
    if txs.is_empty() {
        return Err(AppError::backend("backend returned no transaction hash"));
    }

    Ok(txs)
}

/// Signing hashes from the `wallet.router.sign-transactions` signal.
fn signing_hashes(event: &Value) -> Vec<String> {
    event
        .get("signingDetails")
        .and_then(|d| d.get("hashes"))
        .and_then(|h| h.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// Sent transactions from the `wallet.router.transactions-sent` signal.
///
/// The `approvalTx` flag is required to tell the `approve` from the main
/// operation. Without it a swap whose second transaction failed would look
/// successful.
fn sent_transactions(event: &Value) -> Vec<SentTx> {
    event
        .get("sentTransactions")
        .and_then(|t| t.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|t| {
                    t.get("hash").and_then(|h| h.as_str()).map(|s| SentTx {
                        hash: s.to_string(),
                        is_approval: t
                            .get("approvalTx")
                            .and_then(|a| a.as_bool())
                            .unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_signature_into_components() {
        // 64 + 64 + 2 hex characters: exactly what SignatureDetails requires.
        let signature = format!("0x{}{}{}", "11".repeat(32), "22".repeat(32), "01");
        let (r, s, v) = split_signature(&signature).expect("valid signature");
        assert_eq!(r, "11".repeat(32));
        assert_eq!(s, "22".repeat(32));
        assert_eq!(v, "01");
    }

    #[test]
    fn normalizes_ethereum_v_values() {
        let with_27 = format!("0x{}{}1b", "00".repeat(32), "00".repeat(32));
        let (_, _, v) = split_signature(&with_27).expect("valid signature");
        assert_eq!(v, "00", "27 means recovery id 0");

        let with_28 = format!("0x{}{}1c", "00".repeat(32), "00".repeat(32));
        let (_, _, v) = split_signature(&with_28).expect("valid signature");
        assert_eq!(v, "01", "28 means recovery id 1");
    }

    #[test]
    fn rejects_malformed_signatures() {
        assert!(split_signature("0xdeadbeef").is_err(), "too short");
        let bad_v = format!("0x{}{}ff", "00".repeat(32), "00".repeat(32));
        assert!(split_signature(&bad_v).is_err(), "v out of range");
    }

    #[test]
    fn uuid_is_unique_and_prefixed() {
        let a = unique_uuid();
        let b = unique_uuid();
        assert!(a.starts_with("stauri-"));
        assert_ne!(a, b);
    }

    #[test]
    fn recognizes_addresses() {
        assert!(is_address("0xcd8fd2a9f9726729d19f9be57d959942d7eb578c"));
        assert!(!is_address("0x123"));
        assert!(!is_address("cd8fd2a9f9726729d19f9be57d959942d7eb578c"));
    }

    #[test]
    fn reads_hex_numbers_with_and_without_prefix() {
        assert_eq!(hex_u128("0x10").unwrap(), 16);
        assert_eq!(hex_u128("10").unwrap(), 16);
        assert!(hex_u128("0xzz").is_err());
    }

    #[test]
    fn extracts_signing_hashes() {
        let event = json!({
            "signingDetails": { "hashes": ["0xaa", "0xbb"] }
        });
        assert_eq!(signing_hashes(&event), vec!["0xaa", "0xbb"]);
    }

    #[test]
    fn missing_signing_hashes_is_empty_not_error() {
        assert!(signing_hashes(&json!({})).is_empty());
        assert!(signing_hashes(&json!({"signingDetails": {}})).is_empty());
    }

    #[test]
    fn extracts_sent_transactions_with_approval_flag() {
        let event = json!({
            "sentTransactions": [
                { "hash": "0xaa", "approvalTx": false },
                { "hash": "0xbb", "approvalTx": true }
            ]
        });
        // All of them are returned: a swap has two (approve + the swap itself),
        // and the last one is what gets shown, but choosing is up to the caller.
        assert_eq!(
            sent_transactions(&event),
            vec![
                SentTx {
                    hash: "0xaa".to_string(),
                    is_approval: false
                },
                SentTx {
                    hash: "0xbb".to_string(),
                    is_approval: true
                },
            ]
        );
    }

    #[test]
    fn approval_only_batch_is_recognized() {
        // Exactly what the first round of a LiFi swap delivers: a single
        // approve transaction, because the main one cannot be built before it is
        // mined. The caller must recognise this and start a second round.
        let event = json!({
            "sentTransactions": [
                { "hash": "0x394f", "approvalTx": true }
            ]
        });
        let txs = sent_transactions(&event);
        assert_eq!(txs.len(), 1);
        assert!(txs[0].is_approval);
    }

    #[test]
    fn missing_sent_transactions_is_empty_not_error() {
        assert!(sent_transactions(&json!({})).is_empty());
        assert!(sent_transactions(&json!({"sentTransactions": []})).is_empty());
    }
}
