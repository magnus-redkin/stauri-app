//! Stauri: the Tauri application entry point.
//!
//! Only application assembly and handler registration live here. The logic is
//! split across the modules:
//!
//! * [`core`] — the safety core: keys, PIN envelopes, status-go FFI and pairing.
//!   Everything there is a review decision; see `core/mod.rs`;
//! * [`config`] — network configuration detection and loading;
//! * [`env`] — locating and loading `.env`;
//! * [`commands`] — commands exposed to the frontend;
//! * [`market`] — CoinGecko data;
//! * [`logging`] — file and stderr logging with secret scrubbing;
//! * [`updater`] — update check and installation.
//!
//! Money movement (`transfer`, `ens`, `swap`, `router`) and the data layer
//! (`providers`, `market`) stay outside the core on purpose: they use it, and
//! they are the parts most likely to be rewritten or replaced.

use tauri::Manager;

/// Fits the main window to the current monitor.
///
/// The configured 1200×900 is larger than the work area of a 1280×800 VM display.
/// Windows keeps the requested size, so the lower part of the window — the chat
/// composer in particular — ends up under the taskbar and cannot be reached. The
/// window is shrunk and centred only when it does not fit; a larger display keeps
/// the configured size.
#[cfg(desktop)]
fn fit_window_to_monitor(window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    let screen = monitor.size().to_logical::<f64>(scale);
    let Ok(outer) = window.outer_size() else {
        return;
    };
    let outer = outer.to_logical::<f64>(scale);

    // Leave room for the taskbar or dock and for the window frame.
    let max_width = screen.width * 0.9;
    let max_height = screen.height * 0.85;
    if outer.width <= max_width && outer.height <= max_height {
        return;
    }

    let width = outer.width.min(max_width);
    let height = outer.height.min(max_height);
    if let Err(e) = window.set_size(tauri::LogicalSize::new(width, height)) {
        tracing::warn!(error = %e, "не удалось подогнать окно под экран");
        return;
    }
    let _ = window.center();
}

mod appdirs;
// The safety core: keys, envelopes, status-go FFI, pairing. See `core/mod.rs` for what
// belongs there and what deliberately does not.
mod commands;
mod config;
mod core;
mod dapp;
mod ens;
mod env;
mod invite;
mod logging;
mod market;
mod opener;
mod profile;
mod providers;
mod router;
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
        // Открытие внешних ссылок на Android: на десктопе это делает `open::that`
        // в `opener.rs`, а у мобильной платформы обработчик — только через Intent.
        .plugin(tauri_plugin_opener::init())
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
                core::trace::set_dir(dir.clone());
                appdirs::set_data_dir(dir.clone());
            }

            #[cfg(desktop)]
            if let Some(window) = app.get_webview_window("main") {
                fit_window_to_monitor(&window);
            }

            // status-go lives in this process, so its signals reach the webview
            // through a Tauri event rather than a WebSocket.
            let handle = app.handle().clone();
            core::inprocess::set_app_emitter(move |raw| {
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
        .manage(core::rpc_proxy::RpcProxyState::default())
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
            commands::switch_network,
            commands::inprocess_initialize,
            commands::status_call,
            commands::status_rpc,
            commands::log_frontend,
            market::fetch_market_data,
            core::seed::fetch_seed_phrase,
            core::seed::seed_word,
            core::seed::seed_challenge,
            core::seed::verify_seed_answer,
            core::seed::clear_seed,
            profile::store_avatar,
            profile::get_avatar,
            profile::change_password,
            core::credentials::credential_save_pin,
            core::credentials::credential_open_pin,
            core::credentials::credential_has_pin,
            core::credentials::credential_pin_state,
            core::credentials::credential_save_pin_from_pending,
            core::credentials::credential_forget_pending,
            core::credentials::credential_delete,
            core::credentials::credential_available,
            core::credentials::credential_pin_rules,
            core::pairing::pairing_available,
            core::pairing::pairing_validate,
            core::pairing::pairing_confirmation_code,
            core::pairing::pairing_start_sending,
            core::pairing::pairing_start_receiving,
            core::pairing::pairing_receive,
            core::pairing::pairing_send,
            core::lanpair::pairing_lan_receive_start,
            core::lanpair::pairing_lan_send_start,
            core::lanpair::pairing_lan_confirm,
            core::lanpair::pairing_lan_cancel,
            core::lanpair::pairing_lan_status,
            core::lanpair::pairing_lan_local_address,
            invite::parse_invite_link,
            providers::fetch_feed,
            opener::open_external,
            dapp::open_dapp,
            dapp::open_doc,
            transfer::send_transfer,
            transfer::estimate_transfer_fee,
            ens::get_ens_quote,
            ens::register_ens_name,
            ens::update_ens_public_key,
            swap::get_swap_quote,
            swap::swap_tokens,
            swap::native_token_address
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                let proxy_state = app_handle.state::<core::rpc_proxy::RpcProxyState>();
                core::rpc_proxy::stop(&proxy_state);

                // Last: flushes what is still queued in the log.
                logging::shutdown();
            }
        });
}
