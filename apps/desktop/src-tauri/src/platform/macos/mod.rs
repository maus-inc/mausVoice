pub mod accessibility;
pub mod compositor;
pub mod dock;
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

pub use crate::platform::common::{
    listener_hotkey_strategy as get_hotkey_strategy, supports_app_detection,
};

pub fn supports_paste_keybinds() -> crate::platform::PasteKeybindSupport {
    crate::platform::PasteKeybindSupport::Disabled
}
