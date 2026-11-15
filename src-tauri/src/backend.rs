//! Single access point to status-go.
//!
//! On desktop the backend is a separate process (sidecar) reached over a local
//! port through the authenticating proxy. On Android it becomes a library
//! inside the application (`libstatus.so`) and there is no port at all.
//!
//! The module separates "how to call status-go" from "what to call". Wallet and
//! ENS code depends on `Backend`, not on a port or a socket, so moving to
//! Android replaces the implementation of one variant rather than the code in
//! `ens.rs`, `swap.rs`, `transfer.rs` and `router.rs`.

use serde_json::Value;

use crate::backend_rpc;
use crate::error::{AppError, AppResult};

/// How the application talks to status-go.
///
/// `InProcess` is a placeholder for Android. It is not implemented yet and every
/// call through it returns an error; desktop never constructs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// A separate process reached over a local port (through the proxy).
    Rpc { port: u16 },
    /// A library inside the application process (JNI/FFI); Android only.
    /// Nothing constructs it yet — it exists for the Android build.
    #[allow(dead_code)]
    InProcess,
}

impl Backend {
    /// Builds a `Backend` from the port reported by the frontend.
    ///
    /// Port `0` means "backend is not running": such a call is rejected up front
    /// instead of being sent to `127.0.0.1:0`.
    ///
    /// # Errors
    /// Returns [`crate::error::ErrorKind::Backend`] when the port is `0`.
    pub fn from_port(port: u16) -> AppResult<Self> {
        if port == 0 {
            return Err(AppError::backend("backend is not running"));
        }
        Ok(Backend::Rpc { port })
    }

    /// Makes a JSON-RPC call to `method` with `params`.
    ///
    /// # Errors
    /// Returns [`crate::error::ErrorKind::Backend`] when the backend is
    /// unreachable, answers with an HTTP error or reports a JSON-RPC error. On
    /// desktop an `InProcess` call also fails this way.
    pub async fn call(&self, method: &str, params: Value) -> AppResult<Value> {
        match self {
            Backend::Rpc { port } => backend_rpc::call(*port, method, params).await,
     #[cfg(target_os = "android")]
            Backend::InProcess => crate::inprocess::backend()?.call_rpc(method, params),
     #[cfg(not(target_os = "android"))]
            Backend::InProcess => Err(AppError::backend(
         "in-process backend is only available on Android",
     )),
        }
    }

    /// Port for a WebSocket signal subscription, when the backend is reachable
    /// over the network.
    ///
    /// `InProcess` has no socket-level signals: they arrive as callbacks and the
    /// consumer has to subscribe differently, so this returns `None` rather than
    /// a port.
    pub fn signals_port(&self) -> Option<u16> {
        match self {
            Backend::Rpc { port } => Some(*port),
            Backend::InProcess => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_port_is_rejected() {
        assert!(Backend::from_port(0).is_err());
    }

    #[test]
    fn nonzero_port_builds_rpc_backend() {
        assert_eq!(
            Backend::from_port(8545).unwrap(),
            Backend::Rpc { port: 8545 }
        );
    }

    #[test]
    fn rpc_backend_exposes_its_port_for_signals() {
        assert_eq!(Backend::Rpc { port: 9000 }.signals_port(), Some(9000));
    }

    #[test]
    fn in_process_backend_has_no_signal_port() {
        assert_eq!(Backend::InProcess.signals_port(), None);
    }
}
