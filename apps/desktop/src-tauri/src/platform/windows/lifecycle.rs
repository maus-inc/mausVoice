//! Windows session/resume watcher.
//!
//! `rdev::grab` installs a low-level keyboard hook that the OS tears down
//! across a sleep/wake boundary or a workstation unlock (UIPI / input desktop
//! changes). Without explicit re-registration the global dictation hotkey
//! silently dies on resume. This module owns a hidden message-only HWND that
//! subscribes to the relevant Windows notifications and emits a single
//! `desktop_resume` Tauri event whenever the user comes back, so the
//! frontend can ask the listener to re-grab.
//!
//! # Pump design
//!
//! The HWND lives on a dedicated OS thread (not the Tauri main thread, not
//! the rdev callback thread, not a Tokio worker). It runs a classic
//! `GetMessageW` / `DispatchMessageW` loop. The Tauri event emitter is
//! `Send + Sync`, so we hand a clone into the thread once at startup and
//! fire events from the message handler.
//!
//! Why a dedicated thread rather than a `RunEvent` handler or a Tokio task:
//!
//! * `RunEvent` only fires for Tauri-managed windows. The HWND we need is
//!   a `HWND_MESSAGE` (message-only, invisible, no Z-order, no taskbar
//!   entry); Tauri does not own it, so Tauri will never deliver its
//!   `WM_POWERBROADCAST` or `WM_WTSSESSION_CHANGE` to us.
//! * A Tokio task cannot host a `GetMessageW` loop: `GetMessageW` blocks
//!   the calling thread on a kernel message queue, and `SendMessage` from
//!   other threads (e.g. from the lock-screen SMSS) requires the HWND to
//!   have an actual thread pumping it. A worker thread is the canonical
//!   Win32 pattern for a message-only window.

#[cfg(target_os = "windows")]
mod imp {
    use std::sync::OnceLock;

    use tauri::{AppHandle, Emitter};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{BOOL, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Console::{
        GetConsoleWindow, SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_C_EVENT,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Power::{
        RegisterPowerSettingNotification, UnregisterPowerSettingNotification,
        HPOWERNOTIFY,
    };
    use windows::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows::Win32::System::StationsAndDesktops::{
        GetThreadDesktop, SetThreadDesktop,
    };
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
        RegisterClassW, TranslateMessage, UnregisterClassW, CS_HREDRAW, CS_OWNDC, CS_VREDRAW,
        DEVICE_NOTIFY_WINDOW_HANDLE, HWND_DESKTOP, MSG, WNDCLASSW, WINDOW_EX_STYLE,
        WINDOW_STYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    use crate::domain::EVT_DESKTOP_RESUME;

    const WM_POWERBROADCAST: u32 = 0x0218;
    const WM_WTSSESSION_CHANGE: u32 = 0x02B1;

    const PBT_APMRESUMEAUTOMATIC: usize = 0x0012;
    const PBT_APMRESUMESUSPEND: usize = 0x0007;

    const WTS_SESSION_UNLOCK: u32 = 0x8;

    const GUID_CONSOLE_DISPLAY_STATE: windows::core::GUID =
        windows::core::GUID::from_u128(0x6FE69556_704A_47A0_8F24_C28D936FDA47);

    const LIFECYCLE_CLASS_NAME: &str = "MausVoiceLifecycleWindow";

    /// Holds the registered power-setting notification handle so we can
    /// unregister it on shutdown. Stored as a `OnceLock<u16>` because the
    /// inner handle is a kernel pointer (`HPOWERNOTIFY`) and we only ever
    /// register one. The pointer is the `isize` representation of the
    /// `HPOWERNOTIFY`; we never dereference it.
    fn power_notify_handle() -> &'static OnceLock<usize> {
        static HANDLE: OnceLock<usize> = OnceLock::new();
        &HANDLE
    }

    fn store_power_handle(handle: HPOWERNOTIFY) {
        let _ = power_notify_handle().set(handle.0 as usize);
    }

    fn clear_power_handle() {
        if let Some(raw) = power_notify_handle().get().copied() {
            let _ = unsafe { UnregisterPowerSettingNotification(HPOWERNOTIFY(raw as isize)) };
        }
    }

    /// `Some(())` if the watcher thread is already running. The thread
    /// itself is owned by `OnceLock<JoinHandle>`-equivalent storage; we
    /// don't need the handle because the thread runs for the process
    /// lifetime (the message loop is infinite, `DestroyWindow` from a
    /// signal handler would race the pump).
    fn watcher_started() -> &'static OnceLock<()> {
        static STARTED: OnceLock<()> = OnceLock::new();
        &STARTED
    }

    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_POWERBROADCAST {
            let event = wparam.0;
            if event == PBT_APMRESUMEAUTOMATIC || event == PBT_APMRESUMESUSPEND {
                log::info!(
                    "lifecycle: WM_POWERBROADCAST resume (event={event}); emitting desktop_resume"
                );
                emit_resume();
            }
            return LRESULT(0);
        }
        if msg == WM_WTSSESSION_CHANGE {
            let event = wparam.0 as u32;
            if event == WTS_SESSION_UNLOCK {
                log::info!("lifecycle: WM_WTSSESSION_CHANGE unlock; emitting desktop_resume");
                emit_resume();
            }
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    /// `Send + Sync` closure target for the resume emission. We stash a
    /// clone of the `AppHandle` once at startup; `app_handle.emit` is the
    /// only call site here, and it is safe to invoke from any thread
    /// (Tauri's `Emitter` is `Send + Sync`).
    fn emit_resume() {
        if let Some(handle) = current_app_handle().get() {
            if let Err(err) = handle.emit(EVT_DESKTOP_RESUME, ()) {
                log::error!("lifecycle: failed to emit desktop_resume event: {err}");
            }
        }
    }

    fn current_app_handle() -> &'static OnceLock<AppHandle<tauri::Wry>> {
        static HANDLE: OnceLock<AppHandle<tauri::Wry>> = OnceLock::new();
        &HANDLE
    }

    /// Spawn the message-pump thread. Idempotent: a second call is a
    /// no-op (the `OnceLock` on `watcher_started` short-circuits).
    ///
    /// `app` is cloned into the thread and used to emit
    /// `desktop_resume` whenever the OS notifies us of a sleep/wake
    /// transition or a session unlock. The thread runs the
    /// message-only window's pump for the lifetime of the process.
    pub fn start_watcher(app: &tauri::AppHandle<tauri::Wry>) {
        if watcher_started().set(()).is_err() {
            return;
        }
        let _ = current_app_handle().set(app.clone());

        std::thread::Builder::new()
            .name("mausvoice-lifecycle".to_string())
            .spawn(worker_thread)
            .expect("spawn mausvoice-lifecycle thread");
    }

    fn worker_thread() {
        // Avoid an OS-generated console window popping up on the message
        // thread (e.g. if a panic prints to stderr in a debug build).
        // Best-effort: if no console exists, the call is a no-op.
        unsafe {
            let console = GetConsoleWindow();
            if console.0.is_null() {
                let handler: unsafe extern "system" fn(u32) -> i32 = console_ctrl_handler;
                let _ = SetConsoleCtrlHandler(Some(handler), true);
            }
        }

        // Move to the input desktop so messages from the active session
        // (e.g. lock-screen SMSS) reach us. Best-effort: if the call
        // fails (e.g. service context) we still try the message pump
        // because the current thread desktop is what the lock screen
        // would route to anyway.
        unsafe {
            let tid = GetCurrentThreadId();
            if let Ok(current) = GetThreadDesktop(tid) {
                let _ = SetThreadDesktop(current);
            }
        }

        let class_name_w: Vec<u16> = LIFECYCLE_CLASS_NAME
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        let class_name = PCWSTR(class_name_w.as_ptr());

        let window_name_w: Vec<u16> = "mausVoice Lifecycle"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let window_name = PCWSTR(window_name_w.as_ptr());

        let wc = WNDCLASSW {
            style: CS_OWNDC | CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wndproc),
            hInstance: HINSTANCE(GetModuleHandleW(None).unwrap_or_default().0),
            lpszClassName: class_name,
            ..Default::default()
        };

        let atom = unsafe { RegisterClassW(&wc) };
        if atom == 0 {
            log::error!("lifecycle: RegisterClassW failed");
            return;
        }

        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(
                    WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0,
                ),
                class_name,
                window_name,
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_DESKTOP),
                None,
                None,
                None,
            )
        };
        let hwnd = match hwnd {
            Ok(h) => h,
            Err(err) => {
                log::error!("lifecycle: CreateWindowExW failed: {err}");
                return;
            }
        };

        match unsafe {
            RegisterPowerSettingNotification(
                HANDLE(hwnd.0),
                &GUID_CONSOLE_DISPLAY_STATE,
                DEVICE_NOTIFY_WINDOW_HANDLE,
            )
        } {
            Ok(handle) => store_power_handle(handle),
            Err(err) => log::error!("lifecycle: RegisterPowerSettingNotification failed: {err}"),
        }

        if let Err(err) = unsafe {
            WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)
        } {
            log::error!("lifecycle: WTSRegisterSessionNotification failed: {err}");
        }

        log::info!("lifecycle: lifecycle HWND registered, entering pump");

        let mut msg = MSG::default();
        loop {
            let r = unsafe { GetMessageW(&mut msg, Some(hwnd), 0, 0) };
            // r == 0 => WM_QUIT; r < 0 => error.
            if r.0 <= 0 {
                break;
            }
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }

        clear_power_handle();
        let _ = unsafe { WTSUnRegisterSessionNotification(hwnd) };
        let _ = unsafe { DestroyWindow(hwnd) };
        let _ = unsafe { UnregisterClassW(class_name, None) };
        log::info!("lifecycle: pump exiting");
    }

    /// Best-effort console control handler so a Ctrl-C in a debug build
    /// does not kill the message pump before the rest of the app gets a
    /// chance to clean up. Returning `BOOL(1)` tells the OS "I handled it,
    /// do not terminate the process".
    unsafe extern "system" fn console_ctrl_handler(event: u32) -> BOOL {
        if event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT {
            return BOOL(1);
        }
        BOOL(0)
    }
}

#[cfg(target_os = "windows")]
pub use imp::start_watcher;

/// Stub for non-Windows targets so callers can invoke this unconditionally
/// from platform-agnostic setup code.
#[cfg(not(target_os = "windows"))]
pub fn start_watcher(_app: &tauri::AppHandle<tauri::Wry>) {}
