use std::os::windows::ffi::OsStrExt;

use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation};
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
        let status = GetTokenInformation(
            token,
            TokenElevation,
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

        // Preserve the original arguments, quoting each one so values with
        // spaces or quotes survive the round-trip. The `--elevated` marker tells
        // the relaunched copy it is the post-UAC instance (it is already
        // elevated, so it will not try to relaunch again).
        let mut cli = String::from("--elevated");
        for arg in std::env::args().skip(1) {
            cli.push(' ');
            cli.push_str(&windows_quote(&arg));
        }
        let args: Vec<u16> = cli.encode_utf16().chain(std::iter::once(0)).collect();

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

        // ShellExecuteW returns a value > 32 on success. On success, exit this
        // unelevated instance immediately so the elevated copy can take over the
        // single-instance lock and become the active application. We must exit
        // *before* the elevated copy starts, because tauri-plugin-single-instance
        // force-closes any secondary instance while the primary is still alive.
        // If the user dismisses the UAC prompt, ShellExecuteW returns <= 32 and we
        // stay running.
        let handle = result.0 as isize;
        if handle > 32 {
            log::info!("Elevated relaunch launched; exiting unelevated instance.");
            std::process::exit(0);
        }

        // ERROR_CANCELLED (1223) means the user dismissed the UAC prompt.
        let last_err = unsafe { windows::Win32::Foundation::GetLastError() };
        if last_err == windows::Win32::Foundation::ERROR_CANCELLED {
            return crate::platform::NativeSetupResult::Cancelled;
        }
        return crate::platform::NativeSetupResult::Failed;
    }

    crate::platform::NativeSetupResult::Success
}

/// Quote a single Windows command-line argument per the `CommandLineToArgvW`
/// rules so embedded spaces and quotes survive `ShellExecuteW`.
fn windows_quote(arg: &str) -> String {
    if arg.is_empty() {
        return "\"\"".to_string();
    }
    if !arg.contains(char::is_whitespace) && !arg.contains('"') {
        return arg.to_string();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0;
    for ch in arg.chars() {
        if ch == '\\' {
            backslashes += 1;
        } else if ch == '"' {
            quoted.push_str(&"\\".repeat(backslashes + 1));
            quoted.push('"');
            backslashes = 0;
        } else {
            quoted.push_str(&"\\".repeat(backslashes));
            quoted.push(ch);
            backslashes = 0;
        }
    }
    // Backslashes immediately before the closing quote must be doubled so they
    // are not consumed as an escape for the quote.
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests {
    use super::windows_quote;

    #[test]
    fn quotes_empty_argument() {
        assert_eq!(windows_quote(""), "\"\"");
    }

    #[test]
    fn leaves_unquoted_argument_untouched() {
        assert_eq!(windows_quote("plain"), "plain");
    }

    #[test]
    fn quotes_argument_with_spaces() {
        assert_eq!(windows_quote("a b"), "\"a b\"");
    }

    #[test]
    fn escapes_embedded_quotes() {
        assert_eq!(windows_quote("a\"b"), "\"a\\\"b\"");
    }

    #[test]
    fn doubles_trailing_backslashes_before_closing_quote() {
        assert_eq!(windows_quote("C:\\path"), "\"C:\\path\"");
        assert_eq!(windows_quote("C:\\path\\"), "\"C:\\path\\\\\"");
        assert_eq!(windows_quote("C:\\path\\\\"), "\"C:\\path\\\\\\\"");
    }

    #[test]
    fn path_with_spaces_ending_in_backslash_round_trips() {
        // "C:\Path With Spaces\" must keep its trailing backslash after parsing.
        assert_eq!(windows_quote("C:\\Path With Spaces\\"), "\"C:\\Path With Spaces\\\\\"");
    }

    #[test]
    fn backslashes_before_embedded_quote_are_escaped() {
        assert_eq!(windows_quote("a\\\"b"), "\"a\\\\\\\"b\"");
    }
}

pub fn ensure_background_services() {}
