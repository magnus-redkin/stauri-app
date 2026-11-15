//! Tauri commands exposed to the frontend.

use std::collections::HashMap;

use tauri::Manager;

use crate::auth_proxy;
use crate::error::AppResult;
use crate::rpc_proxy;
use crate::sidecar;
use crate::updater;

#[cfg(desktop)]
#[tauri::command]
pub async fn start_backend(
    app: tauri::AppHandle,
    network: Option<String>,
) -> AppResult<sidecar::StartBackendResponse> {
    sidecar::start(app, network).await
}

/// Android: no process and no port — the backend is a library inside the app.
///
/// The response has the same shape as on desktop. `port`/`authPort` are 0 and
/// unused because `statusFetch` goes through the `status_call` bridge on
/// Android.
#[cfg(mobile)]
#[tauri::command]
pub async fn start_backend(
    app: tauri::AppHandle,
    network: Option<String>,
) -> AppResult<sidecar::StartBackendResponse> {
    let _ = app;
    let dir = crate::appdirs::data_dir()
        .ok_or_else(|| crate::error::AppError::internal("cannot determine app data dir"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| crate::error::AppError::internal(format!("create data dir: {e}")))?;
    // Android has a single network: mainnet (chainId 1). Testnet comes separately.
    let _ = network;
    Ok(sidecar::StartBackendResponse {
 port: 0,
        // There is no port on Android: 1 is a non-zero marker so that connect()
        // does not skip configureWalletRpc (statusFetch does not read the port
        // over the bridge).
 auth_port: 1,
        data_dir: dir.to_string_lossy().into_owned(),
        network_name: "mainnet".to_string(),
        chain_id: 1,
        rpc_url: String::new(),
        waku_fleet: String::new(),
 is_testnet: false,
    })
}

#[tauri::command]
pub fn stop_backend(app: tauri::AppHandle) -> AppResult<String> {
    sidecar::stop(app)
}

/// Returns the token for the `X-Stauri-Token` header.
///
/// The frontend adds it to every request to the auth proxy. Without a token the
/// proxy answers 403, so a third-party local process cannot call status-backend
/// methods directly.
///
/// The token is read inside the webview, so an XSS attacker can reach it — an
/// accepted trade-off, see the header of `auth_proxy.rs`.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Internal`] when the token lock is
/// poisoned or the token cannot be generated.
#[tauri::command]
pub fn auth_proxy_token() -> AppResult<String> {
    auth_proxy::token()
}

/// Starts the forwarder and returns the port.
///
/// `upstreams` is passed at startup rather than through a separate command: a
/// provider from the previous run is already stored in the status-go database
/// and points at our port, so the first request arrives before a second command
/// could run, and a forwarder without a table answers 503.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Internal`] when the listener cannot be
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
/// Returns [`crate::error::ErrorKind::Config`] when the updater is not
/// configured, and [`crate::error::ErrorKind::Network`] when the check fails.
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> AppResult<Option<updater::UpdateInfo>> {
    updater::check(&app).await
}

/// Downloads and installs an update. The application must be restarted.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Config`] when the updater is not
/// configured or no update is available, and
/// [`crate::error::ErrorKind::Network`] when the download or install fails.
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
/// reliably delivers `RunEvent::Exit`, where the sidecar and both proxies are
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

/// Android: initialises status-go through the `libstatus.so` bridge.
///
/// It checks one thing — that the library loads and answers
/// `InitializeApplication` — and returns the reply to the frontend as is.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Internal`] when the data directory cannot
/// be determined or created and when the bridge fails to load, and
/// [`crate::error::ErrorKind::Backend`] when status-go returns no response.
#[tauri::command]
pub fn inprocess_initialize(app: tauri::AppHandle) -> crate::error::AppResult<String> {
    #[cfg(target_os = "android")]
    {
        // Data directory: appdirs honours STAURI_DATA_DIR and otherwise uses the
        // Tauri value.
        let _ = app;
        let dir = crate::appdirs::data_dir()
            .ok_or_else(|| crate::error::AppError::internal("cannot determine app data dir"))?;
        std::fs::create_dir_all(&dir)
            .map_err(|e| crate::error::AppError::internal(format!("create data dir: {e}")))?;
        let data_dir = dir.to_string_lossy().into_owned();
        let request = serde_json::json!({
     "dataDir": data_dir,
     "rootDataDir": data_dir,
     "networkId": 1,
        })
        .to_string();
 crate::inprocess::backend()?.initialize(&request)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(crate::error::AppError::internal("in-process backend is only available on Android"))
    }
}

/// Calls status-go without HTTP.
///
/// On Android this goes through the `libstatus.so` bridge; on other platforms
/// the frontend talks HTTP through the proxy and does not need this command.
///
/// `body` is the request body as `statusFetch` sends it; it is unused for
/// `Logout`.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Internal`] when the bridge cannot be
/// loaded or the endpoint is unsupported, and
/// [`crate::error::ErrorKind::Backend`] when status-go returns an error or no
/// response.
#[tauri::command]
pub fn status_call(endpoint: String, body: String) -> crate::error::AppResult<String> {
    #[cfg(target_os = "android")]
    {
 if endpoint == "TraceNote" {
     // Frontend test notes. A password never reaches this call.
            crate::trace::line(&format!("note {body}"));
     return Ok(String::new());
        }
        crate::trace::line(&format!("call {endpoint} body={}b", body.len()));
 let res = crate::inprocess::backend()?.direct(&endpoint, &body);
        match &res {
     Ok(text) => {
  let limit = if crate::trace::debug_enabled() { 4000 } else { 200 };
        crate::trace::line(&format!("ok {endpoint} len={} text={}", text.len(), text.chars().take(limit).collect::<String>()));
         if endpoint == "InitializeApplication" {
      if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
          match v.get("accounts").and_then(|a| a.get(0)) {
       Some(acc) => {
    let fields: Vec<String> = acc.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    let key_uid = acc.get("key-uid").or_else(|| acc.get("keyUid")).and_then(|k| k.as_str()).unwrap_or("<none>");
           crate::trace::line(&format!("init account fields={fields:?} key-uid={key_uid}"));
       }
       None => crate::trace::line("init accounts: none"),
   }
      }
  }
     }
     Err(e) => crate::trace::line(&format!("err {endpoint} {e}")),
        }
 res
    }
    #[cfg(not(target_os = "android"))]
    {
 let _ = (endpoint, body);
 Err(crate::error::AppError::internal("in-process backend is only available on Android"))
    }
}
