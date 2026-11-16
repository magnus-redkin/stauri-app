//! status-go as a library inside the application process.
//!
//! Every platform now uses this: `libstatus.so` on Linux, `libstatus.dylib` on
//! macOS, `libstatus.dll` on Windows, and the copy installed into `jniLibs` on
//! Android. There is no separate backend process, no local port and no proxy.
//!
//! All status-go traffic goes through [`call_rpc`]. Errors come back as a JSON
//! string, matching `mobile/status.go`, where `CallRPC` returns a JSON string.
//!
//! # Signals
//!
//! status-go pushes signals through a C callback registered with
//! `SetSignalEventCallback`; there is no socket to subscribe to. [`subscribe`]
//! hands out a receiver from a process-wide broadcast channel, and [`set_app_emitter`]
//! lets the application forward the same stream to the frontend. Both sources
//! (`/signals` on `status-backend` and this callback) are fed from the same
//! `internal/signal` package, so the payload shape is identical.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::path::PathBuf;
use std::sync::OnceLock;

use libloading::{Library, Symbol};
use serde_json::Value;
use tokio::sync::broadcast;

use crate::error::{AppError, AppResult};

/// Signatures from `mobile/status.go`: one string in, one string out.
type CStrFn = unsafe extern "C" fn(*mut c_char) -> *mut c_char;
/// `void SetSignalEventCallback(void* cb)`: the argument is a C function pointer.
type SetSignalFn = unsafe extern "C" fn(*mut std::ffi::c_void);

// libc `free`. A string allocated by cgo is released by the caller, because
// `libstatus.h` exports no dedicated release function.
unsafe extern "C" {
    fn free(ptr: *mut std::ffi::c_void);
}

/// Reply of `start_backend`, shaped as the frontend expects.
///
/// status-go runs in this process, so there is no port: the reply carries the
/// profile and network data only.
#[derive(serde::Serialize)]
pub struct StartBackendResponse {
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
}

/// A loaded `libstatus` together with the functions it exports.
///
/// `Library` is kept in the struct: the symbols stay valid only while it lives.
pub struct InProcessBackend {
    _lib: Library,
    call_rpc: CStrFn,
    initialize: CStrFn,
    login: CStrFn,
    create_and_login: CStrFn,
    logout: unsafe extern "C" fn() -> *mut c_char,
    set_signal_callback: Option<SetSignalFn>,
}

// Function pointers and `Library` are thread-safe: status-go serialises calls
// internally.
unsafe impl Send for InProcessBackend {}
unsafe impl Sync for InProcessBackend {}

/// Broadcast channel for status-go signals.
///
/// A broadcast rather than a queue: several consumers subscribe at once (the
/// frontend bridge and a pending Router round) and none of them owns the stream.
/// The capacity bounds memory if a consumer falls behind; lagging consumers see
/// a `Lagged` error and can re-read the state they need from the backend.
static SIGNALS: OnceLock<broadcast::Sender<String>> = OnceLock::new();

/// Capacity in signals. status-go emits bursts (wallet refreshes) but never more
/// than a few hundred at once; 512 keeps a slow consumer from losing a burst
/// without holding an unbounded buffer.
const SIGNAL_CAPACITY: usize = 512;

static BACKEND: OnceLock<AppResult<InProcessBackend>> = OnceLock::new();

fn signal_sender() -> &'static broadcast::Sender<String> {
    SIGNALS.get_or_init(|| broadcast::channel(SIGNAL_CAPACITY).0)
}

/// Subscribes to status-go signals.
///
/// The returned receiver yields the raw JSON envelopes status-go sends; callers
/// filter by `type`. Signals emitted before the call are not replayed, so a
/// caller that needs an event must subscribe **before** triggering it.
pub fn subscribe() -> broadcast::Receiver<String> {
    signal_sender().subscribe()
}

/// Forwards every signal to the frontend through `emit`.
///
/// Called once at startup. Tauri events are used rather than a WebSocket: the
/// backend no longer has an address the webview could connect to.
pub fn set_app_emitter(emit: impl Fn(&str) + Send + Sync + 'static) {
    let mut rx = subscribe();
    let emit = std::sync::Arc::new(emit);
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(raw) => emit(&raw),
                // A slow consumer missed signals; the next one still arrives.
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(skipped = n, "signal consumer lagged");
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// The callback status-go invokes from its own goroutines.
///
/// It must not call back into status-go or block: the body only copies the JSON
/// into the broadcast channel.
unsafe extern "C" fn on_signal(payload: *mut std::ffi::c_void) {
    if payload.is_null() {
        return;
    }
    // SAFETY: status-go passes a NUL-terminated JSON string and keeps it alive
    // for the duration of the call.
    let raw = unsafe { CStr::from_ptr(payload as *mut c_char) }
        .to_string_lossy()
        .into_owned();
    // Send fails only when nobody is subscribed, which is not an error.
    let _ = signal_sender().send(raw);
}

/// File name of the library for the current platform.
fn library_file_name() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        "libstatus.so"
    }
    #[cfg(target_os = "android")]
    {
        "libstatus.so"
    }
    #[cfg(target_os = "macos")]
    {
        "libstatus.dylib"
    }
    #[cfg(target_os = "windows")]
    {
        "libstatus.dll"
    }
    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "windows"
    )))]
    {
        "libstatus.so"
    }
}

/// Where the library is loaded from.
///
/// * `STAURI_LIBSTATUS` — explicit path, used by the release smoke test and by
///   development against a library built outside the project.
/// * Android — the bare file name: the loader searches `jniLibs` itself.
/// * Desktop — next to the executable, which is `usr/bin` inside the AppImage
///   and the target directory during development.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Internal`] when the executable path cannot
/// be determined.
pub fn library_path() -> AppResult<PathBuf> {
    if let Some(path) = std::env::var_os("STAURI_LIBSTATUS") {
        return Ok(PathBuf::from(path));
    }
    #[cfg(target_os = "android")]
    {
        Ok(PathBuf::from(library_file_name()))
    }
    #[cfg(not(target_os = "android"))]
    {
        let exe = std::env::current_exe()
            .map_err(|e| AppError::internal(format!("cannot locate executable: {e}")))?;
        let dir = exe
            .parent()
            .ok_or_else(|| AppError::internal("executable has no parent directory"))?;
        Ok(dir.join(library_file_name()))
    }
}

impl InProcessBackend {
    /// Loads the library and binds the exported functions.
    ///
    /// # Errors
    /// Returns [`crate::error::ErrorKind::Internal`] when the library cannot be
    /// loaded or any required symbol is missing.
    fn load() -> AppResult<Self> {
        let path = library_path()?;
        // SAFETY: loading a trusted library built from our own status-go tree.
        let lib = unsafe { Library::new(&path) }.map_err(|e| {
            AppError::internal(format!("cannot load {}: {e}", path.display()))
        })?;

        // SAFETY: names and signatures come from mobile/status.go.
        unsafe {
            let call_rpc: Symbol<CStrFn> = lib
                .get(b"CallRPC\0")
                .map_err(|e| AppError::internal(format!("no CallRPC: {e}")))?;
            let initialize: Symbol<CStrFn> = lib
                .get(b"InitializeApplication\0")
                .map_err(|e| AppError::internal(format!("no InitializeApplication: {e}")))?;
            let login: Symbol<CStrFn> = lib
                .get(b"LoginAccount\0")
                .map_err(|e| AppError::internal(format!("no LoginAccount: {e}")))?;
            let create_and_login: Symbol<CStrFn> = lib
                .get(b"CreateAccountAndLogin\0")
                .map_err(|e| AppError::internal(format!("no CreateAccountAndLogin: {e}")))?;
            let logout: Symbol<unsafe extern "C" fn() -> *mut c_char> = lib
                .get(b"Logout\0")
                .map_err(|e| AppError::internal(format!("no Logout: {e}")))?;
            // Older status-go builds do not export the callback; the application
            // then falls back to polling, so a missing symbol is not fatal.
            let set_signal_callback = lib
                .get::<SetSignalFn>(b"SetSignalEventCallback\0")
                .ok()
                .map(|s| *s);

            // The library must outlive the symbols, so it is taken last. Copying
            // the function pointers out first ends the borrow of `lib`, which
            // otherwise blocks moving it into the struct.
            let call_rpc = *call_rpc;
            let initialize = *initialize;
            let login = *login;
            let create_and_login = *create_and_login;
            let logout = *logout;

            Ok(Self {
                _lib: lib,
                call_rpc,
                initialize,
                login,
                create_and_login,
                logout,
                set_signal_callback,
            })
        }
    }

    /// Registers the signal callback with status-go.
    ///
    /// Idempotent: status-go keeps one callback, and registering twice replaces
    /// it, so calling this from `start_backend` on every reconnect is safe.
    pub fn register_signals(&self) {
        let Some(set_cb) = self.set_signal_callback else {
            tracing::warn!("status-go does not export SetSignalEventCallback; signals disabled");
            return;
        };
        // `void* cb` in the header: a function pointer cast to a raw pointer.
        let cb = on_signal as *const () as *mut std::ffi::c_void;
        // SAFETY: the export takes the address of a C function and only calls it.
        unsafe { set_cb(cb) };
    }

    /// Calls a C function with a JSON string and returns its string reply.
    ///
    /// Go (cgo) allocates the reply, so it is released with libc `free`. The
    /// input belongs to us: the pointer is handed over and taken back to free the
    /// string.
    ///
    /// # Errors
    /// Returns [`crate::error::ErrorKind::Internal`] when the request contains a
    /// NUL byte, and [`crate::error::ErrorKind::Backend`] when status-go returns
    /// a null pointer.
    fn invoke(&self, f: CStrFn, json: &str) -> AppResult<String> {
        let input = CString::new(json)
            .map_err(|_| AppError::internal("request contains a NUL byte"))?;
        let raw = input.into_raw();
        // SAFETY: raw is our C string until the call returns.
        let out = unsafe { f(raw) };
        // SAFETY: raw is handed back to `CString` and released exactly once.
        drop(unsafe { CString::from_raw(raw) });
        if out.is_null() {
            return Err(AppError::backend("status-go returned no response"));
        }
        // SAFETY: out is a C string returned by status-go.
        let text = unsafe { CStr::from_ptr(out) }.to_string_lossy().into_owned();
        // SAFETY: out is no longer used after the copy.
        unsafe { free(out as *mut std::ffi::c_void) };
        Ok(text)
    }

    /// Application initialisation (`InitializeApplication`), once at startup.
    pub fn initialize(&self, request_json: &str) -> AppResult<String> {
        self.invoke(self.initialize, request_json)
    }

    /// Logs out of status-go (`Logout`), ending the node's session.
    ///
    /// The node itself is not unloaded: status-go cannot be shut down and
    /// reloaded inside a process, so a logout followed by a login is how the
    /// session restarts.
    ///
    /// # Errors
    /// Returns [`crate::error::ErrorKind::Backend`] when status-go returns
    /// nothing.
    pub fn logout(&self) -> AppResult<String> {
        // SAFETY: Logout takes no arguments and returns a C string from Go.
        let out = unsafe { (self.logout)() };
        if out.is_null() {
            return Err(AppError::backend("status-go returned no response"));
        }
        // SAFETY: out is a C string from status-go; copy it, then release it.
        let text = unsafe { CStr::from_ptr(out) }.to_string_lossy().into_owned();
        unsafe { free(out as *mut std::ffi::c_void) };
        Ok(text)
    }

    /// Calls a status-go endpoint by name, the equivalent of an HTTP endpoint on
    /// the old server build.
    ///
    /// `Logout` takes no arguments; every other endpoint takes one JSON string.
    ///
    /// # Errors
    /// Returns [`crate::error::ErrorKind::Internal`] for an unsupported endpoint
    /// name, and propagates the errors of the underlying call.
    pub fn direct(&self, endpoint: &str, body_json: &str) -> AppResult<String> {
        match endpoint {
            "InitializeApplication" => self.invoke(self.initialize, body_json),
            "LoginAccount" => self.invoke(self.login, body_json),
            "CreateAccountAndLogin" => self.invoke(self.create_and_login, body_json),
            "Logout" => self.logout(),
            "CallRPC" => self.invoke(self.call_rpc, body_json),
            other => Err(AppError::internal(format!(
                "unsupported in-process endpoint: {other}"
            ))),
        }
    }

    /// JSON-RPC call (`CallRPC`). The reply is parsed and backend errors are
    /// raised.
    ///
    /// Blocks the calling thread for the duration of the call, so async callers
    /// must go through [`call_rpc`], which moves it to a blocking thread.
    ///
    /// # Errors
    /// Returns [`crate::error::ErrorKind::Backend`] when the reply is not valid
    /// JSON or carries a JSON-RPC error, and propagates the errors of
    /// [`Self::invoke`].
    pub fn call_rpc_blocking(&self, method: &str, params: Value) -> AppResult<Value> {
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let text = self.invoke(self.call_rpc, &request.to_string())?;
        let envelope: Value = serde_json::from_str(&text)
            .map_err(|e| AppError::backend(format!("invalid JSON from backend: {e}")))?;
        if let Some(err) = envelope.get("error") {
            return Err(AppError::backend(describe_rpc_error(err)));
        }
        Ok(envelope.get("result").cloned().unwrap_or(Value::Null))
    }
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

/// One instance per process: the library is loaded on first use.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Internal`] when the library or one of its
/// symbols cannot be loaded.
pub fn backend() -> AppResult<&'static InProcessBackend> {
    BACKEND
        .get_or_init(InProcessBackend::load)
        .as_ref()
        .map_err(|e| AppError::internal(format!("{e}")))
}

/// JSON-RPC call from async code.
///
/// The C call blocks, so it runs on a blocking thread: the node can take seconds
/// (routing, signing) and must not stall the async runtime.
///
/// # Errors
/// Propagates the errors of [`InProcessBackend::call_rpc_blocking`] and
/// [`crate::error::ErrorKind::Internal`] when the blocking task cannot be joined.
pub async fn call_rpc(method: &str, params: Value) -> AppResult<Value> {
    let backend = backend()?;
    let method = method.to_string();
    tokio::task::spawn_blocking(move || backend.call_rpc_blocking(&method, params))
        .await
        .map_err(|e| AppError::internal(format!("backend call panicked: {e}")))?
}
