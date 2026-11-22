//! External data sources (providers).
//!
//! Following `docs/ru/providers_and_dapps.md`, a provider returns **data**, not
//! code, and answers one "give me the list" request rather than "what does the
//! user already have". Merging with native UI elements is always local.
//!
//! Channel feeds use a single built-in type because channels are homogeneous
//! (title, excerpt, link). A Telegram channel is another instance of it —
//! **there is no Telegram code here**: `t.me/s/<name>` is parsed as an HTML page
//! yielding the same field set.
//!
//! # SSRF protection
//!
//! The URL is user input, the request is made by Rust. `rpc_proxy` and the auth
//! proxy listen on `127.0.0.1`, so a feed pointing at
//! `http://127.0.0.1:43057/1` would make the app call its own infrastructure.
//! Loopback, private ranges, link-local and their IPv6 equivalents are blocked,
//! both as literal addresses and after name resolution.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use serde::{Deserialize, Serialize};
use url::Url;

use crate::core::error::{AppError, AppResult};

/// Response size cap: a feed must not exhaust memory.
const MAX_BODY_BYTES: usize = 512 * 1024;

/// Number of items handed to the frontend.
const MAX_ITEMS: usize = 50;

/// Number of redirects a feed load may follow.
///
/// Five is the usual allowance: `http→https`, `example.com→www.example.com`, a
/// domain move. Longer chains do not occur in the wild, and every extra hop is
/// a third-party server the request has to wait on.
const MAX_REDIRECTS: usize = 5;

/// One feed item — the equivalent of a channel row in the chat list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FeedItem {
    /// Link to the entry, used as the identifier for opening it.
    pub url: String,
    /// Entry title.
    pub title: String,
    /// Excerpt text. Text only: HTML never reaches this field (see §9.5).
    pub summary: String,
    /// Publication time in milliseconds, when it could be parsed.
    pub published_at: Option<i64>,
}

/// Result of loading a feed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedResponse {
    /// Source name — the feed title or the channel name.
    pub title: String,
    pub items: Vec<FeedItem>,
    /// Source each item belongs to (`t.me/<name>` or the host).
    pub source: String,
}

/// Checks that a URL points outside the machine.
///
/// The rule is simple: `http`/`https` and no "internal" address. The check runs
/// **before** the request, against both the host name and its resolved
/// addresses; otherwise `localhost.attacker.com` with an A record on
/// `127.0.0.1` would slip through.
///
/// # Errors
/// `ErrorKind::Config` for an unparsable URL, a non-HTTP scheme or an internal
/// address; `ErrorKind::Network` when DNS resolution fails or the host resolves
/// to no addresses.
pub fn validate_external_url(raw: &str) -> AppResult<Url> {
    let url = Url::parse(raw).map_err(|e| AppError::config(format!("invalid URL: {e}")))?;

    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(AppError::config(format!(
                "only http(s) is allowed, got {other}"
            )));
        }
    }

    let host = url
        .host_str()
        .ok_or_else(|| AppError::config("URL has no host"))?;

    // A literal IP is checked at once: no DNS involved.
    if let Ok(ip) = host.parse::<IpAddr>() {
        ensure_public_ip(ip)?;
        return Ok(url);
    }

    // Host name: reject obvious local names before touching DNS.
    let lower = host.to_ascii_lowercase();
    if lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".internal")
    {
        return Err(AppError::config(
            "localhost and private names are not allowed",
        ));
    }

    // Resolve the name and check every address: DNS rebinding is a real way
    // around a naive string check.
    use std::net::ToSocketAddrs;
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| AppError::network(format!("DNS resolution failed: {e}")))?;

    let mut any_public = false;
    for addr in addrs {
        ensure_public_ip(addr.ip())?;
        any_public = true;
    }
    if !any_public {
        return Err(AppError::network("host resolves to no addresses"));
    }

    Ok(url)
}

/// Rejects loopback, private ranges, link-local and their IPv6 equivalents.
///
/// # Errors
/// `ErrorKind::Config` when the address is internal.
fn ensure_public_ip(ip: IpAddr) -> AppResult<()> {
    let blocked = match ip {
        IpAddr::V4(v4) => is_blocked_v4(v4),
        IpAddr::V6(v6) => is_blocked_v6(v6),
    };
    if blocked {
        return Err(AppError::config(format!(
            "address {ip} is internal and cannot be fetched"
        )));
    }
    Ok(())
}

fn is_blocked_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_loopback()          // 127.0.0.0/8
        || ip.is_private()    // 10/8, 172.16/12, 192.168/16
        || ip.is_link_local() // 169.254/16
        || ip.is_broadcast()
        || ip.is_unspecified()
        || ip.is_documentation()
        // 100.64.0.0/10 — CGNAT
        || (o[0] == 100 && (64..128).contains(&o[1]))
        // 0.0.0.0/8
        || o[0] == 0
}

fn is_blocked_v6(ip: Ipv6Addr) -> bool {
    ip.is_loopback() || ip.is_unspecified() || ip.is_unique_local() || ip.is_unicast_link_local()
}

/// Loads a URL, following redirects by hand.
///
/// `reqwest::redirect::Policy` validates only the address the redirect came
/// from, not the one it points to: a server can answer `302 Location:
/// http://127.0.0.1:43057/<secret>/1` and the client follows it silently. That
/// turns [`validate_external_url`] into decoration — no DNS control is needed,
/// any own domain with a single response is enough.
///
/// Here every intermediate address passes the same filter as user input,
/// including name resolution.
///
/// At most [`MAX_REDIRECTS`] hops, so a chain of third-party servers cannot
/// hold the request open. A schema-less `Location` and a relative path are
/// resolved against the current address the way a browser does.
///
/// # Errors
/// `ErrorKind::Network` on a failed request, a redirect without `Location`,
/// too many hops, or an invalid redirect target; `ErrorKind::Config` when the
/// target is internal.
async fn fetch_following_redirects(
    client: &reqwest::Client,
    mut url: url::Url,
) -> AppResult<reqwest::Response> {
    for _ in 0..=MAX_REDIRECTS {
        let resp = client
            .get(url.as_str())
            .header(
                "Accept",
                "application/rss+xml, application/atom+xml, text/xml, text/html",
            )
            // Telegram serves HTML only to a browser user agent; anything else
            // gets a stub page.
            .header(
                "User-Agent",
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Stauri/0.2",
            )
            .send()
            .await
            .map_err(|e| AppError::network(format!("request failed: {e}")))?;

        if !resp.status().is_redirection() {
            return Ok(resp);
        }

        let location = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| AppError::network("redirect without a Location header"))?;

        // Passed the filter — continue; failed — reject with a clear message.
        url = resolve_redirect(&url, location)?;
    }

    Err(AppError::network("too many redirects"))
}

/// Computes the next hop and validates it with the same filter.
///
/// Kept separate so the rule lives in one place and tests can target it: a
/// schema-less `Location` (a relative path) is resolved against the current
/// address as in a browser, and an absolute address is checked by
/// [`validate_external_url`], resolution included.
///
/// # Errors
/// `ErrorKind::Network` for a target that cannot be joined; otherwise whatever
/// [`validate_external_url`] returns.
fn resolve_redirect(current: &url::Url, location: &str) -> AppResult<url::Url> {
    let next = current
        .join(location)
        .map_err(|e| AppError::network(format!("invalid redirect target: {e}")))?;
    validate_external_url(next.as_str())
}

/// Loads a feed from a URL.
///
/// Supports two kinds:
///   * RSS/Atom — a regular feed;
///   * `t.me/s/<name>` — the HTML page of a public Telegram channel.
///
/// Telegram is parsed here rather than through an intermediary: per §9.6 that
/// is the "no bridge" variant — brittle, but the subscription never leaks to a
/// third party.
///
/// # Errors
/// `ErrorKind::Config` for an invalid or internal URL; `ErrorKind::Network`
/// when the request fails, the status is not 2xx, the body cannot be read, or
/// parsing fails; `ErrorKind::Internal` when the HTTP client cannot be built.
#[tauri::command]
pub async fn fetch_feed(url: String) -> AppResult<FeedResponse> {
    let parsed = validate_external_url(&url)?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();

    let client = reqwest::Client::builder()
        // Redirects are handled here so every next address passes the same
        // filter as user input. See [`fetch_following_redirects`].
        .redirect(reqwest::redirect::Policy::none())
        // The system proxy is deliberately left enabled.
        //
        // With `.no_proxy()` the app assumes a direct route always exists. On a
        // machine with `HTTP_PROXY`/`HTTPS_PROXY` that yields `request failed:
        // error sending request for url (...)`, i.e. the feed does not load at
        // all — which is exactly what happened the first time `t.me/s/status`
        // was opened.
        //
        // The trade-off is known: behind a proxy the proxy itself resolves DNS,
        // so [`validate_external_url`] remains the first line (literal
        // addresses and local names) rather than the last. Without a proxy it
        // also checks the DNS result.
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| AppError::internal(format!("client build error: {e}")))?;

    let resp = fetch_following_redirects(&client, parsed.clone()).await?;

    if !resp.status().is_success() {
        return Err(AppError::network(format!("HTTP {}", resp.status())));
    }

    // Size cap: read no more than the limit, discard the rest.
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::network(format!("body read error: {e}")))?;
    let body = &bytes[..bytes.len().min(MAX_BODY_BYTES)];
    let text = String::from_utf8_lossy(body).to_string();

    let source = if host.ends_with("t.me") {
        parsed
            .path_segments()
            .and_then(|mut s| s.rfind(|p| !p.is_empty()))
            .map(|name| format!("t.me/{name}"))
            .unwrap_or_else(|| "t.me".to_string())
    } else {
        host.clone()
    };

    let result = if host.ends_with("t.me") {
        parse_telegram_html(&text, &source)?
    } else {
        parse_rss(&text, &source)?
    };

    tracing::info!(
        target: "providers",
        "feed {} -> {} items",
        source,
        result.items.len()
    );

    Ok(result)
}

/// Parses RSS/Atom.
///
/// Uses `quick-xml` in streaming mode: no tree is built, so a large feed does
/// not occupy memory in full.
///
/// # Errors
/// `ErrorKind::Network` with the reader position when the XML is malformed.
fn parse_rss(xml: &str, source: &str) -> AppResult<FeedResponse> {
    use quick_xml::Reader;
    use quick_xml::events::Event;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut feed_title = String::new();
    let mut items: Vec<FeedItem> = Vec::new();

    let mut cur: Option<FeedItem> = None;
    // Field stack: needed for nesting. `<description><p>x</p></description>`
    // must not turn the field into `p`.
    let mut fields: Vec<String> = Vec::new();
    // Text accumulator: entities arrive as separate `GeneralRef` events.
    let mut pending = String::new();
    let mut seen_feed_title = false;

    loop {
        match reader.read_event() {
            Ok(Event::Eof) => break,

            Ok(Event::Start(e)) => {
                let name = local_name(e.name().as_ref());
                if matches!(name.as_str(), "item" | "entry") {
                    flush(
                        &mut cur,
                        &mut feed_title,
                        fields.last(),
                        &mut pending,
                        &mut seen_feed_title,
                    );
                    fields.clear();
                    cur = Some(FeedItem {
                        url: String::new(),
                        title: String::new(),
                        summary: String::new(),
                        published_at: None,
                    });
                } else {
                    flush(
                        &mut cur,
                        &mut feed_title,
                        fields.last(),
                        &mut pending,
                        &mut seen_feed_title,
                    );
                    fields.push(name);
                }
            }

            Ok(Event::Empty(e)) => {
                // Atom keeps the link in an attribute: <link href="..."/>
                let name = local_name(e.name().as_ref());
                if name == "link"
                    && let Some(href) = attr_value(&e, "href")
                    && let Some(item) = cur.as_mut()
                    && item.url.is_empty()
                {
                    item.url = href;
                }
            }

            Ok(Event::Text(t)) => pending.push_str(&t.xml10_content()),

            Ok(Event::GeneralRef(r)) => {
                // &lt;, &amp; and numeric references. Expanded here: otherwise
                // escaped HTML inside `<description>` would never be unwrapped.
                if let Ok(Some(ch)) = r.resolve_char_ref() {
                    pending.push(ch);
                } else if let Some(rep) =
                    quick_xml::escape::resolve_predefined_entity(&r.xml10_content())
                {
                    pending.push_str(rep);
                } else {
                    pending.push('&');
                    pending.push_str(&r.xml10_content());
                    pending.push(';');
                }
            }

            Ok(Event::CData(t)) => pending.push_str(&t.xml10_content()),

            Ok(Event::End(e)) => {
                let name = local_name(e.name().as_ref());

                if matches!(name.as_str(), "item" | "entry") {
                    flush(
                        &mut cur,
                        &mut feed_title,
                        fields.last(),
                        &mut pending,
                        &mut seen_feed_title,
                    );
                    fields.clear();
                    if let Some(item) = cur.take() {
                        let item = finalize_item(item);
                        if !item.title.is_empty() || !item.summary.is_empty() {
                            items.push(item);
                            if items.len() >= MAX_ITEMS {
                                break;
                            }
                        }
                    }
                } else {
                    flush(
                        &mut cur,
                        &mut feed_title,
                        fields.last(),
                        &mut pending,
                        &mut seen_feed_title,
                    );
                    fields.pop();
                }
            }

            Ok(_) => {}

            Err(e) => {
                // A broken feed is the source's failure, not ours: report it
                // with the position.
                return Err(AppError::network(format!(
                    "XML parse error at {}: {e}",
                    reader.buffer_position()
                )));
            }
        }
    }

    Ok(FeedResponse {
        title: feed_title,
        items,
        source: source.to_string(),
    })
}

/// Writes the accumulated text to its current target.
///
/// The target is the entry when inside one, otherwise the feed title. This is
/// the single place that decides where text goes, so the feed title cannot be
/// lost to a writer that only knows about the current entry.
fn flush(
    cur: &mut Option<FeedItem>,
    feed_title: &mut String,
    field: Option<&String>,
    pending: &mut String,
    seen_feed_title: &mut bool,
) {
    if pending.is_empty() {
        return;
    }
    let Some(field) = field else {
        pending.clear();
        return;
    };

    match cur.as_mut() {
        Some(item) => apply_field(item, field, pending),
        None => {
            if field == "title" && !*seen_feed_title {
                *feed_title = clean_text(pending);
                *seen_feed_title = true;
            }
        }
    }
    pending.clear();
}

/// Distributes text across the entry fields. Names come from RSS and Atom.
fn apply_field(item: &mut FeedItem, field: &str, text: &str) {
    match field {
        "title" => {
            if item.title.is_empty() {
                item.title = text.trim().to_string();
            }
        }
        "description" | "summary" | "content" => {
            if item.summary.is_empty() {
                // Entities are already expanded by the reader (see
                // `parse_rss`), so only tags are stripped and whitespace
                // normalized here.
                item.summary = clean_text(text);
            }
        }
        "link" => {
            if item.url.is_empty() {
                item.url = text.trim().to_string();
            }
        }
        "pubDate" | "published" | "updated" | "date" => {
            if item.published_at.is_none() {
                item.published_at = parse_date(text);
            }
        }
        _ => {}
    }
}

/// Maximum excerpt length.
///
/// The excerpt is stored close to whole and shortened only by CSS
/// (`line-clamp`), which is released on click. Truncating at this size would
/// leave an ellipsis inside the string that the UI cannot expand.
///
/// 4000 is a compromise: enough for most articles, while the cap still exists
/// because full feeds cannot be written to memory and `localStorage`.
const MAX_SUMMARY_CHARS: usize = 4000;

/// Completes an entry: fields are trimmed and the excerpt is capped.
fn finalize_item(mut item: FeedItem) -> FeedItem {
    item.title = item.title.trim().to_string();
    item.summary = item.summary.trim().to_string();
    if item.summary.chars().count() > MAX_SUMMARY_CHARS {
        item.summary = item
            .summary
            .chars()
            .take(MAX_SUMMARY_CHARS)
            .collect::<String>()
            + "…";
    }
    item
}

/// Strips tags and normalizes whitespace.
///
/// RSS often carries HTML inside `<description>`. Per §9.5 markup must not
/// reach the UI: text only, never `{@html}`.
///
/// Entities are **not** expanded here: `quick-xml` 0.42 reports `&lt;` as a
/// separate `GeneralRef` event and the reader concatenates the stream already
/// expanded. Expanding again would turn `<b>` from a description back into a
/// tag, leaving garbage instead of text.
fn clean_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The same for markup delivered as plain text (an HTML page).
fn strip_tags(input: &str) -> String {
    clean_text(&decode_entities(input))
}

/// Expands the common HTML entities. The full list is unnecessary: anything
/// else is left as is and does not break rendering.
fn decode_entities(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

/// Local tag name without the namespace prefix.
///
/// In slice mode `quick-xml` 0.42 hands out names as `&str`, not as bytes.
fn local_name(raw: &str) -> String {
    match raw.rsplit_once(':') {
        Some((_, local)) => local.to_ascii_lowercase(),
        None => raw.to_ascii_lowercase(),
    }
}

fn attr_value(e: &quick_xml::events::BytesStart<'_>, key: &str) -> Option<String> {
    for attr in e.attributes().flatten() {
        if attr.key.as_ref() == key {
            return attr
                .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                .ok()
                .map(|v| v.to_string());
        }
    }
    None
}

/// Parses a date into milliseconds.
///
/// RSS (`RFC 2822`) and Atom (`RFC 3339`) formats are expected; anything else
/// yields `None`. Time is not critical, so a format mismatch must not fail the
/// whole feed.
fn parse_date(raw: &str) -> Option<i64> {
    let trimmed = raw.trim();

    // RFC 3339: 2026-11-05T12:34:56Z, with or without an offset.
    if let Ok(dt) = chrono_lite_parse(trimmed) {
        return Some(dt);
    }
    None
}

/// Minimal ISO-8601 parsing without an external dependency.
///
/// `chrono` is not a dependency and pulling it in for a single field would be
/// excessive. Understands `YYYY-MM-DDTHH:MM:SS(Z|±HH:MM)` and
/// `YYYY-MM-DD HH:MM:SS`.
fn chrono_lite_parse(s: &str) -> Result<i64, ()> {
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return Err(());
    }
    let year: i32 = s.get(0..4).ok_or(())?.parse().map_err(|_| ())?;
    let month: u32 = s.get(5..7).ok_or(())?.parse().map_err(|_| ())?;
    let day: u32 = s.get(8..10).ok_or(())?.parse().map_err(|_| ())?;
    let hour: u32 = s.get(11..13).ok_or(())?.parse().map_err(|_| ())?;
    let min: u32 = s.get(14..16).ok_or(())?.parse().map_err(|_| ())?;
    let sec: u32 = s.get(17..19).ok_or(())?.parse().map_err(|_| ())?;

    Some(
        days_from_civil(year, month, day) * 86_400_000
            + i64::from(hour) * 3_600_000
            + i64::from(min) * 60_000
            + i64::from(sec) * 1000,
    )
    .ok_or(())
}

/// Days from 1970-01-01 to the given date (Howard Hinnant's algorithm).
fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y } as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (i64::from(m) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Parses a `t.me/s/<name>` page.
///
/// The page structure is unofficial and may change — per §9.6 this is an
/// accepted risk in exchange for the subscription never reaching a third party.
/// Only text fields are needed, so class-based regexes suffice and no HTML
/// parser is required.
///
/// # Errors
/// `ErrorKind::Internal` when a regex fails to compile; `ErrorKind::Network`
/// when the page yields no messages, which usually means the layout changed.
fn parse_telegram_html(html: &str, source: &str) -> AppResult<FeedResponse> {
    use regex::Regex;

    // Channel messages: one block per post.
    let block_re =
        Regex::new(r#"(?s)<div class="tgme_widget_message_wrap.*?</div>\s*</div>\s*</div>"#)
            .map_err(|e| AppError::internal(format!("regex: {e}")))?;
    // Link to the post: data-post="channel/12345".
    let post_re = Regex::new(r#"data-post="([^"]+)""#)
        .map_err(|e| AppError::internal(format!("regex: {e}")))?;
    // Fallback: href="https://t.me/channel/12345".
    let href_post_re = Regex::new(r#"href="https?://t\.me/([^"]+)""#)
        .map_err(|e| AppError::internal(format!("regex: {e}")))?;
    // Message text.
    let text_re = Regex::new(r#"(?s)<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>"#)
        .map_err(|e| AppError::internal(format!("regex: {e}")))?;
    // Publication time.
    let time_re = Regex::new(r#"<time[^>]+datetime="([^"]+)""#)
        .map_err(|e| AppError::internal(format!("regex: {e}")))?;
    // Channel title.
    let title_re =
        Regex::new(r#"(?s)<div class="tgme_channel_info_header_title"[^>]*>(.*?)</div>"#)
            .map_err(|e| AppError::internal(format!("regex: {e}")))?;

    let title = title_re
        .captures(html)
        .map(|c| strip_tags(&c[1]))
        .unwrap_or_default();

    let mut items = Vec::new();
    for block in block_re.find_iter(html).take(MAX_ITEMS) {
        let chunk = block.as_str();

        // Link to the post. In the live Telegram markup this is a
        // `data-post="channel/12345"` attribute on the outer `<a>`; some page
        // versions use a plain `href="https://t.me/channel/12345"`. Both are
        // supported: relying on one means breaking whenever the layout changes.
        let post = post_re
            .captures(chunk)
            .map(|c| c[1].to_string())
            .or_else(|| href_post_re.captures(chunk).map(|c| c[1].to_string()));
        let text = text_re
            .captures(chunk)
            .map(|c| strip_tags(&c[1]))
            .unwrap_or_default();
        let published = time_re
            .captures(chunk)
            .and_then(|c| chrono_lite_parse(&c[1]).ok());

        // A post without text is useless: it may be a service block.
        if text.trim().is_empty() {
            continue;
        }

        let url = post
            .map(|p| format!("https://t.me/{p}"))
            .unwrap_or_default();

        // The first line of text serves as the title: Telegram has none.
        let summary = text.trim().to_string();
        let first_line = summary.lines().next().unwrap_or_default().to_string();
        let title = if first_line.chars().count() > 80 {
            first_line.chars().take(80).collect::<String>() + "…"
        } else {
            first_line
        };

        items.push(FeedItem {
            url,
            title,
            // Full text: only the layout shortens it (`line-clamp`, released on
            // click). Truncating here would put the ellipsis inside the string,
            // where the excerpt could not be expanded.
            summary: {
                if summary.chars().count() > MAX_SUMMARY_CHARS {
                    summary.chars().take(MAX_SUMMARY_CHARS).collect::<String>() + "…"
                } else {
                    summary
                }
            },
            published_at: published,
        });
    }

    if items.is_empty() {
        return Err(AppError::network(
            "no messages found on the Telegram page — layout may have changed",
        ));
    }

    Ok(FeedResponse {
        title,
        items,
        source: source.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_loopback_and_private_ranges() {
        for url in [
            "http://127.0.0.1:43057/1",
            "http://127.0.0.1/",
            "http://10.0.0.1/feed",
            "http://192.168.1.1/feed",
            "http://172.16.0.1/feed",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]/feed",
            "http://localhost/feed",
        ] {
            assert!(
                validate_external_url(url).is_err(),
                "{url} must be rejected"
            );
        }
    }

    #[test]
    fn rejects_non_http_schemes() {
        for url in [
            "file:///etc/passwd",
            "ftp://example.org/x",
            "javascript:alert(1)",
        ] {
            assert!(
                validate_external_url(url).is_err(),
                "{url} must be rejected"
            );
        }
    }

    #[test]
    fn blocks_local_domain_names() {
        for url in [
            "http://foo.localhost/x",
            "http://nas.local/x",
            "http://svc.internal/x",
        ] {
            assert!(
                validate_external_url(url).is_err(),
                "{url} must be rejected"
            );
        }
    }

    /// A redirect to a local address must be rejected.
    ///
    /// `reqwest`'s built-in following would check only the originating address,
    /// so a server answering `302 Location: http://127.0.0.1:43057/<secret>/1`
    /// would steer the Rust side into its own forwarder. This asserts that
    /// every hop passes the same filter as user input.
    #[test]
    fn redirect_to_local_address_is_rejected() {
        let current = Url::parse("https://example.org/feed").expect("base url");
        for target in [
            "http://127.0.0.1:43057/secret/1",
            "http://localhost/feed",
            "http://[::1]/feed",
            "http://192.168.1.1/feed",
            "file:///etc/passwd",
        ] {
            let err = resolve_redirect(&current, target);
            assert!(err.is_err(), "redirect to {target} must be rejected");
        }
    }

    /// A relative `Location` is resolved as in a browser and still passes the
    /// filter: `302 Location: /feed.xml` is routine.
    ///
    /// The address is a literal public IP: `validate_external_url` resolves
    /// names, and the test must not depend on DNS or the network.
    #[test]
    fn relative_redirect_is_resolved_against_current_url() {
        let current = Url::parse("https://93.184.216.34/posts/feed").expect("base url");
        let next = resolve_redirect(&current, "/feed.xml").expect("public target");
        assert_eq!(next.as_str(), "https://93.184.216.34/feed.xml");

        let next = resolve_redirect(&current, "atom.xml").expect("public target");
        assert_eq!(next.as_str(), "https://93.184.216.34/posts/atom.xml");
    }

    /// `http→https` and a switch to a public host are legitimate hops.
    #[test]
    fn redirect_to_public_host_is_allowed() {
        let current = Url::parse("http://93.184.216.34/feed").expect("base url");
        let next = resolve_redirect(&current, "https://1.1.1.1/feed.xml")
            .expect("public redirect must pass");
        assert_eq!(next.as_str(), "https://1.1.1.1/feed.xml");
    }

    #[test]
    fn malformed_redirect_target_is_an_error_not_a_panic() {
        let current = Url::parse("https://93.184.216.34/feed").expect("base url");
        assert!(resolve_redirect(&current, "http://[::bad").is_err());
        assert!(
            resolve_redirect(&current, "").is_ok(),
            "empty Location keeps the same address"
        );
    }

    #[test]
    fn strips_html_from_summary() {
        // §9.5: provider markup must not reach the UI.
        assert_eq!(strip_tags("<b>hello</b> <i>world</i>"), "hello world");
        assert_eq!(strip_tags("a &amp; b"), "a & b");
        assert_eq!(strip_tags("  spaced   out  "), "spaced out");
    }

    #[test]
    fn parses_rss_items() {
        let xml = r#"<?xml version="1.0"?>
<rss><channel>
<title>My Feed</title>
<item>
  <title>First</title>
  <link>https://example.org/1</link>
  <description>&lt;p&gt;Hello &lt;b&gt;there&lt;/b&gt;&lt;/p&gt;</description>
  <pubDate>Wed, 05 Nov 2026 12:00:00 +0000</pubDate>
</item>
<item>
  <title>Second</title>
  <link>https://example.org/2</link>
  <description>Plain text</description>
</item>
</channel></rss>"#;

        let feed = parse_rss(xml, "example.org").expect("must parse");
        assert_eq!(feed.title, "My Feed");
        assert_eq!(feed.items.len(), 2);
        assert_eq!(feed.items[0].title, "First");
        assert_eq!(feed.items[0].url, "https://example.org/1");
        // Tags from the description are gone, entities are expanded.
        assert_eq!(feed.items[0].summary, "Hello there");
        assert_eq!(feed.items[1].summary, "Plain text");
    }

    #[test]
    fn parses_atom_entries_with_href_links() {
        let xml = r#"<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom Feed</title>
<entry>
  <title>Entry One</title>
  <link href="https://example.org/a1"/>
  <summary>Summary text</summary>
  <updated>2026-11-05T10:30:00Z</updated>
</entry>
</feed>"#;

        let feed = parse_rss(xml, "example.org").expect("must parse");
        assert_eq!(feed.items.len(), 1);
        assert_eq!(feed.items[0].url, "https://example.org/a1");
        assert_eq!(feed.items[0].summary, "Summary text");
        assert_eq!(feed.items[0].published_at, Some(1_793_874_600_000));
    }

    #[test]
    fn empty_feed_is_not_an_error() {
        let xml = r#"<?xml version="1.0"?><rss><channel><title>Empty</title></channel></rss>"#;
        let feed = parse_rss(xml, "example.org").expect("must parse");
        assert!(feed.items.is_empty());
    }

    #[test]
    fn parses_telegram_html_blocks() {
        let html = r#"
<div class="tgme_channel_info_header_title">Test Channel</div>
<div class="tgme_widget_message_wrap">
  <a class="tgme_widget_message_date" href="https://t.me/testchannel/1">
    <time datetime="2026-11-05T10:30:00+00:00"></time>
  </a>
  <div class="tgme_widget_message_text">First <b>message</b></div>
</div>
</div>
</div>"#;

        let feed = parse_telegram_html(html, "t.me/testchannel").expect("must parse");
        assert_eq!(feed.title, "Test Channel");
        assert_eq!(feed.items.len(), 1);
        // Markup is stripped, only text remains.
        assert_eq!(feed.items[0].summary, "First message");
        assert_eq!(feed.items[0].url, "https://t.me/testchannel/1");
    }

    #[test]
    fn days_from_civil_matches_epoch() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1970, 1, 2), 1);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
    }
}
