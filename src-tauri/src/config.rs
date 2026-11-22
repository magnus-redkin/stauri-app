//! Network configuration: detection, loading and validation.
//!
//! Sources, in priority order: `STAURI_NETWORK`, `STAURI_CONFIG_PATH`,
//! `~/.config/stauri/config.json`, then the built-in default (mainnet).

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::core::error::{AppError, AppResult};

#[derive(Deserialize, Default, Debug)]
pub struct AppConfig {
    ethereum: Option<EthereumConfig>,
    waku: Option<WakuConfig>,
}

#[derive(Deserialize, Default, Debug)]
pub struct EthereumConfig {
    preset: Option<String>,
    #[serde(default = "default_chain_id")]
    chain_id: u64,
    rpc_url: Option<String>,
}

#[derive(Deserialize, Default, Debug)]
pub struct WakuConfig {
    fleet: Option<String>,
}

/// Built-in network when nothing is configured.
///
/// @remarks
/// The dev Android build is the one made with `--debug`; it defaults to Sepolia, so a
/// transaction tried while testing cannot touch real funds. Release builds keep mainnet.
/// The desktop is left alone: `cargo tauri dev` runs against mainnet unless told
/// otherwise, which is what its README says.
fn default_network() -> String {
    #[cfg(all(target_os = "android", debug_assertions))]
    {
        "sepolia".to_string()
    }
    #[cfg(not(all(target_os = "android", debug_assertions)))]
    {
        "mainnet".to_string()
    }
}

fn default_chain_id() -> u64 {
    1
}

impl AppConfig {
    pub fn network_name(&self) -> String {
        self.ethereum
            .as_ref()
            .and_then(|e| e.preset.clone())
            .unwrap_or_else(default_network)
    }

    pub fn chain_id(&self) -> u64 {
        self.ethereum.as_ref().map(|e| e.chain_id).unwrap_or(1)
    }

    pub fn rpc_url(&self) -> String {
        self.ethereum
            .as_ref()
            .and_then(|e| e.rpc_url.clone())
            .unwrap_or_else(|| default_rpc_url(&self.network_name()))
    }

    pub fn waku_fleet(&self) -> String {
        self.waku
            .as_ref()
            .and_then(|w| w.fleet.clone())
            .unwrap_or_else(|| "status.prod".to_string())
    }

    pub fn is_testnet(&self) -> bool {
        self.network_name() != "mainnet"
    }

    pub fn data_dir_suffix(&self) -> PathBuf {
        PathBuf::from(self.network_name())
    }
}

pub fn default_rpc_url(network: &str) -> String {
    match network {
        "sepolia" => "https://rpc.sepolia.org".to_string(),
        "holesky" => "https://ethereum-holesky-rpc.publicnode.com".to_string(),
        _ => "https://ethereum-rpc.publicnode.com".to_string(),
    }
}

/// Whitelisted networks: (name, chain_id, waku_fleet).
pub const NETWORKS: &[(&str, u64, &str)] = &[
    ("mainnet", 1, "status.prod"),
    ("sepolia", 11155111, "status.test"),
    ("holesky", 17000, "status.test"),
];

pub fn config_for_network(network: &str) -> AppResult<AppConfig> {
    let (name, chain_id, fleet) =
        NETWORKS
            .iter()
            .find(|(n, _, _)| *n == network)
            .ok_or_else(|| {
                AppError::config(format!(
                    "unknown network: {network}. Allowed: mainnet, sepolia, holesky"
                ))
            })?;

    let rpc_url = default_rpc_url(name);

    Ok(AppConfig {
        ethereum: Some(EthereumConfig {
            preset: Some(network.to_string()),
            chain_id: *chain_id,
            rpc_url: Some(rpc_url),
        }),
        waku: Some(WakuConfig {
            fleet: Some(fleet.to_string()),
        }),
    })
}

/// Checks that the preset from the file is whitelisted.
///
/// Returns a replacement default config when the preset is unknown, so callers
/// fall back to mainnet instead of running with a network that has no entry in
/// [`NETWORKS`].
fn validate_preset(config: &AppConfig) -> Option<AppConfig> {
    if let Some(ref eth) = config.ethereum
        && let Some(ref preset) = eth.preset
        && !NETWORKS.iter().any(|(n, _, _)| *n == preset)
    {
        tracing::warn!(
            preset = %preset,
            "invalid preset in config.json, falling back to mainnet"
        );
        return Some(AppConfig::default());
    }
    None
}

pub fn load_config() -> AppConfig {
    // 1. STAURI_NETWORK (whitelist only)
    if let Ok(network) = std::env::var("STAURI_NETWORK") {
        match config_for_network(&network) {
            Ok(config) => return config,
            Err(e) => tracing::warn!(
                error = %e.message,
                "invalid STAURI_NETWORK, falling back to mainnet"
            ),
        }
    }

    // 2. STAURI_CONFIG_PATH
    if let Ok(path) = std::env::var("STAURI_CONFIG_PATH")
        && let Ok(content) = std::fs::read_to_string(&path)
        && let Ok(config) = serde_json::from_str::<AppConfig>(&content)
    {
        return validate_preset(&config).unwrap_or(config);
    }

    // 3. ~/.config/stauri/config.json
    if let Some(config_dir) = crate::appdirs::config_dir() {
        let config_path = config_dir.join("stauri").join("config.json");
        if let Ok(content) = std::fs::read_to_string(&config_path)
            && let Ok(config) = serde_json::from_str::<AppConfig>(&content)
        {
            return validate_preset(&config).unwrap_or(config);
        }
    }

    // 4. Default (mainnet)
    AppConfig::default()
}

/// File the in-app network choice is written to.
///
/// `STAURI_CONFIG_PATH` first, so an explicit config file keeps being the one the
/// application reads; otherwise the same `stauri/config.json` that [`load_config`] reads.
fn config_path() -> Option<PathBuf> {
    crate::appdirs::env_override("STAURI_CONFIG_PATH")
        .or_else(|| crate::appdirs::config_dir().map(|dir| dir.join("stauri").join("config.json")))
}

/// Saves the network chosen in the interface, for the next start.
///
/// @param network - One of [`NETWORKS`].
/// @returns Nothing; the value is in the config file and is read by the next start.
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Config`] for an unknown network, when
/// `STAURI_NETWORK` fixes the network for this run, and when the file cannot be written.
///
/// @remarks
/// This only writes a setting. Re-pointing the running process is the caller's job and
/// needs the `CloseAccounts` export: status-go opens its account database once and keeps
/// serving it afterwards, so without closing it first the file and the running process
/// would disagree until the next start. See `commands::switch_network`.
pub fn save_network(network: &str) -> AppResult<()> {
    // An environment override outranks the file on every start, so a write here would be
    // undone silently — after a restart, which is the worst place to learn about it.
    if let Ok(fixed) = std::env::var("STAURI_NETWORK") {
        return Err(AppError::config(format!(
            "the network is fixed by STAURI_NETWORK={fixed}; unset it to switch inside the app"
        )));
    }
    let path = config_path()
        .ok_or_else(|| AppError::config("cannot determine the config directory"))?;
    save_network_to(&path, network)
}

/// Writes `preset` into the config file at `path`, keeping everything else it holds.
///
/// @param path - Config file to write; created with its directory when missing.
/// @param network - One of [`NETWORKS`].
/// # Errors
/// Returns [`crate::core::error::ErrorKind::Config`] for an unknown network and when the
/// file cannot be written.
///
/// @remarks
/// The file is read first and only `ethereum.preset` is replaced: a custom provider or
/// fleet the user put there by hand must survive a switch from the interface.
pub fn save_network_to(path: &Path, network: &str) -> AppResult<()> {
    config_for_network(network)?;
    let mut root: serde_json::Value = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));

    let object = root
        .as_object_mut()
        .expect("an object was guaranteed above");
    let ethereum = object
        .entry("ethereum")
        .or_insert_with(|| serde_json::json!({}));
    if !ethereum.is_object() {
        // A hand-written `"ethereum": "sepolia"` is not the shape `load_config` reads;
        // replace it rather than try to extend it.
        *ethereum = serde_json::json!({});
    }
    ethereum["preset"] = serde_json::Value::String(network.to_string());

    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| AppError::config(format!("create config dir: {e}")))?;
    }
    let text = serde_json::to_string_pretty(&root)
        .map_err(|e| AppError::config(format!("serialize config: {e}")))?;
    std::fs::write(path, text).map_err(|e| AppError::config(format!("write config: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_rpc_url_sepolia() {
        assert_eq!(default_rpc_url("sepolia"), "https://rpc.sepolia.org");
    }

    #[test]
    fn test_default_rpc_url_holesky() {
        assert_eq!(
            default_rpc_url("holesky"),
            "https://ethereum-holesky-rpc.publicnode.com"
        );
    }

    #[test]
    fn test_default_rpc_url_fallback() {
        assert_eq!(
            default_rpc_url("mainnet"),
            "https://ethereum-rpc.publicnode.com"
        );
        assert_eq!(
            default_rpc_url("unknown_network"),
            "https://ethereum-rpc.publicnode.com"
        );
    }

    #[test]
    fn test_config_for_network_sepolia() {
        let config = config_for_network("sepolia").unwrap();
        assert_eq!(config.network_name(), "sepolia");
        assert_eq!(config.chain_id(), 11155111);
        assert_eq!(config.waku_fleet(), "status.test");
        assert!(config.is_testnet());
    }

    #[test]
    fn test_config_for_network_mainnet() {
        let config = config_for_network("mainnet").unwrap();
        assert_eq!(config.network_name(), "mainnet");
        assert_eq!(config.chain_id(), 1);
        assert_eq!(config.waku_fleet(), "status.prod");
        assert!(!config.is_testnet());
    }

    #[test]
    fn test_config_for_network_invalid() {
        let err = config_for_network("../../x").expect_err("unknown network must fail");
        assert_eq!(err.kind, crate::core::error::ErrorKind::Config);
        assert!(err.message.contains("unknown network"), "{}", err.message);
    }

    #[test]
    fn test_app_config_defaults() {
        let config = AppConfig::default();
        assert_eq!(config.network_name(), "mainnet");
        assert_eq!(config.chain_id(), 1);
        assert_eq!(config.rpc_url(), "https://ethereum-rpc.publicnode.com");
        assert_eq!(config.waku_fleet(), "status.prod");
        assert!(!config.is_testnet());
        // data_dir_suffix always returns the network name, mainnet included:
        // otherwise mainnet and testnet directories would share one location.
        assert_eq!(config.data_dir_suffix(), PathBuf::from("mainnet"));
    }

    /// A fresh, empty directory for one test.
    ///
    /// The name carries the process id and the test name so two test binaries running at
    /// once cannot share a file, and the directory is removed first so a previous failed
    /// run cannot make a test pass with its leftovers.
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("stauri-config-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn test_save_network_to_writes_the_preset() {
        let dir = temp_dir("writes");
        let path = dir.join("stauri").join("config.json");

        save_network_to(&path, "sepolia").expect("write config");

        // The written file must be readable as the configuration the next start uses:
        // the preset has to arrive at `network_name`, not only at the JSON field.
        let text = std::fs::read_to_string(&path).expect("read config");
        let config: AppConfig = serde_json::from_str(&text).expect("parse config");
        assert_eq!(config.network_name(), "sepolia");
        assert_eq!(config.data_dir_suffix(), PathBuf::from("sepolia"));
        assert!(config.is_testnet());
    }

    #[test]
    fn test_save_network_to_keeps_other_keys() {
        // A provider and a fleet put in the file by hand are not the switch's business.
        let dir = temp_dir("keeps");
        std::fs::create_dir_all(&dir).expect("create dir");
        let path = dir.join("config.json");
        std::fs::write(
            &path,
            r#"{"ethereum":{"preset":"mainnet","rpc_url":"https://custom.rpc"},"waku":{"fleet":"custom.fleet"}}"#,
        )
        .expect("seed config");

        save_network_to(&path, "holesky").expect("write config");

        let text = std::fs::read_to_string(&path).expect("read config");
        let config: AppConfig = serde_json::from_str(&text).expect("parse config");
        assert_eq!(config.network_name(), "holesky");
        assert_eq!(config.rpc_url(), "https://custom.rpc");
        assert_eq!(config.waku_fleet(), "custom.fleet");
    }

    #[test]
    fn test_save_network_to_rejects_unknown() {
        // The value ends up in a file read at the next start, so a name that
        // `config_for_network` refuses must not be written at all.
        let dir = temp_dir("rejects");
        let path = dir.join("config.json");

        let err = save_network_to(&path, "../../x").expect_err("unknown network must fail");

        assert_eq!(err.kind, crate::core::error::ErrorKind::Config);
        assert!(!path.exists(), "an unknown network must not create the file");
    }

    #[test]
    fn test_app_config_custom() {
        let config = AppConfig {
            ethereum: Some(EthereumConfig {
                preset: Some("sepolia".to_string()),
                chain_id: 11155111,
                rpc_url: Some("https://custom.rpc".to_string()),
            }),
            waku: Some(WakuConfig {
                fleet: Some("custom.fleet".to_string()),
            }),
        };
        assert_eq!(config.network_name(), "sepolia");
        assert_eq!(config.chain_id(), 11155111);
        assert_eq!(config.rpc_url(), "https://custom.rpc");
        assert_eq!(config.waku_fleet(), "custom.fleet");
        assert!(config.is_testnet());
        assert_eq!(config.data_dir_suffix(), PathBuf::from("sepolia"));
    }
}
