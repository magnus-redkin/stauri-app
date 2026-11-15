//! Structured application logging.
//!
//! There are two independent sinks:
//!
//! * **file** — `<data>/<APP_IDENTIFIER>/logs/stauri.<date>.log`, rotated daily,
//!   7 files kept. In a release build this is the main diagnostic source.
//! * **stderr** — what is visible when launched from a terminal. Debug builds
//!   emit from `debug`, release builds only `warn` and above, so launching from
//!   a desktop environment does not clutter the session journal.
//!
//! ## Why secrets are scrubbed at the writer
//!
//! Scrubbing on every `info!` call means eventually forgetting one. Keys leak not
//! only from our own messages but from foreign errors: `reqwest` logs
//! `error sending request for url (https://eth-mainnet.g.alchemy.com/v2/KEY)`,
//! and status-backend prints JSON with `authToken` and providers to stdout.
//! Every sink is therefore wrapped in [`RedactingWriter`], which rewrites the
//! whole line on the way out: once wrapped, it cannot be forgotten.
//!
//! status-go's own `status.log` is left off because it writes full RPC provider
//! URLs including API keys.

use std::io::{self, IsTerminal, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use tracing_appender::non_blocking::{NonBlocking, WorkerGuard};
use tracing_subscriber::EnvFilter;
use tracing_subscriber::Layer;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use crate::env::APP_IDENTIFIER;

/// How many log files to keep under daily rotation.
const KEEP_LOG_FILES: usize = 7;

/// Cap on a line accumulating without a newline, after which it is written as is.
///
/// A guard against garbage: if a stream without `\n` reaches the log, the buffer
/// must not grow without bound.
const MAX_PENDING_LINE: usize = 1024 * 1024;

/// Keeps the background writer thread alive as long as the application runs.
///
/// `WorkerGuard` stops and flushes the queue on `Drop`. It is held until
/// `RunEvent::Exit`, otherwise the buffered log tail is lost on exit — and that
/// is usually where the cause of a crash sits.
static GUARD: OnceLock<Mutex<Option<WorkerGuard>>> = OnceLock::new();

/// Initialises the global subscriber. Calling it again is safe.
///
/// The log directory is resolved without an `AppHandle`: `app_data_dir()` is only
/// available after `.build()`, and logging starts with the first lines. On Linux
/// `app_data_dir()` is `$XDG_DATA_HOME/<identifier>`, which matches
/// `dirs::data_local_dir()`, so the path is the same.
pub fn init() {
    // Android: logs go to logcat (tag "stauri"); there is no file path on a phone.
    #[cfg(target_os = "android")]
    android_logger::init_once(
        android_logger::Config::default().with_max_level(log::LevelFilter::Debug).with_tag("stauri"),
    );
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        // Foreign noise (tauri, reqwest, hyper) is kept at warn: their debug
        // would drown the application's own records.
        //
        // `frontend=` is required separately: webview messages arrive with the
        // target "frontend" (see commands::log_frontend) and do not fall under
        // the `tauri_app_lib=` rule. Without it only ERROR passed, because those
        // are above the `warn` threshold, and debug/info from the frontend were
        // lost.
        EnvFilter::new(if cfg!(debug_assertions) {
            "warn,tauri_app_lib=debug,frontend=debug,status_backend=debug"
        } else {
            "warn,tauri_app_lib=info,frontend=debug,status_backend=info"
        })
    });

    let console_level = if cfg!(debug_assertions) {
        tracing::level_filters::LevelFilter::DEBUG
    } else {
        tracing::level_filters::LevelFilter::WARN
    };

    let console = tracing_subscriber::fmt::layer()
        .with_writer(Redacting::new(io::stderr))
        .with_ansi(io::stderr().is_terminal())
        .with_target(false)
        .with_filter(console_level);

    match file_writer() {
        Some(writer) => {
            let file = tracing_subscriber::fmt::layer()
                .with_writer(Redacting::new(writer))
                .with_ansi(false)
                .with_target(true);
            let _ = tracing_subscriber::registry()
                .with(console)
                .with(file)
                .with(filter)
                .try_init();
        }
        None => {
            // The file is unavailable (no permissions, read-only): do not fail —
            // the application must still run, and stderr remains.
            let _ = tracing_subscriber::registry()
                .with(console)
                .with(filter)
                .try_init();
        }
    }
}

/// Flushes the queue to disk. Call it when the application exits.
pub fn shutdown() {
    if let Some(guard) = GUARD.get()
        && let Ok(mut slot) = guard.lock()
    {
        // `take` destroys the guard, and its `Drop` drains the queue.
        slot.take();
    }
}

/// Log directory: `<data directory>/logs`.
///
/// The data directory comes from `appdirs`: the profile lives there, and it also
/// honours `STAURI_DATA_DIR`. Otherwise logs from a clean copy would land in the
/// main directory and mix with real ones.
pub fn log_dir() -> Option<PathBuf> {
    crate::appdirs::data_dir().map(|base| base.join(APP_IDENTIFIER).join("logs"))
}

fn file_writer() -> Option<NonBlocking> {
    let dir = log_dir()?;
    std::fs::create_dir_all(&dir).ok()?;

    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("stauri")
        .filename_suffix("log")
        .max_log_files(KEEP_LOG_FILES)
        .build(&dir)
        .ok()?;

    let (writer, guard) = tracing_appender::non_blocking(appender);
    let _ = GUARD.set(Mutex::new(Some(guard)));
    Some(writer)
}

// ---------------------------------------------------------------------------
// Secret scrubbing
// ---------------------------------------------------------------------------

/// Sink that rewrites a line before writing it.
///
/// Bytes are accumulated up to a newline: a key must not slip through just
/// because a single `write` split it in two.
pub struct RedactingWriter<W> {
    inner: W,
    pending: Vec<u8>,
}

impl<W> RedactingWriter<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            pending: Vec::new(),
        }
    }
}

impl<W: Write> Write for RedactingWriter<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.pending.extend_from_slice(data);

        while let Some(pos) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=pos).collect();
            let text = String::from_utf8_lossy(&line);
            self.inner.write_all(redact(&text).as_bytes())?;
        }

        if self.pending.len() > MAX_PENDING_LINE {
            let text = String::from_utf8_lossy(&self.pending).into_owned();
            self.inner.write_all(redact(&text).as_bytes())?;
            self.pending.clear();
        }

        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if !self.pending.is_empty() {
            let text = String::from_utf8_lossy(&self.pending).into_owned();
            self.inner.write_all(redact(&text).as_bytes())?;
            self.pending.clear();
        }
        self.inner.flush()
    }
}

/// Wrapper turning any [`MakeWriter`] into a redacting one.
struct Redacting<M> {
    inner: M,
}

impl<M> Redacting<M> {
    fn new(inner: M) -> Self {
        Self { inner }
    }
}

impl<'a, M> MakeWriter<'a> for Redacting<M>
where
    M: MakeWriter<'a>,
{
    type Writer = RedactingWriter<M::Writer>;

    fn make_writer(&'a self) -> Self::Writer {
        RedactingWriter::new(self.inner.make_writer())
    }
}

/// Field and parameter names whose value must not reach the log.
///
/// Compared in normalised form: lowercase without `_` and `-`, so `apiKey`,
/// `api_key` and `API-KEY` are the same.
const SECRET_NAMES: &[&str] = &[
    "key",
    "apikey",
    "token",
    "accesstoken",
    "authtoken",
    "password",
    "passwordhash",
    "secret",
    "privatekey",
    "mnemonic",
    "channelkey",
];

fn is_secret_name(name: &str) -> bool {
    let normalized: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    SECRET_NAMES.contains(&normalized.as_str())
}

/// Scrubs secrets from a log line.
///
/// Two independent checks, because the sources differ:
/// * URL — `https://<host>/v2/<key>`, `?apikey=...`, `user:pass@host`;
/// * JSON — `"authToken":"..."` from status-backend output.
pub fn redact(input: &str) -> String {
    redact_json_fields(&redact_urls(input))
}

const SCHEMES: [&str; 4] = ["https://", "http://", "wss://", "ws://"];

fn redact_urls(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;

    loop {
        let Some(start) = find_scheme(rest) else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start]);

        let after = &rest[start..];
        let end = url_end(after);
        let (url, tail) = after.split_at(end);
        out.push_str(&redact_one_url(url));
        rest = tail;
    }

    out
}

fn find_scheme(input: &str) -> Option<usize> {
    SCHEMES.iter().filter_map(|scheme| input.find(scheme)).min()
}

/// Boundary of a URL: whitespace, a quote, a bracket or a sentence separator.
fn url_end(input: &str) -> usize {
    input
        .char_indices()
        .find(|(_, c)| c.is_whitespace() || "\"'<>()[],;`".contains(*c))
        .map(|(i, _)| i)
        .unwrap_or(input.len())
}

fn redact_one_url(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else {
        return url.to_string();
    };
    let (scheme, rest) = url.split_at(scheme_end + 3);

    let auth_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(auth_end);

    let authority = match authority.rfind('@') {
        Some(at) => format!("***@{}", &authority[at + 1..]),
        None => authority.to_string(),
    };

    let (path, query_and_frag) = match tail.find(['?', '#']) {
        Some(i) => tail.split_at(i),
        None => (tail, ""),
    };

    let (query, fragment) = query_and_frag
        .split_once('#')
        .map_or((query_and_frag, ""), |(q, f)| (q, f));

    let query = match query.strip_prefix('?') {
        Some(params) => format!("?{}", redact_query(params)),
        None => String::new(),
    };
    let fragment = if fragment.is_empty() {
        String::new()
    } else {
        format!("#{fragment}")
    };

    format!("{scheme}{authority}{}{query}{fragment}", redact_path(path))
}

fn redact_path(path: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for (i, segment) in path.split('/').enumerate() {
        let previous = if i > 0 { parts[i - 1].as_str() } else { "" };
        if i > 0 && looks_like_secret_segment(segment, previous) {
            parts.push("***".to_string());
        } else {
            parts.push(segment.to_string());
        }
    }
    parts.join("/")
}

/// A key in a URL path.
///
/// Alchemy and Infura put it right after `v2`/`v3`. Other providers (QuickNode
/// and the like) use a long token as the first path segment instead.
fn looks_like_secret_segment(segment: &str, previous: &str) -> bool {
    if segment.is_empty() {
        return false;
    }
    if previous.eq_ignore_ascii_case("v2") || previous.eq_ignore_ascii_case("v3") {
        return true;
    }
    segment.len() >= 24
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn redact_query(query: &str) -> String {
    query
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some((name, _)) if is_secret_name(name) => format!("{name}=***"),
            _ => pair.to_string(),
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn redact_json_fields(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len() + 8);
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] != b'"' {
            let start = i;
            while i < bytes.len() && bytes[i] != b'"' {
                i += 1;
            }
            out.push_str(&input[start..i]);
            continue;
        }

        let Some((key, after_key)) = read_json_string(input, i) else {
            out.push_str(&input[i..]);
            break;
        };

        let mut colon = after_key;
        while colon < bytes.len() && bytes[colon].is_ascii_whitespace() {
            colon += 1;
        }
        let mut value_start = colon + 1;
        while value_start < bytes.len() && bytes[value_start].is_ascii_whitespace() {
            value_start += 1;
        }

        let is_string_value =
            colon < bytes.len() && bytes[colon] == b':' && bytes.get(value_start) == Some(&b'"');

        if is_string_value && is_secret_name(&key) {
            match read_json_string(input, value_start) {
                Some((_, after_value)) => {
                    // Keep the original spelling of the key and the spaces
                    // around the colon, replacing only the value.
                    out.push_str(&input[i..value_start]);
                    out.push_str("\"***\"");
                    i = after_value;
                    continue;
                }
                None => {
                    out.push_str(&input[i..after_key]);
                    i = after_key;
                    continue;
                }
            }
        }

        out.push_str(&input[i..after_key]);
        i = after_key;
    }

    out
}

/// Reads a JSON string starting at `start` (which must be a `"`).
///
/// Returns the raw contents and the index just past the closing quote. A quote
/// closes the string only when an odd number of backslashes precedes it.
fn read_json_string(input: &str, start: usize) -> Option<(String, usize)> {
    let bytes = input.as_bytes();
    if bytes.get(start) != Some(&b'"') {
        return None;
    }

    let mut raw = String::new();
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => return Some((raw, i + 1)),
            b'\\' if i + 1 < bytes.len() => {
                raw.push(bytes[i] as char);
                raw.push(bytes[i + 1] as char);
                i += 2;
            }
            byte => {
                raw.push(byte as char);
                i += 1;
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_alchemy_key_in_path() {
        assert_eq!(
            redact("GET https://eth-mainnet.g.alchemy.com/v2/abc123def456 done"),
            "GET https://eth-mainnet.g.alchemy.com/v2/*** done"
        );
    }

    #[test]
    fn masks_infura_key_in_path() {
        assert_eq!(
            redact("upstream https://mainnet.infura.io/v3/0123456789abcdef"),
            "upstream https://mainnet.infura.io/v3/***"
        );
    }

    #[test]
    fn masks_long_token_segment() {
        assert_eq!(
            redact("https://example.quiknode.pro/0123456789abcdef0123456789abcdef/"),
            "https://example.quiknode.pro/***/"
        );
    }

    #[test]
    fn masks_secret_query_parameter() {
        assert_eq!(
            redact("https://rpc.example.com/?apikey=secret&chain=1"),
            "https://rpc.example.com/?apikey=***&chain=1"
        );
    }

    #[test]
    fn masks_userinfo() {
        assert_eq!(
            redact("https://user:hunter2@rpc.example.com/1"),
            "https://***@rpc.example.com/1"
        );
    }

    #[test]
    fn keeps_ordinary_urls_intact() {
        let line = "rpc proxy on 127.0.0.1:43057 -> backend :12345";
        assert_eq!(redact(line), line);
        let url = "https://ethereum-rpc.publicnode.com";
        assert_eq!(redact(url), url);
    }

    #[test]
    fn masks_json_token_field() {
        assert_eq!(
            redact(r#"{"authToken":"abcdef","chainId":1}"#),
            r#"{"authToken":"***","chainId":1}"#
        );
    }

    #[test]
    fn masks_json_mnemonic_field_with_spaces() {
        assert_eq!(
            redact(r#"{"mnemonic" : "one two three"}"#),
            r#"{"mnemonic" : "***"}"#
        );
    }

    #[test]
    fn leaves_ordinary_json_alone() {
        let json = r#"{"chainId":1,"name":"Ethereum"}"#;
        assert_eq!(redact(json), json);
    }

    #[test]
    fn masks_every_url_in_a_line() {
        let line = "a https://x.alchemy.com/v2/KEY1 b https://y.infura.io/v3/KEY2 c";
        assert_eq!(
            redact(line),
            "a https://x.alchemy.com/v2/*** b https://y.infura.io/v3/*** c"
        );
    }

    #[test]
    fn writer_redacts_across_write_boundaries() {
        let mut out: Vec<u8> = Vec::new();
        {
            let mut writer = RedactingWriter::new(&mut out);
            // The key is split exactly in the middle: line buffering must glue it
            // back together before scrubbing.
            writer
                .write_all(b"url https://eth-mainnet.g.alchemy.com/v2/abc")
                .unwrap();
            writer.write_all(b"def\nnext line\n").unwrap();
        }
        let text = String::from_utf8(out).unwrap();
        assert_eq!(
            text,
            "url https://eth-mainnet.g.alchemy.com/v2/***\nnext line\n"
        );
    }
}
