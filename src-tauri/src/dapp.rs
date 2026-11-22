//! External dApps in a separate window.
//!
//! A provider serves **data** in a fixed schema that the app renders itself,
//! whereas a dApp brings its own interface and runs in its own window
//! (`docs/ru/providers_and_dapps.md` §12).
//!
//! ## Isolation
//!
//! The window is built with `WebviewUrl::External`, so its origin is not ours.
//! Tauri IPC is available only to windows listed in capabilities, and an
//! external window has no entry, so `invoke` from a foreign page does not work.
//! This is the absence of a permission rather than a convention: capabilities
//! are matched by window label (`dapp-…`) and none of them covers it.
//!
//! The window title carries the host — the visible frame with its source from
//! §12, so the user always sees whose interface they are looking at.
//!
//! ## What is validated
//!
//! The address passes the same filter as feeds ([`validate_external_url`]):
//! only `http(s)`, no `localhost` and no private ranges. The check itself is not
//! about SSRF (the foreign window makes the request, not this app) — it stops a
//! dApp string from becoming a way to open our own interface or a local service
//! inside a foreign frame.

#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
#[cfg(desktop)]
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::core::error::{AppError, AppResult};
#[cfg(desktop)]
use crate::providers::validate_external_url;

/// dApp window size. Enough for a desktop interface without filling the screen:
/// the user should see that this is a separate window.
#[cfg(desktop)]
const DAPP_WIDTH: f64 = 1024.0;
#[cfg(desktop)]
const DAPP_HEIGHT: f64 = 800.0;
#[cfg(desktop)]
const DAPP_MIN_WIDTH: f64 = 480.0;
#[cfg(desktop)]
const DAPP_MIN_HEIGHT: f64 = 360.0;

/// Opens an external dApp in an isolated window.
///
/// Returns the window label. A repeated call with the same address does not
/// create a second window; it focuses the existing one, so clicking a sample
/// twice does not leave invisible copies stacked on each other.
///
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Config`] or [`crate::core::error::ErrorKind::Network`] from
/// [`validate_external_url`], and [`crate::core::error::ErrorKind::Internal`] when the menu or the
/// window cannot be built.
#[cfg(desktop)]
#[tauri::command]
pub async fn open_dapp(app: tauri::AppHandle, url: String) -> AppResult<String> {
    let parsed = validate_external_url(&url)?;
    let label = window_label(parsed.as_str());

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(label);
    }

    let host = parsed.host_str().unwrap_or("dApp").to_string();

    // Navigation menu. Without it there is no way back from a dApp window: the
    // page's own interface may have no back button, and no history is kept on
    // the Tauri side or anywhere else.
    //
    // Only three items: back, forward, reload. No "save page" and no devtools —
    // foreign code has nothing to do on the user's disk.
    let back = MenuItem::with_id(&app, "dapp-back", "← Back", true, Some("Alt+Left"))
        .map_err(|e| AppError::internal(format!("menu item: {e}")))?;
    let forward = MenuItem::with_id(&app, "dapp-forward", "→ Forward", true, Some("Alt+Right"))
        .map_err(|e| AppError::internal(format!("menu item: {e}")))?;
    let reload = MenuItem::with_id(&app, "dapp-reload", "⟳ Reload", true, Some("F5"))
        .map_err(|e| AppError::internal(format!("menu item: {e}")))?;
    let sep = PredefinedMenuItem::separator(&app)
        .map_err(|e| AppError::internal(format!("menu separator: {e}")))?;
    // Closing is a menu item, not the window's close button: in fullscreen mode
    // that button is not visible, and there must always be a way out.
    let close = MenuItem::with_id(&app, "dapp-close", "✕ Close", true, Some("Ctrl+W"))
        .map_err(|e| AppError::internal(format!("menu item: {e}")))?;
    let menu = Menu::with_items(&app, &[&back, &forward, &reload, &sep, &close])
        .map_err(|e| AppError::internal(format!("dApp menu: {e}")))?;

    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        // The host in the title is not decoration: it is the only thing that
        // distinguishes a foreign interface from ours. The `dApp — example.com`
        // format reads unambiguously and cannot be spoofed by a page title.
        .title(format!("dApp — {host}"))
        .inner_size(DAPP_WIDTH, DAPP_HEIGHT)
        .min_inner_size(DAPP_MIN_WIDTH, DAPP_MIN_HEIGHT)
        .menu(menu)
        .resizable(true)
        .build()
        .map_err(|e| AppError::internal(format!("cannot open dApp window: {e}")))?;

    // The handler lives on the _window_, not on the app: that way the menu items
    // apply only to this window and leave the main one alone.
    window.on_menu_event(move |win, event| match event.id().0.as_str() {
        "dapp-back" => navigate(win, "history.back()"),
        "dapp-forward" => navigate(win, "history.forward()"),
        "dapp-reload" => {
            if let Some(webview) = win.app_handle().get_webview_window(win.label()) {
                let _ = webview.reload();
            }
        }
        "dapp-close" => {
            let _ = win.close();
        }
        _ => {}
    });

    Ok(label)
}

/// Documents the app may open from the Home section.
///
/// A whitelist, not a path: the frontend names a document and Rust resolves it
/// to a fixed file under `docs/` in the bundle. A path from the webview would
/// let it read any file the app can see.
#[cfg(desktop)]
const DOC_WHITELIST: &[&str] = &[
    "ru/web3im.md",
    "ru/architecture.md",
    "ru/auth_and_sync.md",
    "ru/comparison.md",
    "en/web3im.md",
    "en/architecture.md",
    "en/auth_and_sync.md",
    "en/comparison.md",
];

/// Opens a bundled document in its own window.
///
/// The window loads the app's own asset (`WebviewUrl::App`), not a foreign page,
/// and it is not listed in any capability: it can read the document, but it
/// cannot call a Tauri command. It is not a dApp, so it carries no dApp menu
/// and its title says what it is.
///
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Config`] for a name outside the whitelist,
/// and [`crate::core::error::ErrorKind::Internal`] when the window cannot be built.
#[cfg(desktop)]
#[tauri::command]
pub async fn open_doc(app: tauri::AppHandle, name: String) -> AppResult<String> {
    if !DOC_WHITELIST.contains(&name.as_str()) {
        return Err(AppError::config(format!("document not allowed: {name}")));
    }
    let label = format!("doc-{}", name.replace(['/', '.'], "-"));
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(label);
    }
    let title = name.rsplit('/').next().unwrap_or(&name).to_string();
    // Each document has a small generated page next to it (scripts/sync-docs.sh);
    // it loads the viewer with the document name in the script tag.
    let page = format!("{}.html", name.strip_suffix(".md").unwrap_or(&name));
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(format!("docs/{page}").into()))
        .title(format!("Stauri — {title}"))
        .inner_size(900.0, 760.0)
        .min_inner_size(480.0, 360.0)
        .resizable(true)
        .build()
        .map_err(|e| AppError::internal(format!("cannot open document window: {e}")))?;
    Ok(label)
}

/// Rejects dApp opening on mobile.
///
/// Mobile platforms have no separate window with a menu, so opening a dApp is
/// not supported there yet. The command stays registered so the frontend gets a
/// clear error instead of "command not found".
///
/// Navigation inside a dApp window is done by evaluating `history.back()` and
/// friends: Tauri has no native `goBack`, and wry does not expose history. That
/// script runs in the window's main frame, so it sees nothing of Stauri. Its
/// error is swallowed on purpose — `eval` can fail while the page is still
/// loading, and there is no reason to fail the command over it.
///
/// # Errors
/// Always returns [`crate::core::error::ErrorKind::Internal`].
#[cfg(mobile)]
#[tauri::command]
pub async fn open_dapp(_url: String) -> AppResult<String> {
    Err(AppError::internal("dApp windows are not available on mobile yet"))
}

/// Opens a bundled document in a separate window.
///
/// Mobile has no second window to put it in, so the command answers with an error
/// rather than being registered only on the desktop: the same frontend bundle runs on
/// both, and an unregistered command fails in the webview with a message that says
/// nothing about why.
///
/// # Errors
/// Always returns [`crate::core::error::ErrorKind::Internal`].
#[cfg(mobile)]
#[tauri::command]
pub async fn open_doc(_name: String) -> AppResult<String> {
    Err(AppError::internal("document windows are not available on mobile yet"))
}

/// Evaluates a navigation call inside the foreign page.
///
/// See [`open_dapp`] for why the call goes through `eval` instead of a native
/// API. The error is dropped: `eval` can fail while the page is still loading,
/// and the user can press the item again.
#[cfg(desktop)]
fn navigate(win: &tauri::Window, js: &str) {
    if let Some(webview) = win.app_handle().get_webview_window(win.label()) {
        let _ = webview.eval(js);
    }
}

/// Window label derived from the address.
///
/// Tauri requires a label of `[a-zA-Z0-9-_]`, so a URL cannot be used directly.
/// FNV-1a gives a stable label with no dependency, so the same address always
/// opens in the same window.
#[cfg(desktop)]
fn window_label(url: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in url.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("dapp-{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_is_stable_and_safe() {
        let a = window_label("https://remix.ethereum.org");
        assert_eq!(a, window_label("https://remix.ethereum.org"));
        assert!(
            a.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "tauri rejects labels with other characters: {a}"
        );
    }

    #[test]
    fn different_urls_get_different_labels() {
        assert_ne!(
            window_label("https://remix.ethereum.org"),
            window_label("https://etherscan.io")
        );
    }
}
