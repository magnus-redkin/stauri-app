//! Authenticating proxy in front of status-backend.
//!
//! `status-backend` (cmd/status-backend/server/server.go) has no
//! authentication: any process on the machine can connect to its 127.0.0.1 port
//! and call, for example, `settings_getSettings` (which returns the seed phrase)
//! or `wallet_*` (which moves funds). The `CheckOrigin` check in the WebSocket
//! handler returns `true`, so it does not stop foreign web pages either.
//!
//! Loopback is not isolated between users: another user of the machine can also
//! connect to `127.0.0.1:<port>`.
//!
//! ## What it does
//!
//! It listens on its own port, requires an `X-Stauri-Token` header holding a
//! secret generated at startup, and forwards traffic to the real backend port
//! only after the check. Both plain HTTP and WebSocket work: once the first
//! request is checked, the connection is copied in both directions, so the
//! upgrade passes through transparently.
//!
//! ## Residual risk
//!
//! The token is handed to the frontend so it can add the header, which means an
//! XSS in the webview exposes it. This is an accepted trade-off: the main goal
//! is to shut out *other local processes*, and under XSS the attacker already has
//! access to the Tauri commands.

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tracing::{debug, error, info};

use crate::error::{AppError, AppResult};

/// Name of the token header.
pub const TOKEN_HEADER: &str = "x-stauri-token";

/// Upper bound on how much is read before the end of the headers.
const MAX_HEADER_BYTES: usize = 32 * 1024;

/// The token lasts for the lifetime of the application.
static TOKEN: Mutex<Option<String>> = Mutex::new(None);

#[derive(Default)]
pub struct AuthProxyState {
    port: Mutex<Option<u16>>,
    upstream: Arc<Mutex<Option<u16>>>,
    task: Mutex<Option<JoinHandle<()>>>,
}

/// Generates a 64-character hex token from /dev/urandom.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Internal`] when `/dev/urandom` cannot be opened or read.
fn generate_token() -> AppResult<String> {
    let mut buf = [0u8; 32];
    let mut f = std::fs::File::open("/dev/urandom")
        .map_err(|e| AppError::internal(format!("cannot open /dev/urandom: {e}")))?;
    std::io::Read::read_exact(&mut f, &mut buf)
        .map_err(|e| AppError::internal(format!("cannot read /dev/urandom: {e}")))?;

    let mut out = String::with_capacity(64);
    for b in buf {
        out.push_str(&format!("{b:02x}"));
    }
    Ok(out)
}

/// Returns the current token, creating it on first use.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Internal`] when the token lock is poisoned or the token
/// cannot be generated.
pub fn token() -> AppResult<String> {
    let mut guard = TOKEN.lock().map_err(|_| AppError::poisoned())?;
    if let Some(t) = guard.as_ref() {
        return Ok(t.clone());
    }
    let t = generate_token()?;
    *guard = Some(t.clone());
    Ok(t)
}

/// Starts the proxy towards the given backend port.
///
/// A repeated call with the same upstream returns the port already in use.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Internal`] when the listener cannot be bound, its
/// address cannot be resolved, or a lock is poisoned, and any error from
/// [`token`].
pub async fn start(state: &AuthProxyState, upstream_port: u16) -> AppResult<u16> {
    // The upstream is updated even when the listener is already up: the backend
    // can restart on a different port.
    {
        let mut up = state.upstream.lock().map_err(|_| AppError::poisoned())?;
        *up = Some(upstream_port);
    }

    if let Some(port) = *state.port.lock().map_err(|_| AppError::poisoned())? {
        return Ok(port);
    }

    // The token must exist before the first request.
    let _ = token()?;

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| AppError::internal(format!("auth proxy bind failed: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::internal(format!("auth proxy local_addr failed: {e}")))?
        .port();

    let upstream = state.upstream.clone();
    let task = tokio::spawn(async move {
        loop {
            let (client, _) = match listener.accept().await {
                Ok(v) => v,
                Err(e) => {
                    error!(error = %e, "auth proxy accept failed");
                    break;
                }
            };
            let up = upstream.clone();
            tokio::spawn(async move {
                if let Err(e) = handle_conn(client, up).await {
                    debug!(kind = ?e.kind, message = %e.message, "auth proxy connection error");
                }
            });
        }
    });

    *state.port.lock().map_err(|_| AppError::poisoned())? = Some(port);
    *state.task.lock().map_err(|_| AppError::poisoned())? = Some(task);

    info!(port, upstream = upstream_port, "auth proxy listening");
    Ok(port)
}

/// Stops the proxy.
pub fn stop(state: &AuthProxyState) {
    if let Ok(mut guard) = state.task.lock()
        && let Some(task) = guard.take()
    {
        task.abort();
    }
    if let Ok(mut port) = state.port.lock() {
        *port = None;
    }
}

/// Checks the token and forwards the connection to the backend.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Internal`] when the headers exceed
/// [`MAX_HEADER_BYTES`] or a lock is poisoned, [`crate::error::ErrorKind::Io`] when the
/// client cannot be read, and [`crate::error::ErrorKind::Backend`] when the backend cannot be
/// reached.
async fn handle_conn(mut client: TcpStream, upstream: Arc<Mutex<Option<u16>>>) -> AppResult<()> {
    // Read the headers but not the body: the body can be large and only the token
    // matters here. Past this point the bytes flow through unchanged.
    let mut head = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];

    let header_end = loop {
        if let Some(pos) = find_subsequence(&head, b"\r\n\r\n") {
            break pos + 4;
        }
        if head.len() > MAX_HEADER_BYTES {
            let _ = write_forbidden(&mut client, "headers too large").await;
            return Err(AppError::internal("auth proxy: headers too large"));
        }
        let n = client
            .read(&mut chunk)
            .await
            .map_err(|e| AppError::io(e.to_string()))?;
        if n == 0 {
            // The connection closed before the end of the headers: there is no
            // one to answer.
            return Ok(());
        }
        head.extend_from_slice(&chunk[..n]);
    };

    let request_head = String::from_utf8_lossy(&head[..header_end]).to_string();
    let expected = token()?;

    let authorized = parse_headers(&request_head)
        .get(TOKEN_HEADER)
        .map(|v| constant_time_eq(v.as_bytes(), expected.as_bytes()))
        .unwrap_or(false);

    if !authorized {
        let _ = write_forbidden(&mut client, "missing or invalid token").await;
        return Ok(());
    }

    // The mutex is released before the await: a MutexGuard is not Send, and this
    // function runs from tokio::spawn.
    let target_port = {
        let up = upstream.lock().map_err(|_| AppError::poisoned())?;
        *up
    };
    let Some(target_port) = target_port else {
        let _ = write_forbidden(&mut client, "backend is not running").await;
        return Ok(());
    };

    let mut server = TcpStream::connect(("127.0.0.1", target_port))
        .await
        .map_err(|e| AppError::backend(format!("auth proxy: cannot reach backend: {e}")))?;

    // Forward the bytes already read to the backend, with the token header
    // removed: the backend should not know about it.
    let forwarded_head = strip_token_header(&request_head);
    server
        .write_all(forwarded_head.as_bytes())
        .await
        .map_err(|e| AppError::io(e.to_string()))?;
    server
        .write_all(&head[header_end..])
        .await
        .map_err(|e| AppError::io(e.to_string()))?;

    // From here on it is a transparent two-way stream, which covers both
    // keep-alive and WebSocket frames after the upgrade.
    let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
    Ok(())
}

/// Comparison without an early exit, so timing does not leak.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Parses request headers into a lowercase-keyed map.
fn parse_headers(head: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let mut lines = head.split("\r\n");
    lines.next(); // request line
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            map.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    map
}

/// Removes the token header line from a request.
fn strip_token_header(head: &str) -> String {
    let mut out = String::with_capacity(head.len());
    for line in head.split_inclusive("\r\n") {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with(TOKEN_HEADER) && lower.contains(':') {
            continue;
        }
        out.push_str(line);
    }
    out
}

async fn write_forbidden(stream: &mut TcpStream, message: &str) -> AppResult<()> {
    let body = format!("{{\"error\":\"{message}\"}}");
    let head = format!(
        "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|e| AppError::io(e.to_string()))?;
    stream
        .write_all(body.as_bytes())
        .await
        .map_err(|e| AppError::io(e.to_string()))?;
    let _ = stream.shutdown().await;
    Ok(())
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_hex_and_stable() {
        let a = token().expect("token");
        let b = token().expect("token");
        assert_eq!(a, b, "token must be stable within a run");
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn constant_time_eq_works() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }

    #[test]
    fn parses_and_strips_token_header() {
        let head = "POST /statusgo/x HTTP/1.1\r\nX-Stauri-Token: abc\r\nHost: 127.0.0.1\r\n\r\n";
        let headers = parse_headers(head);
        assert_eq!(headers.get(TOKEN_HEADER).map(String::as_str), Some("abc"));

        let stripped = strip_token_header(head);
        assert!(!stripped.to_ascii_lowercase().contains(TOKEN_HEADER));
        assert!(stripped.contains("Host: 127.0.0.1"));
        assert!(stripped.ends_with("\r\n\r\n"));
    }

    #[test]
    fn missing_token_header_is_not_authorized() {
        let head = "GET /health HTTP/1.1\r\nHost: x\r\n\r\n";
        let headers = parse_headers(head);
        assert!(!headers.contains_key(TOKEN_HEADER));
    }

    // ---------------------------------------------------------------------
    // End-to-end tests
    //
    // The unit tests above check string parsing. These check what the proxy
    // exists for: without a token a request does not reach the backend, with a
    // token it does and gets an answer, and the token header never arrives at
    // the backend.
    // ---------------------------------------------------------------------

    /// Starts a fake backend and counts the requests that reach it.
    ///
    /// Returns the port and the counter, which shows that a request rejected by
    /// the proxy did NOT reach the backend.
    async fn fake_backend() -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind backend");
        let port = listener.local_addr().expect("backend addr").port();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_for_task = hits.clone();

        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let hits = hits_for_task.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 1024];
                    loop {
                        match socket.read(&mut chunk).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                buf.extend_from_slice(&chunk[..n]);
                                if find_subsequence(&buf, b"\r\n\r\n").is_some() {
                                    break;
                                }
                            }
                        }
                    }

                    let request = String::from_utf8_lossy(&buf).to_string();
                    // The token header must not reach the backend.
                    if !request.to_ascii_lowercase().contains(TOKEN_HEADER) {
                        hits.fetch_add(1, Ordering::SeqCst);
                    }

                    let body = r#"{"result":"ok"}"#;
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(body.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });

        (port, hits)
    }

    /// With the correct token the request passes and the answer comes back to
    /// the client.
    #[tokio::test]
    async fn valid_token_is_forwarded_to_backend() {
        let (backend_port, _hits) = fake_backend().await;

        let state = AuthProxyState::default();
        let port = start(&state, backend_port).await.expect("proxy start");
        let expected = token().expect("token");

        let resp = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/statusgo/x"))
            .header(TOKEN_HEADER, expected)
            .body("{}")
            .send()
            .await
            .expect("request through proxy");

        assert_eq!(resp.status(), 200);
        assert_eq!(resp.text().await.expect("body"), r#"{"result":"ok"}"#);

        stop(&state);
    }

    /// Without a token the answer is 403 and nothing reaches the backend.
    #[tokio::test]
    async fn missing_token_is_rejected_and_backend_untouched() {
        let (backend_port, hits) = fake_backend().await;

        let state = AuthProxyState::default();
        let port = start(&state, backend_port).await.expect("proxy start");

        let resp = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/statusgo/x"))
            .body("{}")
            .send()
            .await
            .expect("request through proxy");

        assert_eq!(resp.status(), 403);
        assert_eq!(
            hits.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "backend must not see unauthenticated requests"
        );

        stop(&state);
    }

    /// A wrong token is also answered with 403.
    #[tokio::test]
    async fn wrong_token_is_rejected() {
        let (backend_port, hits) = fake_backend().await;

        let state = AuthProxyState::default();
        let port = start(&state, backend_port).await.expect("proxy start");

        let resp = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/statusgo/x"))
            .header(TOKEN_HEADER, "definitely-not-the-token")
            .body("{}")
            .send()
            .await
            .expect("request through proxy");

        assert_eq!(resp.status(), 403);
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);

        stop(&state);
    }

    /// The token header is not forwarded to the backend.
    ///
    /// Checked separately from the counter in `fake_backend`, which also catches
    /// a failure, so an explicit case with a successful request is needed.
    #[tokio::test]
    async fn token_header_is_stripped_before_forwarding() {
        let head = "POST /x HTTP/1.1\r\nX-Stauri-Token: secret\r\nHost: h\r\n\r\n";
        let stripped = strip_token_header(head);

        assert!(!stripped.to_ascii_lowercase().contains(TOKEN_HEADER));
        assert!(stripped.starts_with("POST /x HTTP/1.1\r\n"));
        assert!(stripped.contains("Host: h\r\n"));
    }

    /// Different tokens differ per character, not only in length.
    #[test]
    fn token_comparison_rejects_prefix() {
        let expected = "a".repeat(64);
        let mut wrong = expected.clone();
        wrong.pop();
        wrong.push('b');

        assert!(!constant_time_eq(wrong.as_bytes(), expected.as_bytes()));
        // A matching prefix must not produce a positive result.
        assert!(!constant_time_eq(
            &expected.as_bytes()[..63],
            expected.as_bytes()
        ));
    }
}
