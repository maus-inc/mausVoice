use serde::Serialize;

/// Tauri event emitted while a hold-to-talk hotkey is physically held.
pub const EVT_KEYS_HELD: &str = "keys_held";

/// Emitted by the Windows lifecycle watcher (see `platform::windows::lifecycle`)
/// after the workstation resumes from sleep or unlocks. The frontend uses this
/// to re-register the global hotkey listener, which can lose its low-level
/// keyboard hook across a sleep/wake boundary or a session unlock.
pub const EVT_DESKTOP_RESUME: &str = "desktop_resume";

#[derive(Clone, Serialize)]
pub struct KeysHeldPayload {
    pub keys: Vec<String>,
}

pub const EVT_KEYBOARD_LISTENER_HEALTH: &str = "keyboard_listener_health";

#[derive(Clone, Serialize)]
pub struct KeyboardListenerHealthPayload {
    /// Snake-case health state (see `platform::keyboard::HealthState::as_str`).
    pub state: String,
}
