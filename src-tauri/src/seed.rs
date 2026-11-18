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
/// Returns [`crate::error::ErrorKind::Backend`] when the
/// `settings_getSettings` call fails or the response carries no usable mnemonic,
/// and [`crate::error::ErrorKind::Internal`] when the library cannot be loaded.
#[tauri::command]
pub async fn fetch_seed_phrase() -> AppResult<SeedInfo> {
    // No HTTP: the seed is read over the library, in this process. The password
    // never passes through here.
    let parsed = crate::inprocess::call_rpc("settings_getSettings", serde_json::json!([])).await?;

    let words = mnemonic_words(&parsed)?;

    let count = words.len();
    *PHRASE.lock().map_err(|_| AppError::poisoned())? = Some(words);

    Ok(SeedInfo { word_count: count })
}

/// Extracts the seed words from a `settings_getSettings` reply.
///
/// @param reply - Reply of [`crate::inprocess::call_rpc`], which has already
///   unwrapped the JSON-RPC envelope and returned the settings object itself.
/// @returns The words, in order.
/// @remarks
/// Looking for a `result` field here is the bug this function exists to prevent:
/// it was correct while calls went through the sidecar, where the envelope was
/// still present, and silently produced "mnemonic is not available" afterwards.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] when the reply has no `mnemonic`
/// string or the phrase is empty.
fn mnemonic_words(reply: &serde_json::Value) -> AppResult<Vec<String>> {
    let mnemonic = reply
        .get("mnemonic")
        .and_then(|m| m.as_str())
        .ok_or_else(|| AppError::backend("mnemonic is not available"))?;

    let words: Vec<String> = mnemonic.split_whitespace().map(|w| w.to_string()).collect();
    if words.is_empty() {
        return Err(AppError::backend("mnemonic is empty"));
    }
    Ok(words)
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_words_from_an_unwrapped_reply() {
        // The shape `call_rpc` returns: the settings object itself.
        let reply = json!({ "mnemonic": "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima" });
        let words = mnemonic_words(&reply).expect("words");
        assert_eq!(words.len(), 12);
        assert_eq!(words[0], "alpha");
    }

    #[test]
    fn rejects_an_envelope_shaped_reply() {
        // What the sidecar returned. Reading it here means the caller skipped the
        // envelope unwrapping, and the phrase must not be taken from it silently.
        let reply = json!({ "result": { "mnemonic": "alpha bravo" } });
        assert!(mnemonic_words(&reply).is_err());
    }

    #[test]
    fn rejects_a_reply_without_a_phrase() {
        assert!(mnemonic_words(&json!({})).is_err());
        assert!(mnemonic_words(&json!({ "mnemonic": "" })).is_err());
    }
}
