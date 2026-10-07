use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    LogicalSize, Manager, PhysicalPosition, PhysicalSize, RunEvent, WebviewWindow, Window,
    WindowEvent,
};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

const AUTOSTART_HIDDEN_ARG: &str = "--mausvoice-autostart-hidden";
/// Default logical dimensions for the main window (matches `tauri.conf.json`).
const DEFAULT_MAIN_WIDTH: f64 = 1100.0;
const DEFAULT_MAIN_HEIGHT: f64 = 700.0;
/// Opt-in env var that opens the webview devtools on startup. Only read by
/// debug-assist builds, so it is gated the same way to keep release clippy clean.
#[cfg(feature = "debug-assist")]
const DEVTOOLS_ENV_VAR: &str = "MAUSVOICE_ENABLE_DEVTOOLS";

/// Maximum size of a single log file before the plugin rotates it.
/// At 25 MB and `MAX_LOG_FILES` kept files, the total log directory is
/// capped near 250 MB.
const MAX_LOG_FILE_SIZE: u128 = 25 * 1024 * 1024;

/// Number of rotated log files the plugin keeps on disk. Combined with
/// `MAX_LOG_FILE_SIZE` this bounds the log directory to roughly 250 MB.
const MAX_LOG_FILES: usize = 10;

/// Returns the default log level, or the level requested through the
/// `MAUSVOICE_LOG` environment variable when it parses to a known level.
/// `debug` and `trace` are reachable for opt-in troubleshooting; the
/// production default is `info` to keep file size and noise in check.
const MAUSVOICE_LOG_ENV: &str = "MAUSVOICE_LOG";

fn default_log_level() -> log::LevelFilter {
    if let Ok(raw) = std::env::var(MAUSVOICE_LOG_ENV) {
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

    // Minimizing a window moves it to `(-32000, -32000)` on Windows and emits a
    // synthetic `Moved` event on Linux; skip logging move geometry while minimized.
    if window.is_minimized().unwrap_or(false) {
        return;
    }

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

    let window_size = window.inner_size().ok();
    match window.current_monitor() {
        Ok(Some(monitor)) => {
            let origin = monitor.position();
            let size = monitor.size();
            log::debug!(
                "main window moved to ({}, {}) window_size {:?} | monitor {:?} origin ({}, {}) size {}x{} scale {}",
                position.x,
                position.y,
                window_size,
                monitor.name(),
                origin.x,
                origin.y,
                size.width,
                size.height,
                monitor.scale_factor(),
            );
        }
        _ => log::debug!(
            "main window moved to ({}, {}) window_size {:?} | monitor unavailable",
            position.x,
            position.y,
            window_size
        ),
    }
}

/// Flags persisted by `tauri-plugin-window-state`.
///
/// Only size and maximized state are persisted; launch position is left to
/// the window configuration so a saved off-screen coordinate does not strand
/// the window. Including `MAXIMIZED` alongside `SIZE` ensures that closing the
/// app while maximized does not restore the full-screen dimensions as the
/// window's unmaximized size.
const WINDOW_STATE_FLAGS: StateFlags = StateFlags::SIZE.union(StateFlags::MAXIMIZED);

/// Last known unmaximized, unminimized physical inner size of the main window.
///
/// `tauri-plugin-window-state` 2.4.1 overwrites `state.width`/`state.height`
/// during `WindowEvent::Resized` on undecorated macOS windows (`!is_decorated()`
/// forces `is_maximized = false`) and on Linux (`configure-event` arrives
/// before `window-state-event` sets `is_maximized = true`). Keeping the last
/// normal size here lets `save_main_window_state` and startup sanitization
/// preserve a real unmaximized restore size across sessions.
static LAST_NORMAL_MAIN_SIZE: Mutex<Option<PhysicalSize<u32>>> = Mutex::new(None);
/// Tracks whether the main window's latest non-minimized resize was maximized or
/// filled the monitor work area, so closing/hiding on undecorated macOS or
/// exiting after `tauri-plugin-window-state`'s `RunEvent::Exit` callback does
/// not lose the maximized state.
static LAST_MAIN_MAXIMIZED: AtomicBool = AtomicBool::new(false);

/// Returns `true` when `size` represents an unminimized, non-work-area-filling
/// normal window size rather than a `(0, 0)` minimized size or a maximized
/// full-screen work-area size.
fn is_normal_window_size(size: PhysicalSize<u32>, work_area: Option<PhysicalSize<u32>>) -> bool {
    if size.width == 0 || size.height == 0 {
        return false;
    }
    let Some(work) = work_area else {
        return true;
    };
    size.width.saturating_add(2) < work.width || size.height.saturating_add(2) < work.height
}

/// Returns `true` when `size` has positive dimensions that cover the monitor
/// work area (i.e. a maximized/full-work-area window size).
fn is_work_area_window_size(size: PhysicalSize<u32>, work_area: Option<PhysicalSize<u32>>) -> bool {
    size.width > 0 && size.height > 0 && !is_normal_window_size(size, work_area)
}

/// Determines whether the restored main window came from a maximized session,
/// including undecorated macOS sessions where both the saved and live maximize
/// flags can read `false` while the saved or restored size covers the work area.
fn is_maximized_session(
    saved: (PhysicalSize<u32>, bool),
    live: (PhysicalSize<u32>, bool),
    work_area: Option<PhysicalSize<u32>>,
) -> bool {
    saved.1
        || live.1
        || is_work_area_window_size(saved.0, work_area)
        || is_work_area_window_size(live.0, work_area)
}

fn current_work_area_size(window: &Window) -> Option<PhysicalSize<u32>> {
    window
        .current_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor.work_area().size)
}

fn default_main_physical_size(scale_factor: f64) -> PhysicalSize<u32> {
    let scale = if scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    LogicalSize::new(DEFAULT_MAIN_WIDTH, DEFAULT_MAIN_HEIGHT).to_physical(scale)
}

fn record_main_window_resize(window: &Window, size: PhysicalSize<u32>) {
    if window.is_minimized().unwrap_or(false) || size.width == 0 || size.height == 0 {
        return;
    }
    let work_area = current_work_area_size(window);
    let normal = is_normal_window_size(size, work_area);
    let maximized = window.is_maximized().unwrap_or(false) || !normal;
    LAST_MAIN_MAXIMIZED.store(maximized, Ordering::SeqCst);
    if maximized {
        return;
    }
    if let Ok(mut slot) = LAST_NORMAL_MAIN_SIZE.lock() {
        *slot = Some(size);
    }
}

fn window_state_file_path(app_handle: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let app_dir = app_handle.path().app_config_dir().ok()?;
    Some(app_dir.join(app_handle.filename()))
}

fn read_saved_main_window_entry(app_handle: &tauri::AppHandle) -> (PhysicalSize<u32>, bool) {
    let Some(root) = window_state_file_path(app_handle)
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
    else {
        return (PhysicalSize::new(0, 0), false);
    };
    let Some(entry) = root.get("main") else {
        return (PhysicalSize::new(0, 0), false);
    };
    let width = entry.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let height = entry.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let maximized = entry
        .get("maximized")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    (PhysicalSize::new(width, height), maximized)
}

/// Ensures that the persisted `.window-state.json` entry for `"main"` retains
/// a normal unmaximized `width` and `height` and accurate `maximized` flag even
/// when the window was closed while maximized on macOS or Linux.
fn save_main_window_state(app_handle: &tauri::AppHandle) {
    let _ = app_handle.save_window_state(WINDOW_STATE_FLAGS);
    let Some(main_window) = app_handle.get_webview_window("main") else {
        return;
    };
    let work_area = main_window
        .current_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor.work_area().size);
    let scale = main_window.scale_factor().unwrap_or(1.0);
    let fallback_size = LAST_NORMAL_MAIN_SIZE
        .lock()
        .ok()
        .and_then(|slot| *slot)
        .unwrap_or_else(|| default_main_physical_size(scale));
    let Some(state_path) = window_state_file_path(app_handle) else {
        return;
    };
    let Ok(bytes) = std::fs::read(&state_path) else {
        return;
    };
    let Ok(mut root) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return;
    };
    let Some(main_entry) = root.get_mut("main").and_then(|v| v.as_object_mut()) else {
        return;
    };
    let saved_width = main_entry
        .get("width")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let saved_height = main_entry
        .get("height")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let saved_maximized = main_entry
        .get("maximized")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let saved_size = PhysicalSize::new(saved_width, saved_height);
    let is_maximized = main_window.is_maximized().unwrap_or(false)
        || LAST_MAIN_MAXIMIZED.load(Ordering::SeqCst)
        || is_work_area_window_size(saved_size, work_area);
    let needs_size_fix = !is_normal_window_size(saved_size, work_area);
    let needs_max_fix = saved_maximized != is_maximized;
    if needs_size_fix || needs_max_fix {
        if needs_size_fix {
            let width = serde_json::Value::from(fallback_size.width);
            let height = serde_json::Value::from(fallback_size.height);
            main_entry.insert("width".to_string(), width);
            main_entry.insert("height".to_string(), height);
        }
        if needs_max_fix {
            let max_val = serde_json::Value::from(is_maximized);
            main_entry.insert("maximized".to_string(), max_val);
        }
        if let Ok(updated) = serde_json::to_vec_pretty(&root) {
            let _ = std::fs::write(&state_path, updated);
        }
    }
}

/// Repairs the main window's normal restore geometry if `tauri-plugin-window-state`
/// restored work-area / full-screen dimensions as the window's unmaximized size.
fn sanitize_restored_main_window(main_window: &WebviewWindow) {
    let Ok(inner_size) = main_window.inner_size() else {
        return;
    };
    let work_area = main_window
        .current_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor.work_area().size);
    let scale = main_window.scale_factor().unwrap_or(1.0);
    let saved_entry = read_saved_main_window_entry(main_window.app_handle());
    let (saved_size, _) = saved_entry;
    let live_maximized = main_window.is_maximized().unwrap_or(false);
    let live_entry = (inner_size, live_maximized);
    let was_maximized = is_maximized_session(saved_entry, live_entry, work_area);
    LAST_MAIN_MAXIMIZED.store(was_maximized, Ordering::SeqCst);

    if is_normal_window_size(inner_size, work_area) {
        if let Ok(mut slot) = LAST_NORMAL_MAIN_SIZE.lock() {
            *slot = Some(inner_size);
        }
        if was_maximized && !live_maximized {
            let _ = main_window.maximize();
        }
        return;
    }

    if was_maximized && is_normal_window_size(saved_size, work_area) {
        if let Ok(mut slot) = LAST_NORMAL_MAIN_SIZE.lock() {
            *slot = Some(saved_size);
        }
        if !live_maximized {
            let _ = main_window.maximize();
        }
        return;
    }

    let default_physical = default_main_physical_size(scale);
    if let Ok(mut slot) = LAST_NORMAL_MAIN_SIZE.lock() {
        *slot = Some(default_physical);
    }

    let default_logical = LogicalSize::new(DEFAULT_MAIN_WIDTH, DEFAULT_MAIN_HEIGHT);
    let _ = main_window.unmaximize();
    let _ = main_window.set_size(default_logical);
    let _ = main_window.center();
    if was_maximized {
        let _ = main_window.maximize();
    }
}

/// Handles application lifecycle events.
///
/// On exit the window size/position are persisted and the global keyboard
/// listener is stopped; on macOS `Reopen` the main window is surfaced again.
fn handle_run_event(app_handle: &tauri::AppHandle, event: RunEvent) {
    match &event {
        RunEvent::ExitRequested { .. } => {
            save_main_window_state(app_handle);
            if let Err(err) = crate::platform::keyboard::stop_key_listener() {
                log::error!("Failed to stop keyboard listener on exit: {err}");
            }
        }
        RunEvent::Exit => {
            save_main_window_state(app_handle);
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
                    let raw_message = message.to_string();
                    let sanitized = crate::utils::log_sanitizer::sanitize_log_content(&raw_message);
                    out.finish(format_args!(
                        "[{}][{}][{}] {}",
                        now.format("%Y-%m-%d][%H:%M:%S%.3f"),
                        record.level(),
                        record.target(),
                        sanitized
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
        .plugin(tauri_plugin_dialog::init())
        // Database management and migrations are handled in setup via `open_app_database`.
        // The legacy tauri_plugin_sql plugin is intentionally omitted to avoid preloading
        // file locks that prevent quarantine recovery on Windows.
        .plugin(updater_builder.build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                // Only persist/restore the window SIZE and MAXIMIZED state. The
                // launch position is owned by `center: true` in tauri.conf.json
                // — restoring a saved position used to spawn the window wherever
                // it last sat (and defaulted to the top-left corner on a fresh
                // install).
                .with_state_flags(WINDOW_STATE_FLAGS)
                .with_denylist(&["pill"])
                .with_filter(|label| label == "main")
                .build(),
        )
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                    api.prevent_close();
                    save_main_window_state(window.app_handle());
                    // Use the webview window for hide_main_window (which
                    // needs &WebviewWindow, not &Window from on_window_event).
                    if let Some(main_ww) = window.app_handle().get_webview_window("main") {
                        if let Err(err) = crate::platform::window::hide_main_window(&main_ww) {
                            log::error!("Failed to hide main window: {err}");
                        }
                    }
                }
                WindowEvent::Resized(size) if window.label() == "main" => {
                    record_main_window_resize(window, *size);
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
            // Chained rather than replaced. The previous hook wrote only to the log
            // file, and a setup failure exits without a console on Windows and
            // when launched from Finder or a desktop entry, so the reason was
            // invisible everywhere except a log nothing points the user at.
            let previous_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                log::error!("PANIC: {info}");
                previous_hook(info);
            }));

            log::info!("Starting application setup...");

            // Preserve GGML files from the old app-data/models location before
            // the desktop sidecars start using app-data/transcription-models.
            if let Err(err) = crate::system::paths::migrate_legacy_models(app.handle()) {
                log::error!("Failed to migrate legacy transcription models: {err}");
            }

            // Record the Windows elevation state once. An unelevated low-level
            // keyboard hook cannot observe input delivered to a higher-integrity
            // window (UIPI), so this is the first thing to check when a user
            // reports hotkeys failing over an elevated app.
            //
            // Spin up the OS-level sleep/wake and session-unlock watcher so
            // the global keyboard hook can be re-armed after resume. Without
            // this the hotkey stops firing after a laptop sleep or a fast
            // user-switch unlock.
            #[cfg(target_os = "windows")]
            {
                crate::platform::windows::permissions::log_elevation_state();
                crate::platform::windows::lifecycle::start_watcher(app.handle());
            }

            // Purge old log files, keeping the latest 10
            crate::system::diagnostics::purge_old_logs(app.handle());

            // Write startup diagnostics for debugging
            crate::system::diagnostics::write_startup_diagnostics(app.handle());

            let db_path = {
                let handle = app.handle();
                crate::system::paths::database_path(handle)
                    .map_err(|err| -> Box<dyn std::error::Error> { Box::new(err) })?
            };

            // The path belongs in the failure. A database that cannot be opened leaves the
            // app unable to start, so this error is the only account of what
            // happened, and without the path neither the log nor a crash report
            // says which file to look at.
            let pool = tauri::async_runtime::block_on(crate::db::open::open_app_database(&db_path))
                .map_err(|err| -> Box<dyn std::error::Error> {
                    let message = format!(
                        "could not open the database at {}: {err}",
                        db_path.display()
                    );
                    log::error!("{message}");
                    message.into()
                })?;

            app.manage(crate::state::OptionKeyDatabase::new(pool.clone()));
            app.manage(crate::state::OverlayState::new());
            app.manage(crate::state::RemoteReceiverState::new());
            app.manage(crate::state::FloatingWindowState::new());

            #[cfg(desktop)]
            {
                if let Some(main_window) = app.get_webview_window("main") {
                    sanitize_restored_main_window(&main_window);
                    if std::env::args().any(|arg| arg == AUTOSTART_HIDDEN_ARG) {
                        if let Err(err) = crate::platform::window::hide_main_window(&main_window) {
                            log::error!("Failed to hide main window on autostart: {err}");
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

            // The capability itself is omitted from stable binaries. Keeping this
            // behind the same compile-time feature makes the environment variable
            // intentionally ineffective if it is set for a release build.
            #[cfg(feature = "debug-assist")]
            if std::env::var(DEVTOOLS_ENV_VAR).is_ok() {
                log::info!("{DEVTOOLS_ENV_VAR} detected, opening dev tools...");
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
            crate::commands::user_preferences_set_expansion_flags,
            crate::commands::user_preferences_compare_set_expansion_flags,
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
            crate::commands::private_http_request,
            crate::commands::openai_compatible_http_request,
            crate::commands::simulate_type,
            crate::commands::cancel_private_http_request,
            crate::commands::cancel_typing,
            crate::commands::copy_to_clipboard,
            crate::commands::transcription_create,
            crate::commands::transcription_list,
            crate::commands::transcription_delete,
            crate::commands::transcription_update,
            crate::commands::transcription_audio_load,
            crate::commands::transcription_import_audio,
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
            crate::commands::hotkey_replace_style_hotkeys,
            crate::commands::set_tray_title,
            crate::commands::set_menu_icon,
            crate::commands::set_tray_language_menu,
            crate::commands::set_register_app_label,
            crate::commands::set_dashboard_menu_labels,
            crate::commands::set_pill_visibility_menu_state,
            crate::commands::set_reset_pill_position_enabled,
            crate::commands::request_pill_position,
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
            crate::commands::set_interaction_chime_enabled,
            crate::commands::set_interaction_feedback_volume,
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
            crate::commands::quit_app,
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
            crate::commands::check_for_channel_update,
            crate::commands::download_and_open_mac_installer,
            crate::commands::get_system_volume,
            crate::commands::set_system_volume,
            crate::commands::composer_register_text,
            crate::commands::composer_peek_text,
            crate::commands::composer_discard_text,
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

#[cfg(test)]
mod tests {
    use super::{
        default_main_physical_size, is_maximized_session, is_normal_window_size,
        is_work_area_window_size, WINDOW_STATE_FLAGS,
    };
    use tauri::PhysicalSize;
    use tauri_plugin_window_state::StateFlags;

    #[test]
    fn window_state_flags_persist_both_size_and_maximized() {
        assert!(WINDOW_STATE_FLAGS.contains(StateFlags::SIZE));
        assert!(WINDOW_STATE_FLAGS.contains(StateFlags::MAXIMIZED));
        assert!(!WINDOW_STATE_FLAGS.contains(StateFlags::POSITION));
    }

    #[test]
    fn normal_window_size_rejects_minimized_and_work_area_dimensions() {
        let work_area = Some(PhysicalSize::new(1920, 1040));
        let zero = PhysicalSize::new(0, 0);
        let full = PhysicalSize::new(1920, 1040);
        let almost_full = PhysicalSize::new(1919, 1039);
        let normal = PhysicalSize::new(1100, 700);

        assert!(!is_normal_window_size(zero, work_area));
        assert!(!is_normal_window_size(full, work_area));
        assert!(!is_normal_window_size(almost_full, work_area));
        assert!(is_normal_window_size(normal, work_area));
        assert!(is_normal_window_size(normal, None));
    }

    #[test]
    fn is_maximized_session_detects_work_area_size_when_flags_are_false() {
        let work_area = Some(PhysicalSize::new(1920, 1040));
        let zero = PhysicalSize::new(0, 0);
        let full = PhysicalSize::new(1920, 1040);
        let normal = PhysicalSize::new(1100, 700);

        assert!(!is_work_area_window_size(zero, work_area));
        assert!(is_work_area_window_size(full, work_area));
        assert!(!is_work_area_window_size(normal, work_area));

        let full_state = (full, false);
        let norm_state = (normal, false);
        let zero_state = (zero, false);
        let flagged_norm = (normal, true);

        assert!(is_maximized_session(full_state, full_state, work_area));
        assert!(is_maximized_session(norm_state, full_state, work_area));
        assert!(is_maximized_session(full_state, norm_state, work_area));
        assert!(is_maximized_session(flagged_norm, norm_state, work_area));
        assert!(!is_maximized_session(norm_state, norm_state, work_area));
        assert!(!is_maximized_session(zero_state, zero_state, work_area));
    }

    #[test]
    fn default_main_physical_size_scales_logical_dimensions() {
        let one_x = PhysicalSize::new(1100, 700);
        let two_x = PhysicalSize::new(2200, 1400);

        assert_eq!(default_main_physical_size(1.0), one_x);
        assert_eq!(default_main_physical_size(2.0), two_x);
    }
}
