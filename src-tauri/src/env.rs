//! `.env` loading.
//!
//! The relative path `../.env` only resolves when cwd is `src-tauri/`, that is
//! under `pnpm tauri dev`. In a release build cwd is whatever directory the user
//! launched the application from, and for an AppImage it is arbitrary, so the
//! file has to be looked up under absolute paths rather than relative to cwd.
//!
//! dotenv does not overwrite variables that are already set, so a value from the
//! shell still takes priority over the file.

use std::path::PathBuf;

pub const APP_IDENTIFIER: &str = "com.magnus.stauri-app";

/// Loads `.env` from the first location that has one.
///
/// Returns `true` when a file was found and read. The flag is returned instead
/// of warning here because this runs before logging is initialised (otherwise
/// `RUST_LOG` from `.env` would never reach the `EnvFilter`), and a warning
/// emitted now would go nowhere; the caller prints it once a subscriber exists.
pub fn load_env() -> bool {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 1. User config: ~/.config/com.magnus.stauri-app/.env
    if let Some(dir) = crate::appdirs::config_dir() {
        candidates.push(dir.join(APP_IDENTIFIER).join(".env"));
    }

    // 2. Next to the executable (for an AppImage, usr/bin/).
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        candidates.push(dir.join(".env"));
    }

    // 3. The build directory, debug builds only, so a release never carries the
    //    developer's machine path.
    if cfg!(debug_assertions) {
        candidates.push(PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../.env"
        )));
    }

    // 4. Relative to cwd, for the `pnpm tauri dev` layout.
    candidates.push(PathBuf::from("../.env"));

    candidates
        .iter()
        .any(|path| path.is_file() && dotenv::from_path(path).is_ok())
}
