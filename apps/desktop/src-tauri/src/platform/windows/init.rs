use std::os::windows::ffi::OsStrExt;

use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcessToken, TOKEN_ELEVATION, TOKEN_QUERY,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::PCWSTR;

use crate::platform::permissions;

pub fn init_x11_threads() {}

pub fn configure_display_backend() {}

pub fn is_process_elevated() -> bool {
    unsafe {
        let mut token = windows::Win32::Foundation::HANDLE::default();
        if OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY,
            &mut token,
        )
        .is_err()
        {
            return false;
        }

        let mut elevation = TOKEN_ELEVATION::default();
        let mut size = std::mem::size_of::<TOKEN_ELEVATION>() as u32;
        let status = windows::Win32::System::Threading::GetTokenInformation(
            token,
            windows::Win32::System::Threading::TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            size,
            &mut size,
        );
        if status.is_err() {
            return false;
        }
        elevation.TokenIsElevated != 0
    }
}

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
    // Trigger the OS-native permission prompts (accessibility + microphone).
    // These show a UAC/consent prompt through the system, not pkexec.
    if let Err(err) = permissions::request_microphone_permission() {
        log::error!("Failed to request microphone permission: {err}");
    }
    if let Err(err) = permissions::request_accessibility_permission() {
        log::error!("Failed to request accessibility permission: {err}");
    }

    // If the process is not elevated and the app needs admin for global input
    // capture, relaunch as administrator via ShellExecuteW "runas". The current
    // instance exits; the elevated copy continues. If the user dismisses the UAC
    // prompt, ShellExecuteW reports ERROR_CANCELLED.
    if !is_process_elevated() {
        let exe = std::env::current_exe().unwrap_or_default();
        let exe_wide: Vec<u16> = exe
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let verb: Vec<u16> = "runas\0".encode_utf16().collect();
        let args: Vec<u16> = std::env::args()
            .skip(1)
            .collect::<Vec<_>>()
            .join(" ")
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        let result = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(verb.as_ptr()),
                PCWSTR(exe_wide.as_ptr()),
                PCWSTR(args.as_ptr()),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };

        // ShellExecuteW returns a value > 32 on success.
        let handle = result.0 as isize;
        if handle > 32 {
            // The elevated copy is launching; tell the UI a restart is happening.
            return crate::platform::NativeSetupResult::RequireRestart;
        }

        // ERROR_CANCELLED (1223) means the user dismissed the UAC prompt.
        let last_err = windows::Win32::Foundation::GetLastError();
        if last_err == windows::Win32::Foundation::ERROR_CANCELLED {
            return crate::platform::NativeSetupResult::Cancelled;
        }
        return crate::platform::NativeSetupResult::Failed;
    }

    crate::platform::NativeSetupResult::Success
}

pub fn ensure_background_services() {}
