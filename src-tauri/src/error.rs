//! Typed errors for Tauri commands.
//!
//! Every command returns `AppError`, so the frontend can branch on `kind`
//! instead of matching on message text. The error serialises as an object:
//!
//! ```json
//! { "kind": "backend", "message": "..." }
//! ```
//!
//! `kind` is stable and meant for programmatic handling; `message` is for the
//! user and the logs.

use serde::Serialize;

/// Error category. Serialises to a snake_case string.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// The backend is not running, has crashed, or is unreachable.
    Backend,
    /// Configuration problem: unknown network, malformed config.json.
    Config,
    /// File operations: reading, writing, creating directories.
    Io,
    /// Failure talking to an external service (CoinGecko, RPC provider).
    Network,
    /// Broken internal invariants: poisoned mutex, out-of-range index.
    Internal,
}

/// Error returned by a Tauri command.
///
/// Serialises as an object with `kind` and `message` fields, so the frontend
/// receives a structured value rather than a string.
#[derive(Debug, Serialize)]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
}

impl AppError {
    fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn backend(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Backend, message)
    }

    pub fn config(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Config, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Io, message)
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Network, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, message)
    }

    /// Error for a poisoned mutex. One shared message so the string is not
    /// repeated in every `map_err`.
    pub fn poisoned() -> Self {
        Self::internal("internal lock poisoned")
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::io(e.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        Self::internal(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_kind_and_message() {
        let err = AppError::backend("backend is not running");
        let json = serde_json::to_string(&err).expect("serialize");
        assert_eq!(
            json,
            r#"{"kind":"backend","message":"backend is not running"}"#
        );
    }

    #[test]
    fn kinds_are_snake_case() {
        let cases = [
            (ErrorKind::Backend, "backend"),
            (ErrorKind::Config, "config"),
            (ErrorKind::Io, "io"),
            (ErrorKind::Network, "network"),
            (ErrorKind::Internal, "internal"),
        ];
        for (kind, expected) in cases {
            let err = AppError::new(kind, "");
            let json = serde_json::to_string(&err).expect("serialize");
            assert!(
                json.contains(&format!(r#""kind":"{expected}""#)),
                "expected {expected} in {json}"
            );
        }
    }

    #[test]
    fn io_error_maps_to_io_kind() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "missing");
        let err: AppError = io_err.into();
        assert_eq!(err.kind, ErrorKind::Io);
        assert!(err.message.contains("missing"));
    }
}
