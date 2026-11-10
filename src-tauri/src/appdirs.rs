//! Каталог конфигурации приложения.
//!
//! На десктопе `dirs::config_dir()` даёт нормальный путь. На Android он
//! возвращает `None` (нет `$HOME`/XDG), поэтому каталог задаёт Tauri при старте
//! через [`set_config_dir`] (`app.path().app_config_dir()`). Если значение не
//! задано, остаётся прежнее поведение — файлы пользователя не переезжают.

use std::path::PathBuf;
use std::sync::OnceLock;

static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Задаёт каталог конфигурации один раз, при старте приложения.
pub fn set_config_dir(dir: PathBuf) {
    let _ = CONFIG_DIR.set(dir);
}

/// Каталог конфигурации: заданный Tauri, иначе системный `dirs`.
pub fn config_dir() -> Option<PathBuf> {
    CONFIG_DIR.get().cloned().or_else(dirs::config_dir)
}
