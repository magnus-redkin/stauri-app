//! Local HTTP forwarder for RPC.
//!
//! status-go reuses TCP connections from its pool (`http.DefaultTransport`),
//! and on this channel those connections die silently: the socket stays ESTAB,
//! packets go out, no replies come back, and retries pile up until
//! `tcp_retries2`. A request to a healthy RPC then hangs for 20 seconds and
//! trips the circuit breaker's timeout.
//!
//! So status-go talks to `http://127.0.0.1:<port>/<secret>/<chainId>` instead
//! of the provider, and this forwarder opens a NEW connection to the upstream
//! for every request (pooling disabled via `pool_max_idle_per_host(0)`) — the
//! way curl behaves, which works under the same conditions.
//!
//! # Why the secret lives in the path
//!
//! The caller is **status-go**, not our frontend: the provider URL is written
//! through `networks_setChainUserRpcProviders` and used inside the node. The
//! node will not send an `X-Stauri-Token` header, so the protection has to be
//! part of the URL — the only thing that can be handed over.
//!
//! Without it, any process on the machine (and any site opened in the dApp
//! WebView) could reach `127.0.0.1:<port>/1` and use the RPC. A request with no
//! parameters used to answer `HTTP 200`.
//!
//! The secret is generated once, stored in a file and survives restarts:
//! provider URLs are already recorded in the status-go database, and a random
//! secret on the next start would leave them pointing at nothing.

use crate::error::{AppError, AppResult};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tracing::{debug, error, info};

/// Maximum size of an incoming request's headers and body.
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

/// Port the forwarder tries to take.
///
/// The port must be stable: provider URLs
/// (`http://127.0.0.1:<port>/<chain>`) are stored in the status-go database and
/// survive an app restart. With a random port, on the next start the provider
/// would point at nothing and the RPC client created during node
/// initialization would already be broken.
const PREFERRED_PORT: u16 = 43057;

/// Secret length in the path, in hex characters.
///
/// 32 characters = 128 bits of entropy. Brute-forcing it over the network is
/// pointless, while a short one would be guessable from the same machine.
const SECRET_HEX_LEN: usize = 32;

type Upstreams = Arc<Mutex<HashMap<u64, String>>>;

struct Handle {
    port: u16,
    /// Secret that must be present in every request path.
    secret: String,
    task: tokio::task::JoinHandle<()>,
    upstreams: Upstreams,
}

#[derive(Default)]
pub struct RpcProxyState {
    handle: Mutex<Option<Handle>>,
}

impl RpcProxyState {
    pub fn port(&self) -> Option<u16> {
        self.handle.lock().ok()?.as_ref().map(|h| h.port)
    }

    /// Path secret. `None` when the forwarder is not running.
    pub fn secret(&self) -> Option<String> {
        self.handle.lock().ok()?.as_ref().map(|h| h.secret.clone())
    }
}

/// Directory for the secret — next to the application config.
fn secret_path() -> Option<std::path::PathBuf> {
    let dir = crate::appdirs::config_dir()?.join(env_identifier());
    Some(dir.join("rpc-proxy.secret"))
}

fn env_identifier() -> &'static str {
    crate::env::APP_IDENTIFIER
}

/// Reads the secret from a file, or creates a new one.
///
/// The file is used rather than memory because a provider URL
/// (`http://127.0.0.1:<port>/<secret>/<chainId>`) is written to the status-go
/// database and survives a restart. With an in-memory secret, on the next start
/// every provider would point at nothing and the wallet would have no RPC.
///
/// On Unix the file is created with mode `0600`: the secret grants access to
/// the forwarder and through it to the RPC endpoints.
///
/// # Errors
/// `ErrorKind::Config` when the config directory cannot be determined;
/// `ErrorKind::Io` when the directory or the file cannot be created or
/// written; `ErrorKind::Internal` when randomness cannot be read.
fn load_or_create_secret() -> AppResult<String> {
    let path = secret_path()
        .ok_or_else(|| AppError::config("cannot determine config dir for rpc proxy secret"))?;

    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim().to_string();
        if trimmed.len() == SECRET_HEX_LEN && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(trimmed);
        }
        // The file exists but holds garbage: regenerate it instead of failing.
        // The worst consequence is a mismatch with the providers in the
        // database, and `configureWalletRpc` rewrites them with the new URL.
        debug!(?path, "rpc proxy secret file is malformed, regenerating");
    }

    if let Some(parent) = path.parent()
        && let Err(e) = std::fs::create_dir_all(parent)
    {
        return Err(AppError::io(format!(
            "cannot create config dir for rpc proxy secret: {e}"
        )));
    }

    let secret = generate_secret()?;

    // Permissions are set before writing so the file is never readable.
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| AppError::io(format!("cannot create secret file: {e}")))?;
        file.write_all(secret.as_bytes())
            .map_err(|e| AppError::io(format!("cannot write secret file: {e}")))?;
    }

    #[cfg(not(unix))]
    {
        // Only a warning here, not an ACL.
        //
        // The secret grants access to the RPC forwarder. On Unix the file is
        // created with `0600` (branch above); on Windows it inherits the
        // directory's permissions, i.e. it is readable by other users of the
        // machine.
        //
        // It could be restricted with `SetNamedSecurityInfoW` through
        // `windows-sys`, but this build does not compile or test on Windows,
        // and unverified ACL code is more dangerous than none: a bug in the
        // permissions looks like working protection. Until then the platform
        // states its condition explicitly.
        //
        // Practical consequence: Stauri ships as a Linux AppImage, so on the
        // current platform this is not an open hole.
        std::fs::write(&path, secret.as_bytes())
            .map_err(|e| AppError::io(format!("cannot write secret file: {e}")))?;
        tracing::warn!(
            "rpc proxy secret has default permissions on this platform; \
             other local users may read it"
        );
    }

    info!(?path, "rpc proxy secret generated");
    Ok(secret)
}

/// 16 random bytes in hex.
fn generate_secret() -> AppResult<String> {
    use std::io::Read;
    let mut buf = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| AppError::internal(format!("cannot read randomness: {e}")))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Starts the forwarder with a chainId -> upstream map.
///
/// A repeated call returns the port already in use and does not start a second
/// listener, but the upstream map is updated.
///
/// The port must never change silently: the provider URL
/// (`http://127.0.0.1:<port>/<chain>`) is stored in the status-go database and
/// survives a restart. Taking a random port at startup would leave the client
/// built during node initialization pointing at `<port>`, where it would either
/// get answers from a **foreign** process if one listens there — requests going
/// somewhere unknown — or be refused and look like "the provider is dead".
///
/// Hence the fixed port: if it is taken, an error explains why. The caller
/// decides what to do instead of silently receiving a broken configuration.
///
/// # Errors
/// `ErrorKind::Config` when the config directory cannot be determined;
/// `ErrorKind::Io` when the secret file cannot be written; `ErrorKind::Internal`
/// when the port is taken or the client cannot be built.
pub async fn start(state: &RpcProxyState, upstreams: HashMap<u64, String>) -> AppResult<u16> {
    start_on(state, upstreams, PREFERRED_PORT).await
}

/// Starts on the given port. `0` means any free port.
///
/// Separate from [`start`] so tests do not fight over the production port: two
/// `#[tokio::test]` cases run in parallel and would both bind 43057.
///
/// # Errors
/// `ErrorKind::Config` when the config directory cannot be determined;
/// `ErrorKind::Io` when the secret file cannot be written; `ErrorKind::Internal`
/// when the port cannot be bound or the client cannot be built.
pub async fn start_on(
    state: &RpcProxyState,
    upstreams: HashMap<u64, String>,
    preferred: u16,
) -> AppResult<u16> {
    if let Some(port) = state.port() {
        set_upstreams(state, upstreams);
        return Ok(port);
    }

    let secret = load_or_create_secret()?;

    let listener = TcpListener::bind(("127.0.0.1", preferred))
        .await
        .map_err(|e| {
            AppError::internal(format!(
                "RPC-провайдеры указывают на 127.0.0.1:{preferred}, но этот порт занят ({e}). \
                 Скорее всего работает другая копия Stauri — закройте её и перезапустите приложение."
            ))
        })?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::internal(format!("rpc proxy local_addr failed: {e}")))?
        .port();

    let shared: Upstreams = Arc::new(Mutex::new(upstreams));

    // Pooling is disabled: each connection serves one request. That is the
    // whole point of the fix.
    let client = reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| AppError::internal(format!("rpc proxy client failed: {e}")))?;

    let task = tokio::spawn(accept_loop(
        listener,
        client,
        shared.clone(),
        secret.clone(),
    ));

    if let Ok(mut guard) = state.handle.lock() {
        *guard = Some(Handle {
            port,
            secret,
            task,
            upstreams: shared,
        });
    }

    info!(port, "rpc proxy listening");
    Ok(port)
}

pub fn stop(state: &RpcProxyState) {
    if let Ok(mut guard) = state.handle.lock()
        && let Some(handle) = guard.take()
    {
        handle.task.abort();
        info!(port = handle.port, "rpc proxy stopped");
    }
}

pub fn set_upstreams(state: &RpcProxyState, map: HashMap<u64, String>) {
    let guard = match state.handle.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(handle) = guard.as_ref()
        && let Ok(mut target) = handle.upstreams.lock()
    {
        *target = map;
    }
}

async fn accept_loop(
    listener: TcpListener,
    client: reqwest::Client,
    upstreams: Upstreams,
    secret: String,
) {
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(pair) => pair,
            Err(e) => {
                error!(error = %e, "rpc proxy accept failed");
                continue;
            }
        };
        let client = client.clone();
        let upstreams = upstreams.clone();
        let secret = secret.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(stream, client, upstreams, &secret).await {
                debug!(kind = ?e.kind, message = %e.message, "rpc proxy request failed");
            }
        });
    }
}

/// Constant-time comparison, so the secret cannot be guessed character by
/// character from response timing.
fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

async fn handle_conn(
    mut stream: TcpStream,
    client: reqwest::Client,
    upstreams: Upstreams,
    secret: &str,
) -> AppResult<()> {
    let (request_line, _headers, body) = read_request(&mut stream).await?;

    let path = request_line.split_whitespace().nth(1).unwrap_or("/");
    let mut parts = path
        .trim_start_matches('/')
        .split('?')
        .next()
        .unwrap_or("")
        .split('/');

    let given_secret = parts.next().unwrap_or("");
    let chain_part = parts.next().unwrap_or("");

    // The secret is checked before any parsing: a wrong path must not reveal
    // whether a given chain exists, and must not count as an error.
    if !constant_time_eq(given_secret, secret) {
        // Answer as if the resource were missing rather than with 403:
        // otherwise a foreign program learns it hit our forwarder and can keep
        // guessing. The secret is never logged.
        debug!("rpc proxy request with invalid secret rejected");
        return write_plain(&mut stream, 404, "not found").await;
    }

    let chain_id: u64 = chain_part
        .parse()
        .map_err(|_| AppError::internal(format!("bad chain id in path: {path}")))?;

    let upstream = {
        let guard = upstreams.lock().map_err(|_| AppError::poisoned())?;
        guard.get(&chain_id).cloned()
    };
    let Some(upstream) = upstream else {
        return write_plain(&mut stream, 503, "no upstream configured for chain").await;
    };

    let response = match client
        .post(&upstream)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            // Return 502 with a JSON-RPC error instead of dropping the
            // connection silently: otherwise ethclient sees EOF and wastes time
            // retrying, although the cause is already known.
            let body = format!(
                "{{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{{\"code\":-32603,\"message\":\"rpc proxy: {}\"}}}}",
                e.to_string().replace('\\', "\\\\").replace('"', "\\\"")
            );
            return write_json(&mut stream, 502, body.as_bytes()).await;
        }
    };

    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| AppError::network(format!("upstream body read failed: {e}")))?;

    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        reason(status),
        bytes.len()
    );
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|e| AppError::io(e.to_string()))?;
    stream
        .write_all(&bytes)
        .await
        .map_err(|e| AppError::io(e.to_string()))?;
    let _ = stream.shutdown().await;
    Ok(())
}

/// Serves a JSON body with the given status and closes the connection.
async fn write_json(stream: &mut TcpStream, status: u16, body: &[u8]) -> AppResult<()> {
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        reason(status),
        body.len()
    );
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|e| AppError::io(e.to_string()))?;
    stream
        .write_all(body)
        .await
        .map_err(|e| AppError::io(e.to_string()))?;
    let _ = stream.shutdown().await;
    Ok(())
}

/// Reads a whole request: request line, headers and a body of `Content-Length`.
///
/// # Errors
/// `ErrorKind::Internal` when the headers or the body exceed their caps, or
/// when the connection closes before either is complete; `ErrorKind::Io` on a
/// read error.
async fn read_request(
    stream: &mut TcpStream,
) -> AppResult<(String, HashMap<String, String>, Vec<u8>)> {
    let mut buf = Vec::with_capacity(8192);
    let mut chunk = [0u8; 4096];

    let header_end = loop {
        if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
            break pos + 4;
        }
        if buf.len() > MAX_HEADER_BYTES {
            return Err(AppError::internal("headers too large"));
        }
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| AppError::io(e.to_string()))?;
        if n == 0 {
            return Err(AppError::internal("connection closed before headers"));
        }
        buf.extend_from_slice(&chunk[..n]);
    };

    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("").to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let content_length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if content_length > MAX_BODY_BYTES {
        return Err(AppError::internal("body too large"));
    }

    let mut body = buf[header_end..].to_vec();
    while body.len() < content_length {
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| AppError::io(e.to_string()))?;
        if n == 0 {
            return Err(AppError::internal("connection closed before body"));
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(content_length);

    Ok((request_line, headers, body))
}

async fn write_plain(stream: &mut TcpStream, code: u16, message: &str) -> AppResult<()> {
    let body = format!(
        "{{\"jsonrpc\":\"2.0\",\"error\":{{\"code\":-32603,\"message\":\"{}\"}}}}",
        message
    );
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        code,
        reason(code),
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
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Starts a local HTTP server answering with a fixed JSON body.
    ///
    /// Used instead of a real provider: tests must not touch the network,
    /// otherwise they fail in CI without internet and suffer from other
    /// people's rate limits.
    async fn mock_upstream(response_body: &'static str) -> (u16, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind mock");
        let port = listener.local_addr().expect("mock addr").port();

        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    // The request is read in full so the client does not get an RST.
                    let _ = read_request(&mut socket).await;
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        response_body.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(response_body.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });

        (port, handle)
    }

    /// Builds a forwarder URL the way the frontend does in `rpcConfig.ts`: the
    /// secret is the first path segment.
    fn url_for(state: &RpcProxyState, port: u16, tail: &str) -> String {
        let secret = state.secret().expect("running proxy must expose a secret");
        format!("http://127.0.0.1:{port}/{secret}/{tail}")
    }

    /// End to end: request to the local port -> a separate socket to the
    /// upstream -> the JSON-RPC answer back to the client.
    #[tokio::test]
    async fn proxies_json_rpc_request() {
        let (mock_port, mock) =
            mock_upstream(r#"{"jsonrpc":"2.0","id":1,"result":"0x1234"}"#).await;

        let state = RpcProxyState::default();
        let mut map = HashMap::new();
        map.insert(1u64, format!("http://127.0.0.1:{mock_port}"));
        let port = start_on(&state, map, 0)
            .await
            .expect("proxy should start on any free port");

        let client = reqwest::Client::new();
        let resp = client
            .post(url_for(&state, port, "1"))
            .header("Content-Type", "application/json")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}"#)
            .send()
            .await
            .expect("request to proxy should succeed");

        assert_eq!(resp.status(), 200);
        let text = resp.text().await.expect("body text");
        let body: serde_json::Value = serde_json::from_str(&text).expect("json body");
        assert_eq!(
            body.get("result").and_then(|v| v.as_str()),
            Some("0x1234"),
            "proxy must pass the upstream body through unchanged: {body}"
        );

        stop(&state);
        mock.abort();
    }

    /// An unknown network must answer 503, not time out silently.
    #[tokio::test]
    async fn unknown_chain_returns_503() {
        let state = RpcProxyState::default();
        let port = start_on(&state, HashMap::new(), 0)
            .await
            .expect("proxy should start on any free port");

        let client = reqwest::Client::new();
        let resp = client
            .post(url_for(&state, port, "999"))
            .body("{}")
            .send()
            .await
            .expect("request should complete");

        assert_eq!(resp.status(), 503);
        stop(&state);
    }

    /// A dead upstream yields 502 with a JSON-RPC error, not a dropped
    /// connection.
    ///
    /// Otherwise ethclient sees EOF and wastes time retrying, although the
    /// cause is already known.
    #[tokio::test]
    async fn dead_upstream_returns_502() {
        // Take a port and release it at once: almost certainly nothing is there.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let dead_port = listener.local_addr().expect("addr").port();
        drop(listener);

        let state = RpcProxyState::default();
        let mut map = HashMap::new();
        map.insert(1u64, format!("http://127.0.0.1:{dead_port}"));
        let port = start_on(&state, map, 0).await.expect("proxy start");

        let resp = reqwest::Client::new()
            .post(url_for(&state, port, "1"))
            .body("{}")
            .send()
            .await
            .expect("proxy must answer, not drop the connection");

        assert_eq!(resp.status(), 502);
        let text = resp.text().await.expect("body");
        assert!(
            text.contains("\"error\""),
            "expected JSON-RPC error body, got: {text}"
        );

        stop(&state);
    }

    /// The table changes at runtime: a new chainId becomes available without
    /// restarting the forwarder.
    #[tokio::test]
    async fn set_upstreams_takes_effect_without_restart() {
        let (mock_port, mock) = mock_upstream(r#"{"jsonrpc":"2.0","id":1,"result":"0x1"}"#).await;

        let state = RpcProxyState::default();
        let port = start_on(&state, HashMap::new(), 0)
            .await
            .expect("proxy start");

        let client = reqwest::Client::new();
        let url = url_for(&state, port, "42161");

        // The network is absent before the table is updated.
        assert_eq!(
            client.post(&url).body("{}").send().await.unwrap().status(),
            503
        );

        let mut map = HashMap::new();
        map.insert(42161u64, format!("http://127.0.0.1:{mock_port}"));
        set_upstreams(&state, map);

        assert_eq!(
            client.post(&url).body("{}").send().await.unwrap().status(),
            200
        );

        stop(&state);
        mock.abort();
    }

    /// A malformed chainId must not bring the process down.
    #[tokio::test]
    async fn bad_chain_id_does_not_panic() {
        let state = RpcProxyState::default();
        let port = start_on(&state, HashMap::new(), 0)
            .await
            .expect("proxy start");

        let resp = reqwest::Client::new()
            .post(url_for(&state, port, "not-a-number"))
            .body("{}")
            .send()
            .await;

        // The connection may be closed without a response — what matters is
        // that the process survives and the next request is served.
        let _ = resp;

        let ok = reqwest::Client::new()
            .post(url_for(&state, port, "999"))
            .body("{}")
            .send()
            .await
            .expect("proxy must still serve requests");
        assert_eq!(ok.status(), 503);

        stop(&state);
    }

    /// A request without the secret in its path must be rejected.
    ///
    /// Without the secret, any process on the machine (and any page in the dApp
    /// WebView) could reach `127.0.0.1:<port>/1` and get `HTTP 200` — that is,
    /// access to the RPC.
    ///
    /// The answer is 404 rather than 403: a 403 would confirm that a forwarder
    /// lives on the port and suggest probing further.
    #[tokio::test]
    async fn request_without_secret_is_rejected() {
        let (mock_port, mock) = mock_upstream(r#"{"jsonrpc":"2.0","id":1,"result":"0x1"}"#).await;

        let state = RpcProxyState::default();
        let mut map = HashMap::new();
        map.insert(1u64, format!("http://127.0.0.1:{mock_port}"));
        let port = start_on(&state, map, 0).await.expect("proxy start");

        let client = reqwest::Client::new();

        // A bare chainId without the secret — exactly the shape of the hole.
        let bare = client
            .post(format!("http://127.0.0.1:{port}/1"))
            .body("{}")
            .send()
            .await
            .expect("proxy must answer");
        assert_eq!(
            bare.status(),
            404,
            "request without secret must be rejected"
        );

        // A foreign secret of the same length.
        let wrong = client
            .post(format!(
                "http://127.0.0.1:{port}/{}",
                "a".repeat(SECRET_HEX_LEN)
            ))
            .body("{}")
            .send()
            .await
            .expect("proxy must answer");
        assert_eq!(
            wrong.status(),
            404,
            "request with wrong secret must be rejected"
        );

        // The correct secret must pass — otherwise the checks above would also
        // hold for a forwarder that rejects everything.
        let ok = client
            .post(url_for(&state, port, "1"))
            .body("{}")
            .send()
            .await
            .expect("proxy must answer");
        assert_eq!(ok.status(), 200, "request with valid secret must pass");

        stop(&state);
        mock.abort();
    }
}
