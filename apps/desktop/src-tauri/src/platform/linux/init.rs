use crate::platform::{NativeSetupResult, NativeSetupStatus};

pub fn init_x11_threads() {
    if !super::detect::is_wayland() {
        super::x11::init::init_x11_threads();
    }
}

pub fn configure_display_backend() {
    if super::detect::is_wayland() {
        super::wl::init::configure_display_backend();
    }
}

/// Applies the WebKitGTK rendering workarounds for the current session
/// type. See [`launch_env::apply_webkit_workarounds`].
pub fn apply_webkit_workarounds() {
    super::launch_env::apply_webkit_workarounds();
}

pub fn get_native_setup_status() -> NativeSetupStatus {
    if super::detect::is_wayland() {
        super::wl::setup::get_native_setup_status()
    } else {
        NativeSetupStatus::Ready
    }
}

pub async fn run_native_setup(_app: tauri::AppHandle) -> NativeSetupResult {
    if super::detect::is_wayland() {
        super::wl::setup::run_native_setup(_app).await
    } else {
        NativeSetupResult::Success
    }
}

pub fn ensure_background_services() {
    if super::detect::is_wayland() {
        super::wl::setup::ensure_background_services();
    }
}
