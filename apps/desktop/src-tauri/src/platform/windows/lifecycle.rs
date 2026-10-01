//! Windows session/resume watcher.
//!
//! `rdev::grab` installs a low-level keyboard hook that the OS tears down
//! across a sleep/wake boundary or a workstation unlock (UIPI / input desktop
//! changes). Without explicit re-registration the global dictation hotkey
//! silently dies on resume. This module owns a hidden top-level HWND that
//! subscribes to the relevant Windows notifications and emits
//! `desktop_resume` when the user comes back, so the frontend can ask the
//! listener to re-grab. A single wake can produce more than one event; see
//! [`imp::start_watcher`] for which signals are watched and why.
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
//!   an invisible top-level tool window parented to the desktop —
//!   deliberately **not** a `HWND_MESSAGE` message-only window, because
//!   message-only windows do not receive broadcast messages such as
//!   `WM_POWERBROADCAST`. Tauri does not own this window either way, so
//!   it will never deliver these notifications for us.
//! * A Tokio task cannot host a `GetMessageW` loop: `GetMessageW` blocks
//!   the calling thread on a kernel message queue, and `SendMessage` from
//!   other threads (e.g. from the lock-screen SMSS) requires the HWND to
//!   have an actual thread pumping it. A worker thread is the canonical
//!   Win32 pattern for a notification window.

#[cfg(target_os = "windows")]
mod imp {
    use std::sync::OnceLock;

    use tauri::{AppHandle, Emitter};
    use windows::core::BOOL;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Console::{
        GetConsoleWindow, SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_C_EVENT,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Power::{
        RegisterPowerSettingNotification, UnregisterPowerSettingNotification, HPOWERNOTIFY,
        POWERBROADCAST_SETTING,
    };
    use windows::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
        RegisterClassW, TranslateMessage, UnregisterClassW, CS_HREDRAW, CS_OWNDC, CS_VREDRAW,
        DEVICE_NOTIFY_WINDOW_HANDLE, HWND_DESKTOP, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSW,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    use crate::domain::EVT_DESKTOP_RESUME;

    const WM_POWERBROADCAST: u32 = 0x0218;
    const WM_WTSSESSION_CHANGE: u32 = 0x02B1;

    const PBT_APMRESUMEAUTOMATIC: usize = 0x0012;
    const PBT_APMRESUMESUSPEND: usize = 0x0007;
    /// What a registered power setting arrives as. Every message for a
    /// `RegisterPowerSettingNotification` setting is this one, so the
    /// APM constants above are never seen for the console display state.
    const PBT_POWERSETTINGCHANGE: usize = 0x8013;

    /// `GUID_CONSOLE_DISPLAY_STATE` reports 0 when the display is off and 1 when
    /// it is on again. Any other value is a different display state change.
    const CONSOLE_DISPLAY_ON: u32 = 1;

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
            } else if event == PBT_POWERSETTINGCHANGE && console_display_is_on(lparam) {
                // The wake this watcher is registered for. Display-off/suspend
                // reports no APM resume on many machines, so the registered
                // notification was the only signal available and nothing above
                // ever matched it.
                log::info!(
                    "lifecycle: console display power setting returned to on; emitting desktop_resume"
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

    /// Whether a `PBT_POWERSETTINGCHANGE` reports the registered console display
    /// setting has come back on.
    ///
    /// The payload is borrowed as a `POWERBROADCAST_SETTING`, whose `Data`
    /// tail is only `DataLength` bytes long, so the message guarantees
    /// `offset_of!(Data) + DataLength` bytes and nothing more. A `DataLength`
    /// of 0 means 20 of that struct's 24 bytes exist, and forming a
    /// `&POWERBROADCAST_SETTING` asserts all 24 are readable and that the
    /// address carries the struct's alignment. So each field is read from the
    /// raw pointer with `read_unaligned` instead, and the `Data` byte is
    /// touched only after the length says it is there. The expected GUID is
    /// checked first, so a message from another registered setting cannot be
    /// answered with this one's answer.
    fn console_display_is_on(lparam: LPARAM) -> bool {
        if lparam.0 == 0 {
            return false;
        }
        let base = lparam.0 as *const u8;
        let power_setting = unsafe { std::ptr::read_unaligned(base.cast::<GUID>()) };
        if power_setting != GUID_CONSOLE_DISPLAY_STATE {
            return false;
        }
        let data_length = unsafe {
            std::ptr::read_unaligned(
                base.add(std::mem::offset_of!(POWERBROADCAST_SETTING, DataLength))
                    .cast::<u32>(),
            )
        };
        if data_length as usize != std::mem::size_of::<u32>() {
            return false;
        }
        // `Data` is a `[u8; 1]`, so read the byte rather than casting to a
        // `*const u32`: the array is only byte-aligned and the value is small.
        unsafe { *base.add(std::mem::offset_of!(POWERBROADCAST_SETTING, Data)) }
            == CONSOLE_DISPLAY_ON as u8
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
    /// `app` is cloned into the thread and used to emit `desktop_resume` on
    /// three signals, which are not all resumes:
    ///
    /// * an APM resume (`PBT_APMRESUMEAUTOMATIC` / `PBT_APMRESUMESUSPEND`),
    /// * a session unlock (`WTS_SESSION_UNLOCK`),
    /// * the registered console-display setting returning to on.
    ///
    /// The third is a fallback for the machines that report a sleep/wake
    /// *only* as the display coming back, so it also fires for transitions
    /// that are not resumes at all (a second monitor entering DPMS, a KVM
    /// switching inputs, a manual display toggle). A machine that reports
    /// both an APM resume and the display-on change emits twice for one
    /// wake. That is harmless rather than correct-by-construction:
    /// `restart_key_listener` runs inside the lifecycle lock in
    /// `platform/keyboard.rs`, so the second call is serialized behind the
    /// first instead of racing it.
    ///
    /// The thread runs the hidden window's pump for the lifetime of the
    /// process.
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
                let handler: unsafe extern "system" fn(u32) -> BOOL = console_ctrl_handler;
                let _ = SetConsoleCtrlHandler(Some(handler), true);
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

        let wc = unsafe {
            WNDCLASSW {
                style: CS_OWNDC | CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(wndproc),
                hInstance: HINSTANCE(GetModuleHandleW(None).unwrap_or_default().0),
                lpszClassName: class_name,
                ..Default::default()
            }
        };

        let atom = unsafe { RegisterClassW(&wc) };
        if atom == 0 {
            log::error!("lifecycle: RegisterClassW failed");
            return;
        }

        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0),
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
                // Class is registered but no window exists. Without this
                // call the registration would leak for the lifetime of
                // the process; OnceLock then prevents a retry from
                // re-arming the watcher.
                let _ = unsafe { UnregisterClassW(class_name, None) };
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

        if let Err(err) = unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) } {
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

    #[cfg(test)]
    mod tests {
        use super::{console_display_is_on, CONSOLE_DISPLAY_ON, GUID_CONSOLE_DISPLAY_STATE};
        use windows::core::GUID;
        use windows::Win32::Foundation::LPARAM;
        use windows::Win32::System::Power::POWERBROADCAST_SETTING;

        const OTHER_SETTING: GUID = GUID::from_u128(0x00000000_0000_0000_0000_000000000000);

        fn lparam_of(setting: &POWERBROADCAST_SETTING) -> LPARAM {
            LPARAM(setting as *const POWERBROADCAST_SETTING as isize)
        }

        #[test]
        fn the_display_coming_back_on_is_a_wake() {
            let setting = POWERBROADCAST_SETTING {
                PowerSetting: GUID_CONSOLE_DISPLAY_STATE,
                DataLength: std::mem::size_of::<u32>() as u32,
                Data: [CONSOLE_DISPLAY_ON as u8],
            };
            assert!(console_display_is_on(lparam_of(&setting)));
        }

        #[test]
        fn the_display_going_off_is_not_a_wake() {
            let setting = POWERBROADCAST_SETTING {
                PowerSetting: GUID_CONSOLE_DISPLAY_STATE,
                DataLength: std::mem::size_of::<u32>() as u32,
                Data: [0],
            };
            assert!(!console_display_is_on(lparam_of(&setting)));
        }

        /// The reported length is what says how much data follows the fixed
        /// header, so a length that is not the one this watcher registered
        /// for is not a value it may read.
        #[test]
        fn a_zero_or_unexpected_data_length_is_rejected() {
            for data_length in [0u32, 1, 2, 3, 5, 8] {
                let setting = POWERBROADCAST_SETTING {
                    PowerSetting: GUID_CONSOLE_DISPLAY_STATE,
                    DataLength: data_length,
                    Data: [CONSOLE_DISPLAY_ON as u8],
                };
                assert!(
                    !console_display_is_on(lparam_of(&setting)),
                    "DataLength {data_length} is not the registered setting's width"
                );
            }
        }

        /// A message for a different registered setting carries the same
        /// header shape, and answering it with this setting's answer is how a
        /// resume gets emitted for an event that was never one.
        #[test]
        fn another_registered_setting_is_not_answered() {
            let setting = POWERBROADCAST_SETTING {
                PowerSetting: OTHER_SETTING,
                DataLength: std::mem::size_of::<u32>() as u32,
                Data: [CONSOLE_DISPLAY_ON as u8],
            };
            assert!(!console_display_is_on(lparam_of(&setting)));
        }

        #[test]
        fn a_null_pointer_is_not_a_wake() {
            assert!(!console_display_is_on(LPARAM(0)));
        }
    }
}

#[cfg(target_os = "windows")]
pub use imp::start_watcher;

/// Stub for non-Windows targets so callers can invoke this unconditionally
/// from platform-agnostic setup code.
#[cfg(not(target_os = "windows"))]
pub fn start_watcher(_app: &tauri::AppHandle<tauri::Wry>) {}
