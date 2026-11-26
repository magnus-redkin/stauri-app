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

use crate::core::error::{AppError, AppResult};

/// Signatures from `mobile/status.go`: one string in, one string out.
type CStrFn = unsafe extern "C" fn(*mut c_char) -> *mut c_char;
/// Two strings in, one string out.
///
/// The local-pairing clients take a connection string *and* a config
/// (`InputConnectionStringForBootstrapping(cs, configJSON string) string`), so
/// they need their own signature rather than {@link CStrFn}.
type CStr2Fn = unsafe extern "C" fn(*mut c_char, *mut c_char) -> *mut c_char;
/// `void SetSignalEventCallback(void* cb)`: the argument is a C function pointer.
type SetSignalFn = unsafe extern "C" fn(*mut std::ffi::c_void);

// libc `free`. A string allocated by cgo is released by the caller, because
// `libstatus.h` exports no dedicated release function.
//
// On Windows the matching allocator is not Rust's: see [`release`].
#[cfg(not(target_os = "windows"))]
unsafe extern "C" {
    fn free(ptr: *mut std::ffi::c_void);
}

/// Releases a C string returned by status-go.
///
/// # Remarks
/// The string is allocated by the engine, and the host must free it in the same C
/// runtime. On Linux and Android both sides use the system libc, so plain `free`
/// is right. On Windows it is not: status-go is built with the mingw toolchain and
/// allocates through `msvcrt.dll`, while Rust under MSVC links against `ucrtbase`.
/// Freeing a `msvcrt` block with `ucrtbase`'s `free` corrupts the heap — the
/// process dies inside `RtlValidateHeap` right after the first reply — so the
/// Windows path takes `free` from `msvcrt.dll` itself.
///
/// # Safety
/// `ptr` must be a string returned by this engine and must not be used afterwards.
#[cfg(not(target_os = "windows"))]
fn release(ptr: *mut c_char) {
    // SAFETY: allocated by the same libc as `free`.
    unsafe { free(ptr as *mut std::ffi::c_void) };
}

/// Releases a C string returned by status-go; see the other [`release`].
///
/// # Safety
/// `ptr` must be a string returned by this engine and must not be used afterwards.
#[cfg(target_os = "windows")]
fn release(ptr: *mut c_char) {
    type FreeFn = unsafe extern "C" fn(*mut std::ffi::c_void);
    static MSVCRT_FREE: OnceLock<Option<FreeFn>> = OnceLock::new();

    let free = MSVCRT_FREE.get_or_init(|| {
        // SAFETY: `msvcrt.dll` is a system module and `free` has the C signature.
        unsafe {
            let lib = match Library::new("msvcrt.dll") {
                Ok(lib) => lib,
                Err(e) => {
                    tracing::warn!("msvcrt.dll not usable: {e}");
                    return None;
                }
            };
            let symbol: Symbol<FreeFn> = match lib.get(b"free\0") {
                Ok(symbol) => symbol,
                Err(e) => {
                    tracing::warn!("msvcrt.dll exports no free: {e}");
                    return None;
                }
            };
            let entry = *symbol;
            // The module must stay loaded while its `free` is callable.
            Box::leak(Box::new(lib));
            Some(entry)
        }
    });

    match free {
        // SAFETY: the block was allocated by this very allocator.
        Some(entry) => unsafe { entry(ptr as *mut std::ffi::c_void) },
        // Leaking one reply is survivable; freeing it into the wrong heap is not.
        None => tracing::warn!("status-go reply not released: no msvcrt free"),
    }
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
    restore_and_login: CStrFn,
    /// Re-wraps the profile's encryption key with a new password.
    ///
    /// A direct export rather than an RPC method: `ChangeDatabasePasswordV2` is not
    /// part of any RPC namespace, so it is called like `LoginAccount`.
    ///
    /// `None` on a build that does not export it; the caller then reports that the
    /// password cannot be changed instead of failing to load the library at all.
    change_password: Option<CStrFn>,
    /// Derives the profile key uid from a seed phrase.
    ///
    /// The restore screen needs it to tell "first time on this device" from "this
    /// profile is already here": the same phrase always yields the same key uid, so a
    /// match means the profile exists and the way in is a login, not a restore.
    validate_mnemonic: Option<CStrFn>,
    /// Removes a profile from this device: its database, keystore and wrapped key.
    delete_multiaccount: Option<CStrFn>,
    /// Local pairing, sending side: starts a server that hands the profile out.
    ///
    /// The device must be logged in — the keys are what it is sending. The call
    /// returns a connection string for the other device to read.
    connection_string_sender: Option<CStrFn>,
    /// Local pairing, receiving side: starts a server that takes a profile in.
    ///
    /// Used by a device that is logged out or has no profile yet. Also returns a
    /// connection string.
    connection_string_receiver: Option<CStrFn>,
    /// Local pairing, receiving side as a client: consumes a connection string.
    ///
    /// The device is logged out; the profile arrives from the other device and is
    /// stored here.
    bootstrap_receiver: Option<CStr2Fn>,
    /// Local pairing, sending side as a client: consumes a connection string.
    ///
    /// The device is logged in and pushes its profile to the other one.
    bootstrap_sender: Option<CStr2Fn>,
    /// Checks a connection string without starting anything.
    ///
    /// The screens call it before a scan or a paste is accepted, so a mistyped
    /// string is reported as such instead of failing halfway through a transfer.
    validate_connection_string: Option<CStrFn>,
    /// Closes the multiaccounts database so the next `InitializeApplication` opens
    /// the directory it is given.
    ///
    /// Added by the Stauri patch (`src-tauri/status-go/`). Without it a host that
    /// changes its data directory keeps reading the first directory's profiles,
    /// because `OpenAccounts` opens the database once and returns early afterwards.
    /// `None` on an unpatched library; callers report that switching needs a
    /// restart instead of pretending it worked.
    close_accounts: Option<unsafe extern "C" fn() -> *mut c_char>,
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
/// Returns [`crate::core::error::ErrorKind::Internal`] when the executable path cannot
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
    /// Returns [`crate::core::error::ErrorKind::Internal`] when the library cannot be
    /// loaded or any required symbol is missing.
    fn load() -> AppResult<Self> {
        let path = library_path()?;
        // SAFETY: loading a trusted library built from our own status-go tree.
        let lib = unsafe { Library::new(&path) }
            .map_err(|e| AppError::internal(format!("cannot load {}: {e}", path.display())))?;

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
            let restore_and_login: Symbol<CStrFn> = lib
                .get(b"RestoreAccountAndLogin\0")
                .map_err(|e| AppError::internal(format!("no RestoreAccountAndLogin: {e}")))?;
            // Optional: only builds that ship the DEK encryption scheme export it, and
            // the profile screen keeps the password field hidden when it is missing
            // rather than failing at the moment the user presses the button.
            let change_password = lib
                .get::<CStrFn>(b"ChangeDatabasePasswordV2\0")
                .ok()
                .map(|s| *s);
            // Both are optional for the same reason: a library built without the
            // profile-management exports still runs, it just cannot offer the
            // "open an existing profile from its phrase" path.
            let validate_mnemonic = lib.get::<CStrFn>(b"ValidateMnemonicV2\0").ok().map(|s| *s);
            let delete_multiaccount = lib.get::<CStrFn>(b"DeleteMultiaccount\0").ok().map(|s| *s);
            // Local pairing is optional as a group: a library built without it still
            // runs every other flow, and the screens hide the sync option rather than
            // offering a button that cannot work.
            let connection_string_sender = lib
                .get::<CStrFn>(b"GetConnectionStringForBootstrappingAnotherDevice\0")
                .ok()
                .map(|s| *s);
            let connection_string_receiver = lib
                .get::<CStrFn>(b"GetConnectionStringForBeingBootstrapped\0")
                .ok()
                .map(|s| *s);
            let bootstrap_receiver = lib
                .get::<CStr2Fn>(b"InputConnectionStringForBootstrapping\0")
                .ok()
                .map(|s| *s);
            let bootstrap_sender = lib
                .get::<CStr2Fn>(b"InputConnectionStringForBootstrappingAnotherDevice\0")
                .ok()
                .map(|s| *s);
            let validate_connection_string = lib
                .get::<CStrFn>(b"ValidateConnectionString\0")
                .ok()
                .map(|s| *s);
            // Added by the Stauri patch, so it is optional: an unpatched library loads
            // and runs every other flow, and only a network switch reports that it needs
            // a rebuild.
            let close_accounts = lib
                .get::<unsafe extern "C" fn() -> *mut c_char>(b"CloseAccounts\0")
                .ok()
                .map(|s| *s);
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
            let restore_and_login = *restore_and_login;
            // `change_password` is already an owned `Option<CStrFn>`, so it needs no copy.
            let logout = *logout;

            Ok(Self {
                _lib: lib,
                call_rpc,
                initialize,
                login,
                create_and_login,
                restore_and_login,
                change_password,
                validate_mnemonic,
                delete_multiaccount,
                connection_string_sender,
                connection_string_receiver,
                bootstrap_receiver,
                bootstrap_sender,
                validate_connection_string,
                close_accounts,
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
    /// Returns [`crate::core::error::ErrorKind::Internal`] when the request contains a
    /// NUL byte, and [`crate::core::error::ErrorKind::Backend`] when status-go returns
    /// a null pointer.
    fn invoke(&self, f: CStrFn, json: &str) -> AppResult<String> {
        let input =
            CString::new(json).map_err(|_| AppError::internal("request contains a NUL byte"))?;
        let raw = input.into_raw();
        // SAFETY: raw is our C string until the call returns.
        let out = unsafe { f(raw) };
        // SAFETY: raw is handed back to `CString` and released exactly once.
        drop(unsafe { CString::from_raw(raw) });
        if out.is_null() {
            return Err(AppError::backend("status-go returned no response"));
        }
        // SAFETY: out is a C string returned by status-go.
        let text = unsafe { CStr::from_ptr(out) }
            .to_string_lossy()
            .into_owned();
        // SAFETY: out is no longer used after the copy.
        release(out);
        Ok(text)
    }

    /// Calls a two-string C function and returns its string reply.
    ///
    /// Same ownership rules as [`Self::invoke`]: both inputs are ours until the
    /// call returns, the reply belongs to Go and is released here.
    ///
    /// # Errors
    /// Returns [`crate::core::error::ErrorKind::Internal`] when either argument contains
    /// a NUL byte, and [`crate::core::error::ErrorKind::Backend`] when status-go returns
    /// a null pointer.
    fn invoke2(&self, f: CStr2Fn, first: &str, second: &str) -> AppResult<String> {
        let a = CString::new(first)
            .map_err(|_| AppError::internal("first argument contains a NUL byte"))?;
        let b = CString::new(second)
            .map_err(|_| AppError::internal("second argument contains a NUL byte"))?;
        let (ra, rb) = (a.into_raw(), b.into_raw());
        // SAFETY: both pointers are our C strings until the call returns.
        let out = unsafe { f(ra, rb) };
        // SAFETY: each pointer is handed back to `CString` and released exactly once.
        drop(unsafe { CString::from_raw(ra) });
        drop(unsafe { CString::from_raw(rb) });
        if out.is_null() {
            return Err(AppError::backend("status-go returned no response"));
        }
        // SAFETY: out is a C string returned by status-go.
        let text = unsafe { CStr::from_ptr(out) }
            .to_string_lossy()
            .into_owned();
        // SAFETY: out is no longer used after the copy.
        release(out);
        Ok(text)
    }

    /// Whether this build exports the local-pairing functions.
    ///
    /// @returns `true` when both directions are available; the screens use it to
    /// hide the sync option instead of offering a button that cannot work.
    pub fn supports_pairing(&self) -> bool {
        self.connection_string_sender.is_some()
            && self.connection_string_receiver.is_some()
            && self.bootstrap_receiver.is_some()
            && self.bootstrap_sender.is_some()
    }

    /// Starts a pairing server that sends this device's profile.
    ///
    /// @param config_json - `SenderServerConfig` (keystore path, device type, key
    ///   uid, password).
    /// @returns The connection string the other device has to read.
    ///
    /// # Errors
    /// Returns [`crate::core::error::ErrorKind::Internal`] when the build does not export
    /// pairing, and propagates status-go's error.
    pub fn pairing_start_sender(&self, config_json: &str) -> AppResult<String> {
        let f = self.connection_string_sender.ok_or_else(|| {
            AppError::internal(
                "status-go does not export GetConnectionStringForBootstrappingAnotherDevice",
            )
        })?;
        self.invoke(f, config_json)
    }

    /// Starts a pairing server that receives a profile onto this device.
    ///
    /// @param config_json - `ReceiverServerConfig` (root data dir, KDF iterations).
    /// @returns The connection string the other device has to read.
    ///
    /// # Errors
    /// Returns [`crate::core::error::ErrorKind::Internal`] when the build does not export
    /// pairing, and propagates status-go's error.
    pub fn pairing_start_receiver(&self, config_json: &str) -> AppResult<String> {
        let f = self.connection_string_receiver.ok_or_else(|| {
            AppError::internal("status-go does not export GetConnectionStringForBeingBootstrapped")
        })?;
        self.invoke(f, config_json)
    }

    /// Consumes a connection string as the receiving side.
    ///
    /// @param connection_string - String read from the other device.
    /// @param config_json - `ReceiverClientConfig`.
    /// @returns status-go's JSON reply.
    ///
    /// # Errors
    /// Returns [`crate::core::error::ErrorKind::Internal`] when the build does not export
    /// pairing, and propagates status-go's error.
    pub fn pairing_bootstrap_receiver(
        &self,
        connection_string: &str,
        config_json: &str,
    ) -> AppResult<String> {
        let f = self.bootstrap_receiver.ok_or_else(|| {
            AppError::internal("status-go does not export InputConnectionStringForBootstrapping")
        })?;
        self.invoke2(f, connection_string, config_json)
    }

    /// Consumes a connection string as the sending side.
    ///
    /// @param connection_string - String read from the other device.
    /// @param config_json - `SenderClientConfig`.
    /// @returns status-go's JSON reply.
    ///
    /// # Errors
    /// Returns [`crate::core::error::ErrorKind::Internal`] when the build does not export
    /// pairing, and propagates status-go's error.
    pub fn pairing_bootstrap_sender(
        &self,
        connection_string: &str,
        config_json: &str,
    ) -> AppResult<String> {
        let f = self.bootstrap_sender.ok_or_else(|| {
            AppError::internal(
                "status-go does not export InputConnectionStringForBootstrappingAnotherDevice",
            )
        })?;
        self.invoke2(f, connection_string, config_json)
    }

    /// Checks a connection string without starting a transfer.
    ///
    /// @param connection_string - String to check.
    /// @returns An empty string when valid, status-go's reason otherwise.
    ///
    /// # Errors
    /// Returns [`crate::core::error::ErrorKind::Internal`] when the build does not export
    /// validation.
    pub fn pairing_validate(&self, connection_string: &str) -> AppResult<String> {
        let f = self.validate_connection_string.ok_or_else(|| {
            AppError::internal("status-go does not export ValidateConnectionString")
        })?;
        self.invoke(f, connection_string)
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
    /// Returns [`crate::core::error::ErrorKind::Backend`] when status-go returns
    /// nothing.
    pub fn logout(&self) -> AppResult<String> {
        // SAFETY: Logout takes no arguments and returns a C string from Go.
        let out = unsafe { (self.logout)() };
        owned_reply(out)
    }

    /// Whether this library can reopen its account database.
    ///
    /// @returns `true` when the Stauri patch is present; callers use it to offer the
    /// in-place network switch and to explain its absence on an unpatched build.
    pub fn supports_account_reopen(&self) -> bool {
        self.close_accounts.is_some()
    }

    /// Closes the account database, so the next `InitializeApplication` opens the
    /// directory it is given (`CloseAccounts`, added by the Stauri patch).
    ///
    /// # Errors
    /// Returns [`crate::core::error::ErrorKind::Internal`] when the library does not
    /// export it, and [`crate::core::error::ErrorKind::Backend`] when status-go
    /// refuses.
    ///
    /// @remarks
    /// The database is the unencrypted `accounts.sql` holding profile metadata; no key
    /// material passes through it. The keystore itself is only re-rooted by
    /// `UpdateRootDataDir`, which `InitializeApplication` performs.
    pub fn close_accounts(&self) -> AppResult<()> {
        let f = self.close_accounts.ok_or_else(|| {
            AppError::internal(
                "this libstatus does not export CloseAccounts; rebuild it from src-tauri/status-go \
                 to switch networks without restarting",
            )
        })?;
        // SAFETY: the export takes no arguments and returns a C string from Go.
        let out = unsafe { f() };
        owned_reply(out)?;
        Ok(())
    }

    /// Calls a status-go endpoint by name, the equivalent of an HTTP endpoint on
    /// the old server build.
    ///
    /// `Logout` takes no arguments; every other endpoint takes one JSON string.
    ///
    /// # Errors
    /// Returns [`crate::core::error::ErrorKind::Internal`] for an unsupported endpoint
    /// name, and propagates the errors of the underlying call.
    pub fn direct(&self, endpoint: &str, body_json: &str) -> AppResult<String> {
        match endpoint {
            "InitializeApplication" => self.invoke(self.initialize, body_json),
            "LoginAccount" => self.invoke(self.login, body_json),
            "CreateAccountAndLogin" => self.invoke(self.create_and_login, body_json),
            "RestoreAccountAndLogin" => self.invoke(self.restore_and_login, body_json),
            "ChangeDatabasePasswordV2" => {
                let f = self.change_password.ok_or_else(|| {
                    AppError::internal("status-go does not export ChangeDatabasePasswordV2")
                })?;
                self.invoke(f, body_json)
            }
            "ValidateMnemonicV2" => {
                let f = self.validate_mnemonic.ok_or_else(|| {
                    AppError::internal("status-go does not export ValidateMnemonicV2")
                })?;
                self.invoke(f, body_json)
            }
            "DeleteMultiaccount" => {
                let f = self.delete_multiaccount.ok_or_else(|| {
                    AppError::internal("status-go does not export DeleteMultiaccount")
                })?;
                self.invoke(f, body_json)
            }
            "Logout" => self.logout(),
            "CloseAccounts" => {
                self.close_accounts()?;
                Ok("{}".to_string())
            }
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
    /// Returns [`crate::core::error::ErrorKind::Backend`] when the reply is not valid
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

/// Copies a reply allocated by Go and releases it.
///
/// Go (cgo) allocates the returned string; the caller owns it and releases it with
/// libc `free`, because `libstatus.h` exports no dedicated release function.
///
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Backend`] when status-go returned a null
/// pointer.
fn owned_reply(out: *mut c_char) -> AppResult<String> {
    if out.is_null() {
        return Err(AppError::backend("status-go returned no response"));
    }
    // SAFETY: out is a C string returned by status-go.
    let text = unsafe { CStr::from_ptr(out) }
        .to_string_lossy()
        .into_owned();
    // SAFETY: out is no longer used after the copy.
    release(out);
    Ok(text)
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
/// Returns [`crate::core::error::ErrorKind::Internal`] when the library or one of its
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
/// [`crate::core::error::ErrorKind::Internal`] when the blocking task cannot be joined.
pub async fn call_rpc(method: &str, params: Value) -> AppResult<Value> {
    let backend = backend()?;
    let method = method.to_string();
    tokio::task::spawn_blocking(move || backend.call_rpc_blocking(&method, params))
        .await
        .map_err(|e| AppError::internal(format!("backend call panicked: {e}")))?
}
