//! Opening external links with the system handler.
//!
//! ## Why not the `shell` plugin
//!
//! `@tauri-apps/plugin-shell.open` refuses to work without a capability
//! permission, and granting the webview the right to open arbitrary addresses is
//! an unnecessary door: any XSS in the interface could launch foreign programs.
//! Here the address arrives in Rust, the scheme is checked, and only then is it
//! handed to the system.
//!
//! ## Why a command rather than `<a target="_blank">`
//!
//! In WebKitGTK `target="_blank"` inside a Tauri window often does nothing: the
//! webview is not a browser and is not obliged to open new windows. A link click
//! therefore calls a command instead of navigating.

use url::Url;

use crate::core::error::{AppError, AppResult};

/// Schemes that may be opened.
///
/// `http` and `https` cover ordinary links from feeds; `mailto` covers addresses
/// in articles. Everything else (`file:`, `javascript:`, `data:`) is rejected:
/// the first is a path to local files, the other two are code execution.
const ALLOWED_SCHEMES: [&str; 3] = ["http", "https", "mailto"];

/// Opens an address with the system default handler.
///
/// ## Telegram
///
/// For a link to a Telegram post (`t.me/<channel>/<id>`) the `tg:` scheme is
/// tried first: the Telegram client registers it on install, and the post then
/// opens in the application rather than the browser. Without the client `tg:`
/// has no handler and fails, so the plain `https` address — the browser — is
/// used instead.
///
/// The order is deliberate: `tg:` has no fallback handler, so without an
/// installed client it is a guaranteed failure, and the only way to find out is
/// to try.
///
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Config`] when the address cannot be parsed
/// or its scheme is not allowed, and [`crate::core::error::ErrorKind::Internal`] when
/// the system has no handler for it.
#[tauri::command]
pub fn open_external(app: tauri::AppHandle, url: String) -> AppResult<()> {
    let parsed = parse(&url)?;

    // На Android у `open::that` нет обработчика вовсе: браузер запускается только
    // Intent'ом, и его отправляет плагин opener. Схема уже проверена выше.
    #[cfg(mobile)]
    {
        use tauri_plugin_opener::OpenerExt;
        return app
            .opener()
            .open_url(parsed.as_str().to_string(), None::<String>)
            .map_err(|e| AppError::internal(format!("no handler for this address: {e}")));
    }

    #[cfg(not(mobile))]
    {
        let _ = &app;
        if let Some(tg) = telegram_deep_link(&parsed)
            && open::that(&tg).is_ok()
        {
            return Ok(());
        }

        open::that(parsed.as_str())
            .map_err(|e| AppError::internal(format!("no handler for this address: {e}")))
    }
}

/// Checks the scheme and parses the address.
///
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Config`] when the address is malformed or
/// its scheme is not in [`ALLOWED_SCHEMES`].
fn parse(raw: &str) -> AppResult<Url> {
    let url =
        Url::parse(raw.trim()).map_err(|e| AppError::config(format!("invalid address: {e}")))?;

    if !ALLOWED_SCHEMES.contains(&url.scheme()) {
        return Err(AppError::config(format!(
            "scheme {} is not allowed",
            url.scheme()
        )));
    }

    Ok(url)
}

/// The `tg://` link for the same Telegram post as a `t.me` address.
///
/// `https://t.me/eveningprophet/4645` becomes
/// `tg://resolve?domain=eveningprophet&post=4645`.
///
/// Returns `None` when the address is not Telegram or does not look like a post
/// link: a channel without a post number (`https://t.me/eveningprophet`) is a
/// feed, there is nothing to open in the application, and the browser suits it
/// better.
fn telegram_deep_link(url: &Url) -> Option<String> {
    let host = url.host_str()?.to_ascii_lowercase();
    if host != "t.me" && host != "telegram.me" && host != "www.t.me" {
        return None;
    }

    let mut segments = url.path_segments()?.filter(|s| !s.is_empty());
    let channel = segments.next()?;
    let post = segments.next()?;

    // A post number is digits only; `t.me/s/<name>` and other service paths do
    // not qualify and are undefined in the application.
    if !post.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    // A channel name is letters, digits and underscore, which rejects `t.me/s/…`.
    if !channel
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return None;
    }

    Some(format!("tg://resolve?domain={channel}&post={post}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_web_schemes() {
        assert!(parse("file:///etc/passwd").is_err());
        assert!(parse("javascript:alert(1)").is_err());
        assert!(parse("data:text/html,<script>").is_err());
    }

    #[test]
    fn accepts_http_https_and_mailto() {
        assert!(parse("https://example.com/article").is_ok());
        assert!(parse("http://example.com").is_ok());
        assert!(parse("mailto:author@example.com").is_ok());
    }

    #[test]
    fn builds_telegram_deep_link_for_post() {
        let url = parse("https://t.me/eveningprophet/4645").expect("valid");
        assert_eq!(
            telegram_deep_link(&url).as_deref(),
            Some("tg://resolve?domain=eveningprophet&post=4645")
        );
    }

    #[test]
    fn no_deep_link_for_channel_feed() {
        // A channel feed is not a post: there is nothing to open in the application.
        let url = parse("https://t.me/eveningprophet").expect("valid");
        assert_eq!(telegram_deep_link(&url), None);
    }

    #[test]
    fn no_deep_link_for_preview_path() {
        // `t.me/s/<name>` is a preview service path, not a post.
        let url = parse("https://t.me/s/eveningprophet").expect("valid");
        assert_eq!(telegram_deep_link(&url), None);
    }

    #[test]
    fn no_deep_link_for_other_hosts() {
        let url = parse("https://blog.rust-lang.org/2024/01/01/post.html").expect("valid");
        assert_eq!(telegram_deep_link(&url), None);
    }

    #[test]
    fn no_deep_link_for_lookalike_host() {
        // `t.me.evil.com` is not Telegram: hosts are compared by exact name.
        let url = parse("https://t.me.evil.com/chan/1").expect("valid");
        assert_eq!(telegram_deep_link(&url), None);
    }

    #[test]
    fn no_deep_link_for_non_numeric_post() {
        let url = parse("https://t.me/channel/about").expect("valid");
        assert_eq!(telegram_deep_link(&url), None);
    }
}
