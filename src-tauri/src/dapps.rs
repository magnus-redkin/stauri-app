//! dApp plugins: install from a manifest, run in the Extism sandbox, serve their UI.
//!
//! A dApp is three files described by one manifest: a WASM module with the logic, an
//! optional static UI bundle, and the manifest itself with hashes and permissions.
//! Nothing else about the dApp is trusted:
//!
//! * the module runs with WASI off and no network; it reaches the outside only through
//!   host functions, and the only one in this version is `http_get_json`, limited to the
//!   hosts listed in the manifest's `http:<host>` permissions;
//! * the UI bundle is served from the dApp directory on its own origin, over a loopback
//!   server that requires a per-session token, with a CSP that forbids the network;
//! * both the module and the bundle are installed only when their SHA-256 matches the
//!   manifest, and a missing hash is an error rather than a skipped check.
//!
//! See `docs/en/dapp-connect.md` for the process this implements.

use crate::appdirs;
use crate::core::error::{AppError, AppResult};
use extism::{host_fn, Error, Manifest as WasmManifest, Plugin, PluginBuilder, UserData, ValType, Wasm};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tiny_http::{Header, Method, Response, Server};

/// Largest manifest accepted from the network.
const MANIFEST_LIMIT: usize = 1 << 20;
/// Largest module accepted from the network.
const MODULE_LIMIT: usize = 32 << 20;
/// Largest UI archive accepted from the network.
const UI_LIMIT: usize = 64 << 20;
/// Fuel per plugin call: enough for parsing a page of JSON, far from unbounded.
const FUEL_PER_CALL: u64 = 10_000_000;
/// Default memory cap when the manifest does not set one: 16 MiB.
const DEFAULT_MAX_PAGES: u32 = 256;
/// Download timeout for every file.
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a host-function response is reused.
const CACHE_TTL: Duration = Duration::from_secs(60);

/// The parts of an Extism manifest Stauri reads. Unknown fields are ignored so a
/// dApp may carry its own data.
#[derive(Debug, Clone, Deserialize)]
pub struct DappManifest {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub wasm: Vec<WasmSource>,
    #[serde(default)]
    pub memory: MemoryLimits,
    #[serde(default)]
    pub stauri: StauriSection,
}

/// Where the module comes from, and its digest.
#[derive(Debug, Clone, Deserialize)]
pub struct WasmSource {
    pub url: String,
    #[serde(default)]
    pub hash: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct MemoryLimits {
    #[serde(default)]
    pub max_pages: Option<u32>,
}

/// The Stauri-specific section: identity, permissions and exports.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct StauriSection {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub exports: Vec<String>,
    #[serde(default)]
    pub ui: Option<UiBundle>,
}

/// A static UI bundle, archived as `tar.gz`.
#[derive(Debug, Clone, Deserialize)]
pub struct UiBundle {
    pub url: String,
    #[serde(default)]
    pub hash: String,
}

/// What the frontend lists for an installed dApp.
#[derive(Debug, Clone, Serialize)]
pub struct InstalledDapp {
    pub id: String,
    pub name: String,
    pub version: String,
    pub permissions: Vec<String>,
    pub exports: Vec<String>,
    pub has_ui: bool,
}

/// Root of installed dApps: `<data>/dapps`.
fn dapps_root() -> AppResult<PathBuf> {
    let base = appdirs::data_dir().ok_or_else(|| AppError::config("no application data directory"))?;
    Ok(base.join("dapps"))
}

/// Directory of the current version of one dApp.
fn dapp_dir(id: &str) -> AppResult<PathBuf> {
    let root = dapps_root()?;
    let current = std::fs::read_to_string(root.join(id).join("current"))
        .map_err(|e| AppError::io(format!("dApp {id}: {e}")))?;
    let version = checked_version(current.trim())?;
    Ok(root.join(id).join(version))
}

/// An id becomes a directory name, so it is restricted to a safe alphabet.
fn checked_id(raw: &str) -> AppResult<String> {
    let id = raw.trim();
    let ok = !id.is_empty()
        && id.len() <= 64
        && id != "."
        && id != ".."
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(id.to_string())
    } else {
        Err(AppError::config(format!("manifest: invalid id {raw:?}")))
    }
}

/// A version becomes a directory name too.
fn checked_version(raw: &str) -> AppResult<String> {
    let version = raw.trim();
    let ok = !version.is_empty()
        && version.len() <= 64
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | '_'));
    if ok {
        Ok(version.to_string())
    } else {
        Err(AppError::config(format!("manifest: invalid version {raw:?}")))
    }
}

fn hex(digest: &[u8]) -> String {
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Compares a downloaded file with the manifest digest. A missing digest is an error:
/// skipping the check would install whatever the server sent.
fn verify(bytes: &[u8], expected: &str, what: &str) -> AppResult<()> {
    let expected = expected.trim();
    if expected.is_empty() {
        return Err(AppError::config(format!("manifest: {what} hash is missing")));
    }
    let actual = hex(&Sha256::digest(bytes));
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(AppError::network(format!(
            "{what} hash mismatch: expected {expected}, got {actual}"
        )))
    }
}

/// HTTP client for installs. The system proxy is applied the same way the feed client
/// does it: a desktop application has no proxy environment variables of its own.
fn http_client() -> AppResult<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent(concat!(
            "Stauri/",
            env!("CARGO_PKG_VERSION"),
            " (+https://github.com/magnus-redkin/stauri-app)"
        ));
    if let Some(proxy) = crate::sysproxy::proxy_url() {
        if let Ok(proxy) = reqwest::Proxy::all(&proxy) {
            builder = builder.proxy(proxy);
        }
    }
    builder
        .build()
        .map_err(|e| AppError::internal(format!("http client: {e}")))
}

async fn fetch_bytes(url: &str, limit: usize) -> AppResult<Vec<u8>> {
    let client = http_client()?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::network(format!("fetch {url}: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::network(format!("fetch {url}: HTTP {}", response.status())));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| AppError::network(format!("fetch {url}: body: {e}")))?;
    if bytes.len() > limit {
        return Err(AppError::network(format!(
            "fetch {url}: {} bytes exceeds the {limit} byte limit",
            bytes.len()
        )));
    }
    Ok(bytes.to_vec())
}

/// Whether an archive entry may be unpacked: no absolute paths, no `..`, no drive prefix.
fn archive_path_is_safe(path: &Path) -> bool {
    !path.is_absolute()
        && !path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
}

/// Unpacks the UI bundle, refusing absolute paths and `..` components.
fn extract_tar_gz(bytes: &[u8], dest: &Path) -> AppResult<()> {
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|e| AppError::io(format!("ui archive: {e}")))?;
    let mut count = 0usize;
    for entry in entries {
        let mut entry = entry.map_err(|e| AppError::io(format!("ui archive: {e}")))?;
        let path = entry
            .path()
            .map_err(|e| AppError::io(format!("ui archive path: {e}")))?
            .to_path_buf();
        if !archive_path_is_safe(&path) {
            return Err(AppError::io(format!(
                "ui archive: unsafe path {}",
                path.display()
            )));
        }
        let unpacked = entry
            .unpack_in(dest)
            .map_err(|e| AppError::io(format!("ui archive: {e}")))?;
        if !unpacked {
            return Err(AppError::io(format!(
                "ui archive: cannot unpack {}",
                path.display()
            )));
        }
        count += 1;
        if count > 5_000 {
            return Err(AppError::io("ui archive: too many entries"));
        }
    }
    Ok(())
}

/// Installs a dApp from its manifest.
///
/// # Errors
/// `Config` for an invalid or incomplete manifest, `Network` for a failed download or a
/// hash mismatch, `Io` for the archive or the data directory.
#[tauri::command]
pub async fn dapp_install(manifest_url: String) -> AppResult<InstalledDapp> {
    let manifest_bytes = fetch_bytes(&manifest_url, MANIFEST_LIMIT).await?;
    let manifest: DappManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| AppError::config(format!("manifest: {e}")))?;
    let id = checked_id(&manifest.stauri.id)?;
    let version = checked_version(&manifest.version)?;
    if manifest.stauri.exports.is_empty() {
        return Err(AppError::config("manifest: stauri.exports is empty"));
    }
    let source = manifest
        .wasm
        .first()
        .ok_or_else(|| AppError::config("manifest: no wasm entry"))?;
    let module = fetch_bytes(&source.url, MODULE_LIMIT).await?;
    verify(&module, &source.hash, "module")?;

    let ui = match &manifest.stauri.ui {
        Some(bundle) => {
            let archive = fetch_bytes(&bundle.url, UI_LIMIT).await?;
            verify(&archive, &bundle.hash, "ui bundle")?;
            Some(archive)
        }
        None => None,
    };

    let root = dapps_root()?;
    let app_root = root.join(&id);
    let staging = app_root.join(format!(".{version}.staging"));
    let target = app_root.join(&version);
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|e| AppError::io(format!("{}: {e}", staging.display())))?;
    }
    std::fs::create_dir_all(&staging).map_err(|e| AppError::io(format!("{}: {e}", staging.display())))?;
    std::fs::write(staging.join("module.wasm"), &module)
        .map_err(|e| AppError::io(format!("module.wasm: {e}")))?;
    std::fs::write(staging.join("manifest.json"), &manifest_bytes)
        .map_err(|e| AppError::io(format!("manifest.json: {e}")))?;
    if let Some(archive) = &ui {
        let ui_dir = staging.join("ui");
        std::fs::create_dir_all(&ui_dir).map_err(|e| AppError::io(format!("ui: {e}")))?;
        extract_tar_gz(archive, &ui_dir)?;
    }
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|e| AppError::io(format!("{}: {e}", target.display())))?;
    }
    std::fs::rename(&staging, &target).map_err(|e| AppError::io(format!("install: {e}")))?;
    std::fs::write(app_root.join("current"), &version)
        .map_err(|e| AppError::io(format!("current: {e}")))?;
    tracing::info!(id = %id, version = %version, "dApp installed");

    Ok(InstalledDapp {
        id,
        name: manifest.name,
        version,
        permissions: manifest.stauri.permissions,
        exports: manifest.stauri.exports,
        has_ui: ui.is_some(),
    })
}

/// Lists installed dApps with what the frontend needs to show them.
#[tauri::command]
pub fn dapp_list() -> AppResult<Vec<InstalledDapp>> {
    let root = match dapps_root() {
        Ok(root) => root,
        Err(_) => return Ok(Vec::new()),
    };
    let mut result = Vec::new();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Ok(result);
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(current) = std::fs::read_to_string(dir.join("current")) else {
            continue;
        };
        let version_dir = dir.join(current.trim());
        let Ok(bytes) = std::fs::read(version_dir.join("manifest.json")) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_slice::<DappManifest>(&bytes) else {
            continue;
        };
        result.push(InstalledDapp {
            id: manifest.stauri.id.clone(),
            name: manifest.name,
            version: manifest.version,
            permissions: manifest.stauri.permissions,
            exports: manifest.stauri.exports,
            has_ui: manifest.stauri.ui.is_some(),
        });
    }
    result.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(result)
}

/// Removes a dApp: its code and its stored versions.
#[tauri::command]
pub fn dapp_remove(id: String) -> AppResult<()> {
    let id = checked_id(&id)?;
    let dir = dapps_root()?.join(&id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| AppError::io(format!("{}: {e}", dir.display())))?;
    }
    if let Some(state) = SERVER.get() {
        if let Ok(mut plugins) = state.plugins.lock() {
            plugins.remove(&id);
        }
    }
    Ok(())
}

// ---------- The UI server ----------

/// State shared by the loopback server and the commands.
struct ServerState {
    port: u16,
    /// Session token -> dApp id. Every request carries its token in the path.
    sessions: Mutex<HashMap<String, String>>,
    /// One live plugin instance per dApp.
    plugins: Mutex<HashMap<String, Plugin>>,
    /// Responses of `http_get_json`, reused for [`CACHE_TTL`].
    cache: Arc<Mutex<HashMap<String, (Instant, String)>>>,
    counter: Mutex<u64>,
}

static SERVER: OnceLock<Arc<ServerState>> = OnceLock::new();

fn server() -> AppResult<Arc<ServerState>> {
    if let Some(state) = SERVER.get() {
        return Ok(state.clone());
    }
    let server = Server::http("127.0.0.1:0")
        .map_err(|e| AppError::internal(format!("dApp server: {e}")))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|addr| addr.port())
        .ok_or_else(|| AppError::internal("dApp server: no TCP address"))?;
    let state = Arc::new(ServerState {
        port,
        sessions: Mutex::new(HashMap::new()),
        plugins: Mutex::new(HashMap::new()),
        cache: Arc::new(Mutex::new(HashMap::new())),
        counter: Mutex::new(0),
    });
    let loop_state = state.clone();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            handle(request, &loop_state);
        }
    });
    let _ = SERVER.set(state.clone());
    Ok(state)
}

fn new_token(state: &ServerState) -> String {
    let mut counter = state.counter.lock().unwrap();
    *counter += 1;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    hex(&Sha256::digest(format!("{}-{}-{}", std::process::id(), nanos, *counter).as_bytes()))
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name, value).expect("static header")
}

fn respond(request: tiny_http::Request, body: Vec<u8>, mime: &str, status: u16) {
    let response = Response::from_data(body)
        .with_status_code(status)
        .with_header(header("Content-Type", mime))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' https://coin-images.coingecko.com data:; \
             style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
        ));
    let _ = request.respond(response);
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// Serves one request: the page's files, or the call bridge.
fn handle(mut request: tiny_http::Request, state: &ServerState) {
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or("/");
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    let (first, rest) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if first != "s" {
        respond(request, b"not found".to_vec(), "text/plain", 404);
        return;
    }
    let mut segments = rest.splitn(2, '/');
    let token = segments.next().unwrap_or("");
    let tail = segments.next().unwrap_or("");
    let id = match state.sessions.lock().ok().and_then(|s| s.get(token).cloned()) {
        Some(id) => id,
        None => {
            respond(request, b"unknown session".to_vec(), "text/plain", 403);
            return;
        }
    };

    if tail == "api/call" {
        if request.method() != &Method::Post {
            respond(request, b"POST only".to_vec(), "text/plain", 405);
            return;
        }
        let mut body = Vec::new();
        let mut reader = request.as_reader().take(1 << 20);
        if let Err(e) = reader.read_to_end(&mut body) {
            respond(request, format!("read: {e}").into_bytes(), "text/plain", 400);
            return;
        }
        #[derive(Deserialize)]
        struct Call {
            function: String,
            #[serde(default)]
            input: String,
        }
        let call: Call = match serde_json::from_slice(&body) {
            Ok(call) => call,
            Err(e) => {
                respond(request, format!("call: {e}").into_bytes(), "text/plain", 400);
                return;
            }
        };
        match call_plugin(state, &id, &call.function, &call.input) {
            Ok(output) => respond(request, output.into_bytes(), "application/json", 200),
            Err(e) => respond(
                request,
                format!("{{\"error\":\"{}\"}}", e.message.replace('"', "'")).into_bytes(),
                "application/json",
                502,
            ),
        }
        return;
    }

    let ui_root = match dapp_dir(&id) {
        Ok(dir) => dir.join("ui"),
        Err(e) => {
            respond(request, e.message.into_bytes(), "text/plain", 500);
            return;
        }
    };
    let relative = if tail.is_empty() { "index.html" } else { tail };
    let candidate = ui_root.join(relative);
    let safe = candidate
        .strip_prefix(&ui_root)
        .map(|p| !p.components().any(|c| matches!(c, Component::ParentDir)))
        .unwrap_or(false);
    let file = if safe && candidate.is_file() {
        candidate
    } else {
        ui_root.join("index.html")
    };
    match std::fs::read(&file) {
        Ok(bytes) => respond(request, bytes, mime_for(&file), 200),
        Err(_) => respond(request, b"not found".to_vec(), "text/plain", 404),
    }
}

/// Calls an exported plugin function, creating the instance on first use.
fn call_plugin(state: &ServerState, id: &str, function: &str, input: &str) -> AppResult<String> {
    let mut plugins = state
        .plugins
        .lock()
        .map_err(|_| AppError::internal("dApp plugin lock poisoned"))?;
    if !plugins.contains_key(id) {
        plugins.insert(id.to_string(), build_plugin(id, state.cache.clone())?);
    }
    let plugin = plugins
        .get_mut(id)
        .ok_or_else(|| AppError::internal("dApp plugin missing"))?;
    match plugin.call::<&str, String>(function, input) {
        Ok(output) => Ok(output),
        Err(e) => {
            // A trapped instance may be poisoned: drop it, the next call builds a fresh one.
            plugins.remove(id);
            Err(AppError::internal(format!("dApp call: {e}")))
        }
    }
}

/// Builds the sandbox: WASI off, one host function, limits from the manifest.
fn build_plugin(id: &str, cache: Arc<Mutex<HashMap<String, (Instant, String)>>>) -> AppResult<Plugin> {
    let dir = dapp_dir(id)?;
    let manifest_bytes = std::fs::read(dir.join("manifest.json"))
        .map_err(|e| AppError::io(format!("manifest: {e}")))?;
    let manifest: DappManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| AppError::config(format!("manifest: {e}")))?;
    let allowed: Vec<String> = manifest
        .stauri
        .permissions
        .iter()
        .filter_map(|p| p.strip_prefix("http:").map(|h| h.trim().to_ascii_lowercase()))
        .filter(|h| !h.is_empty())
        .collect();
    let pages = manifest.memory.max_pages.unwrap_or(DEFAULT_MAX_PAGES);
    let wasm = WasmManifest::new([Wasm::file(dir.join("module.wasm"))]).with_memory_max(pages);
    PluginBuilder::new(wasm)
        .with_fuel_limit(FUEL_PER_CALL)
        .with_wasi(false)
        .with_function(
            "http_get_json",
            [ValType::I64],
            [ValType::I64],
            UserData::new(HostState { allowed, cache }),
            http_get_json,
        )
        .build()
        .map_err(|e| AppError::internal(format!("dApp sandbox: {e}")))
}

/// What a host-function call may use.
#[derive(Clone)]
struct HostState {
    /// Hosts the manifest allows for `http_get_json`.
    allowed: Vec<String>,
    /// Shared response cache.
    cache: Arc<Mutex<HashMap<String, (Instant, String)>>>,
}

host_fn!(http_get_json(user_data: HostState; url: String) -> String {
    let state = user_data.get()?;
    let (allowed, cache) = {
        let state = state.lock().unwrap();
        (state.allowed.clone(), state.cache.clone())
    };
    let parsed = url::Url::parse(&url).map_err(|e| Error::msg(format!("bad url: {e}")))?;
    if parsed.scheme() != "https" {
        return Err(Error::msg("http_get_json: https only"));
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let allowed_host = allowed
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")));
    if !allowed_host {
        return Err(Error::msg(format!("http_get_json: host not allowed: {host}")));
    }
    if let Some((at, body)) = cache.lock().unwrap().get(&url) {
        if at.elapsed() < CACHE_TTL {
            return Ok(body.clone());
        }
    }
    let body = blocking_fetch(&url)?;
    cache.lock().unwrap().insert(url, (Instant::now(), body.clone()));
    Ok(body)
});

/// Synchronous fetch for the host function: it runs inside a plugin call, which is not
/// async. Same user agent and system proxy as the rest of the application.
fn blocking_fetch(url: &str) -> Result<String, Error> {
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("Stauri/", env!("CARGO_PKG_VERSION")));
    if let Some(proxy) = crate::sysproxy::proxy_url() {
        if let Ok(proxy) = reqwest::Proxy::all(&proxy) {
            builder = builder.proxy(proxy);
        }
    }
    let client = builder.build().map_err(|e| Error::msg(format!("client: {e}")))?;
    let response = client.get(url).send().map_err(|e| Error::msg(format!("request: {e}")))?;
    if !response.status().is_success() {
        return Err(Error::msg(format!("HTTP {}", response.status())));
    }
    response.text().map_err(|e| Error::msg(format!("body: {e}")))
}

// ---------- Opening a dApp ----------

/// Opens a dApp page in its own window and returns the address.
///
/// # Errors
/// `Config` when the dApp is unknown or has no UI bundle, `Internal` when the window or
/// the loopback server cannot be created.
#[tauri::command]
pub fn dapp_open(app: tauri::AppHandle, id: String) -> AppResult<String> {
    let id = checked_id(&id)?;
    let dir = dapp_dir(&id)?;
    if !dir.join("ui").join("index.html").is_file() {
        return Err(AppError::config(format!("dApp {id} has no UI bundle")));
    }
    let manifest_bytes = std::fs::read(dir.join("manifest.json"))
        .map_err(|e| AppError::io(format!("manifest: {e}")))?;
    let manifest: DappManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| AppError::config(format!("manifest: {e}")))?;

    let state = server()?;
    let token = new_token(&state);
    state
        .sessions
        .lock()
        .map_err(|_| AppError::internal("dApp session lock poisoned"))?
        .insert(token.clone(), id.clone());
    let url = format!("http://127.0.0.1:{}/s/{}/index.html", state.port, token);

    #[cfg(desktop)]
    {
        use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
        let label = format!("dapp-{id}");
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
        let target = url
            .parse()
            .map_err(|e| AppError::internal(format!("dApp url: {e}")))?;
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(target))
            .title(format!("{} — Stauri dApp", manifest.name))
            .inner_size(900.0, 700.0)
            .build()
            .map_err(|e| AppError::internal(format!("dApp window: {e}")))?;
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_cannot_escape_the_data_directory() {
        assert!(checked_id("market").is_ok());
        assert!(checked_id("notes.example.eth").is_ok());
        assert!(checked_id("../evil").is_err());
        assert!(checked_id("a/b").is_err());
        assert!(checked_id(".").is_err());
        assert!(checked_id("").is_err());
    }

    #[test]
    fn versions_cannot_escape_the_data_directory() {
        assert!(checked_version("0.1.1").is_ok());
        assert!(checked_version("1.0.0-beta.2").is_ok());
        assert!(checked_version("../../etc").is_err());
        assert!(checked_version("").is_err());
    }

    #[test]
    fn a_missing_hash_is_an_error_and_a_wrong_one_is_rejected() {
        assert!(verify(b"module", "", "module").is_err());
        let digest = hex(&Sha256::digest(b"module"));
        assert!(verify(b"module", &digest, "module").is_ok());
        assert!(verify(b"module", &digest.to_uppercase(), "module").is_ok());
        assert!(verify(b"other", &digest, "module").is_err());
    }

    #[test]
    fn the_ui_archive_cannot_write_outside_its_directory() {
        assert!(!archive_path_is_safe(Path::new("../evil.txt")));
        assert!(!archive_path_is_safe(Path::new("/etc/passwd")));
        assert!(!archive_path_is_safe(Path::new("a/../../b")));
        assert!(archive_path_is_safe(Path::new("index.html")));
        assert!(archive_path_is_safe(Path::new("assets/index.js")));
    }

    #[test]
    fn a_normal_ui_archive_is_unpacked() {
        let mut tar = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar);
            let mut header = tar::Header::new_gnu();
            header.set_path("index.html").unwrap();
            header.set_size(5);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, "index.html", &b"hello"[..]).unwrap();
            builder.finish().unwrap();
        }
        let gz = gzip(&tar);
        let dir = std::env::temp_dir().join(format!("stauri-dapp-ui-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        extract_tar_gz(&gz, &dir).unwrap();
        assert_eq!(std::fs::read(dir.join("index.html")).unwrap(), b"hello");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }
}
