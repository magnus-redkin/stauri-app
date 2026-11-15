//! Update check and installation.
//!
//! ## Why commands rather than the JS plugin
//!
//! `@tauri-apps/plugin-updater` does everything itself, but runs from the
//! webview and needs the `updater:default` permission. Webview rights are
//! deliberately narrow here (see `capabilities/default.json` and `auth_proxy.rs`),
//! so only two thin commands exist: the check returns the version and release
//! notes, and installation runs entirely in Rust.
//!
//! ## Why the server address and key come from `tauri.conf.json`
//!
//! `plugins.updater.endpoints` and `plugins.updater.pubkey` are the standard
//! place for them, and the plugin reads them itself. While the key is empty,
//! `check_for_update` returns `None` rather than an error: a build without a
//! signing key must start normally, just without updates.
//!
//! ## Signature
//!
//! Every artefact is signed, and the public half lives in `tauri.conf.json`.
//! The plugin verifies the signature before installing, so the file cannot be
//! forged without the private key. That key is the only release secret and must
//! never enter the repository.

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::UpdaterExt;

use crate::error::{AppError, AppResult};

/// An update found by the server.
#[derive(Serialize)]
pub struct UpdateInfo {
    pub version: String,
    #[serde(rename = "currentVersion")]
    pub current_version: String,
    /// Release notes. `None` when the server sent none.
    pub notes: Option<String>,
    /// Publication date in ISO 8601.
    pub date: Option<String>,
}

/// Whether auto-update is configured.
///
/// While `pubkey` in `tauri.conf.json` is empty the update can not be offered,
/// let alone installed: the signature is verified only at install time, so
/// `check()` would return a version from the server, the interface would show
/// "update available", and pressing "Install" would fail decoding an empty key.
/// The user would be shown a button that cannot work.
fn is_configured<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|cfg| cfg.get("pubkey"))
        .and_then(|key| key.as_str())
        .is_some_and(|key| !key.trim().is_empty())
}

/// Asks the server for an update.
///
/// Returns `Ok(None)` when there is no update or updates are off (empty signing
/// key, empty endpoint list). That is not an error — it is the normal state of a
/// build with no update server configured.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Config`] when the updater cannot be built
/// and [`crate::error::ErrorKind::Network`] when the check request fails.
pub async fn check<R: Runtime>(app: &AppHandle<R>) -> AppResult<Option<UpdateInfo>> {
    if !is_configured(app) {
        tracing::debug!("updater is not configured (no pubkey); skipping check");
        return Ok(None);
    }

    let updater = app
        .updater_builder()
        .build()
        .map_err(|e| AppError::config(format!("updater is not configured: {e}")))?;

    let update = updater
        .check()
        .await
        .map_err(|e| AppError::network(format!("update check failed: {e}")))?;

    Ok(update.map(|u| UpdateInfo {
        version: u.version,
        current_version: u.current_version,
        notes: u.body,
        date: u.date.map(|d| d.to_string()),
    }))
}

/// Downloads, verifies and installs an update.
///
/// The plugin verifies the signature before installing: an unsigned file, or one
/// signed with a foreign key, is rejected and the command returns an error.
///
/// On Linux the file is replaced in place, so the new version starts only after a
/// restart, which the user performs.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Config`] when the updater cannot be built
/// or no update is available any more, and [`crate::error::ErrorKind::Network`]
/// when the check, download or install fails.
pub async fn install<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    let updater = app
        .updater_builder()
        .build()
        .map_err(|e| AppError::config(format!("updater is not configured: {e}")))?;

    let Some(update) = updater
        .check()
        .await
        .map_err(|e| AppError::network(format!("update check failed: {e}")))?
    else {
        // The release could have been withdrawn between the check and the install.
        // This is not a failure: it reports that there is nothing to install.
        return Err(AppError::config("no update available"));
    };

    let version = update.version.clone();
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| AppError::network(format!("update install failed: {e}")))?;

    tracing::info!(version, "update installed, restart required");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_info_serializes_camel_case() {
        let info = UpdateInfo {
            version: "0.3.0".into(),
            current_version: "0.2.0".into(),
            notes: Some("fixes".into()),
            date: None,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains(r#""currentVersion":"0.2.0""#));
        assert!(json.contains(r#""version":"0.3.0""#));
        assert!(json.contains(r#""notes":"fixes""#));
    }
}
