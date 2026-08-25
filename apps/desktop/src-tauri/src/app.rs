use sqlx::sqlite::SqlitePoolOptions;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, PhysicalPosition, RunEvent, Window, WindowEvent};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

const AUTOSTART_HIDDEN_ARG: &str = "--mausvoice-autostart-hidden";

/// Maximum size of a single log file before the plugin rotates it.
/// At 25 MB and `MAX_LOG_FILES` kept files, the total log directory is
/// capped near 250 MB.
const MAX_LOG_FILE_SIZE: u64 = 25 * 1024 * 1024;

/// Number of rotated log files the plugin keeps on disk. Combined with
/// `MAX_LOG_FILE_SIZE` this bounds the log directory to roughly 250 MB.
const MAX_LOG_FILES: usize = 10;

/// Returns the default log level, or the level requested through the
/// `MAUSVOICE_LOG` environment variable when it parses to a known level.
/// `debug` and `trace` are reachable for opt-in troubleshooting; the
/// production default is `info` to keep file size and noise in check.
fn default_log_level() -> log::LevelFilter {
    if let Ok(raw) = std::env::var("MAUSVOICE_LOG") {
        match raw.trim().to_ascii_lowercase().as_str() {
            "trace" => return log::LevelFilter::Trace,
            "debug" => return log::LevelFilter::Debug,
            "info" => return log::LevelFilter::Info,
            "warn" | "warning" => return log::LevelFilter::Warn,
            "error" => return log::LevelFilter::Error,
            "off" => return log::LevelFilter::Off,
            _ => {}
        }
    }
    log::LevelFilter::Info
}

/// Minimum gap between two window-move log lines.
const MOVE_LOG_THROTTLE: Duration = Duration::from_millis(250);

/// Records where the window manager actually placed the main window while it
/// is being dragged.
///
/// The main window is frameless (`decorations: false`), so `data-tauri-drag-region`
/// hands the gesture straight to the window manager via `start_dragging` and the
/// app never sees the pointer. That makes a "the window will not drag past X"
/// report impossible to triage from the frontend: the only observable is the
/// position the OS reports back. Logging it next to the monitor geometry
/// separates "the compositor clamped the window" from "the drag never started"
/// (no `Moved` events at all — usually a missing `core:window:allow-start-dragging`
/// capability). Throttled so an ordinary drag does not flood the log.
fn log_main_window_move(window: &Window, position: &PhysicalPosition<i32>) {
    static LAST_LOG: Mutex<Option<Instant>> = Mutex::new(None);

    let Ok(mut last) = LAST_LOG.lock() else {
        return;
    };
    let now = Instant::now();
    if let Some(previous) = *last {
        if now.duration_since(previous) < MOVE_LOG_THROTTLE {
            return;
        }
    }
    *last = Some(now);
    drop(last);

    match window.current_monitor() {
        Ok(Some(monitor)) => {
            let origin = monitor.position();
            let size = monitor.size();
            log::debug!(
                "main window moved to ({}, {}) | monitor {:?} origin ({}, {}) size {}x{} scale {}",
                position.x,
                position.y,
                monitor.name(),
                origin.x,
                origin.y,
                size.width,
                size.height,
                monitor.scale_factor(),
            );
        }
        _ => log::debug!(
            "main window moved to ({}, {}) | monitor unavailable",
            position.x,
            position.y
        ),
    }
}

/// Handles application lifecycle events.
///
/// On exit the window size/position are persisted and the global keyboard
/// listener is stopped; on macOS `Reopen` the main window is surfaced again.
fn handle_run_event(app_handle: &tauri::AppHandle, event: RunEvent) {
    match &event {
        RunEvent::ExitRequested { .. } => {
            let _ = app_handle.save_window_state(StateFlags::SIZE);
            if let Err(err) = crate::platform::keyboard::stop_key_listener() {
                log::error!("Failed to stop keyboard listener on exit: {err}");
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = crate::platform::window::surface_main_window(&window);
            }
        }
        _ => {}
    }
}

/// Builds the Tauri application: plugins (logging, single instance, autostart,
/// updater, window state), the invoke handler, and window event wiring.
pub fn build() -> tauri::Builder<tauri::Wry> {
    let updater_builder = tauri_plugin_updater::Builder::new();

    tauri::Builder::default()
        .plugin({
            let file_name = chrono::Local::now()
                .format("mausvoice_%Y-%m-%d_%H%M%S")
                .to_string();
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::LogDir {
                        file_name: Some(file_name),
                    }),
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::Webview),
                ])
                .max_file_size(MAX_LOG_FILE_SIZE)
                .rotation_strategy(RotationStrategy::KeepSome(MAX_LOG_FILES))
                .level(default_log_level())
                .level_for("hyper_util", log::LevelFilter::Info)
                .level_for("reqwest", log::LevelFilter::Info)
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .format(|out, message, record| {
                    let now = chrono::Local::now();
                    out.finish(format_args!(
                        "[{}][{}][{}] {}",
                        now.format("%Y-%m-%d][%H:%M:%S%.3f"),
                        record.level(),
                        record.target(),
                        message
                    ))
                })
                .build()
        })
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // When a second instance is launched, bring the existing window to the foreground.
            if let Some(window) = app.get_webview_window("main") {
                let _ = crate::platform::window::surface_main_window(&window);
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_HIDDEN_ARG]),
        ))
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_sql::Builder::new()
                .add_migrations(crate::db::DB_CONNECTION, crate::db::migrations())
                .build(),
        )
        .plugin(updater_builder.build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                // Only persist/restore the window SIZE. The launch position is
                // owned by `center: true` in tauri.conf.json — restoring a
                // saved position used to spawn the window wherever it last sat
                // (and defaulted to the top-left corner on a fresh install).
                .with_state_flags(StateFlags::SIZE)
                .build(),
        )
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                    api.prevent_close();
                    let _ = window
                        .app_handle()
                        .save_window_state(StateFlags::SIZE);
                    let _ = window.hide();
                    // On Windows, force the WebView to stay active after hiding the window
                    // so that background JS (global hotkey detection via keys_held events)
                    // continues running while the app is minimized to the system tray.
                    #[cfg(target_os = "windows")]
                    {
                        crate::platform::window::keep_webview_active(window.app_handle(), "main");
                        crate::platform::window::set_webview_keepalive(true);
                    }
                    #[cfg(target_os = "macos")]
                    {
                        if let Err(err) = crate::platform::macos::dock::hide_dock_icon() {
                            log::error!("Failed to hide dock icon: {err}");
                        }
                    }
                }
                // On Windows, WebView2 automatically freezes JS execution when the
                // hosting window is occluded (fully covered by another window) or
                // minimized. This breaks global hotkey detection via keys_held events.
                // Counter this by re-asserting WebView visibility whenever focus is lost,
                // and running a periodic keepalive to defeat ongoing occlusion detection.
                WindowEvent::Moved(position) if window.label() == "main" => {
                    log_main_window_move(window, position);
                }
                #[cfg(target_os = "windows")]
                WindowEvent::Focused(focused) => {
                    if window.label() == "main" && !focused {
                        crate::platform::window::keep_webview_active(window.app_handle(), "main");
                        crate::platform::window::set_webview_keepalive(true);
                    }
                    if window.label() == "main" && *focused {
                        crate::platform::window::set_webview_keepalive(false);
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            std::panic::set_hook(Box::new(|info| {
                log::error!("PANIC: {info}");
            }));

            log::info!("Starting application setup...");

            // Preserve GGML files from the old app-data/models location before
            // the desktop sidecars start using app-data/transcription-models.
            crate::system::paths::migrate_legacy_models(app.handle())
                .map_err(|err| -> Box<dyn std::error::Error> { Box::new(err) })?;

            // Record the Windows elevation state once. An unelevated low-level
            // keyboard hook cannot observe input delivered to a higher-integrity
            // window (UIPI), so this is the first thing to check when a user
            // reports hotkeys failing over an elevated app.
            #[cfg(target_os = "windows")]
            {
                crate::platform::windows::permissions::log_elevation_state();
                crate::platform::windows::lifecycle::start_watcher(app.handle());
            }

            // Purge old log files, keeping the latest 10
            crate::system::diagnostics::purge_old_logs(app.handle());

            // Write startup diagnostics for debugging
            crate::system::diagnostics::write_startup_diagnostics(app.handle());

            let db_url = {
                let handle = app.handle();
                crate::system::paths::database_url(handle)
                    .map_err(|err| -> Box<dyn std::error::Error> { Box::new(err) })?
            };

            let pool = tauri::async_runtime::block_on(async {
                SqlitePoolOptions::new()
                    .max_connections(5)
                    .connect(&db_url)
                    .await
            })
            .map_err(|err| -> Box<dyn std::error::Error> { Box::new(err) })?;

            app.manage(crate::state::OptionKeyDatabase::new(pool.clone()));
            app.manage(crate::state::OverlayState::new());
            app.manage(crate::state::RemoteReceiverState::new());
            app.manage(crate::state::FloatingWindowState::new());

            #[cfg(desktop)]
            {
                if std::env::args().any(|arg| arg == AUTOSTART_HIDDEN_ARG) {
                    if let Some(main_window) = app.get_webview_window("main") {
                        let _ = main_window.hide();
                        #[cfg(target_os = "windows")]
                        {
                            crate::platform::window::keep_webview_active(app.handle(), "main");
                            crate::platform::window::set_webview_keepalive(true);
                        }
                        #[cfg(target_os = "macos")]
                        {
                            if let Err(err) = crate::platform::macos::dock::hide_dock_icon() {
                                log::error!("Failed to hide dock icon on autostart: {err}");
                            }
                        }
                    }
                }

                #[cfg(target_os = "windows")]
                crate::platform::window::start_webview_keepalive(app.handle());

                crate::system::tray::setup_tray(app)
                    .map_err(|err| -> Box<dyn std::error::Error> { Box::new(err) })?;

                let app_handle = app.handle();

                let recorder = crate::platform::audio::new_recorder();

                app.manage(recorder);

                // Pre-warm audio output for instant chime playback
                crate::system::audio_feedback::warm_audio_output();

                crate::overlay::try_create_native_overlays(app_handle);
            }

            if crate::platform::get_hotkey_strategy() == "bridge" {
                crate::platform::init::ensure_background_services();
                crate::system::bridge_server::start(app.handle().clone());
                crate::platform::compositor::deploy_trigger_script(app.handle());
            }

            // Open dev tools if MAUSVOICE_ENABLE_DEVTOOLS is set
            if std::env::var("MAUSVOICE_ENABLE_DEVTOOLS").is_ok() {
                log::info!("MAUSVOICE_ENABLE_DEVTOOLS detected, opening dev tools...");
                if let Some(main_window) = app.get_webview_window("main") {
                    main_window.open_devtools();
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            crate::commands::user_get_one,
            crate::commands::user_set_one,
            crate::commands::user_preferences_get,
            crate::commands::user_preferences_set,
            crate::commands::list_microphones,
            crate::commands::list_gpus,
            crate::commands::get_system_capabilities,
            crate::commands::get_screen_visible_area,
            crate::commands::get_monitor_at_cursor,
            crate::commands::check_microphone_permission,
            crate::commands::request_microphone_permission,
            crate::commands::check_accessibility_permission,
            crate::commands::request_accessibility_permission,
            crate::commands::get_current_app_info,
            crate::commands::app_target_upsert,
            crate::commands::app_target_list,
            crate::commands::paired_remote_device_upsert,
            crate::commands::paired_remote_device_list,
            crate::commands::paired_remote_device_delete,
            crate::commands::remote_receiver_start,
            crate::commands::remote_receiver_stop,
            crate::commands::remote_receiver_status,
            crate::commands::remote_sender_deliver_final_text,
            crate::commands::remote_sender_pair_with_receiver,
            crate::commands::start_recording,
            crate::commands::stop_recording,
            crate::commands::pause_recording,
            crate::commands::resume_recording,
            crate::commands::store_transcription_audio,
            crate::commands::storage_upload_data,
            crate::commands::storage_get_download_url,
            crate::commands::surface_main_window,
            crate::commands::set_pill_window_size,
            crate::commands::paste,
            crate::commands::simulate_type,
            crate::commands::cancel_typing,
            crate::commands::copy_to_clipboard,
            crate::commands::transcription_create,
            crate::commands::transcription_list,
            crate::commands::transcription_delete,
            crate::commands::transcription_update,
            crate::commands::transcription_audio_load,
            crate::commands::purge_stale_transcription_audio,
            crate::commands::export_transcription,
            crate::commands::export_diagnostics,
            crate::commands::term_create,
            crate::commands::term_update,
            crate::commands::term_list,
            crate::commands::term_delete,
            crate::commands::hotkey_list,
            crate::commands::hotkey_save,
            crate::commands::hotkey_delete,
            crate::commands::set_tray_title,
            crate::commands::set_menu_icon,
            crate::commands::set_tray_language_menu,
            crate::commands::set_register_app_label,
            crate::commands::set_pill_visibility_menu_state,
            crate::commands::set_reset_pill_position_enabled,
            crate::commands::reset_pill_position,
            crate::commands::set_tray_visible,
            crate::commands::api_key_create,
            crate::commands::api_key_list,
            crate::commands::api_key_delete,
            crate::commands::api_key_update,
            crate::commands::tone_upsert,
            crate::commands::tone_list,
            crate::commands::tone_get,
            crate::commands::tone_delete,
            crate::commands::clear_local_data,
            crate::commands::set_phase,
            crate::commands::set_pill_visibility,
            crate::commands::set_pill_placement,
            crate::commands::notify_pill_style_info,
            crate::commands::sync_native_pill_assistant,
            crate::commands::start_key_listener,
            crate::commands::stop_key_listener,
            crate::commands::restart_key_listener,
            crate::commands::sync_hotkey_combos,
            crate::commands::sync_compositor_hotkeys,
            crate::commands::reset_key_listener_state,
            crate::commands::get_key_listener_health,
            crate::commands::retry_key_listener,
            crate::commands::play_audio,
            crate::commands::get_text_field_info,
            crate::commands::get_screen_context,
            crate::commands::find_pid_by_window_title,
            crate::commands::get_selected_text,
            crate::commands::gather_accessibility_dump,
            crate::commands::get_focused_field_info,
            crate::commands::write_accessibility_fields,
            crate::commands::focus_accessibility_field,
            crate::commands::read_accessibility_field_values,
            crate::commands::resolve_app_pids,
            crate::commands::check_focused_paste_target,
            crate::commands::run_terminal_command,
            crate::commands::get_hotkey_strategy,
            crate::commands::supports_app_detection,
            crate::commands::supports_paste_keybinds,
            crate::commands::enable_java_access_bridge,
            crate::commands::get_native_setup_status,
            crate::commands::run_native_setup,
            crate::commands::request_admin_relaunch,
            crate::commands::get_keyboard_language,
            crate::commands::conversation_create,
            crate::commands::conversation_list,
            crate::commands::conversation_update,
            crate::commands::conversation_delete,
            crate::commands::chat_message_create,
            crate::commands::chat_message_list,
            crate::commands::chat_message_update,
            crate::commands::chat_message_delete_many,
            crate::commands::check_app_location_writable,
            crate::commands::download_and_open_mac_installer,
            crate::commands::get_system_volume,
            crate::commands::set_system_volume,
            crate::commands::floating_window_create,
            crate::commands::floating_window_destroy,
            crate::commands::floating_window_list,
        ])
}

pub fn run(context: tauri::Context) -> Result<(), tauri::Error> {
    // If this process is the Windows elevation bootstrap helper, it waits for
    // the original process to exit and then launches the elevated copy. It must
    // run before the Tauri app initializes (and takes the single-instance lock).
    #[cfg(target_os = "windows")]
    if crate::platform::windows::init::run_elevate_helper_if_requested() {
        return Ok(());
    }

    let app = build().build(context)?;
    app.run(handle_run_event);
    Ok(())
}
