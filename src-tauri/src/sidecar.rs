//! Managing the `status-backend` process: starting, stopping, the PID file and
//! reading its output.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;
use tauri_plugin_shell::{ShellExt, process::CommandChild};
use tracing::{debug, info, warn};

use crate::appdirs;
use crate::auth_proxy;
use crate::config::{config_for_network, load_config};
use crate::error::{AppError, AppResult};

/// Backend state shared with the commands.
pub struct BackendState {
    pub child: Mutex<Option<CommandChild>>,
    pub port: Mutex<Option<u16>>,
    pub data_dir: Mutex<Option<PathBuf>>,
}

#[derive(Serialize)]
pub struct StartBackendResponse {
    pub port: u16,
    /// Port of the authenticating proxy. The frontend talks only to this one;
    /// `port` is the real backend port and is not needed outside.
    #[serde(rename = "authPort")]
    pub auth_port: u16,
    #[serde(rename = "dataDir")]
    pub data_dir: String,
    #[serde(rename = "networkName")]
    pub network_name: String,
    #[serde(rename = "chainId")]
    pub chain_id: u64,
    #[serde(rename = "rpcUrl")]
    pub rpc_url: String,
    #[serde(rename = "wakuFleet")]
    pub waku_fleet: String,
    #[serde(rename = "isTestnet")]
    pub is_testnet: bool,
}

impl Default for BackendState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            port: Mutex::new(None),
            data_dir: Mutex::new(None),
        }
    }
}

/// Kills a backend process left over from a previous run.
///
/// The PID file is written at startup and survives an abnormal exit. The process
/// name is checked before signalling so a stale PID file cannot kill an
/// unrelated process. On Linux this reads `/proc/<pid>/comm`.
pub fn kill_stale_backend(dir: &Path) {
    let pid_file = dir.join("status-backend.pid");
    if let Ok(s) = std::fs::read_to_string(&pid_file) {
        if let Ok(pid) = s.trim().parse::<u32>() {
            #[cfg(target_os = "linux")]
            {
                if std::fs::read_to_string(format!("/proc/{pid}/comm"))
                    .map(|c| c.trim() == "status-backend")
                    .unwrap_or(false)
                {
                    let _ = std::process::Command::new("kill")
                        .arg(pid.to_string())
                        .status();
                }
            }
        }
        let _ = std::fs::remove_file(&pid_file);
    }
}

/// Starts the sidecar and the authenticating proxy.
///
/// When the backend is already running this returns the existing ports and
/// configuration instead of starting a second process.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] when the backend runs on a
/// different network than the one requested, when the sidecar command cannot be
/// created or spawned, and when the proxy fails to start. Returns
/// [`crate::error::ErrorKind::Config`] for an unknown network and
/// [`crate::error::ErrorKind::Io`] when the data directory cannot be determined
/// or created. Returns [`crate::error::ErrorKind::Internal`] when a lock is
/// poisoned or no free port can be found.
pub async fn start(
    app: tauri::AppHandle,
    network: Option<String>,
) -> AppResult<StartBackendResponse> {
    let state = app.state::<BackendState>();

    // 1. Check whether a process is already running.
    //
    // The mutexes are held only for reading and released before the first
    // await: a `MutexGuard` is not `Send`, and `start` is async.
    let already_running = {
        let child_lock = state.child.lock().map_err(|_| AppError::poisoned())?;
        child_lock.is_some()
    };

    if already_running {
        // The process is running but a different network was requested: switch
        // requires a restart.
        let current_config = load_config();
        if let Some(ref net) = network
            && net != &current_config.network_name()
        {
            return Err(AppError::backend(format!(
                "backend already running on network '{}', cannot switch to '{}' without restart",
                current_config.network_name(),
                net
            )));
        }
        let port = {
            let port_lock = state.port.lock().map_err(|_| AppError::poisoned())?;
            port_lock.unwrap_or(0)
        };

        let data_dir_str = {
            let data_dir_lock = state.data_dir.lock().map_err(|_| AppError::poisoned())?;
            data_dir_lock
                .as_ref()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        };

        let config = if let Some(net) = &network {
            config_for_network(net)?
        } else {
            load_config()
        };

        // Start the authenticating proxy and report its port to the frontend.
        // The backend port itself stays internal.
        let auth_state = app.state::<auth_proxy::AuthProxyState>();
        let auth_port = auth_proxy::start(&auth_state, port).await?;

        return Ok(StartBackendResponse {
            port,
            auth_port,
            data_dir: data_dir_str,
            network_name: config.network_name(),
            chain_id: config.chain_id(),
            rpc_url: config.rpc_url(),
            waku_fleet: config.waku_fleet(),
            is_testnet: config.is_testnet(),
        });
    }

    // 2. Load the configuration
    let config = if let Some(net) = &network {
        config_for_network(net)?
    } else {
        load_config()
    };

    let response = StartBackendResponse {
        port: 0,
        auth_port: 0,
        data_dir: String::new(),
        network_name: config.network_name(),
        chain_id: config.chain_id(),
        rpc_url: config.rpc_url(),
        waku_fleet: config.waku_fleet(),
        is_testnet: config.is_testnet(),
    };

    // 3. Build dataDir. `appdirs::data_dir()` honours `STAURI_DATA_DIR`, which is
    //    how a clean copy of the application runs against its own profile.
    let app_data_dir =
        appdirs::data_dir().ok_or_else(|| AppError::io("cannot determine app data dir"))?;
    let data_dir = app_data_dir.join(config.data_dir_suffix());
    std::fs::create_dir_all(&data_dir).map_err(|e| AppError::io(e.to_string()))?;
    let data_dir_str = data_dir.to_string_lossy().to_string();

    // 4. Kill leftovers from a previous run
    kill_stale_backend(&data_dir);

    // 5. Find a free port
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| AppError::internal(format!("failed to find free port: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::internal(format!("failed to get local addr: {e}")))?
        .port();
    drop(listener);

    // 6. Arguments for status-backend
    let args = vec!["-address".to_string(), format!("127.0.0.1:{port}")];

    // 7. Start the sidecar.
    //
    // In a dev build libsds.so sits in target/debug/binaries/, so the process
    // needs LD_LIBRARY_PATH=./binaries (relative to cwd = target/debug/).
    // In a release build and in an AppImage libsds.so sits next to
    // status-backend (usr/bin/) and the RPATH=$ORIGIN that Tauri sets at build
    // time finds it. LD_LIBRARY_PATH must NOT be set in release: it overrides
    // the RPATH and points at usr/lib/stauri-app/, where libsds.so is absent.
    let sidecar = app
        .shell()
        .sidecar("status-backend")
        .map_err(|e| AppError::backend(format!("failed to create sidecar command: {e}")))?
        .args(&args);

    let sidecar_command = if cfg!(debug_assertions) {
        sidecar.env("LD_LIBRARY_PATH", "./binaries")
    } else {
        sidecar
    };

    let (mut rx, child) = sidecar_command
        .spawn()
        .map_err(|e| AppError::backend(format!("failed to spawn sidecar: {e}")))?;

    // 7a. Bring up the authenticating proxy.
    //
    // status-backend does not check who connects to it and listens on
    // 127.0.0.1, which every local process can reach. The proxy demands a secret
    // header and lets only our frontend through.
    let auth_port = {
        let auth_state = app.state::<auth_proxy::AuthProxyState>();
        auth_proxy::start(&auth_state, port).await?
    };

    // 8. Write the PID
    let pid = child.pid();
    let pid_file = data_dir.join("status-backend.pid");
    if let Err(e) = std::fs::write(&pid_file, pid.to_string()) {
        warn!(pid_file = %pid_file.display(), error = %e, "не удалось записать PID-файл");
    }

    info!(
        port,
        auth_port,
        data_dir = %data_dir_str,
        network = config.network_name(),
        chain_id = config.chain_id(),
        "backend started"
    );

    // 9. Store the process, the port and dataDir
    {
        let mut child_lock = state.child.lock().map_err(|_| AppError::poisoned())?;
        *child_lock = Some(child);
        let mut port_lock = state.port.lock().map_err(|_| AppError::poisoned())?;
        *port_lock = Some(port);
        let mut data_dir_lock = state.data_dir.lock().map_err(|_| AppError::poisoned())?;
        *data_dir_lock = Some(data_dir.clone());
    }

    // 10. Stream the logs in the background
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                    log_backend_line(&line, tracing::Level::DEBUG);
                }
                tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                    // status-backend writes ordinary progress to stderr too, so
                    // the level is INFO rather than WARN; WARN would turn the
                    // release log into noise.
                    log_backend_line(&line, tracing::Level::INFO);
                }
                tauri_plugin_shell::process::CommandEvent::Terminated(payload) => {
                    warn!(
                        code = payload.code,
                        signal = payload.signal,
                        "status-backend terminated"
                    );
                    let state = app_handle.state::<BackendState>();
                    if let Ok(mut port_lock) = state.port.lock() {
                        *port_lock = None;
                    }
                    if let Ok(mut child_lock) = state.child.lock() {
                        *child_lock = None;
                    }
                }
                _ => {}
            }
        }
    });

    Ok(StartBackendResponse {
        port,
        auth_port,
        data_dir: data_dir_str,
        ..response
    })
}

/// Stops the sidecar and removes the PID file.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Backend`] when the process cannot be
/// killed and [`crate::error::ErrorKind::Internal`] when a lock is poisoned.
pub fn stop(app: tauri::AppHandle) -> AppResult<String> {
    let state = app.state::<BackendState>();
    let mut child_lock = state.child.lock().map_err(|_| AppError::poisoned())?;
    let child_res = if let Some(child) = child_lock.take() {
        child
            .kill()
            .map_err(|e| AppError::backend(format!("failed to kill sidecar: {e}")))
    } else {
        Ok(())
    };

    let mut port_lock = state.port.lock().map_err(|_| AppError::poisoned())?;
    *port_lock = None;
    drop(port_lock);
    drop(child_lock);

    // Remove the PID file, using the stored dataDir
    let data_dir_lock = state.data_dir.lock().map_err(|_| AppError::poisoned())?;
    if let Some(data_dir) = data_dir_lock.as_ref() {
        let pid_file = data_dir.join("status-backend.pid");
        let _ = std::fs::remove_file(&pid_file);
    }

    child_res.map(|_| "Backend stopped".to_string())
}

/// Stops the sidecar when the application exits. Errors are ignored.
pub fn shutdown(app_handle: &tauri::AppHandle) {
    let state = app_handle.state::<BackendState>();
    if let Ok(mut child_lock) = state.child.lock()
        && let Some(child) = child_lock.take()
    {
        let _ = child.kill();
        info!("status-backend killed on exit");
    }
    if let Ok(data_dir_lock) = state.data_dir.lock()
        && let Some(data_dir) = data_dir_lock.as_ref()
    {
        let _ = std::fs::remove_file(data_dir.join("status-backend.pid"));
    }
}

/// Writes one line of `status-backend` output to the shared log.
///
/// The stream is read line by line, so the trailing `\n` is stripped; otherwise
/// every entry would gain an empty line at its tail.
fn log_backend_line(bytes: &[u8], level: tracing::Level) {
    let text = String::from_utf8_lossy(bytes);
    let line = text.trim_end_matches(['\r', '\n']);
    if line.is_empty() {
        return;
    }
    match level {
        tracing::Level::DEBUG => debug!(target: "status_backend", "{line}"),
        tracing::Level::INFO => info!(target: "status_backend", "{line}"),
        tracing::Level::WARN => warn!(target: "status_backend", "{line}"),
        _ => info!(target: "status_backend", "{line}"),
    }
}
