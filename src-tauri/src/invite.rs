//! Parsing of Status invite links.
//!
//! ## Why this lives in Rust
//!
//! A channel link (`status.app/cc/…`) carries not a UUID but a
//! **brotli-compressed protobuf** describing the channel and community:
//!
//! ```go
//! // pkg/services/sharedurls/service.go
//! func (api *PublicAPI) prepareEncodedCommunityChannelData(...) {
//!     channelData, _ := proto.Marshal(channelProto)
//!     urlData, _ := proto.Marshal(&protobuf.URLData{Content: channelData})
//!     return encodeDataURL(urlData)   // brotli + base64url
//! }
//! ```
//!
//! brotli cannot be decoded in the webview: Chromium's `DecompressionStream`
//! knows gzip and deflate, not brotli. Parsing therefore happens here.
//!
//! `status-go` parses these links too (`sharedurls.Service`) but does not expose
//! it as RPC: `pkg/services/ext/api.go` has no such method. A fork is not needed
//! for that — the format is simple and stable.
//!
//! ## Link forms
//!
//! ```text
//! status.app/c#<key>                 — community, key only
//! status.app/c/<brotli>#<key>        — community, with description
//! status.app/cc/<uuid>#<key>         — channel, by UUID
//! status.app/cc/<brotli>#<key>       — channel, with description (this module)
//! ```
//!
//! The payload always starts with a length byte: `0x1b` becomes `G0…` in base64,
//! and `0x1b` is also the first byte of the compressed stream. This is an
//! observation rather than a format check: the compressed stream for a community
//! and for a channel description starts with `1b`, followed by brotli.
//!
//! A community link (`/c/`, without a second `c`) has no channel, so it is
//! rejected rather than parsed.

use base64::Engine;
use serde::Serialize;

/// What could be extracted from a link.
///
/// `channel_id` is `None` when the link points at a whole community: there is no
/// channel in it, so there is nothing to open.
#[derive(Debug, Serialize)]
pub struct InviteTarget {
    /// Channel UUID (`c42488f6-68cc-455c-a206-a820ecd388d0`).
    pub channel_id: Option<String>,
    /// Channel name from the description — shown before history loads.
    pub channel_name: Option<String>,
    /// Community name from the description.
    pub community_name: Option<String>,
}

/// Parses a `status.app/cc/…` link and extracts the channel UUID.
///
/// Returns `None` only when the link does not contain `/cc/` at all, that is,
/// there is no channel in it by definition. An unreadable payload (broken
/// base64, a foreign format) gives `Some` with `channel_id: None`: the community
/// still opens by the key after `#`, so there is no reason to fail over the
/// channel description.
#[tauri::command]
pub fn parse_invite_link(url: String) -> Option<InviteTarget> {
    let encoded = extract_cc_payload(&url)?;

    // Variant with a ready-made UUID: `status.app/cc/<uuid>#<key>`.
    if let Some(uuid) = as_channel_uuid(&encoded) {
        tracing::debug!(target: "invite", "channel link carries a bare uuid");
        return Some(InviteTarget {
            channel_id: Some(uuid),
            channel_name: None,
            community_name: None,
        });
    }

    let empty = InviteTarget {
        channel_id: None,
        channel_name: None,
        community_name: None,
    };

    let Some(compressed) = decode_base64url(&encoded) else {
        tracing::debug!(target: "invite", "channel link payload is not base64url");
        return Some(empty);
    };
    let Some(decompressed) = decompress_brotli(&compressed) else {
        return Some(empty);
    };

    let parsed = parse_channel_proto(&decompressed);

    tracing::debug!(
        target: "invite",
        "decoded channel link: bytes={} uuid={:?}",
        decompressed.len(),
        parsed.channel_id
    );

    Some(parsed)
}

/// Extracts the part between `/cc/` and `#` (or the end of the string).
fn extract_cc_payload(url: &str) -> Option<String> {
    let (_, rest) = url.split_once("/cc/")?;
    let end = rest.find(['#', '?', '&']).unwrap_or(rest.len());
    Some(rest[..end].trim().to_string())
}

/// Checks whether a value looks like a channel UUID (`channelUUIDRegExp` in
/// status-go).
fn as_channel_uuid(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    let parts: Vec<&str> = lower.split('-').collect();
    let shapes = [8, 4, 4, 4, 12];
    if parts.len() != shapes.len() {
        return None;
    }
    for (part, want) in parts.iter().zip(shapes) {
        if part.len() != want || !part.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
    }
    // Version and variant positions, as in the status-go regexp: the 3rd group
    // starts with 0–5, the 4th with 8/9/a/b.
    let version_ok = parts[2].starts_with(['0', '1', '2', '3', '4', '5']);
    let variant_ok = parts[3].starts_with(['8', '9', 'a', 'b']);
    if !version_ok || !variant_ok {
        return None;
    }
    Some(lower)
}

/// Decodes base64url, with or without padding.
///
/// status-go uses `base64.URLEncoding`, that is, with padding, but browser-side
/// copies may drop it.
fn decode_base64url(input: &str) -> Option<Vec<u8>> {
    let engine = base64::engine::general_purpose::URL_SAFE;
    engine.decode(input).ok().or_else(|| {
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(input)
            .ok()
    })
}

fn decompress_brotli(input: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    match brotli_decompressor::BrotliDecompress(&mut &input[..], &mut out) {
        Ok(_) => Some(out),
        Err(e) => {
            tracing::debug!(target: "invite", "brotli failed: {e}");
            None
        }
    }
}

/// Minimal protobuf parsing: only string fields are needed.
///
/// Structure (`protocol/protobuf/url_data.proto`):
///
/// ```text
/// URLData { bytes content = 1; }
/// Channel { string display_name = 1; string description = 2; bytes emoji = 3;
///           string color = 4; Community community = 5; string uuid = 6; }
/// Community { string display_name = 1; ... }
/// ```
///
/// A full protobuf parser would be overkill here: only two nested fields are
/// needed, and the format is fixed in the spec. Unknown fields are skipped by
/// wire type, so extra data does not break parsing.
fn parse_channel_proto(data: &[u8]) -> InviteTarget {
    let mut target = InviteTarget {
        channel_id: None,
        channel_name: None,
        community_name: None,
    };

    // Outer level is URLData: field 1 (content, bytes) holds the Channel.
    let Some(content) = find_length_delimited(data, 1) else {
        return target;
    };

    // Inside Channel: 1 is display_name, 5 community, 6 uuid.
    target.channel_name =
        find_length_delimited(content, 1).and_then(|b| String::from_utf8(b.to_vec()).ok());
    target.channel_id = find_length_delimited(content, 6)
        .and_then(|b| String::from_utf8(b.to_vec()).ok())
        .and_then(|s| as_channel_uuid(&s));
    target.community_name = find_length_delimited(content, 5)
        .and_then(|community| find_length_delimited(community, 1))
        .and_then(|b| String::from_utf8(b.to_vec()).ok());

    target
}

/// Finds the first field with the given number and the length-delimited wire
/// type (2).
///
/// Returns the field body. Other fields are skipped so that ordering and the
/// presence of optional fields do not affect the result.
fn find_length_delimited(data: &[u8], field_number: u32) -> Option<&[u8]> {
    let mut pos = 0;
    while pos < data.len() {
        let (key, used) = read_varint(&data[pos..])?;
        pos += used;

        let field = (key >> 3) as u32;
        let wire = key & 0x7;

        match wire {
            // Varint: skip the value.
            0 => {
                let (_, used) = read_varint(&data[pos..])?;
                pos += used;
            }
            // 64-bit.
            1 => pos += 8,
            // Length-delimited.
            2 => {
                let (len, used) = read_varint(&data[pos..])?;
                pos += used;
                let len = len as usize;
                if pos + len > data.len() {
                    return None;
                }
                let body = &data[pos..pos + len];
                if field == field_number {
                    return Some(body);
                }
                pos += len;
            }
            // 32-bit.
            5 => pos += 4,
            // Groups (3, 4) are not used in new schemas.
            _ => return None,
        }
    }
    None
}

fn read_varint(data: &[u8]) -> Option<(u64, usize)> {
    let mut value = 0u64;
    let mut shift = 0;
    for (i, byte) in data.iter().take(10).enumerate() {
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some((value, i + 1));
        }
        shift += 7;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real channel link from SIM (community `stauri-akk-test-1131`).
    const CHANNEL_LINK: &str = "https://status.app/cc/G6MAAGRsbYhHPOGJ7cR__Ufp9yLSIjo5YP6-nX7QII88AC6PseEMUlyZ3X-6Wz9LVLJ_xqhNBov43gTuw87TtM3CZnyt35xJbP6-5u5YN7qtQqDjGDRu3QBCGNnfeEAePwMdZv7Dsh-MdZ3JnE0Z_diccsPwJJCGbQMuhA00xRJog2LXdphhOBg=#zQ3shuaXi1bQ6iVowkgm6eUtt5PPToUUpifePDvereeupioks";

    #[test]
    fn parses_real_sim_channel_link() {
        let target = parse_invite_link(CHANNEL_LINK.to_string()).expect("must parse");

        assert_eq!(
            target.channel_id.as_deref(),
            Some("c42488f6-68cc-455c-a206-a820ecd388d0")
        );
        assert_eq!(target.channel_name.as_deref(), Some("general"));
        assert_eq!(
            target.community_name.as_deref(),
            Some("stauri-akk-test-1131")
        );
    }

    #[test]
    fn parses_bare_uuid_channel_link() {
        let target = parse_invite_link(
            "https://status.app/cc/c42488f6-68cc-455c-a206-a820ecd388d0#zQ3shabc".to_string(),
        )
        .expect("must parse");

        assert_eq!(
            target.channel_id.as_deref(),
            Some("c42488f6-68cc-455c-a206-a820ecd388d0")
        );
    }

    #[test]
    fn rejects_community_link() {
        // /c/ is a whole community; the link contains no channel.
        let target = parse_invite_link("https://status.app/c/G0UAAGTcHPB7#zQ3shabc".to_string());
        assert!(target.is_none());
    }

    #[test]
    fn survives_garbage_payload() {
        // Not a connection error: the community still opens by the key.
        let target =
            parse_invite_link("https://status.app/cc/!!!not-base64!!!#zQ3shabc".to_string());
        assert!(target.is_some());
        assert_eq!(target.unwrap().channel_id, None);
    }

    #[test]
    fn reads_varint_across_bytes() {
        // 300 = 0b1_0010_1100 → 0xAC 0x02
        assert_eq!(read_varint(&[0xac, 0x02]), Some((300, 2)));
        assert_eq!(read_varint(&[0x7f]), Some((127, 1)));
        assert_eq!(read_varint(&[]), None);
    }
}
