use crate::platform::permissions;

pub fn init_x11_threads() {}

pub fn configure_display_backend() {}

pub fn get_native_setup_status() -> crate::platform::NativeSetupStatus {
    let mic = permissions::check_microphone_permission();
    let ax = permissions::check_accessibility_permission();

    let mic_ok = matches!(mic, Ok(s) if s.state == crate::domain::PermissionState::Authorized);
    let ax_ok = matches!(ax, Ok(s) if s.state == crate::domain::PermissionState::Authorized);

    if mic_ok && ax_ok {
        crate::platform::NativeSetupStatus::Ready
    } else {
        crate::platform::NativeSetupStatus::NeedsSetup
    }
}

pub async fn run_native_setup() -> crate::platform::NativeSetupResult {
    // macOS gates global input capture behind the Accessibility and Microphone
    // privacy prompts. Triggering them (via the real permission flow) is the
    // macOS equivalent of Linux's pkexec provisioning.
    if let Err(err) = permissions::request_microphone_permission() {
        log::error!("Failed to request microphone permission: {err}");
    }
    if let Err(err) = permissions::request_accessibility_permission() {
        log::error!("Failed to request accessibility permission: {err}");
    }

    let mic = permissions::check_microphone_permission();
    let ax = permissions::check_accessibility_permission();
    let mic_ok = matches!(mic, Ok(s) if s.state == crate::domain::PermissionState::Authorized);
    let ax_ok = matches!(ax, Ok(s) if s.state == crate::domain::PermissionState::Authorized);

    if mic_ok && ax_ok {
        crate::platform::NativeSetupResult::Success
    } else {
        crate::platform::NativeSetupResult::RequireRestart
    }
}

pub fn ensure_background_services() {}
