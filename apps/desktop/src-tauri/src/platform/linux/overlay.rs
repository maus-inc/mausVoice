use crate::platform::common::PillOverlay;

const OVERLAY: PillOverlay = PillOverlay {
    binary_name: "mausvoice-gtk-pill",
    package_dir: "rust_gtk_pill",
    missing_label: "GTK pill binary not found",
    active_label: "Using native overlays via GTK layer-shell",
};

pub fn try_create_native_overlays(app: &tauri::AppHandle) -> bool {
    crate::platform::common::try_spawn_native_overlays(app, &OVERLAY)
}

/// Forwards the pill anchor preference (`top` / `bottom`) to the GTK pill
/// process. The GTK pill currently ignores it; see the settings gate.
pub use crate::platform::common::notifications::notify_pill_placement;

pub use crate::platform::common::notifications::*;
