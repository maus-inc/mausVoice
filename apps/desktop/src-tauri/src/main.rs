// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

static MAUSVOICE_KEYBOARD_LISTENER: &str = "MAUSVOICE_KEYBOARD_LISTENER";
static MAUSVOICE_GPU_ENUMERATOR: &str = "MAUSVOICE_GPU_ENUMERATOR";

mod flavor_env;

fn main() {
    // CRITICAL: Configure display backend before GTK initialization
    desktop_lib::platform::init::configure_display_backend();

    // CRITICAL: Initialize X11 threading before ANY other operations
    desktop_lib::platform::init::init_x11_threads();

    // CRITICAL: Apply WebKit workarounds on X11 before the Tauri builder creates the WebView.
    desktop_lib::platform::init::apply_webkit_workarounds();

    // Initialize startup logging
    eprintln!("=== mausVoice Startup ===");
    eprintln!("[startup] Version: {}", env!("CARGO_PKG_VERSION"));
    eprintln!("[startup] OS: {}", std::env::consts::OS);
    eprintln!("[startup] Arch: {}", std::env::consts::ARCH);

    flavor_env::load_flavor_env();

    if std::env::var(MAUSVOICE_KEYBOARD_LISTENER).as_deref() == Ok("1") {
        eprintln!("[startup] Running in keyboard listener mode");
        if let Err(err) = desktop_lib::platform::keyboard::run_listener_process() {
            eprintln!("[startup] ERROR: Keyboard listener process failed: {err}");
            std::process::exit(1);
        }
        return;
    }

    if std::env::var(MAUSVOICE_GPU_ENUMERATOR).as_deref() == Ok("1") {
        eprintln!("[startup] Running in GPU enumerator mode");
        if let Err(err) = desktop_lib::system::gpu::run_gpu_enumerator_process() {
            eprintln!("[startup] ERROR: GPU enumerator process failed: {err}");
            std::process::exit(1);
        }
        return;
    }

    eprintln!("[startup] Building Tauri application...");

    let app_result = std::panic::catch_unwind(|| desktop_lib::app::run(tauri::generate_context!()));

    // A database that cannot be opened is raised inside Tauri's setup hook,
    // which turns a setup `Err` into a panic carrying the message, so that is the
    // arm that has to recognise it. The `Ok(Err(..))` arm below still matches on
    // the same phrase because a runtime can return the error directly, but the
    // panic arm is the one that carries it today.
    const DATABASE_OPEN_FAILURE: &str = "could not open the database";

    match app_result {
        Ok(result) => {
            if let Err(err) = result {
                let err_str = err.to_string();
                eprintln!("[startup] ERROR: Tauri runtime failure: {err}");

                // Provide context-specific guidance
                if err_str.contains(DATABASE_OPEN_FAILURE) {
                    // The path is in the message. The app cannot start without
                    // its database and nothing here can repair it, so say so —
                    // advising deletion would throw away the transcriptions, keys
                    // and preferences the file holds.
                    eprintln!(
                        "[startup] The database could not be opened. Its contents have been left in place."
                    );
                } else if err_str.contains("migration") {
                    eprintln!("[startup] This is a database migration issue.");
                    eprintln!("[startup] Try deleting the app database and restarting.");
                } else if err_str.contains("vulkan")
                    || err_str.contains("gpu")
                    || err_str.contains("GPU")
                {
                    eprintln!("[startup] This appears to be a GPU/graphics driver issue.");
                    eprintln!(
                        "[startup] Local transcription can fall back to CPU from Settings if GPU acceleration is unstable."
                    );
                }
                std::process::exit(1);
            }
        }
        Err(panic_info) => {
            eprintln!("[startup] PANIC: Application panicked during startup!");
            // Downcast once: the payload is printed and inspected from the same
            // value, so the two cannot disagree about what it was.
            let panicked: &str = if let Some(s) = panic_info.downcast_ref::<&str>() {
                s
            } else if let Some(s) = panic_info.downcast_ref::<String>() {
                s.as_str()
            } else {
                ""
            };
            if panicked.is_empty() {
                eprintln!("[startup] Panic message: <unknown>");
            } else {
                eprintln!("[startup] Panic message: {panicked}");
            }
            if panicked.contains(DATABASE_OPEN_FAILURE) {
                eprintln!(
                    "[startup] The database could not be opened. Its contents have been left in place."
                );
            } else {
                eprintln!(
                    "[startup] If this is GPU-related, switch local transcription to CPU in Settings."
                );
            }
            std::process::exit(1);
        }
    }
}
