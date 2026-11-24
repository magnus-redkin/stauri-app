//! Bridge trace written to `bridge-trace.log` in the application data directory.
//!
//! It allows checking sign-in step by step without reading `logcat` or taking
//! screenshots: every `status_call` appends a line. A write failure never breaks
//! the call.

use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

static TRACE_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Sets the application data directory; the file itself is created on the first
/// write.
pub fn set_dir(dir: PathBuf) {
    let _ = TRACE_PATH.set(dir.join("bridge-trace.log"));
}

/// Whether verbose tracing is on, read once from `STAURI_DEBUG_TRACE=1` before
/// the application starts.
///
/// When enabled, responses are written up to 4000 characters instead of 200.
pub fn debug_enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| {
        std::env::var("STAURI_DEBUG_TRACE")
            .map(|v| v == "1")
            .unwrap_or(false)
    })
}

/// Appends one line with a timestamp.
///
/// Request and response bodies are never written in full: only the endpoint, its
/// length and the first 200 characters of the response.
pub fn line(text: &str) {
    // Android release builds cannot be read back with `run-as`, so the same line also
    // goes through the `log` crate: `android_logger` writes it to logcat under the tag
    // `stauri`. Without this, every diagnostic in this file was invisible on the phone.
    // The `log` dependency is Android-only, hence the gate; on desktop the file is the
    // channel and is readable as it is.
    #[cfg(target_os = "android")]
    log::info!("{text}");
    let Some(path) = TRACE_PATH.get() else { return };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{stamp} {text}");
    }
}
