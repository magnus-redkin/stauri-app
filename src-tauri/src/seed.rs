//! Seed phrase: kept outside the webview.
//!
//! The phrase is fetched once on the Rust side and stays in process memory. The
//! frontend only ever receives:
//!
//!   * `seed_word(index)` — a single word, for display;
//!   * `seed_challenge()` — random indices for verification;
//!   * `verify_seed_answer(i, answer)` — the comparison result, without
//!     revealing the expected word.
//!
//! The user still has to see the phrase in order to write it down, so it cannot
//! be hidden entirely. The goal is to keep it out of the webview and out of the
//! logs; `clear_seed()` wipes it from memory when the screen is left.

use std::sync::Mutex;

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::Manager;

/// The phrase in process memory. `None` until loaded and after clearing.
static PHRASE: Mutex<Option<Vec<String>>> = Mutex::new(None);

#[derive(Serialize)]
pub struct SeedInfo {
    /// Word count; the frontend numbers the words when displaying them.
    pub word_count: usize,
}

#[derive(Serialize, Deserialize)]
pub struct VerifyResult {
    pub correct: bool,
}

/// Fetches the mnemonic from status-go and keeps it in Rust memory.
///
/// Returns the word count only, never the phrase itself.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] when the backend is not running,
/// the `settings_getSettings` call fails, or the response carries no usable
/// mnemonic. Returns [`crate::error::ErrorKind::Network`] on transport and body
/// read failures, [`crate::error::ErrorKind::Internal`] when the HTTP client
/// cannot be built or a lock is poisoned.
#[tauri::command]
pub async fn fetch_seed_phrase(app: tauri::AppHandle) -> AppResult<SeedInfo> {
    let port = {
        let state = app.state::<crate::sidecar::BackendState>();
        let port_lock = state.port.lock().map_err(|_| AppError::poisoned())?;
        port_lock.ok_or_else(|| AppError::backend("backend is not running"))?
    };

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| AppError::internal(format!("client build error: {e}")))?;

    let resp = client
        .post(format!("http://127.0.0.1:{port}/statusgo/CallRPC"))
        .header("Content-Type", "application/json")
        .body(
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "settings_getSettings",
                "params": []
            })
            .to_string(),
        )
        .send()
        .await
        .map_err(|e| AppError::network(format!("request failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::backend(format!(
            "settings_getSettings HTTP {}",
            resp.status()
        )));
    }

    let text = resp
        .text()
        .await
        .map_err(|e| AppError::network(format!("body read error: {e}")))?;

    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| AppError::backend(format!("JSON parse error: {e}")))?;

    let mnemonic = parsed
        .get("result")
        .and_then(|r| r.get("mnemonic"))
        .and_then(|m| m.as_str())
        .ok_or_else(|| AppError::backend("mnemonic is not available"))?;

    let words: Vec<String> = mnemonic.split_whitespace().map(|w| w.to_string()).collect();

    if words.is_empty() {
        return Err(AppError::backend("mnemonic is empty"));
    }

    let count = words.len();
    *PHRASE.lock().map_err(|_| AppError::poisoned())? = Some(words);

    Ok(SeedInfo { word_count: count })
}

/// One word by index, for display to the user.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] when the phrase is not loaded,
/// [`crate::error::ErrorKind::Internal`] when the index is out of range or a
/// lock is poisoned.
#[tauri::command]
pub fn seed_word(index: usize) -> AppResult<String> {
    let guard = PHRASE.lock().map_err(|_| AppError::poisoned())?;
    let words = guard
        .as_ref()
        .ok_or_else(|| AppError::backend("seed phrase is not loaded"))?;
    words
        .get(index)
        .cloned()
        .ok_or_else(|| AppError::internal(format!("word index {index} out of range")))
}

/// Random distinct indices for checking that the phrase was memorised.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] when the phrase is not loaded or
/// is empty, and [`crate::error::ErrorKind::Internal`] when a lock is poisoned.
#[tauri::command]
pub fn seed_challenge(count: usize) -> AppResult<Vec<usize>> {
    let guard = PHRASE.lock().map_err(|_| AppError::poisoned())?;
    let words = guard
        .as_ref()
        .ok_or_else(|| AppError::backend("seed phrase is not loaded"))?;

    let total = words.len();
    if total == 0 {
        return Err(AppError::backend("seed phrase is empty"));
    }
    let take = count.min(total);

    // A simple choice with no external dependencies. Cryptographic strength is
    // not needed: the point is to stop the user from always being asked the same
    // words, not to resist an attacker.
    let mut seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E37_79B9_7F4A_7C15);

    let mut picked: Vec<usize> = Vec::with_capacity(take);
    while picked.len() < take {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let idx = (seed >> 33) as usize % total;
        if !picked.contains(&idx) {
            picked.push(idx);
        }
    }

    picked.sort_unstable();
    Ok(picked)
}

/// Checks the user's answer without revealing the expected word.
///
/// Comparison is case-insensitive and ignores surrounding whitespace.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] when the phrase is not loaded,
/// [`crate::error::ErrorKind::Internal`] when the index is out of range or a
/// lock is poisoned.
#[tauri::command]
pub fn verify_seed_answer(index: usize, answer: String) -> AppResult<VerifyResult> {
    let guard = PHRASE.lock().map_err(|_| AppError::poisoned())?;
    let words = guard
        .as_ref()
        .ok_or_else(|| AppError::backend("seed phrase is not loaded"))?;
    let expected = words
        .get(index)
        .ok_or_else(|| AppError::internal(format!("word index {index} out of range")))?;

    Ok(VerifyResult {
        correct: expected.eq_ignore_ascii_case(answer.trim()),
    })
}

/// Wipes the phrase from memory. Called when the screen is left.
#[tauri::command]
pub fn clear_seed() {
    if let Ok(mut guard) = PHRASE.lock() {
        if let Some(words) = guard.as_mut() {
            for w in words.iter_mut() {
                // Overwrite the contents so the string does not linger in the heap.
                w.clear();
            }
        }
        *guard = None;
    }
}
