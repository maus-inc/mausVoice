use std::os::windows::ffi::OsStrExt;

use windows::core::PCWSTR;
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::platform::permissions;

pub fn init_x11_threads() {}

pub fn configure_display_backend() {}

pub fn apply_webkit_workarounds() {}

/// Owns a Win32 `HANDLE` and closes it on drop.
///
/// `OpenProcessToken` hands back a kernel handle that the caller must close.
/// Doing that manually is easy to get wrong, because every early return needs
/// its own `CloseHandle`. Tying the close to `Drop` makes the release
/// unconditional — including on the error paths below.
struct OwnedHandle(windows::Win32::Foundation::HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(self.0);
            }
        }
    }
}

pub fn is_process_elevated() -> bool {
    unsafe {
        let mut token = windows::Win32::Foundation::HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        // Take ownership immediately, so every path from here closes the token.
        // This is called once per second by the permission poller, so a missed
        // close leaks a kernel handle per second for the app's whole runtime.
        let token = OwnedHandle(token);

        let mut elevation = TOKEN_ELEVATION::default();
        let mut size = std::mem::size_of::<TOKEN_ELEVATION>() as u32;
        let status = GetTokenInformation(
            token.0,
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

    if is_process_elevated() {
        return crate::platform::NativeSetupResult::Success;
    }
    request_elevation_relaunch(app)
}

/// Relaunches the app elevated via the `runas` bootstrap helper. If the
/// process is not elevated and the app needs admin for global input capture,
/// we do NOT exit immediately and hope the elevated copy wins the
/// single-instance race: instead we start a bootstrap helper (this same exe,
/// unelevated) that waits for THIS process to fully exit, then launches the
/// elevated copy. That guarantees the singleton lock is free before the
/// elevated app starts.
///
/// On UAC cancellation the app keeps running and returns `Cancelled`; the
/// caller decides whether that cancellation should be surfaced to the user.
pub fn request_elevation_relaunch(app: tauri::AppHandle) -> crate::platform::NativeSetupResult {
    if is_process_elevated() {
        return crate::platform::NativeSetupResult::Success;
    }

    let self_exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(err) => {
            log::error!("Cannot determine current executable path for elevation relaunch: {err}");
            return crate::platform::NativeSetupResult::Failed;
        }
    };
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
        log::info!("UAC elevation declined by user; continuing unelevated");
        return crate::platform::NativeSetupResult::Cancelled;
    }
    crate::platform::NativeSetupResult::Failed
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
#[derive(Debug, PartialEq)]
enum ParentExit {
    Launch,
    Abort,
}

/// Decide whether to launch the elevated replacement after confirming the
/// original (unelevated) process exited and released the single-instance lock.
///
/// `open` performs exactly ONE `OpenProcess` + `WaitForSingleObject` attempt for
/// `parent_pid`: `Ok(event)` means the handle was obtained and waited on
/// (`event` is the `WaitForSingleObject` result); `Err(code)` means `OpenProcess`
/// failed with `GetLastError` value `code`.
///
/// The attempt is made exactly once. We deliberately do NOT retry: if
/// `OpenProcess` reports the PID is gone the parent has exited, and re-calling
/// `OpenProcess` could observe a recycled PID belonging to an unrelated process
/// (which would hang the helper on `WaitForSingleObject`).
///
/// Rules:
/// - `Ok(WAIT_OBJECT_0)` => the parent confirmed exited => launch.
/// - `Ok(other)` => wait failed => abort (must NOT launch).
/// - `Err(ERROR_INVALID_PARAMETER)` => the PID does not exist (parent gone) =>
///   launch.
/// - `Err(other)` => cannot verify parent state => abort.
#[cfg(target_os = "windows")]
fn decide_parent_exit(
    parent_pid: u32,
    open: &mut dyn FnMut(
        u32,
    ) -> Option<
        std::result::Result<windows::Win32::Foundation::WAIT_EVENT, u32>,
    >,
) -> ParentExit {
    match open(parent_pid) {
        Some(Ok(event)) => {
            if event == windows::Win32::Foundation::WAIT_OBJECT_0 {
                ParentExit::Launch
            } else {
                ParentExit::Abort
            }
        }
        Some(Err(code)) => {
            if code == windows::Win32::Foundation::ERROR_INVALID_PARAMETER.0 {
                ParentExit::Launch
            } else {
                ParentExit::Abort
            }
        }
        None => ParentExit::Abort,
    }
}

#[cfg(target_os = "windows")]
fn run_elevate_helper(parent_pid: u32, rest_args: &[String]) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        CreateProcessW, OpenProcess, WaitForSingleObject, INFINITE, PROCESS_CREATION_FLAGS,
        PROCESS_INFORMATION, PROCESS_SYNCHRONIZE, STARTUPINFOW,
    };

    let mut open =
        |pid: u32| -> Option<std::result::Result<windows::Win32::Foundation::WAIT_EVENT, u32>> {
            match unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) } {
                Ok(handle) => {
                    let event = unsafe { WaitForSingleObject(handle, INFINITE) };
                    unsafe {
                        let _ = CloseHandle(handle);
                    }
                    Some(Ok(event))
                }
                Err(_) => Some(Err(unsafe { windows::Win32::Foundation::GetLastError() }.0)),
            }
        };
    match decide_parent_exit(parent_pid, &mut open) {
        ParentExit::Launch => {}
        ParentExit::Abort => {
            log::error!("Elevation helper did not confirm parent exit; not launching replacement.");
            std::process::exit(1);
        }
    }

    let exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(err) => {
            log::error!("Elevation helper cannot determine current executable path: {err}");
            std::process::exit(1);
        }
    };
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

    #[cfg(target_os = "windows")]
    mod elevate_helper {
        use super::super::{decide_parent_exit, ParentExit};
        use windows::Win32::Foundation::{
            ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, WAIT_EVENT, WAIT_OBJECT_0,
        };

        type OpenResult = Option<std::result::Result<WAIT_EVENT, u32>>;

        #[test]
        fn invalid_parameter_launches_without_recalling_opener() {
            // Regression test for the PID-reuse hang: once OpenProcess reports
            // ERROR_INVALID_PARAMETER (PID gone), the helper must decide to
            // launch and must NOT call OpenProcess again.
            let mut calls = 0usize;
            let mut open = |_pid: u32| -> OpenResult {
                calls += 1;
                Some(Err(ERROR_INVALID_PARAMETER.0))
            };
            assert_eq!(decide_parent_exit(1234, &mut open), ParentExit::Launch);
            assert_eq!(
                calls, 1,
                "must not re-call opener after ERROR_INVALID_PARAMETER"
            );
        }

        #[test]
        fn wait_object_0_launches() {
            let mut calls = 0usize;
            let mut open = |_pid: u32| -> OpenResult {
                calls += 1;
                Some(Ok(WAIT_OBJECT_0))
            };
            assert_eq!(decide_parent_exit(1, &mut open), ParentExit::Launch);
            assert_eq!(calls, 1);
        }

        #[test]
        fn wait_failed_aborts() {
            let mut calls = 0usize;
            let mut open = |_pid: u32| -> OpenResult {
                calls += 1;
                Some(Ok(WAIT_EVENT(0xFFFF_FFFF)))
            };
            assert_eq!(decide_parent_exit(1, &mut open), ParentExit::Abort);
            assert_eq!(calls, 1);
        }

        #[test]
        fn access_denied_aborts() {
            let mut calls = 0usize;
            let mut open = |_pid: u32| -> OpenResult {
                calls += 1;
                Some(Err(ERROR_ACCESS_DENIED.0))
            };
            assert_eq!(decide_parent_exit(1, &mut open), ParentExit::Abort);
            assert_eq!(calls, 1);
        }

        #[test]
        fn unavailable_opener_aborts() {
            let mut calls = 0usize;
            let mut open = |_pid: u32| -> OpenResult {
                calls += 1;
                None
            };
            assert_eq!(decide_parent_exit(1, &mut open), ParentExit::Abort);
            assert_eq!(calls, 1);
        }
    }
}

pub fn ensure_background_services() {}
