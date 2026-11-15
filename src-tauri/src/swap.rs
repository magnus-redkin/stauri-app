//! Token swaps within a single network.
//!
//! The swap is executed by a provider (Paraswap or LI.FI) and the route is
//! built by the status-go Router: it fetches the price, computes
//! `minAmountOut` from the slippage allowance and decides whether a separate
//! `approve` is needed. Replicating that outside would mean diverging from the
//! provider's calculations.
//!
//! The signal and signature machinery is shared with ENS registration and lives
//! in `router.rs`.
//!
//! # Mainnet only
//!
//! Providers have no liquidity on test networks: `getPartnerAddressAndFeePcnt`
//! knows five mainnet networks and LI.FI is not configured on Sepolia. A swap
//! attempt on a test network returns "no routes found", so the network is
//! checked here to give a clear message instead of the provider's refusal.
//!
//! # Slippage
//!
//! `slippagePercentage` is the allowance by which the output may fall short of
//! the quote. The contract requires it to be strictly positive
//! (`ErrSwapSlippagePercentageMustBePositive`), so zero cannot be sent. 1% is a
//! reasonable compromise: less and the swap often fails on price movement, more
//! and the user can be short-changed significantly.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use std::time::Duration;

use crate::backend::Backend;
use crate::error::{AppError, AppResult};
use crate::router::{
    GAS_FEE_MEDIUM, connect_signals, execute_round, hex_u128, is_address, unique_uuid,
};

/// `SendType` from `pkg/services/wallet/router/sendtype/send_type.go`: Swap=8.
const SEND_TYPE_SWAP: u64 = 8;

/// Slippage allowance in percent.
const SLIPPAGE_PERCENT: f64 = 1.0;

/// Networks where swaps actually work: the ones Paraswap knows.
const SWAP_CHAINS: [u64; 5] = [1, 10, 42161, 8453, 56];

/// How long to wait for an `approve` to stop being pending.
///
/// A minute is generous: a normal `approve` is mined within seconds on
/// Ethereum, and under congestion the network will not answer faster. Holding
/// the command longer is not an option — the user has already pressed "swap".
const MINING_TIMEOUT: Duration = Duration::from_secs(60);

/// The first polls are frequent: an `approve` is usually mined almost
/// immediately, so waiting three seconds for a block that already exists is
/// pointless.
const MINING_POLL_FAST: Duration = Duration::from_millis(700);

/// Later polls are rarer, to avoid flooding the forwarder with requests.
const MINING_POLL_SLOW: Duration = Duration::from_millis(2500);

/// Swap request body.
#[derive(Debug, Deserialize)]
pub struct SwapRequest {
    pub port: u16,
    pub chain_id: u64,
    /// Wallet address: both payer and recipient of the swap.
    pub from: String,
    /// Token being given up.
    pub from_token: String,
    /// Token being received.
    pub to_token: String,
    /// Amount given up, in the smallest unit.
    pub amount: String,
    pub password: String,
}

/// Swap quote: how much is received and what it costs.
#[derive(Debug, Serialize)]
pub struct SwapQuote {
    /// Amount received, in the smallest unit of the target token.
    pub amount_out: String,
    /// Minimum acceptable at the current slippage.
    pub min_amount_out: String,
    /// Network fee in wei. `null` when the route did not price gas.
    pub fee: Option<String>,
    /// Whether a separate `approve` is needed before the swap (for an ERC-20
    /// input).
    pub needs_approval: bool,
    /// Who executes the swap: `Paraswap`, `Lifi`, etc.
    pub provider: String,
}

/// Swap result.
#[derive(Debug, Serialize)]
pub struct SwapResult {
    /// Hash of the main swap transaction.
    pub tx_hash: String,
    /// Hash of the `approve`, when it was a separate transaction.
    pub approval_tx_hash: String,
}

/// The native asset as the backend reports it: the zero address.
const NATIVE_TOKEN: &str = "0x0000000000000000000000000000000000000000";

/// `tokenKey` in the form the Router expects: `<chainId>-<lowercase address>`.
fn token_key(chain_id: u64, address: &str) -> String {
    format!("{chain_id}-{}", address.to_lowercase())
}

/// Validates the network and the token pair before contacting the provider.
///
/// # Errors
/// `ErrorKind::Config` for a test network, a malformed token address, identical
/// tokens, a non-integer amount or a zero amount.
fn validate(from_chain: u64, from_token: &str, to_token: &str, amount: &str) -> AppResult<u128> {
    if !SWAP_CHAINS.contains(&from_chain) {
        return Err(AppError::config(
            "Swapping is available only on mainnet networks",
        ));
    }
    for (label, addr) in [("source", from_token), ("target", to_token)] {
        if !is_address(addr) {
            return Err(AppError::config(format!("invalid {label} token address")));
        }
    }
    if from_token.eq_ignore_ascii_case(to_token) {
        return Err(AppError::config(
            "source and target tokens must be different",
        ));
    }

    let value = amount
        .parse::<u128>()
        .map_err(|_| AppError::config("amount must be a decimal integer"))?;
    if value == 0 {
        return Err(AppError::config("amount must be greater than zero"));
    }
    Ok(value)
}

/// Swap route parameters.
///
/// Shared by the quote and the send: a divergence would mean showing one amount
/// and executing another.
fn route_params(
    uuid: &str,
    chain_id: u64,
    from: &str,
    from_token: &str,
    to_token: &str,
    amount: u128,
) -> Value {
    json!({
        "uuid": uuid,
        "sendType": SEND_TYPE_SWAP,
        "addrFrom": from,
        // The swap recipient is the same wallet: a swap is not a transfer, the
        // funds stay with the owner.
        "addrTo": from,
        "amountIn": format!("0x{amount:x}"),
        "tokenKey": token_key(chain_id, from_token),
        "toTokenKey": token_key(chain_id, to_token),
        "tokenIDIsOwnerToken": false,
        "fromChainID": chain_id,
        "toChainID": chain_id,
        "gasFeeMode": GAS_FEE_MEDIUM,
        // Strictly greater than zero: the contract rejects zero.
        "slippagePercentage": SLIPPAGE_PERCENT,
    })
}

/// First route path — a swap is always a single path within one network.
fn first_path(route: &Value) -> Option<&Value> {
    route.get("Route")?.as_array()?.first()
}

/// How much is received and whether an `approve` is needed.
///
/// Read-only: the provider computes the route, the key is not used, so the
/// quote can be shown before the password is entered.
///
/// # Errors
/// `ErrorKind::Config` for a missing backend port, a bad wallet address or
/// validation failures; `ErrorKind::Backend` when the backend call fails or no
/// route is available.
#[tauri::command]
pub async fn get_swap_quote(
    port: u16,
    chain_id: u64,
    from: String,
    from_token: String,
    to_token: String,
    amount: String,
) -> AppResult<SwapQuote> {
    if port == 0 {
        return Err(AppError::config("backend is not running"));
    }
    if !is_address(&from) {
        return Err(AppError::config("invalid wallet address"));
    }
    let value = validate(chain_id, &from_token, &to_token, &amount)?;

    let uuid = unique_uuid();
    let params = route_params(&uuid, chain_id, &from, &from_token, &to_token, value);
    let route = Backend::from_port(port)?
        .call("wallet_getSuggestedRoutes", json!([params]))
        .await?;

    let path = first_path(&route)
        .ok_or_else(|| AppError::backend("no swap route is available for this pair right now"))?;

    let amount_out = path
        .get("AmountOut")
        .and_then(|v| v.as_str())
        .and_then(|v| hex_u128(v).ok())
        .unwrap_or(0);

    // The Router does not expose the output minimum as a separate field: it is
    // already baked into the calldata. It is computed here with the same
    // slippage that goes into the route, so the figure on screen matches the
    // contract.
    let min_amount_out = (amount_out as f64 * (1.0 - SLIPPAGE_PERCENT / 100.0)).floor() as u128;

    let fee = path
        .get("TxTotalFee")
        .and_then(|v| v.as_str())
        .and_then(|v| hex_u128(v).ok())
        .map(|v| v.to_string());

    Ok(SwapQuote {
        amount_out: amount_out.to_string(),
        min_amount_out: min_amount_out.to_string(),
        fee,
        // The native token needs no approve: it leaves directly with the
        // transaction.
        needs_approval: path
            .get("ApprovalRequired")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        provider: path
            .get("ProcessorName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// Executes the swap and returns the transaction hashes.
///
/// Two rounds may be needed because LiFi does not return the main swap
/// transaction together with `approve`: it is built only once `approve` is
/// mined. `transaction_manager_route.go` states it plainly — "we cannot build
/// the swap tx before the approval tx is mined" — and the loop breaks
/// (`continue`) after sending `approve`. The first round therefore returns
/// **one** transaction, and mistaking it for the swap yields an approval that
/// went through, tokens that were not swapped, and a screen reporting "Swap
/// executed".
///
/// Hence: if the answer contains only `approve`, wait for it to be mined and
/// run the round again **with the same `uuid`**. The route is kept in the
/// backend, while a fresh `wallet_getSuggestedRoutes` would reprice at a rate
/// the user has not agreed to.
///
/// # Errors
/// `ErrorKind::Config` for a missing backend port, a bad wallet address, an
/// empty password or validation failures; `ErrorKind::Backend` when building the
/// route, signing or sending fails; `ErrorKind::Internal` when the signals
/// connection cannot be built.
#[tauri::command]
pub async fn swap_tokens(request: SwapRequest) -> AppResult<SwapResult> {
    if request.port == 0 {
        return Err(AppError::config("backend is not running"));
    }
    if !is_address(&request.from) {
        return Err(AppError::config("invalid wallet address"));
    }
    if request.password.is_empty() {
        return Err(AppError::config("password is required"));
    }
    let value = validate(
        request.chain_id,
        &request.from_token,
        &request.to_token,
        &request.amount,
    )?;

    let uuid = unique_uuid();
    let params = route_params(
        &uuid,
        request.chain_id,
        &request.from,
        &request.from_token,
        &request.to_token,
        value,
    );

    let backend = Backend::from_port(request.port)?;
    let mut ws = connect_signals(request.port).await?;

    let first = execute_round(
        &mut ws,
        backend,
        Some(params),
        &uuid,
        &request.from,
        &request.password,
    )
    .await?;

    // A lone `approve` without the main transaction is not a swap but its
    // preparation.
    let approval_only = first.len() == 1 && first[0].is_approval;

    let final_txs = if approval_only {
        let approval_hash = first[0].hash.clone();
        wait_until_not_pending(backend, &approval_hash).await?;

        // Second round with the same uuid: the route is already in the backend.
        let second = execute_round(
            &mut ws,
            backend,
            None,
            &uuid,
            &request.from,
            &request.password,
        )
        .await?;
        (approval_hash, second)
    } else {
        (
            first
                .iter()
                .find(|tx| tx.is_approval)
                .map(|tx| tx.hash.clone())
                .unwrap_or_default(),
            first,
        )
    };

    let _ = ws.close(None).await;

    let (approval_tx_hash, txs) = final_txs;

    // The main transaction is the last non-approve one. Without it the swap did
    // not happen and success must not be reported.
    let tx_hash = txs
        .iter()
        .rev()
        .find(|tx| !tx.is_approval)
        .map(|tx| tx.hash.clone())
        .ok_or_else(|| {
            AppError::backend(
                "the swap transaction was not sent: the backend returned only the approval",
            )
        })?;

    Ok(SwapResult {
        tx_hash,
        approval_tx_hash,
    })
}

/// Waits until the transaction stops being pending.
///
/// `wallet_getPendingTransactions` is used rather than a receipt because
/// `wallet_getTransactionReceipt` does not exist in status-go ("method does not
/// exist/is not available") and `eth_getTransactionReceipt` lives in the `eth`
/// namespace, unreachable through `CallRPC` as well. The pending-transaction
/// tracker, however, removes its entry once the transaction is mined or
/// dropped — exactly the event being awaited.
///
/// Success and failure cannot be distinguished from this list, deliberately: if
/// `approve` failed, the second round returns the provider's error and the user
/// sees the cause. Inventing a verdict from a missing entry would be a guess.
///
/// Waiting is bounded because the transaction may never be mined: a timeout
/// returns a clear error — tokens not taken, `approve` sent, the swap can be
/// retried.
///
/// # Errors
/// `ErrorKind::Backend` when the approval is still pending at the deadline.
async fn wait_until_not_pending(backend: Backend, tx_hash: &str) -> AppResult<()> {
    let deadline = tokio::time::Instant::now() + MINING_TIMEOUT;
    let hash = tx_hash.to_ascii_lowercase();
    let mut attempt = 0u32;

    loop {
        // The first check happens at once: an `approve` is often mined before
        // execution reaches here.
        if let Ok(pending) = backend
            .call("wallet_getPendingTransactions", json!([]))
            .await
        {
            let still_pending = pending
                .as_array()
                .map(|list| {
                    list.iter().any(|tx| {
                        tx.get("hash")
                            .and_then(|h| h.as_str())
                            .map(|h| h.eq_ignore_ascii_case(&hash))
                            .unwrap_or(false)
                    })
                })
                // The list could not be parsed — treat it as nothing left to
                // wait for: the second round will return the error if something
                // is wrong.
                .unwrap_or(false);
            if !still_pending {
                return Ok(());
            }
        }

        if tokio::time::Instant::now() >= deadline {
            return Err(AppError::backend(
                "the token approval is still pending; the swap was not sent. Try again in a minute",
            ));
        }

        let delay = if attempt < 10 {
            MINING_POLL_FAST
        } else {
            MINING_POLL_SLOW
        };
        tokio::time::sleep(delay).await;
        attempt += 1;
    }
}

/// Builds the native token address — for the frontend, so it need not be
/// hardcoded.
#[tauri::command]
pub fn native_token_address() -> String {
    NATIVE_TOKEN.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_known_swap_chains() {
        for chain in SWAP_CHAINS {
            assert!(
                validate(
                    chain,
                    NATIVE_TOKEN,
                    "0x1111111111111111111111111111111111111111",
                    "1"
                )
                .is_ok(),
                "chain {chain}"
            );
        }
    }

    #[test]
    fn rejects_test_networks_with_a_clear_message() {
        // Providers have no liquidity on test networks, and their refusal
        // explains nothing, so this is checked in advance.
        for chain in [11155111u64, 84532, 421614, 560048] {
            let err = validate(
                chain,
                NATIVE_TOKEN,
                "0x1111111111111111111111111111111111111111",
                "1",
            )
            .expect_err("testnet must be rejected");
            assert!(
                err.to_string().to_lowercase().contains("mainnet"),
                "chain {chain}: {err}"
            );
        }
    }

    #[test]
    fn rejects_same_token() {
        let token = "0x1111111111111111111111111111111111111111";
        assert!(validate(1, token, token, "1").is_err());
    }

    #[test]
    fn rejects_bad_addresses() {
        assert!(validate(1, "0x123", NATIVE_TOKEN, "1").is_err());
        assert!(validate(1, NATIVE_TOKEN, "nope", "1").is_err());
    }

    #[test]
    fn rejects_zero_and_garbage_amounts() {
        let to = "0x1111111111111111111111111111111111111111";
        assert!(validate(1, NATIVE_TOKEN, to, "0").is_err());
        assert!(validate(1, NATIVE_TOKEN, to, "1.5").is_err());
        assert!(validate(1, NATIVE_TOKEN, to, "").is_err());
    }

    #[test]
    fn token_key_uses_the_status_go_format() {
        // A hyphen, not a colon: with a colon the backend silently finds no
        // token.
        assert_eq!(
            token_key(1, "0x744D70FDBE2BA4CF95131626614A1763DF805B9E"),
            "1-0x744d70fdbe2ba4cf95131626614a1763df805b9e"
        );
    }

    #[test]
    fn route_params_use_swap_send_type_and_positive_slippage() {
        let params = route_params(
            "uuid-1",
            1,
            "0xcd8fd2a9f9726729d19f9be57d959942d7eb578c",
            NATIVE_TOKEN,
            "0x1111111111111111111111111111111111111111",
            1_000,
        );

        assert_eq!(params["sendType"], 8, "Swap");
        assert_eq!(params["amountIn"], "0x3e8");
        // Zero is rejected by the contract (ErrSwapSlippagePercentageMustBePositive).
        assert!(params["slippagePercentage"].as_f64().unwrap() > 0.0);
        // A swap is not a transfer: the recipient is the same wallet.
        assert_eq!(params["addrFrom"], params["addrTo"]);
    }

    #[test]
    fn missing_route_has_no_first_path() {
        assert!(first_path(&json!({})).is_none());
        assert!(first_path(&json!({"Route": []})).is_none());
    }

    #[test]
    fn reads_amount_out_and_fee() {
        let route = json!({
            "Route": [{
                "AmountOut": "0x5f5e100",
                "TxTotalFee": "0x2386f26fc10000",
                "ApprovalRequired": true,
                "ProcessorName": "Paraswap"
            }]
        });
        let path = first_path(&route).expect("path");
        assert_eq!(
            hex_u128(path["AmountOut"].as_str().unwrap()).unwrap(),
            100_000_000
        );
        assert_eq!(path["ApprovalRequired"].as_bool(), Some(true));
    }

    #[test]
    fn min_amount_out_respects_slippage() {
        // 1000 out at 1% slippage leaves a minimum of 990.
        let amount_out: u128 = 1000;
        let min = (amount_out as f64 * (1.0 - SLIPPAGE_PERCENT / 100.0)).floor() as u128;
        assert_eq!(min, 990);
    }
}
