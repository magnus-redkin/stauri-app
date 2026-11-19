//! Stauri: the Tauri application entry point.
//!
//! Only application assembly and handler registration live here. The logic is
//! split across the modules:
//!
//! * [`config`] — network configuration detection and loading;
//! * [`env`] — locating and loading `.env`;
//! * [`inprocess`] — status-go as a library inside this process;
//! * [`commands`] — commands exposed to the frontend;
//! * [`rpc_proxy`] — forwarder for RPC providers;
//! * [`seed`] — seed phrase handling outside the webview;
//! * [`market`] — CoinGecko data;
//! * [`logging`] — file and stderr logging with secret scrubbing;
//! * [`updater`] — update check and installation;
//! * [`error`] — typed command errors.

use tauri::Manager;

mod appdirs;
mod trace;
mod backend;
mod commands;
mod config;
// Per-profile secrets for the mobile entry flow: the PIN and the password it protects.
// See the module docs for what protects them on each platform.
mod credentials;
mod dapp;
mod ens;
mod env;
mod error;
mod inprocess;
mod invite;
mod logging;
mod market;
mod opener;
mod pairing;
mod profile;
mod providers;
mod router;
mod rpc_proxy;
mod seed;
mod swap;
mod transfer;
mod updater;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Order matters. `.env` is loaded first because it can carry `RUST_LOG`, and
    // `EnvFilter` is read when the subscriber is created. The warning about a
    // missing file is printed after `logging::init` — before that it would go
    // nowhere.
    let env_found = env::load_env();
    logging::init();
    if !env_found {
        tracing::warn!("no .env found; using environment variables only");
    }
    tauri::Builder::default()
        // The updater plugin is registered for its configuration alone
        // (endpoints and pubkey from tauri.conf.json). Its commands are not
        // available to the frontend: no permission is granted in capabilities,
        // and the frontend goes through commands::check_for_update and
        // commands::install_update instead.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Directories from Tauri: on Android `dirs::config_dir()` and
            // `dirs::data_local_dir()` do not work. `STAURI_CONFIG_DIR` and
            // `STAURI_DATA_DIR` take priority; see `appdirs`.
            use tauri::Manager;
            if let Some(dir) = appdirs::env_override("STAURI_CONFIG_DIR") {
                appdirs::set_config_dir(dir);
            } else if let Ok(dir) = app.path().app_config_dir() {
                appdirs::set_config_dir(dir);
            }
            let data_dir = appdirs::env_override("STAURI_DATA_DIR")
                .or_else(|| app.path().app_data_dir().ok());
            if let Some(dir) = &data_dir {
                if let Err(e) = std::fs::create_dir_all(dir) {
                    tracing::warn!(dir = %dir.display(), error = %e, "не удалось создать каталог данных");
                }
                trace::set_dir(dir.clone());
                appdirs::set_data_dir(dir.clone());
            }

            // status-go lives in this process, so its signals reach the webview
            // through a Tauri event rather than a WebSocket.
            let handle = app.handle().clone();
            inprocess::set_app_emitter(move |raw| {
                use tauri::Emitter;
                let payload: serde_json::Value = match serde_json::from_str(raw) {
                    Ok(v) => v,
                    // An unparsable signal is still worth surfacing to the
                    // trace, but it cannot be typed for the frontend.
                    Err(_) => serde_json::Value::Null,
                };
                if payload.is_null() {
                    return;
                }
                if let Err(e) = handle.emit("status-signal", payload) {
                    tracing::warn!(error = %e, "cannot emit status signal");
                }
            });
            Ok(())
        })
        .manage(rpc_proxy::RpcProxyState::default())
        .invoke_handler(tauri::generate_handler![
            commands::start_backend,
            commands::stop_backend,
            commands::start_rpc_proxy,
            commands::rpc_proxy_secret,
            commands::set_rpc_upstreams,
            commands::stop_rpc_proxy,
            commands::check_for_update,
            commands::install_update,
            commands::restart_app,
            commands::inprocess_initialize,
            commands::status_call,
            commands::status_rpc,
            commands::log_frontend,
            market::fetch_market_data,
            seed::fetch_seed_phrase,
            seed::seed_word,
            seed::seed_challenge,
            seed::verify_seed_answer,
            seed::clear_seed,
            profile::store_avatar,
            profile::get_avatar,
            profile::change_password,
            credentials::credential_save_pin,
            credentials::credential_open_pin,
            credentials::credential_has_pin,
            credentials::credential_pin_state,
            credentials::credential_save_pin_from_pending,
            credentials::credential_forget_pending,
            credentials::credential_delete,
            credentials::credential_available,
            credentials::credential_pin_rules,
            pairing::pairing_available,
            pairing::pairing_validate,
            pairing::pairing_confirmation_code,
            pairing::pairing_start_sending,
            pairing::pairing_start_receiving,
            pairing::pairing_receive,
            pairing::pairing_send,
            invite::parse_invite_link,
            providers::fetch_feed,
            opener::open_external,
            dapp::open_dapp,
            dapp::open_doc,
            transfer::send_transfer,
            transfer::estimate_transfer_fee,
            ens::get_ens_quote,
            ens::register_ens_name,
            swap::get_swap_quote,
            swap::swap_tokens,
            swap::native_token_address
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                let proxy_state = app_handle.state::<rpc_proxy::RpcProxyState>();
                rpc_proxy::stop(&proxy_state);

                // Last: flushes what is still queued in the log.
                logging::shutdown();
            }
        });
}
