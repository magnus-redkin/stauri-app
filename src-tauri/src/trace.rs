//! Тестовая печать моста в файл `bridge-trace.log` (каталог данных приложения).
//!
//! Нужна, чтобы проверять вход по шагам без чтения `logcat` и скриншотов: каждый
//! вызов `status_call` дописывает строку. Ошибка записи никогда не ломает вызов.

use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

static TRACE_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Задаёт каталог данных приложения; файл создаётся при первой записи.
pub fn set_dir(dir: PathBuf) {
    let _ = TRACE_PATH.set(dir.join("bridge-trace.log"));
}

/// Дописывает одну строку с меткой времени. Тела запросов/ответов сюда не
/// пишем целиком: только endpoint, длину и первые 200 символов ответа.
pub fn line(text: &str) {
    let Some(path) = TRACE_PATH.get() else { return };
    let stamp = std::time::SystemTime::now()
 .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{stamp} {text}");
    }
}
