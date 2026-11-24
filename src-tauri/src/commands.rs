//! Tauri commands exposed to the frontend.

use std::collections::HashMap;

use tauri::Manager;

use crate::core::error::AppResult;
use crate::core::inprocess;
use crate::core::rpc_proxy;
use crate::updater;

/// Prepares status-go inside this process.
///
/// There is no child process to start: the library is loaded on first use and
/// the signal callback is registered with it. The response carries the data
/// directory and the network settings; no port is returned.
///
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Internal`] when the data directory cannot
/// be determined or created, and when the library or one of its symbols cannot
/// be loaded.
#[tauri::command]
pub async fn start_backend(
    app: tauri::AppHandle,
    network: Option<String>,
) -> AppResult<inprocess::StartBackendResponse> {
    let _ = app;
    tracing::info!(network = ?network, "start_backend called");
    let base = crate::appdirs::data_dir()
        .ok_or_else(|| crate::core::error::AppError::internal("cannot determine app data dir"))?;

    let config = match network.as_deref() {
        Some(net) => crate::config::config_for_network(net)?,
        None => crate::config::load_config(),
    };

    // One profile directory per network: mainnet and testnet must never share
    // accounts or databases.
    let dir = base.join(config.data_dir_suffix());
    std::fs::create_dir_all(&dir)
        .map_err(|e| crate::core::error::AppError::internal(format!("create data dir: {e}")))?;

    // Loading here rather than lazily gives an immediate, actionable error when
    // the library is missing next to the executable.
    let backend = inprocess::backend()?;
    backend.register_signals();

    Ok(inprocess::StartBackendResponse {
        data_dir: dir.to_string_lossy().into_owned(),
        network_name: config.network_name(),
        chain_id: config.chain_id(),
        rpc_url: config.rpc_url(),
        waku_fleet: config.waku_fleet(),
        is_testnet: config.is_testnet(),
    })
}

/// Logs out of status-go.
///
/// Nothing is killed: the node lives in this process, so stopping it means
/// asking status-go to log out. The reply mirrors the old `stop_backend` string
/// so callers keep working.
///
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Internal`] when the library cannot be
/// loaded, and [`crate::core::error::ErrorKind::Backend`] when status-go refuses.
#[tauri::command]
pub async fn stop_backend() -> AppResult<String> {
    let backend = inprocess::backend()?;
    // `Logout` takes no arguments; `direct` handles that endpoint specially.
    tokio::task::spawn_blocking(move || backend.logout())
        .await
        .map_err(|e| crate::core::error::AppError::internal(format!("logout panicked: {e}")))??;
    Ok("Backend stopped".to_string())
}

/// Starts the forwarder and returns the port.
///
/// `upstreams` is passed at startup rather than through a separate command: a
/// provider from the previous run is already stored in the status-go database
/// and points at our port, so the first request arrives before a second command
/// could run, and a forwarder without a table answers 503.
///
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Internal`] when the listener cannot be
/// bound or address resolution fails.
#[tauri::command]
pub async fn start_rpc_proxy(
    app: tauri::AppHandle,
    upstreams: HashMap<u64, String>,
) -> AppResult<u16> {
    let state = app.state::<rpc_proxy::RpcProxyState>();
    rpc_proxy::start(&state, upstreams).await
}

/// Returns the secret every request to the forwarder must carry in its path.
///
/// The forwarder is used by `status-go`, not by the frontend: a provider URL is
/// written through `networks_setChainUserRpcProviders` and used inside the node.
/// The node will not send an `X-Stauri-Token` header, so the secret lives in the
/// URL itself — the only thing that can be passed through.
///
/// Without it any process on the machine (and any site open in a dApp WebView)
/// could call `127.0.0.1:<port>/1` and reach the RPC; such a request used to
/// answer `HTTP 200`.
///
/// Returns `None` while the forwarder has not been started.
///
/// # Errors
/// Never fails; `AppResult` keeps the command signatures uniform.
#[tauri::command]
pub fn rpc_proxy_secret(app: tauri::AppHandle) -> AppResult<Option<String>> {
    let state = app.state::<rpc_proxy::RpcProxyState>();
    Ok(state.secret())
}

/// Sets where requests are proxied for each network.
///
/// `upstreams` maps chainId to a provider URL.
///
/// # Errors
/// Never fails; `AppResult` keeps the command signatures uniform.
#[tauri::command]
pub fn set_rpc_upstreams(app: tauri::AppHandle, upstreams: HashMap<u64, String>) -> AppResult<()> {
    let state = app.state::<rpc_proxy::RpcProxyState>();
    rpc_proxy::set_upstreams(&state, upstreams);
    Ok(())
}

#[tauri::command]
pub fn stop_rpc_proxy(app: tauri::AppHandle) -> AppResult<()> {
    let state = app.state::<rpc_proxy::RpcProxyState>();
    rpc_proxy::stop(&state);
    Ok(())
}

/// Asks the update server whether a newer version exists.
///
/// `Ok(None)` means there is no update or auto-update is not configured. An
/// error means the server did not answer or answered incorrectly.
///
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Config`] when the updater is not
/// configured, and [`crate::core::error::ErrorKind::Network`] when the check fails.
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> AppResult<Option<updater::UpdateInfo>> {
    updater::check(&app).await
}

/// Downloads and installs an update. The application must be restarted.
///
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Config`] when the updater is not
/// configured or no update is available, and
/// [`crate::core::error::ErrorKind::Network`] when the download or install fails.
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> AppResult<()> {
    updater::install(&app).await
}

/// Restarts the application.
///
/// Used after installing an update: on Linux the file is replaced in place and
/// the running process keeps executing the old code.
///
/// `request_restart` is used rather than `restart` because only the former
/// reliably delivers `RunEvent::Exit`, where the RPC forwarder is
/// stopped and the log queue is flushed. Called from the main thread, `restart`
/// bypasses those handlers: the `status-backend` child would stay alive on the
/// old image and the log tail would be lost.
///
/// Nothing else needs to run before `request_restart`; the exit handler already
/// does all of it.
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    tracing::info!("restart requested by user");
    app.request_restart();
}

/// Reply of [`switch_network`]: the chosen network's settings and its profiles.
#[derive(serde::Serialize)]
pub struct SwitchNetworkResponse {
    #[serde(rename = "dataDir")]
    pub data_dir: String,
    #[serde(rename = "networkName")]
    pub network_name: String,
    #[serde(rename = "chainId")]
    pub chain_id: u64,
    #[serde(rename = "rpcUrl")]
    pub rpc_url: String,
    #[serde(rename = "wakuFleet")]
    pub waku_fleet: String,
    #[serde(rename = "isTestnet")]
    pub is_testnet: bool,
    /// Profiles stored in the chosen network's directory.
    pub accounts: Vec<serde_json::Value>,
}

/// Switches the network in place: the process keeps running, the data directory does not.
///
/// @param network - Network preset as the picker names it: `mainnet`, `sepolia`,
/// `holesky`.
/// @returns The network settings and the profiles found in its directory.
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Config`] for an unknown preset or when the
/// network is fixed by `STAURI_NETWORK`, and
/// [`crate::core::error::ErrorKind::Internal`] when the library cannot reopen its account
/// database (an unpatched `libstatus`, see `src-tauri/status-go/`).
///
/// @remarks
/// status-go opens `accounts.sql` once per process and answers every later
/// `InitializeApplication` from it (`OpenAccounts` returns early once opened), while
/// `UpdateRootDataDir` still moves the keystore root. Without closing it first, a
/// process started on one network lists that network's profiles under any other and
/// looks for their keystore in the new, empty directory — a profile that is shown but
/// cannot be opened.
///
/// The order is: validate and persist the choice, log out (nobody may be logged in while
/// the database is swapped), `CloseAccounts`, then `InitializeApplication` on the new
/// directory. The reply is the same shape as `start_backend`, plus the accounts.
#[tauri::command]
pub async fn switch_network(
    app: tauri::AppHandle,
    network: String,
) -> AppResult<SwitchNetworkResponse> {
    let _ = app;
    tokio::task::spawn_blocking(move || switch_network_blocking(&network))
        .await
        .map_err(|e| crate::core::error::AppError::internal(format!("switch panicked: {e}")))?
}

fn switch_network_blocking(network: &str) -> AppResult<SwitchNetworkResponse> {
    // Validates the preset and refuses when `STAURI_NETWORK` fixes it, before anything
    // is touched.
    crate::config::save_network(network)?;
    let config = crate::config::config_for_network(network)?;

    let base = crate::appdirs::data_dir()
        .ok_or_else(|| crate::core::error::AppError::internal("cannot determine app data dir"))?;
    // One profile directory per network, the same suffix `start_backend` uses.
    let dir = base.join(config.data_dir_suffix());
    std::fs::create_dir_all(&dir)
        .map_err(|e| crate::core::error::AppError::internal(format!("create data dir: {e}")))?;

    let backend = inprocess::backend()?;
    if !backend.supports_account_reopen() {
        return Err(crate::core::error::AppError::internal(
            "this libstatus does not export CloseAccounts; rebuild it from src-tauri/status-go \
             to switch networks without restarting the app",
        ));
    }

    // Nothing may stay logged in while the account database is swapped: a session holds
    // the old profile's keys and its node is bound to the old data directory.
    backend.logout()?;
    backend.close_accounts()?;

    let reply = backend.direct("InitializeApplication", &initialize_request(&dir))?;
    let parsed: serde_json::Value = serde_json::from_str(&reply).map_err(|e| {
        crate::core::error::AppError::backend(format!("invalid JSON from backend: {e}"))
    })?;
    if let Some(err) = parsed.get("error") {
        return Err(crate::core::error::AppError::backend(
            inprocess::describe_rpc_error(err),
        ));
    }
    let accounts = parsed
        .get("accounts")
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();

    tracing::info!(
        network = config.network_name(),
        dir = %dir.display(),
        accounts = accounts.len(),
        "network switched in place"
    );

    Ok(SwitchNetworkResponse {
        data_dir: dir.to_string_lossy().into_owned(),
        network_name: config.network_name(),
        chain_id: config.chain_id(),
        rpc_url: config.rpc_url(),
        waku_fleet: config.waku_fleet(),
        is_testnet: config.is_testnet(),
        accounts,
    })
}

/// Request body for `InitializeApplication`, matching `requests.InitializeApplication`.
///
/// Only `dataDir` is read by status-go; it also sets the root from which the account
/// manager resolves the keystore.
fn initialize_request(dir: &std::path::Path) -> String {
    let dir = dir.to_string_lossy();
    serde_json::json!({
        "dataDir": dir,
        "rootDataDir": dir,
    })
    .to_string()
}

/// Accepts a log line from the webview and writes it to the shared file.
///
/// In a release build the frontend logs nowhere on its own: `debug`/`log` in
/// `src/lib/utils/log.ts` are empty functions, `console.*` is stripped by the
/// bundler, and the webview's stdout is not visible to the user. Frontend
/// messages therefore come here and `logging.rs` writes them to the same file as
/// Rust. The level is passed as a string (`debug`/`info`/`warn`/`error`) so the
/// frontend does not need to know about `tracing::Level`.
///
/// Sending is gated by the `VITE_DEBUG_LOG=1` build flag: every call is an IPC
/// round trip plus a disk write, which is fine for debugging and needless for
/// everyday use. With the flag off the webview makes no such call at all.
///
/// Leaks are handled by `RedactingWriter` in `logging.rs`: keys and tokens are
/// scrubbed on write, whoever produced the line.
#[tauri::command]
pub fn log_frontend(level: String, message: String) {
    // The message comes from the webview, so it is untrusted. It is length-capped
    // so one line cannot bloat the log, and newlines are removed because they
    // could forge the record format.
    let message: String = message
        .chars()
        .filter(|c| *c != '\n' && *c != '\r')
        .take(4096)
        .collect();

    match level.as_str() {
        "error" => tracing::error!(target: "frontend", "{message}"),
        "warn" => tracing::warn!(target: "frontend", "{message}"),
        "info" => tracing::info!(target: "frontend", "{message}"),
        _ => tracing::debug!(target: "frontend", "{message}"),
    }
}

/// Initialises status-go through the library.
///
/// Checks one thing — that the library loads and answers
/// `InitializeApplication` — and returns the reply to the frontend as is.
///
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Internal`] when the data directory cannot
/// be determined or created and when the library fails to load, and
/// [`crate::core::error::ErrorKind::Backend`] when status-go returns no response.
#[tauri::command]
pub fn inprocess_initialize(app: tauri::AppHandle) -> crate::core::error::AppResult<String> {
    let _ = app;
    // Data directory: appdirs honours STAURI_DATA_DIR and otherwise uses the
    // Tauri value.
    let dir = crate::appdirs::data_dir()
        .ok_or_else(|| crate::core::error::AppError::internal("cannot determine app data dir"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| crate::core::error::AppError::internal(format!("create data dir: {e}")))?;
    let data_dir = dir.to_string_lossy().into_owned();
    let request = serde_json::json!({
        "dataDir": data_dir,
        "rootDataDir": data_dir,
        "networkId": 1,
    })
    .to_string();
    crate::core::inprocess::backend()?.initialize(&request)
}

/// Calls a status-go endpoint by name without a transport.
///
/// The frontend uses this for `InitializeApplication`, `LoginAccount`,
/// `CreateAccountAndLogin`, `Logout` and `CallRPC`; everything else goes through
/// [`status_rpc`].
///
/// `body` is the request body as the frontend builds it; it is unused for
/// `Logout`.
///
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Internal`] when the library cannot be
/// loaded or the endpoint is unsupported, and
/// [`crate::core::error::ErrorKind::Backend`] when status-go returns an error or no
/// response.
#[tauri::command]
pub fn status_call(endpoint: String, body: String) -> crate::core::error::AppResult<String> {
    if endpoint == "TraceNote" {
        // Frontend test notes. A password never reaches this call.
        crate::core::trace::line(&format!("note {body}"));
        return Ok(String::new());
    }
    crate::core::trace::line(&format!("call {endpoint} body={}b", body.len()));
    let res = crate::core::inprocess::backend()?.direct(&endpoint, &body);
    match &res {
        Ok(text) => {
            let limit = if crate::core::trace::debug_enabled() {
                4000
            } else {
                200
            };
            crate::core::trace::line(&format!(
                "ok {endpoint} len={} text={}",
                text.len(),
                text.chars().take(limit).collect::<String>()
            ));
        }
        Err(e) => crate::core::trace::line(&format!("err {endpoint} {e}")),
    }
    res
}

/// One JSON-RPC call to status-go.
///
/// The async counterpart of `status_call("CallRPC", …)`: the blocking C call
/// runs on a worker thread, so a slow method (routing, signing) does not stall
/// the command handler.
///
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Internal`] when the library cannot be
/// loaded, and [`crate::core::error::ErrorKind::Backend`] when status-go reports a
/// JSON-RPC error.
#[tauri::command]
pub async fn status_rpc(method: String, params: serde_json::Value) -> AppResult<serde_json::Value> {
    crate::core::inprocess::call_rpc(&method, params).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_request_uses_the_data_dir_field() {
        // `requests.InitializeApplication` reads `dataDir` and nothing else in
        // `initializeApplication`; a wrong key leaves status-go with no directory, and
        // `Validate` then refuses the call. `rootDataDir` is ignored by this version but
        // is kept so a build that starts reading it keeps working.
        let body = initialize_request(std::path::Path::new("/var/data/sepolia"));
        let value: serde_json::Value = serde_json::from_str(&body).expect("request is JSON");
        assert_eq!(value["dataDir"], "/var/data/sepolia");
        assert_eq!(value["rootDataDir"], "/var/data/sepolia");
    }
}
