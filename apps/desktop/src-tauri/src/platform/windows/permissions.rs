use crate::domain::{PermissionKind, PermissionState, PermissionStatus};
use crate::platform::windows::init::is_process_elevated;

pub(crate) fn check_microphone_permission() -> Result<PermissionStatus, String> {
    Ok(authorized_status(PermissionKind::Microphone))
}

pub(crate) fn request_microphone_permission() -> Result<PermissionStatus, String> {
    check_microphone_permission()
}

pub(crate) fn check_accessibility_permission() -> Result<PermissionStatus, String> {
    // On Windows, reliable global input capture requires the process to run
    // elevated (admin / UIAccess). We surface elevation as the accessibility
    // gate so the UI can prompt for it via run_native_setup.
    if is_process_elevated() {
        Ok(authorized_status(PermissionKind::Accessibility))
    } else {
        Ok(PermissionStatus {
            kind: PermissionKind::Accessibility,
            state: PermissionState::NotDetermined,
            prompt_shown: false,
        })
    }
}

pub(crate) fn request_accessibility_permission() -> Result<PermissionStatus, String> {
    check_accessibility_permission()
}

fn authorized_status(kind: PermissionKind) -> PermissionStatus {
    PermissionStatus {
        kind,
        state: PermissionState::Authorized,
        prompt_shown: false,
    }
}
