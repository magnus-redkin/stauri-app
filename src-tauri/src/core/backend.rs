//! Single access point to status-go.
//!
//! status-go runs as a library inside the application process on every platform
//! (`libstatus.so`/`.dylib`/`.dll`), so there is no port to pass around and no
//! transport to choose between. [`Backend`] exists for the naming, not for
//! polymorphism: wallet and ENS code says `Backend` and never touches the
//! library directly.
//!
//! Signals do not come from a socket either; see [`crate::core::inprocess::subscribe`].

use serde_json::Value;

use crate::core::error::AppResult;
use crate::core::inprocess;

/// status-go, reached through the library loaded into this process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backend;

impl Backend {
    /// Returns the backend handle.
    ///
    /// Loading is neither attempted nor required here: a call fails with a clear
    /// error if the library is missing, and `start_backend` reports that at
    /// startup, where the user can act on it.
    pub fn new() -> Self {
        Self
    }

    /// Makes a JSON-RPC call to `method` with `params`.
    ///
    /// # Errors
    /// Returns [`crate::core::error::ErrorKind::Backend`] when status-go reports a
    /// JSON-RPC error or returns nothing, and
    /// [`crate::core::error::ErrorKind::Internal`] when the library cannot be loaded.
    pub async fn call(&self, method: &str, params: Value) -> AppResult<Value> {
        inprocess::call_rpc(method, params).await
    }

    /// Subscribes to status-go signals.
    ///
    /// Subscribe **before** starting the operation whose signal is awaited: the
    /// channel does not replay, and status-go can answer faster than a later
    /// subscription could be set up.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<String> {
        inprocess::subscribe()
    }
}

impl Default for Backend {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_handle_is_cheap_and_uniform() {
        assert_eq!(Backend::new(), Backend::default());
    }
}
