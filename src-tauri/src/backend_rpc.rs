//! status-go calls through the authenticating proxy.
//!
//! Shared by the transfer and ENS paths so the request handling lives in one
//! place instead of drifting between copies.
//!
//! ## Why through the proxy
//!
//! `status-backend` does not check who connects to it: any local process could
//! call `settings_getSettings` (the seed phrase) or `wallet_*`. The proxy
//! requires a header with a token generated at startup (see `auth_proxy.rs`), so
//! knowing the port alone does not grant access.

use serde_json::{Value, json};

use crate::auth_proxy;
use crate::error::{AppError, AppResult};

/// Name of the proxy method that all JSON-RPC calls go through.
const CALL_RPC: &str = "CallRPC";

/// Calls status-go through the proxy.
///
/// The timeout is 60 seconds: building a transaction and estimating gas on a
/// slow network fit inside it, while a hung call would otherwise block the
/// command indefinitely.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] when the proxy token is missing,
/// the request fails, the backend answers with a non-success HTTP status, sends
/// invalid JSON or reports a JSON-RPC error. Returns
/// [`crate::error::ErrorKind::Internal`] when the HTTP client cannot be built.
pub async fn call(port: u16, method: &str, params: Value) -> AppResult<Value> {
    let token = auth_proxy::token()?;
    let url = format!("http://127.0.0.1:{port}/statusgo/{CALL_RPC}");

    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });

    let client = reqwest::Client::builder()
        // Local address: a system proxy would only get in the way.
        .no_proxy()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| AppError::internal(format!("client build error: {e}")))?;

    let resp = client
        .post(&url)
        .header(auth_proxy::TOKEN_HEADER, token)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::backend(format!("backend request failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::backend(format!(
            "backend returned HTTP {}",
            resp.status()
        )));
    }

    let envelope: Value = resp
        .json()
        .await
        .map_err(|e| AppError::backend(format!("backend sent invalid JSON: {e}")))?;

    // A method error arrives inside the JSON-RPC envelope, not as an HTTP status.
    if let Some(err) = envelope.get("error") {
        return Err(AppError::backend(describe_rpc_error(err)));
    }

    Ok(envelope.get("result").cloned().unwrap_or(Value::Null))
}

/// Extracts the message from a JSON-RPC error response.
///
/// status-go reports errors in two forms: a plain string and a
/// `{ code, message }` object. Both are handled without returning the whole
/// body, which can carry addresses and amounts.
pub fn describe_rpc_error(err: &Value) -> String {
    if let Some(msg) = err.as_str() {
        return msg.to_string();
    }
    if let Some(msg) = err.get("message").and_then(|m| m.as_str()) {
        return msg.to_string();
    }
    "backend returned an error".to_string()
}
