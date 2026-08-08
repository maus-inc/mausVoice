use std::os::windows::ffi::OsStrExt;

use windows::core::PCWSTR;
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::platform::permissions;

pub fn init_x11_threads() {}

pub fn configure_display_backend() {}

pub fn is_process_elevated() -> bool {
    unsafe {
        let mut token = windows::Win32::Foundation::HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
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

pub async fn run_native_setup(app: tauri::AppHandle) -> crate::platform::NativeSetupResult {
    // Trigger the OS-native permission prompts (accessibility + microphone).
    // These show a UAC/consent prompt through the system, not pkexec.
    if let Err(err) = permissions::request_microphone_permission() {
        log::error!("Failed to request microphone permission: {err}");
    }
    if let Err(err) = permissions::request_accessibility_permission() {
        log::error!("Failed to request accessibility permission: {err}");
    }

    // If the process is not elevated and the app needs admin for global input
    // capture, relaunch as administrator. We do NOT exit immediately and hope
    // the elevated copy wins the single-instance race: instead we start a
    // bootstrap helper (this same exe, unelevated) that waits for THIS process
    // to fully exit, then launches the elevated copy. That guarantees the
    // singleton lock is free before the elevated app starts.
    if !is_process_elevated() {
        let self_exe = std::env::current_exe().unwrap_or_default();
        let parent_pid = std::process::id();

        // Launch the bootstrap helper with "runas" so the UAC prompt happens
        // HERE, while the main process is still alive. If the user cancels UAC,
        // the helper never starts and we stay running (return Cancelled). Only
        // after a successful elevated launch do we perform a controlled shutdown
        // and let the (now-elevated) helper relaunch the main app.
        let verb: Vec<u16> = "runas\0".encode_utf16().collect();
        let exe_wide: Vec<u16> = self_exe
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let mut cli = format!("--elevate-helper {parent_pid}");
        for arg in std::env::args().skip(1) {
            cli.push(' ');
            cli.push_str(&windows_quote(&arg));
        }
        let args_wide: Vec<u16> = cli.encode_utf16().chain(std::iter::once(0)).collect();

        let result = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(verb.as_ptr()),
                PCWSTR(exe_wide.as_ptr()),
                PCWSTR(args_wide.as_ptr()),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };

        let handle = result.0 as isize;
        if handle > 32 {
            // The elevated helper is now waiting for this process to exit, after
            // which it launches the elevated main app. Perform a controlled
            // shutdown (runs ExitRequested so window state is saved and the
            // keyboard listener stops) rather than an abrupt std::process::exit.
            log::info!("Elevation helper launched; performing controlled shutdown.");
            app.exit(0);
            #[allow(unreachable_code)]
            return crate::platform::NativeSetupResult::RequireRestart;
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

/// If this process was started as the elevation bootstrap helper
/// (`--elevate-helper <parent_pid> <args...>`), wait for the original process
/// to exit, then launch the elevated copy and exit the helper. Returns true
/// when the helper path was taken (caller must not continue normal startup).
#[cfg(target_os = "windows")]
pub fn run_elevate_helper_if_requested() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if let Some(pos) = args.iter().position(|a| a == "--elevate-helper") {
        let pid = args.get(pos + 1).and_then(|s| s.parse::<u32>().ok());
        let rest: Vec<String> = args.iter().skip(pos + 2).cloned().collect();
        if let Some(pid) = pid {
            run_elevate_helper(pid, &rest);
        }
        std::process::exit(0);
    }
    false
}

#[cfg(target_os = "windows")]
fn run_elevate_helper(parent_pid: u32, rest_args: &[String]) {
    use windows::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{
        CreateProcessW, OpenProcess, WaitForSingleObject, INFINITE, PROCESS_CREATION_FLAGS,
        PROCESS_INFORMATION, PROCESS_SYNCHRONIZE, STARTUPINFOW,
    };

    // Wait for the original (unelevated) process to exit and release the
    // single-instance lock before launching the elevated replacement.
    //
    // Rules (per review):
    // - OpenProcess succeeds => wait on the handle. Only WAIT_OBJECT_0 confirms
    //   the parent exited; WAIT_FAILED must NOT permit launch.
    // - OpenProcess fails with "not found" => the parent is already gone; safe
    //   to launch after a bounded poll.
    // - OpenProcess fails with access denied (or any other error) => we cannot
    //   verify the parent state; do NOT launch and terminate the helper.
    let mut launch = false;
    for _ in 0..50 {
        match unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, parent_pid) } {
            Ok(handle) => {
                let result = unsafe { WaitForSingleObject(handle, INFINITE) };
                unsafe {
                    let _ = CloseHandle(handle);
                }
                if result == WAIT_OBJECT_0 {
                    launch = true;
                    break;
                }
                log::error!(
                    "Elevation helper WaitForSingleObject returned {:#x}; aborting.",
                    result.0
                );
                break;
            }
            Err(_) => {
                let err = unsafe { windows::Win32::Foundation::GetLastError() };
                if err == ERROR_INVALID_PARAMETER {
                    // The PID does not exist: the parent already exited. Treat as
                    // gone after a short poll so we give it time to release the
                    // single-instance lock.
                    launch = true;
                    std::thread::sleep(std::time::Duration::from_millis(100));
                } else {
                    // ERROR_ACCESS_DENIED or any other (possibly transient) error:
                    // we cannot confirm the parent state, so do NOT launch.
                    log::error!(
                        "Elevation helper cannot open parent {parent_pid} (error {:#x}); aborting.",
                        err.0
                    );
                    break;
                }
            }
        }
    }
    if !launch {
        log::error!("Elevation helper did not confirm parent exit; not launching replacement.");
        std::process::exit(1);
    }

    let exe = std::env::current_exe().unwrap_or_default();
    // The helper is already elevated (launched via runas). Start the replacement
    // main app with CreateProcessW so the child inherits this elevated token.
    // ShellExecuteW("open") is NOT safe here: it can be routed through the
    // unelevated Explorer and drop the elevation, leaving the replacement
    // unelevated.
    let mut cli = String::new();
    for arg in rest_args {
        cli.push(' ');
        cli.push_str(&windows_quote(arg));
    }
    let mut cmd_line: Vec<u16> = format!("\"{}\"{cli}", exe.display())
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;

    let result = unsafe {
        CreateProcessW(
            None,
            Some(windows::core::PWSTR(cmd_line.as_mut_ptr())),
            None,
            None,
            false,
            PROCESS_CREATION_FLAGS(0),
            None,
            None,
            &si,
            &mut pi,
        )
    };
    match result {
        Ok(()) => {
            // Close the handles we do not need; the child keeps running.
            unsafe {
                let _ = CloseHandle(pi.hProcess);
                let _ = CloseHandle(pi.hThread);
            }
        }
        Err(err) => {
            log::error!("Elevation helper failed to launch elevated main app: {err}");
        }
    }
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
        // These inputs contain spaces, so windows_quote must quote them; the
        // trailing backslashes must be doubled before the closing quote.
        assert_eq!(
            windows_quote("C:\\Path With Spaces"),
            "\"C:\\Path With Spaces\""
        );
        assert_eq!(
            windows_quote("C:\\Path With Spaces\\"),
            "\"C:\\Path With Spaces\\\\\""
        );
        assert_eq!(
            windows_quote("C:\\Path With Spaces\\\\"),
            "\"C:\\Path With Spaces\\\\\\\""
        );
    }

    #[test]
    fn path_with_spaces_ending_in_backslash_round_trips() {
        // "C:\Path With Spaces\" must keep its trailing backslash after parsing.
        assert_eq!(
            windows_quote("C:\\Path With Spaces\\"),
            "\"C:\\Path With Spaces\\\\\""
        );
    }

    #[test]
    fn backslashes_before_embedded_quote_are_escaped() {
        assert_eq!(windows_quote("a\\\"b"), "\"a\\\\\\\"b\"");
    }
}

pub fn ensure_background_services() {}
