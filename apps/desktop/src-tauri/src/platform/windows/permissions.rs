use crate::domain::{PermissionKind, PermissionState, PermissionStatus};
use crate::platform::windows::init::is_process_elevated;

pub(crate) fn check_microphone_permission() -> Result<PermissionStatus, String> {
    Ok(authorized_status(PermissionKind::Microphone))
}

pub(crate) fn request_microphone_permission() -> Result<PermissionStatus, String> {
    check_microphone_permission()
}

/// Report whether global input capture is available.
///
/// Windows has no accessibility permission in the macOS sense. The dictation
/// hotkey is a low-level keyboard hook (`rdev::grab`), which a standard user
/// can install, so this reports `Authorized` on an unelevated install.
///
/// This state is load-bearing beyond onboarding: `AppSideEffects` starts the
/// key listener only while it reads as authorized, and `PermissionsDialog`
/// blocks the whole app while it does not. Reporting anything other than
/// `Authorized` here therefore disables dictation on every standard install,
/// which is why the previous `NotDetermined`-when-unelevated behaviour made
/// the app look broken for non-admin users.
///
/// Elevation still has one genuine effect — a low-level hook cannot observe
/// input delivered to a window running at a higher integrity level (UIPI), so
/// hotkeys are ignored while an elevated window is focused. That is a
/// per-window limitation rather than a missing permission, so it is surfaced
/// through the optional `run_native_setup` elevation flow in `init.rs` instead
/// of gating the whole app here.
pub(crate) fn check_accessibility_permission() -> Result<PermissionStatus, String> {
    // Logged (not gated) so the elevation state is visible in diagnostics when
    // a user reports hotkeys failing over an elevated window.
    log::debug!(
        "Windows accessibility check: process elevated = {}",
        is_process_elevated()
    );

    Ok(authorized_status(PermissionKind::Accessibility))
}

/// Windows shows no OS-level accessibility prompt.
///
/// Elevation is requested explicitly by the frontend through `run_native_setup`
/// (see `platform/windows/init.rs`), which triggers UAC. This call therefore
/// just re-reports the current state.
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
