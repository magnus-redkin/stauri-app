//! Application directories: configuration and data.
//!
//! On desktop `dirs::config_dir()` and `dirs::data_local_dir()` return usable
//! paths. On Android they return `None` (no `$HOME`, no XDG), so Tauri supplies
//! the directories at startup through [`set_config_dir`] and [`set_data_dir`].
//! When neither is set the previous behaviour holds and user files stay put.
//!
//! ## Why `STAURI_DATA_DIR`
//!
//! The profile (keys, databases, chats) lives in the app data directory.
//! Checking a release needs a clean profile next to the working one: the
//! variable runs the same build against its own directory without touching the
//! real profile. It is unset by default, so a normal install is unaffected.
//!
//! Environment values take priority over the Tauri directories; otherwise on
//! desktop, where Tauri always supplies a path, `STAURI_DATA_DIR` would be
//! silently ignored. The values are read once at startup.

use std::path::PathBuf;
use std::sync::OnceLock;

static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Sets the configuration directory, once at application startup.
///
/// Later calls are ignored: the value is stored in a `OnceLock`.
pub fn set_config_dir(dir: PathBuf) {
    let _ = CONFIG_DIR.set(dir);
}

/// Sets the data directory, once at application startup.
///
/// Later calls are ignored: the value is stored in a `OnceLock`.
pub fn set_data_dir(dir: PathBuf) {
    let _ = DATA_DIR.set(dir);
}

/// Configuration directory: the value set by Tauri, otherwise the system `dirs`
/// path.
pub fn config_dir() -> Option<PathBuf> {
    CONFIG_DIR.get().cloned().or_else(dirs::config_dir)
}

/// Reads a directory override from the environment.
///
/// `STAURI_CONFIG_DIR` and `STAURI_DATA_DIR` must hold absolute paths. A
/// relative path is rejected because an AppImage is launched from an arbitrary
/// directory, and the data would land somewhere the user does not expect.
pub fn env_override(name: &str) -> Option<PathBuf> {
    let raw = std::env::var(name).ok()?;
    let path = PathBuf::from(raw.trim());
    if path.as_os_str().is_empty() {
        return None;
    }
    if !path.is_absolute() {
        tracing::warn!(%name, path = %path.display(), "переменная каталога должна быть абсолютным путём; игнорирую");
        return None;
    }
    Some(path)
}

/// Data directory: `STAURI_DATA_DIR`, then the Tauri value, then the system
/// path.
///
/// The order is fixed: the environment variable must win, otherwise on desktop
/// (where Tauri always passes its own path) it would change nothing.
pub fn data_dir() -> Option<PathBuf> {
    env_override("STAURI_DATA_DIR")
        .or_else(|| DATA_DIR.get().cloned())
        .or_else(dirs::data_local_dir)
}
