//! Единая точка доступа к status-go.
//!
//! Сейчас бэкенд — отдельный процесс (sidecar), и доступ к нему идёт по
//! локальному порту через аутентифицирующий прокси. На Android бэкенд будет
//! библиотекой внутри приложения (`libstatus.so`), и порта не будет вовсе.
//!
//! Этот модуль отделяет «как вызвать status-go» от «что вызвать».
//! Кошельковая и ENS-логика знает только `Backend`, а не порт и не сокет.
//! Поэтому при переходе на Android меняется реализация варианта, а не код
//! `ens.rs`, `swap.rs`, `transfer.rs`, `router.rs`.
//!
//! См. `docs/PLAN.md`, раздел B.1.

use serde_json::Value;

use crate::backend_rpc;
use crate::error::{AppError, AppResult};

/// Способ связи с status-go.
///
/// Вариант `InProcess` — заготовка для Android. Пока не реализован, и любой
/// вызов через него возвращает ошибку: на десктопе он не используется.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// Отдельный процесс, доступ по локальному порту (через прокси).
    Rpc { port: u16 },
    /// Библиотека внутри процесса приложения (JNI/FFI). Только Android.
    /// Пока никем не создаётся: нужен для сборки под Android (`docs/PLAN.md`, B.2).
    #[allow(dead_code)]
    InProcess,
}

impl Backend {
    /// Строит `Backend` из порта, который приходит от фронтенда.
    ///
    /// Порт `0` означает «бэкенд не запущен»: такой вызов отклоняется сразу,
    /// а не уходит в сеть на `127.0.0.1:0`.
    pub fn from_port(port: u16) -> AppResult<Self> {
        if port == 0 {
            return Err(AppError::backend("backend is not running"));
        }
        Ok(Backend::Rpc { port })
    }

    /// JSON-RPC вызов `method` с параметрами `params`.
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

    /// Порт для WebSocket-подписки на сигналы, если бэкенд доступен по сети.
    ///
    /// На `InProcess` сигналов по сокету нет: они приходят колбэком, и
    /// потребитель должен подписаться иначе. Поэтому возвращаем `None`,
    /// а не порт.
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
