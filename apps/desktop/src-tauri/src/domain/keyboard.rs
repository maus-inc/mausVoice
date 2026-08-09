use serde::Serialize;

pub const EVT_KEYS_HELD: &str = "keys_held";

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
