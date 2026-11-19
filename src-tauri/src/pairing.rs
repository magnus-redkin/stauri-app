//! Local pairing: copying a profile from one device to another over the LAN.
//!
//! status-go implements the transfer; this module wraps it for the two screens
//! that need it. The shape of the protocol decides most of the design, so it is
//! worth writing down:
//!
//! * **The device that has the profile is the sender.** It is logged in, its
//!   keys are what is being copied, and it starts a server
//!   (`GetConnectionStringForBootstrappingAnotherDevice`).
//! * **The device without the profile is the receiver.** It is logged out and
//!   starts a receiver server (`GetConnectionStringForBeingBootstrapped`).
//! * Either side produces a **connection string** — a few hundred base64
//!   characters that the other side has to read. There is no way around that
//!   string: it carries the sender's address, the encryption key and the TLS
//!   certificate pin, and it is what makes an unauthenticated LAN transfer safe.
//! * The transfer itself is TCP over the local network, with mDNS used only for
//!   peer discovery. `StartSearchForLocalPairingPeers` is **not** used here: on
//!   Android it is a no-op (`PeerNotifier.Search` returns early with "Sorry
//!   Android" in the status-go source), so a discovery screen would find nothing
//!   on the very platform this flow is built for.
//!
//! # The password problem
//!
//! The sender ships the profile **password** inside the payload
//! (`LocalPairingPayload.password`), and the receiver stores it with the keys.
//! That password is the one the entry flow generates — 32 random characters that
//! no human ever types. So the receiver must immediately wrap what it received
//! under its own PIN, which is exactly what the entry flow does after a restore.
//! The password arrives in the `received-account` signal, not in the call's
//! reply, so this module subscribes to signals before starting the transfer and
//! waits for that event.
//!
//! # What is never logged
//!
//! Passwords and connection strings are secrets: a connection string is enough
//! to pull the profile off the network for as long as the server lives. Only
//! lengths and outcomes are traced.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::{AppError, AppResult};
use crate::inprocess;

/// How long a connection string stays usable, in milliseconds.
///
/// The server stops itself when this elapses, so a code left on a screen — or copied
/// into a chat by mistake — stops working on its own. Five minutes is status-go's own
/// pairing-test value (`server_pairing_test.go`) and long enough to read a code across
/// two devices.
///
/// The clock starts when the server starts, not when the other device connects: the
/// timeout is a window for *starting* a transfer, and the transfer itself is not cut
/// short by it.
const CONNECTION_STRING_TTL_MS: u32 = 5 * 60 * 1000;

/// Identifier every connection string begins with.
const CONNECTION_STRING_ID: &str = "cs";

/// KDF iterations written into the receiving profile.
///
/// This is status-go's own default (`dbsetup.ReducedKDFIterationsNumber`) and is
/// what the pairing tests use. It is not a security parameter here: the key
/// derivation protects the profile database, and the profile password sitting
/// behind the PIN is generated with 195 bits of entropy.
const RECEIVER_KDF_ITERATIONS: u64 = 3200;

/// How long to wait for the transfer to produce an account, in seconds.
///
/// The sender and receiver talk directly, so the only slow part is a user who
/// takes a while to read the string across. Five minutes is well past that and
/// still gives up instead of hanging forever.
const ACCOUNT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// What a completed transfer hands back to the caller.
///
/// @remarks
/// The profile password is **not** part of this: it travels from the signal straight into
/// `credentials::stash_pending`, and the receiving screen only ever learns the key uid and
/// the name. A password put in this structure would have to be serialised to the webview
/// to be used, and the webview is the one place it does not need to be.
#[derive(Debug, Clone, Serialize)]
pub struct PairedAccount {
    /// Key uid of the profile that arrived, `0x…`.
    pub key_uid: String,
    /// Display name, when the sender had one.
    pub name: Option<String>,
    /// The profile password that came with it, for the caller that wraps it.
    #[serde(skip)]
    pub password: String,
}

/// Role a device plays in a transfer.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// This device has the profile and hands it out.
    Sender,
    /// This device is empty and takes the profile in.
    Receiver,
}

/// Whether this build can pair at all.
///
/// @returns `true` when status-go exports the pairing functions.
pub fn available() -> bool {
    inprocess::backend().map(|b| b.supports_pairing()).unwrap_or(false)
}

/// Reads the profile's keystore directory under the application's data dir.
///
/// @param data_dir - Root data directory of the selected network.
/// @param key_uid - Profile key uid.
/// @returns The per-profile keystore path.
///
/// @remarks
/// The layout is status-go's (`api.DefaultKeystorePath`): `keystore/<keyUid>`.
/// The sender config validates that the path *ends* with the key uid, so a
/// different layout is rejected by the library rather than by this code.
fn keystore_path(data_dir: &str, key_uid: &str) -> String {
    format!("{data_dir}/keystore/{key_uid}")
}

/// Starts a sender and returns the connection string to show.
///
/// @param data_dir - Root data directory of the selected network.
/// @param key_uid - Profile being sent.
/// @param password - Its password; required by status-go to read the keys.
/// @param device_type - `android`, `linux`, … as status-go records it.
/// @param sync_messages - Whether the message history travels with the profile.
/// @returns The connection string for the other device, and the code both sides compare.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] when status-go refuses to start,
/// which is usually a wrong password or a profile that is not logged in.
pub fn start_sender(
    data_dir: &str,
    key_uid: &str,
    password: &str,
    device_type: &str,
    sync_messages: bool,
) -> AppResult<(String, String)> {
    let backend = inprocess::backend()?;
    let config = json!({
        "senderConfig": {
            "keystorePath": keystore_path(data_dir, key_uid),
            "deviceType": device_type,
            "keyUID": key_uid,
            "password": password,
            // The history is a privacy decision the user makes, and status-go reads this
            // flag only on the *server* side — which is this one. It is off unless the
            // user ticked the box: the whole history travels, with no date window.
            "messageSyncingEnabled": sync_messages,
        },
        "serverConfig": {
            // The code stops working on its own, so one copied into a chat by mistake is
            // not a standing invitation.
            "timeout": CONNECTION_STRING_TTL_MS,
        },
    });
    let raw = backend.pairing_start_sender(&config.to_string())?;
    // The reply is the connection string itself, not JSON with an error field:
    // `StartUpSenderServer` returns `cp.ToString()` on success and the error text
    // otherwise. A successful string is base58 and much longer than a message.
    let text = raw.trim().to_string();
    if text.is_empty() {
        return Err(AppError::backend("pairing server returned no connection string"));
    }
    let code = confirmation_code(&text)?;
    crate::trace::line(&format!(
        "pairing sender started key={} stringLen={} syncMessages={sync_messages}",
        short_key(key_uid),
        text.len()
    ));
    Ok((text, code))
}

/// Starts a receiver and returns the connection string to show.
///
/// @param data_dir - Root data directory of the selected network.
/// @returns The connection string for the other device, and the code both sides compare.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] when status-go refuses to start.
pub fn start_receiver(data_dir: &str) -> AppResult<(String, String)> {
    let backend = inprocess::backend()?;
    let config = json!({
        "receiverConfig": {
            "createAccount": {
                "rootDataDir": data_dir,
                "kdfIterations": RECEIVER_KDF_ITERATIONS,
            },
        },
        "serverConfig": {
            "timeout": CONNECTION_STRING_TTL_MS,
        },
    });
    let raw = backend.pairing_start_receiver(&config.to_string())?;
    let text = raw.trim().to_string();
    if text.is_empty() {
        return Err(AppError::backend("pairing server returned no connection string"));
    }
    let code = confirmation_code(&text)?;
    crate::trace::line(&format!(
        "pairing receiver started stringLen={}",
        text.len()
    ));
    Ok((text, code))
}

/// The six digits both devices show before a transfer starts.
///
/// @param connection_string - String produced on this device.
/// @returns Six digits derived from the key inside the string.
///
/// @remarks
/// The string carries an AES key that only the device that produced it knows. Both sides
/// derive the same six digits from it, so a string substituted on its way across — pasted
/// from a chat, read off a photograph — produces different digits, and the mismatch is
/// the moment to stop.
///
/// What this does **not** cover: someone who simply saw the whole string. They use it as
/// it is, so the digits agree. The short lifetime of the code is what limits that, not
/// the digits.
fn confirmation_code(connection_string: &str) -> AppResult<String> {
    use sha2::{Digest, Sha256};

    let key = aes_key_of(connection_string)
        .ok_or_else(|| AppError::backend("connection string carries no key"))?;
    // Domain-separated, so the digits are not a usable prefix of anything else derived
    // from the same key.
    let mut digest = Sha256::new();
    digest.update(b"stauri-pairing-confirmation");
    digest.update(&key);
    let hash = digest.finalize();
    let mut bytes = [0u8; 4];
    bytes.copy_from_slice(&hash[..4]);
    let value = u32::from_be_bytes(bytes) % 1_000_000;
    Ok(format!("{value:06}"))
}

/// Reads the AES key out of a connection string.
///
/// @param connection_string - `cs<version>:<ips>:<port>:<pubkey>:<aeskey>:…`.
/// @returns The key bytes, or `None` when the string is not in the documented shape.
///
/// @remarks
/// The layout is fixed by status-go (`pkg/services/pairing/connection.go`): base58 fields
/// separated by `:`, with the AES key fifth. Only that one field is needed, so the rest is
/// not parsed — the fields after it are optional, and a reader that insisted on all of
/// them would break when status-go appends a parameter.
fn aes_key_of(connection_string: &str) -> Option<Vec<u8>> {
    let body = connection_string.trim().strip_prefix(CONNECTION_STRING_ID)?;
    let fields: Vec<&str> = body.split(':').collect();
    // version, ips, port, public key, AES key.
    let encoded = fields.get(4)?;
    bs58::decode(encoded).into_vec().ok().filter(|k| !k.is_empty())
}

/// Checks a connection string typed or pasted by the user.
///
/// @param connection_string - String to check.
/// @returns `true` when status-go accepts it.
///
/// # Errors
/// Never: an invalid string is an answer, not a failure.
#[must_use]
pub fn is_valid_connection_string(connection_string: &str) -> bool {
    let trimmed = connection_string.trim();
    if trimmed.is_empty() {
        return false;
    }
    inprocess::backend()
        .and_then(|b| b.pairing_validate(trimmed))
        // `ValidateConnectionString` returns an empty string on success.
        .map(|answer| answer.trim().is_empty())
        .unwrap_or(false)
}

/// Runs this device as the receiver and waits for the profile to arrive.
///
/// @param data_dir - Root data directory of the selected network.
/// @param connection_string - String produced by the sender.
/// @returns The profile that arrived, with its password.
///
/// @remarks
/// The subscription to status-go signals is made **before** the transfer starts.
/// The `received-account` event can be emitted before the call returns, and a
/// subscriber that arrives afterwards would wait for an event that already
/// happened — the same shape of bug that makes `RestoreAccountAndLogin` look
/// successful while `node.login` reports the failure.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] when the string is refused, the
/// transfer fails, or no account arrives within the timeout.
pub async fn bootstrap_receiver(
    data_dir: &str,
    connection_string: &str,
) -> AppResult<PairedAccount> {
    let backend = inprocess::backend()?;
    if !backend.supports_pairing() {
        return Err(AppError::internal("this build has no local pairing"));
    }

    let config = json!({
        "receiverConfig": {
            "createAccount": {
                "rootDataDir": data_dir,
                "kdfIterations": RECEIVER_KDF_ITERATIONS,
            },
        },
        "clientConfig": {},
    });

    // Subscribe first: see the remark above.
    let mut signals = inprocess::subscribe();
    let cs = connection_string.trim().to_string();

    let reply = tokio::task::spawn_blocking(move || {
        let backend = inprocess::backend()?;
        backend.pairing_bootstrap_receiver(&cs, &config.to_string())
    })
    .await
    .map_err(|e| AppError::internal(format!("pairing receive panicked: {e}")))??;

    // The reply carries the installation id and key uid, so an error in it is
    // final; anything after that arrives through the signals.
    if let Some(err) = pairing_reply_error(&reply) {
        return Err(AppError::backend(err));
    }

    let account = wait_for_account(&mut signals).await?;
    crate::trace::line(&format!(
        "pairing received account key={} passwordLen={}",
        short_key(&account.key_uid),
        account.password.len()
    ));
    Ok(account)
}

/// Runs this device as the sender and pushes the profile to the other one.
///
/// @param data_dir - Root data directory of the selected network.
/// @param connection_string - String produced by the receiver.
/// @param key_uid - Profile being sent.
/// @param password - Its password.
/// @param device_type - `android`, `linux`, … as status-go records it.
///
/// @remarks
/// No waiting for a signal: the sender's job ends when the transfer reports
/// success, and the receiving device is the one that has to store keys and open
/// the profile.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] when the string is refused or the
/// transfer fails.
pub async fn bootstrap_sender(
    data_dir: &str,
    connection_string: &str,
    key_uid: &str,
    password: &str,
    device_type: &str,
) -> AppResult<()> {
    let backend = inprocess::backend()?;
    if !backend.supports_pairing() {
        return Err(AppError::internal("this build has no local pairing"));
    }

    let config = json!({
        "senderConfig": {
            "keystorePath": keystore_path(data_dir, key_uid),
            "deviceType": device_type,
            "keyUID": key_uid,
            "password": password,
        },
        "clientConfig": {},
    });

    let mut signals = inprocess::subscribe();
    let cs = connection_string.trim().to_string();
    let key = key_uid.to_string();

    let reply = tokio::task::spawn_blocking(move || {
        let backend = inprocess::backend()?;
        backend.pairing_bootstrap_sender(&cs, &config.to_string())
    })
    .await
    .map_err(|e| AppError::internal(format!("pairing send panicked: {e}")))??;

    if let Some(err) = pairing_reply_error(&reply) {
        return Err(AppError::backend(err));
    }

    // The sender also sees the transfer events, so the result is confirmed rather
    // than assumed: `StartUpSendingClient` returns before the payload has been
    // acknowledged, and an empty reply means "started", not "succeeded".
    wait_for_transfer(&mut signals).await?;
    crate::trace::line(&format!("pairing sent account key={}", short_key(&key)));
    Ok(())
}

/// Waits for the `received-account` event and builds [`PairedAccount`] from it.
async fn wait_for_account(
    signals: &mut tokio::sync::broadcast::Receiver<String>,
) -> AppResult<PairedAccount> {
    let deadline = tokio::time::Instant::now() + ACCOUNT_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(AppError::backend("pairing timed out"));
        }
        let raw = match tokio::time::timeout(remaining, signals.recv()).await {
            Ok(Ok(raw)) => raw,
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(_)) => return Err(AppError::internal("signal stream closed")),
            Err(_) => return Err(AppError::backend("pairing timed out")),
        };

        let Some((event_type, data)) = pairing_event(&raw) else {
            continue;
        };
        match event_type.as_str() {
            "received-account" => {
                let account = data
                    .get("account")
                    .ok_or_else(|| AppError::backend("pairing returned no account"))?;
                let key_uid = account
                    .get("keyUid")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| AppError::backend("pairing returned no key uid"))?
                    .to_string();
                let password = data
                    .get("password")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                if password.is_empty() {
                    // Without the password the profile cannot be opened afterwards,
                    // and silently storing it would leave a dead profile on the
                    // device. This is a hard failure, not a warning.
                    return Err(AppError::backend(
                        "pairing did not transfer the profile password",
                    ));
                }
                let name = account
                    .get("name")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(std::string::ToString::to_string);
                return Ok(PairedAccount {
                    key_uid,
                    name,
                    password,
                });
            }
            "process-error" | "transfer-error" | "connection-error" => {
                return Err(AppError::backend(event_error_message(&data)));
            }
            _ => {}
        }
    }
}

/// Waits for the sender's transfer to be confirmed.
async fn wait_for_transfer(
    signals: &mut tokio::sync::broadcast::Receiver<String>,
) -> AppResult<()> {
    let deadline = tokio::time::Instant::now() + ACCOUNT_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(AppError::backend("pairing timed out"));
        }
        let raw = match tokio::time::timeout(remaining, signals.recv()).await {
            Ok(Ok(raw)) => raw,
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(_)) => return Err(AppError::internal("signal stream closed")),
            Err(_) => return Err(AppError::backend("pairing timed out")),
        };

        let Some((event_type, data)) = pairing_event(&raw) else {
            continue;
        };
        match event_type.as_str() {
            "transfer-success" | "process-success" | "received-account" => return Ok(()),
            "transfer-error" | "process-error" | "connection-error" => {
                return Err(AppError::backend(event_error_message(&data)));
            }
            _ => {}
        }
    }
}

/// Extracts the pairing event from a status-go signal.
///
/// @param raw - Raw signal envelope.
/// @returns The event type and its data, or `None` for other signals.
fn pairing_event(raw: &str) -> Option<(String, serde_json::Value)> {
    let envelope: serde_json::Value = serde_json::from_str(raw).ok()?;
    if envelope.get("type").and_then(|t| t.as_str()) != Some("localPairing") {
        return None;
    }
    let event = envelope.get("event")?;
    let kind = event.get("type").and_then(|t| t.as_str())?.to_string();
    let data = event.get("data").cloned().unwrap_or(serde_json::Value::Null);
    Some((kind, data))
}

/// Reads the human-readable error out of a pairing event.
fn event_error_message(data: &serde_json::Value) -> String {
    data.get("error")
        .and_then(|e| e.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("pairing failed")
        .to_string()
}

/// Reads an error from a pairing call reply.
///
/// @param reply - Raw reply of a bootstrap call.
/// @returns The message when the reply reports a failure.
///
/// @remarks
/// The bootstrap calls answer with a JSON object
/// (`{"installationId": …, "keyUID": …}`) on success and with
/// `{"error": "…"}` on failure. Anything that is not that object — a bare error text, an
/// empty answer — is a failure too: treating an unparseable reply as success would send
/// the caller on to wait five minutes for a signal that is never coming, and the user
/// would see a timeout instead of the reason.
fn pairing_reply_error(reply: &str) -> Option<String> {
    let value: serde_json::Value = match serde_json::from_str(reply) {
        Ok(value) => value,
        Err(_) => {
            let text = reply.trim();
            return Some(if text.is_empty() {
                "pairing returned no reply".to_string()
            } else {
                format!("pairing failed: {}", truncate(text, 200))
            });
        }
    };
    let Some(err) = value.get("error") else {
        return None;
    };
    let message = if let Some(s) = err.as_str() {
        s.to_string()
    } else {
        err.get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("pairing failed")
            .to_string()
    };
    if message.is_empty() {
        None
    } else {
        Some(message)
    }
}

/// Shortens a message for an error surfaced to the user.
fn truncate(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((index, _)) => &text[..index],
        None => text,
    }
}

/// First characters of a key uid, for traces.
fn short_key(key_uid: &str) -> &str {
    &key_uid[..10.min(key_uid.len())]
}

/// Device type as status-go records it.
///
/// @returns `android` or the desktop OS name.
///
/// @remarks
/// The webview reports the platform through its user agent and the screens pass it in
/// explicitly, because a user agent is a weak signal. This function is the authoritative
/// answer for callers that are already in Rust.
#[must_use]
#[allow(dead_code)]
pub fn device_type() -> &'static str {
    #[cfg(target_os = "android")]
    {
        "android"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(not(any(
        target_os = "android",
        target_os = "linux",
        target_os = "macos",
        target_os = "windows"
    )))]
    {
        "unknown"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keystore_path_ends_with_key_uid() {
        // status-go validates `keystorepath` by requiring the last segment to be
        // the key uid, so this layout is part of the contract.
        let path = keystore_path("/data/mainnet", "0xabc");
        assert!(path.ends_with("/0xabc"));
        assert_eq!(path, "/data/mainnet/keystore/0xabc");
    }

    #[test]
    fn invalid_connection_strings_are_rejected_without_the_backend() {
        // Empty input is answered before the library is touched, which keeps the
        // screens from starting a transfer on a stray paste.
        assert!(!is_valid_connection_string(""));
        assert!(!is_valid_connection_string("   "));
    }

    #[test]
    fn pairing_event_ignores_other_signals() {
        let raw = r#"{"type":"messages","event":{"type":"message"}}"#;
        assert!(pairing_event(raw).is_none());
    }

    #[test]
    fn pairing_event_extracts_type_and_data() {
        let raw = r#"{"type":"localPairing","event":{"type":"received-account","data":{"password":"x"}}}"#;
        let (kind, data) = pairing_event(raw).expect("event");
        assert_eq!(kind, "received-account");
        assert_eq!(data.get("password").and_then(|p| p.as_str()), Some("x"));
    }

    #[test]
    fn reply_error_is_read_from_object() {
        assert_eq!(
            pairing_reply_error(r#"{"error":"boom"}"#),
            Some("boom".to_string())
        );
        assert_eq!(pairing_reply_error(r#"{"installationId":"x"}"#), None);
        assert_eq!(pairing_reply_error(r#"{"error":""}"#), None);
        // A bare reply is not JSON, so it cannot be the success object: treating it as
        // success would send the caller on to wait five minutes for a signal that is not
        // coming, and the user would see a timeout instead of the reason.
        assert_eq!(
            pairing_reply_error("not json"),
            Some("pairing failed: not json".to_string())
        );
        assert_eq!(
            pairing_reply_error("   "),
            Some("pairing returned no reply".to_string())
        );
    }

    #[test]
    fn a_long_bare_reply_is_truncated() {
        // The reply is error text from the library and reaches the user: a multi-kilobyte
        // string would be a wall of text in a one-line error.
        let long = "x".repeat(500);
        let message = pairing_reply_error(&long).expect("an error");
        assert!(message.len() < 260, "got {} characters", message.len());
    }

    #[test]
    fn event_error_message_falls_back() {
        let empty = serde_json::Value::Null;
        assert_eq!(event_error_message(&empty), "pairing failed");
        let real = serde_json::json!({ "error": "timeout" });
        assert_eq!(event_error_message(&real), "timeout");
    }

    /// Builds a connection string with the given AES key in the documented shape.
    ///
    /// @remarks
    /// The real layout is `cs` followed by the version and then the fields
    /// (`connection.go`), so the version is part of the first segment: `cs3:<ips>:…`.
    /// Writing it as `cs3:<version>:…` would shift every field by one, which is exactly
    /// how the first version of this test compared the wrong bytes.
    fn string_with_key(key: &[u8]) -> String {
        format!(
            "cs{}:{}:{}:{}:{}",
            bs58::encode([3u8]).into_string(),
            bs58::encode([1u8]).into_string(),
            bs58::encode([0u8]).into_string(),
            bs58::encode([9u8, 9]).into_string(),
            bs58::encode(key).into_string(),
        )
    }

    #[test]
    fn the_same_key_gives_the_same_code_on_both_sides() {
        // The point of the code: two devices holding one string derive one answer.
        let key = [0x11u8; 32];
        let a = confirmation_code(&string_with_key(&key)).expect("code");
        let b = confirmation_code(&string_with_key(&key)).expect("code");
        assert_eq!(a, b);
        assert_eq!(a.len(), 6, "six digits, ready to read aloud");
        assert!(a.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn a_different_key_gives_different_digits() {
        // This is what catches a string substituted on its way across.
        let a = confirmation_code(&string_with_key(&[0x11u8; 32])).expect("code");
        let b = confirmation_code(&string_with_key(&[0x22u8; 32])).expect("code");
        assert_ne!(a, b);
    }

    #[test]
    fn a_string_outside_the_documented_shape_is_refused() {
        // Not `cs…`, too few fields, or an AES field that is not base58: the code must not
        // be invented from whatever happened to be there.
        assert!(confirmation_code("").is_err());
        assert!(confirmation_code("cs3:abc").is_err());
        assert!(confirmation_code("xx3:a:b:c:d").is_err());
        assert!(confirmation_code("cs3:a:b:c:!!!").is_err());
    }

    #[test]
    fn trailing_fields_do_not_change_the_code() {
        // status-go appends parameters instead of changing existing ones, so a future
        // string with installation id and key uid must still produce the same digits.
        let key = [0x33u8; 32];
        let short = string_with_key(&key);
        let long = format!("{short}:{}:{}", bs58::encode([1u8]).into_string(), bs58::encode(b"0xab").into_string());
        assert_eq!(
            confirmation_code(&short).expect("code"),
            confirmation_code(&long).expect("code")
        );
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// A connection string produced on this device.
#[derive(Serialize)]
pub struct ConnectionString {
    /// The string to show. A few hundred base58 characters; it cannot be typed.
    pub value: String,
    /// Role this device took, so the screen can word the instructions.
    pub role: Role,
    /// Six digits both devices compare before the transfer starts.
    pub confirmation_code: String,
}

/// Starts this device as the sender and returns the string to show.
///
/// @param data_dir - Root data directory of the selected network.
/// @param key_uid - Profile being sent.
/// @param password - Its password.
/// @param device_type - `android`, `linux`, … as status-go records it.
/// @param sync_messages - Whether the message history travels with the profile.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] when status-go refuses to start
/// the server, usually because the profile is not logged in.
#[tauri::command]
pub async fn pairing_start_sending(
    data_dir: String,
    key_uid: String,
    password: String,
    device_type: String,
    sync_messages: bool,
) -> AppResult<ConnectionString> {
    let (value, confirmation_code) = tokio::task::spawn_blocking(move || {
        start_sender(&data_dir, &key_uid, &password, &device_type, sync_messages)
    })
    .await
    .map_err(|e| AppError::internal(format!("pairing start panicked: {e}")))??;
    Ok(ConnectionString {
        value,
        role: Role::Sender,
        confirmation_code,
    })
}

/// Starts this device as the receiver and returns the string to show.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] when status-go refuses to start
/// the server.
#[tauri::command]
pub async fn pairing_start_receiving(data_dir: String) -> AppResult<ConnectionString> {
    let (value, confirmation_code) = tokio::task::spawn_blocking(move || start_receiver(&data_dir))
        .await
        .map_err(|e| AppError::internal(format!("pairing start panicked: {e}")))??;
    Ok(ConnectionString {
        value,
        role: Role::Receiver,
        confirmation_code,
    })
}

/// Whether this build can pair at all.
#[tauri::command]
pub fn pairing_available() -> bool {
    available()
}

/// Checks a connection string without starting a transfer.
///
/// @returns `true` when status-go accepts the string.
#[tauri::command]
pub fn pairing_validate(connection_string: String) -> bool {
    is_valid_connection_string(&connection_string)
}

/// The six digits the receiving device compares against the sender's screen.
///
/// @param connection_string - String the user pasted.
/// @returns The digits, or an error when the string is not in the documented shape.
/// @remarks
/// Derived here rather than in the webview so both devices run the same code over the
/// same bytes — a second implementation in JavaScript would be a second thing to keep
/// right, and a mismatch between them would look like an attack.
#[tauri::command]
pub fn pairing_confirmation_code(connection_string: String) -> AppResult<String> {
    confirmation_code(&connection_string)
}

/// Receives a profile from the other device.
///
/// @param data_dir - Root data directory of the selected network.
/// @param connection_string - String produced by the sender.
/// @param network - `mainnet` or `testnet`; the received password is filed under it.
/// @returns The profile that arrived: key uid and name, never the password.
///
/// @remarks
/// The password is taken out of the account and parked in
/// `credentials::stash_pending`, where `credential_save_pin_from_pending` wraps it under
/// the PIN the user picks. It is deliberately not part of the return value: a password
/// serialised to the webview would sit in Svelte state for as long as the PIN screen is
/// open, and nothing there needs it.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] when the transfer fails or times
/// out.
#[tauri::command]
pub async fn pairing_receive(
    data_dir: String,
    connection_string: String,
    network: String,
) -> AppResult<PairedAccount> {
    let account = bootstrap_receiver(&data_dir, &connection_string).await?;
    let slot = crate::credentials::Slot::new(&network, &account.key_uid)?;
    crate::credentials::stash_pending(slot, account.password.clone());
    Ok(PairedAccount {
        key_uid: account.key_uid,
        name: account.name,
        password: String::new(),
    })
}

/// Sends this device's profile to the other one.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] when the transfer fails or times
/// out.
#[tauri::command]
pub async fn pairing_send(
    data_dir: String,
    connection_string: String,
    key_uid: String,
    password: String,
    device_type: String,
) -> AppResult<()> {
    bootstrap_sender(
        &data_dir,
        &connection_string,
        &key_uid,
        &password,
        &device_type,
    )
    .await
}
