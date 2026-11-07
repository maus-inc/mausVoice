use crate::platform::common::PillOverlay;

const OVERLAY: PillOverlay = PillOverlay {
    binary_name: "mausvoice-windows-pill.exe",
    package_dir: "rust_windows_pill",
    missing_label: "Windows pill binary not found",
    active_label: "Using native overlays via Windows pill",
};

pub fn try_create_native_overlays(app: &tauri::AppHandle) -> bool {
    crate::platform::common::try_spawn_native_overlays(app, &OVERLAY)
}

pub use crate::platform::common::notifications::*;
