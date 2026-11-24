//! Profile actions that status-go reaches through something other than a plain RPC.
//!
//! Two of them:
//!
//!   * an avatar — `multiaccounts_storeIdentityImage` takes a *file path*, and the
//!     webview has no filesystem access, so the bytes arrive here as base64, are
//!     written to a temporary file, handed over and deleted;
//!   * a password change — `ChangeDatabasePasswordV2` is a direct export, not an
//!     RPC method, so it is called like `LoginAccount`.
//!
//! Neither command logs its payload: the avatar is a picture, and the password is a
//! secret. Only lengths and outcomes are traced.

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::core::error::{AppError, AppResult};
use crate::core::inprocess;

/// Shortest side an avatar may have, in pixels.
///
/// status-go resizes to 80×80 for the thumbnail, so a smaller original would be
/// upscaled and look blurred in every client.
pub const AVATAR_MIN_SIDE: u32 = 80;

/// Largest avatar accepted, in bytes.
///
/// status-go re-encodes to ~350 KB itself (`internal/images/adjust.go`), so this is
/// not a technical limit: it keeps a 20 MB phone photo from crossing the IPC boundary
/// and being decoded twice for nothing.
pub const AVATAR_MAX_BYTES: usize = 5 * 1024 * 1024;

/// Accepted image types, matching `internal/images/decode.go`.
const AVATAR_TYPES: [&str; 3] = ["image/png", "image/jpeg", "image/webp"];

#[derive(Serialize)]
pub struct AvatarSaved {
    /// `thumbnail` or `large`, as status-go names them.
    pub kinds: Vec<String>,
    /// Pixel size of the large variant, for the caption in the UI.
    pub width: u32,
    pub height: u32,
}

#[derive(Deserialize)]
pub struct AvatarInput {
    /// `data:` URL or bare base64 of the file.
    pub image: String,
    /// MIME type as the browser reported it, when it did.
    pub media_type: Option<String>,
}

/// Validates, writes and stores a new profile picture.
///
/// @param input - The picture as base64 with its declared type.
/// @returns What status-go stored.
/// @remarks
/// The temporary file is removed on every path, including a failed store: the data
/// directory holds enough copies of the picture already, and a stray temp image would
/// outlive the profile.
///
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Config`] when the type or size is unacceptable,
/// [`crate::core::error::ErrorKind::Backend`] when status-go refuses the image, and
/// [`crate::core::error::ErrorKind::Io`] when the temporary file cannot be written.
#[tauri::command]
pub async fn store_avatar(input: AvatarInput) -> AppResult<AvatarSaved> {
    let bytes = decode_avatar(&input)?;
    tracing::info!(bytes = bytes.len(), "store_avatar: decoded");

    let temp = std::env::temp_dir().join(format!("stauri-avatar-{}.img", std::process::id()));
    std::fs::write(&temp, &bytes)?;

    // status-go crops from the rectangle it is given. A zero rectangle would produce
    // an empty image, so the full picture is passed and status-go crops its centre —
    // the same path `GenerateIdentityImagesFromURL` takes.
    let (w, h) = image_size(&bytes).unwrap_or((0, 0));
    let key_uid = key_uid().await?;
    let result = inprocess::call_rpc(
        "multiaccounts_storeIdentityImage",
        serde_json::json!([key_uid, temp.to_string_lossy(), 0, 0, w, h]),
    )
    .await;
    let _ = std::fs::remove_file(&temp);

    let stored = result?;
    let mut kinds = Vec::new();
    let mut width = 0;
    let mut height = 0;
    for item in stored.as_array().cloned().unwrap_or_default() {
        let kind = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if !kind.is_empty() {
            kinds.push(kind.to_string());
        }
        // The large variant is the one worth reporting: it is the size the profile
        // screen displays.
        if kind == "large" {
            width = item.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            height = item.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        }
    }
    tracing::info!(kinds = ?kinds, "store_avatar: stored");
    Ok(AvatarSaved {
        kinds,
        width,
        height,
    })
}

/// The thumbnail of the current profile picture, as a data URL.
///
/// @returns `None` when the profile has no picture.
/// @remarks
/// The RPC reply carries only metadata (`internal/images/identity.go` drops `Payload`
/// from its `MarshalJSON`), so the picture is read back through the media server and
/// inlined here. Returning bytes rather than a URL keeps the webview from having to
/// reach a localhost port with a self-signed certificate.
///
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Backend`] when the images cannot be listed or
/// fetched, and [`crate::core::error::ErrorKind::Network`] when the media server does not
/// answer.
#[tauri::command]
pub async fn get_avatar() -> AppResult<Option<String>> {
    let key_uid = key_uid().await?;
    let images = inprocess::call_rpc(
        "multiaccounts_getIdentityImages",
        serde_json::json!([key_uid]),
    )
    .await?;

    let thumbnail = images
        .as_array()
        .into_iter()
        .flatten()
        .find(|i| i.get("type").and_then(|v| v.as_str()) == Some("thumbnail"));

    let Some(url) = thumbnail
        .and_then(|i| i.get("localUrl"))
        .and_then(|v| v.as_str())
        .filter(|u| !u.is_empty())
    else {
        return Ok(None);
    };

    // The media server uses a certificate signed by status-go itself, so verification
    // is off here. The request goes to localhost and the URL comes from status-go, not
    // from a remote party.
    let response = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| AppError::network(format!("http client: {e}")))?
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::network(format!("avatar fetch: {e}")))?;

    if !response.status().is_success() {
        return Err(AppError::network(format!(
            "avatar fetch: status {}",
            response.status()
        )));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let body = response
        .bytes()
        .await
        .map_err(|e| AppError::network(format!("avatar body: {e}")))?;

    let encoded = base64::engine::general_purpose::STANDARD.encode(body);
    Ok(Some(format!("data:{content_type};base64,{encoded}")))
}

#[derive(Deserialize)]
pub struct PasswordChange {
    pub current: String,
    pub new: String,
}

/// Re-encrypts the profile with a new password.
///
/// @param input - Current and new password.
/// @remarks
/// Only the lengths are traced. status-go verifies the current password itself
/// (`changeDatabasePasswordV2` calls `VerifyProfilePassword`), so a wrong one is
/// reported rather than silently accepted.
///
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Backend`] when the current password is wrong, the
/// backend does not export the call, or status-go refuses.
#[tauri::command]
pub async fn change_password(input: PasswordChange) -> AppResult<()> {
    tracing::info!(
        current_len = input.current.len(),
        new_len = input.new.len(),
        "change_password"
    );
    let key_uid = key_uid().await?;
    let body = serde_json::json!({
        "keyUID": key_uid,
        "oldPassword": input.current,
        "newPassword": input.new,
        // Rewrap only: the databases and the keystore stay as they are, which is the
        // fast path in `ChangeDatabasePassword` and needs no node restart.
        "rekey": false,
    });

    let backend = inprocess::backend()?;
    let reply = tokio::task::spawn_blocking(move || {
        backend.direct("ChangeDatabasePasswordV2", &body.to_string())
    })
    .await
    .map_err(|e| AppError::internal(format!("password change panicked: {e}")))??;

    error_from_reply(&reply)
}

/// The profile's key uid, as status-go has it right now.
///
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Backend`] when settings cannot be read or carry
/// no key uid.
async fn key_uid() -> AppResult<String> {
    let settings = inprocess::call_rpc("settings_getSettings", serde_json::json!([])).await?;
    settings
        .get("key-uid")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
        .ok_or_else(|| AppError::backend("profile has no key uid"))
}

/// Decodes and validates the picture.
///
/// @param input - Base64 with an optional `data:` prefix and a declared type.
/// @returns The file bytes.
/// @remarks
/// The type is taken from the `data:` prefix when present, because that is what the
/// browser measured; the declared `media_type` is the fallback. A file whose magic
/// bytes do not match is refused before status-go sees it.
fn decode_avatar(input: &AvatarInput) -> AppResult<Vec<u8>> {
    let (declared, payload) = match input.image.split_once(',') {
        Some((header, rest)) if header.starts_with("data:") => {
            let media = header
                .trim_start_matches("data:")
                .split(';')
                .next()
                .unwrap_or("")
                .to_string();
            (Some(media), rest)
        }
        _ => (input.media_type.clone(), input.image.as_str()),
    };

    let media = declared.unwrap_or_default().to_lowercase();
    if !media.is_empty() && !AVATAR_TYPES.contains(&media.as_str()) {
        return Err(AppError::config(format!("unsupported image type: {media}")));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| AppError::config(format!("image is not valid base64: {e}")))?;

    if bytes.is_empty() {
        return Err(AppError::config("image is empty"));
    }
    if bytes.len() > AVATAR_MAX_BYTES {
        return Err(AppError::config(format!(
            "image is {} bytes, the limit is {}",
            bytes.len(),
            AVATAR_MAX_BYTES
        )));
    }

    let (w, h) = image_size(&bytes)
        .ok_or_else(|| AppError::config("image format is not PNG, JPEG or WebP"))?;
    if w.min(h) < AVATAR_MIN_SIDE {
        return Err(AppError::config(format!(
            "image is {w}×{h}, the smallest side must be {AVATAR_MIN_SIDE}"
        )));
    }
    Ok(bytes)
}

/// Width and height from the file header.
///
/// @param bytes - File contents.
/// @returns The size, or `None` when the format is not recognised.
/// @remarks
/// This is a header read, not a decode: the point is to reject a wrong file and to
/// know the crop rectangle without pulling in an image library. PNG, JPEG and WebP
/// are the formats status-go accepts, so the same three are read here.
fn image_size(bytes: &[u8]) -> Option<(u32, u32)> {
    // PNG: signature, then an IHDR chunk whose width and height are big-endian u32.
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) && bytes.len() >= 24 {
        let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        return Some((w, h));
    }

    // JPEG: walk the segments to the start-of-frame, which carries the size.
    if bytes.starts_with(&[0xff, 0xd8]) {
        let mut i = 2;
        while i + 9 < bytes.len() {
            if bytes[i] != 0xff {
                i += 1;
                continue;
            }
            let marker = bytes[i + 1];
            // SOF0..SOF15, excluding the non-frame markers in that range.
            if (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
                let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
                let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
                return Some((w, h));
            }
            let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
            i += 2 + len;
        }
        return None;
    }

    // WebP: RIFF container with a VP8/VP8L/VP8X chunk.
    if bytes.len() >= 30 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        match &bytes[12..16] {
            b"VP8X" => {
                let w = 1 + u32::from_le_bytes([bytes[24], bytes[25], bytes[26], 0]);
                let h = 1 + u32::from_le_bytes([bytes[27], bytes[28], bytes[29], 0]);
                return Some((w, h));
            }
            b"VP8 " => {
                let w = u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3fff;
                let h = u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3fff;
                return Some((w as u32, h as u32));
            }
            _ => return None,
        }
    }

    None
}

/// Turns a status-go reply into an error when it carries one.
///
/// @param reply - JSON as the export returned it.
/// @remarks
/// The direct exports answer `{"error":""}` on success. An empty message is a success,
/// not a failure with a blank reason.
fn error_from_reply(reply: &str) -> AppResult<()> {
    let parsed: serde_json::Value = serde_json::from_str(reply)
        .map_err(|e| AppError::backend(format!("unexpected reply: {e}")))?;
    let error = parsed.get("error").and_then(|v| v.as_str()).unwrap_or("");
    if error.is_empty() {
        Ok(())
    } else {
        Err(AppError::backend(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 1×1 PNG: enough to exercise the size reader.
    const PNG_1X1: &[u8] = &[
        0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, b'I', b'H', b'D',
        b'R', 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
    ];

    #[test]
    fn reads_png_size() {
        assert_eq!(image_size(PNG_1X1), Some((1, 1)));
    }

    #[test]
    fn rejects_unknown_format() {
        assert_eq!(image_size(b"not an image at all"), None);
    }

    #[test]
    fn rejects_a_picture_below_the_minimum_side() {
        let input = AvatarInput {
            image: base64::engine::general_purpose::STANDARD.encode(PNG_1X1),
            media_type: Some("image/png".into()),
        };
        let err = decode_avatar(&input).expect_err("1x1 must be refused");
        assert!(err.message.contains("smallest side"), "{}", err.message);
    }

    #[test]
    fn rejects_an_unsupported_type() {
        let input = AvatarInput {
            image: "data:application/pdf;base64,AAAA".into(),
            media_type: None,
        };
        let err = decode_avatar(&input).expect_err("pdf must be refused");
        assert!(
            err.message.contains("unsupported image type"),
            "{}",
            err.message
        );
    }

    #[test]
    fn accepts_an_empty_error_as_success() {
        assert!(error_from_reply(r#"{"error":""}"#).is_ok());
    }

    #[test]
    fn reports_a_real_error() {
        let err =
            error_from_reply(r#"{"error":"incorrect current password"}"#).expect_err("must fail");
        assert!(err.message.contains("incorrect current password"));
    }
}
