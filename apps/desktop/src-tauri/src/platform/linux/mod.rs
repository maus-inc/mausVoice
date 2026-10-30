pub(crate) mod detect;
pub(crate) mod launch_env;
mod wl;
mod x11;

pub mod accessibility;
pub mod audio;
pub mod compositor;
pub mod feedback;
pub mod init;
pub mod input;
pub mod keyboard;
pub mod keyboard_language;
pub mod monitor;
pub mod overlay;
pub mod permissions;
pub mod position;
pub mod volume;
pub mod window;

pub fn get_hotkey_strategy() -> &'static str {
    use crate::platform::common::{BRIDGE_HOTKEY_STRATEGY, LISTENER_HOTKEY_STRATEGY};

    if detect::is_wayland() {
        BRIDGE_HOTKEY_STRATEGY
    } else {
        LISTENER_HOTKEY_STRATEGY
    }
}

pub fn supports_app_detection() -> bool {
    !detect::is_wayland()
}

pub fn supports_paste_keybinds() -> crate::platform::PasteKeybindSupport {
    if detect::is_wayland() {
        crate::platform::PasteKeybindSupport::Global
    } else {
        crate::platform::PasteKeybindSupport::PerApp
    }
}
