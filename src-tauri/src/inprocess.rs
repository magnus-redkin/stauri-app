//! Android: status-go as the `libstatus.so` library inside the application
//! process.
//!
//! Desktop runs the backend as a separate process (sidecar); Android cannot.
//! Here the library is loaded with `dlopen` and its C functions are called
//! directly.
//!
//! Android only. All status-go traffic goes through
//! [`InProcessBackend::call_rpc`]. Errors come back as a JSON string, matching
//! `mobile/status.go`, where `CallRPC` returns a JSON string.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::sync::OnceLock;

use libloading::{Library, Symbol};
use serde_json::Value;

use crate::error::{AppError, AppResult};

/// Signatures from `mobile/status.go`: one string in, one string out.
type CStrFn = unsafe extern "C" fn(*mut c_char) -> *mut c_char;

// libc `free`. A string allocated by cgo is released by the caller, because
// `libstatus.h` exports no dedicated release function.
unsafe extern "C" {
    fn free(ptr: *mut std::ffi::c_void);
}

/// A loaded `libstatus.so` together with its functions.
///
/// `Library` is kept in the struct: the symbols stay valid only while it lives.
pub struct InProcessBackend {
    _lib: Library,
    call_rpc: CStrFn,
    initialize: CStrFn,
    login: CStrFn,
    call_rpc_raw: CStrFn,
    create_and_login: CStrFn,
    logout: unsafe extern "C" fn() -> *mut c_char,
}

// Function pointers and `Library` are thread-safe: status-go serialises calls
// internally.
unsafe impl Send for InProcessBackend {}
unsafe impl Sync for InProcessBackend {}

static BACKEND: OnceLock<AppResult<InProcessBackend>> = OnceLock::new();

impl InProcessBackend {
    /// Loads `libstatus.so` from the application's native libraries.
    ///
    /// Android installs the library into `jniLibs/arm64-v8a`, so the bare name
    /// is enough: the loader finds it among the application paths.
    ///
    /// # Errors
    /// Returns [`crate::error::ErrorKind::Internal`] when the library cannot be
    /// loaded or any of the expected symbols is missing.
    fn load() -> AppResult<Self> {
        // SAFETY: loading a trusted library built from our own tree
        // (build/bin/libstatus.so from status-go).
        let lib = unsafe { Library::new("libstatus.so") }
            .map_err(|e| AppError::internal(format!("cannot load libstatus.so: {e}")))?;

        // SAFETY: names and signatures come from mobile/status.go.
 unsafe {
     let call_rpc: Symbol<CStrFn> = lib
         .get(b"CallRPC\0")
  .map_err(|e| AppError::internal(format!("no CallRPC: {e}")))?;
     let initialize: Symbol<CStrFn> = lib
  .get(b"InitializeApplication\0")
         .map_err(|e| AppError::internal(format!("no InitializeApplication: {e}")))?;
            let call_rpc_raw: Symbol<CStrFn> = lib
         .get(b"CallRPC\0")
         .map_err(|e| AppError::internal(format!("no CallRPC raw: {e}")))?;
        let login: Symbol<CStrFn> = lib
         .get(b"LoginAccount\0")
  .map_err(|e| AppError::internal(format!("no LoginAccount: {e}")))?;

     let create_and_login: Symbol<CStrFn> = lib
         .get(b"CreateAccountAndLogin\0")
         .map_err(|e| AppError::internal(format!("no CreateAccountAndLogin: {e}")))?;
     let logout: Symbol<unsafe extern "C" fn() -> *mut c_char> = lib
  .get(b"Logout\0")
         .map_err(|e| AppError::internal(format!("no Logout: {e}")))?;
     Ok(Self {
         call_rpc: *call_rpc,
  initialize: *initialize,
  login: *login,
  call_rpc_raw: *call_rpc_raw,
  create_and_login: *create_and_login,
  logout: *logout,
         _lib: lib,
     })
        }
    }

    /// Calls a C function with a JSON string and returns its string reply.
    ///
    /// Go (cgo) allocates the reply, so it is released with libc `free`. The
    /// input belongs to us: the pointer is handed over and taken back to free
    /// the string.
    ///
    /// # Errors
    /// Returns [`crate::error::ErrorKind::Internal`] when the request contains a
    /// NUL byte, and [`crate::error::ErrorKind::Backend`] when status-go
    /// returns a null pointer.
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

    /// Signs in to an account (`LoginAccount`).
    pub fn login(&self, request_json: &str) -> AppResult<String> {
        self.invoke(self.login, request_json)
    }

    /// Calls a status-go endpoint by name, the equivalent of
    /// `statusFetch(port, endpoint, body)` on desktop.
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
     "Logout" => {
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
     "CallRPC" => self.invoke(self.call_rpc_raw, body_json),
     other => Err(AppError::internal(format!("unsupported in-process endpoint: {other}"))),
        }
    }

    /// JSON-RPC call (`CallRPC`). The reply is parsed and backend errors are
    /// raised.
    ///
    /// # Errors
    /// Returns [`crate::error::ErrorKind::Backend`] when the reply is not valid
    /// JSON or carries a JSON-RPC error, and propagates the errors of
    /// [`Self::invoke`].
    pub fn call_rpc(&self, method: &str, params: Value) -> AppResult<Value> {
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
            return Err(AppError::backend(crate::backend_rpc::describe_rpc_error(err)));
 }
        Ok(envelope.get("result").cloned().unwrap_or(Value::Null))
    }
}

/// One instance per process: `libstatus.so` is loaded on first use.
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
