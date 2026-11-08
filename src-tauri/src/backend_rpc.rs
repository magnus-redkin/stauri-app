//! Вызов status-go через аутентифицирующий прокси.
//!
//! Раньше эта функция жила внутри `transfer.rs`, но понадобилась и ENS-пути.
//! Копия разошлась бы: одно место исправили, другое забыли. Поэтому вынесена
//! сюда и используется обоими модулями.
//!
//! ## Почему через прокси, а не напрямую
//!
//! `status-backend` не проверяет, кто к нему подключился: любой локальный
//! процесс может вызвать `settings_getSettings` (seed-фраза) или `wallet_*`.
//! Прокси требует заголовок с токеном, сгенерированным при старте
//! (`auth_proxy.rs`), поэтому даже знание порта не даёт доступа.

use serde_json::{Value, json};

use crate::auth_proxy;
use crate::error::{AppError, AppResult};

/// Имя метода прокси, через который уходят все JSON-RPC вызовы.
const CALL_RPC: &str = "CallRPC";

/// Запрос к status-go через прокси.
///
/// Таймаут 60 секунд: сборка транзакции и оценка газа на медленной сети
/// укладываются, а зависший вызов иначе держал бы команду бесконечно.
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
        // Локальный адрес: системный прокси здесь только помешает.
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

    // Ошибка метода приходит внутри JSON-RPC, а не кодом HTTP.
    if let Some(err) = envelope.get("error") {
        return Err(AppError::backend(describe_rpc_error(err)));
    }

    Ok(envelope.get("result").cloned().unwrap_or(Value::Null))
}

/// Достаёт текст ошибки из ответа JSON-RPC.
///
/// status-go кладёт ошибки в двух формах: строка и объект
/// `{ code, message }`. Показываем что есть, но без тела ответа целиком —
/// там бывают адреса и суммы.
pub fn describe_rpc_error(err: &Value) -> String {
    if let Some(msg) = err.as_str() {
        return msg.to_string();
    }
    if let Some(msg) = err.get("message").and_then(|m| m.as_str()) {
        return msg.to_string();
    }
    "backend returned an error".to_string()
}
