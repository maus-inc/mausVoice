use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::*;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::constants::*;
use crate::draw;
use crate::gfx::Gfx;
use crate::input;
use crate::ipc::{self, InMessage, OutMessage, Phase, Rect, ResetStrategy, Visibility};
use crate::state;
use crate::state::{ClickAction, PillState, Rocket, RocketPhase, Spark, WindowMode};
use rust_pill_shared::drag::{DragBounds, DragController, DragFrame};
use rust_pill_shared::hover::{HoverFrame, HoverIntent};

// Issue #7: Thread-local statics are an architectural requirement, not a smell.
// Win32 HWNDs are thread-affine — they must only be accessed on the thread that
// created them (the pill process's main / message-loop thread). Global mutable
// state in the pill would require either a separate lock per HWND (same cost) or
// a single-threaded executor (what we already have). Thread-locals give us the
// same ergonomics as globals without violating HWND affinity.

const TIMER_CURSOR: usize = 2;
const TOPMOST_REASSERT_INTERVAL: Duration = Duration::from_secs(2);

thread_local! {
    static STATE: RefCell<Option<PillState>> = const { RefCell::new(None) };
    static GFX: RefCell<Option<Gfx>> = const { RefCell::new(None) };
    static RECEIVER: RefCell<Option<Receiver<InMessage>>> = const { RefCell::new(None) };
    static QUIT: Cell<bool> = const { Cell::new(false) };
    static LAST_TICK: Cell<Option<Instant>> = const { Cell::new(None) };
    static HWND_CELL: Cell<HWND> = const { Cell::new(HWND(std::ptr::null_mut())) };
    static TYPING_ACTIVE: Cell<bool> = const { Cell::new(false) };
    static EDIT_CONTAINER: Cell<HWND> = const { Cell::new(HWND(std::ptr::null_mut())) };
    static EDIT_HWND: Cell<HWND> = const { Cell::new(HWND(std::ptr::null_mut())) };
    static EDIT_BG_BRUSH: Cell<HBRUSH> = const { Cell::new(HBRUSH(std::ptr::null_mut())) };
    // Cached reduced-motion probe (see reduced_motion()); re-read at most
    // every 2 s so the frame loop never pays for a settings call per tick.
    static REDUCED_MOTION_CACHED: Cell<bool> = const { Cell::new(false) };
    static REDUCED_MOTION_CHECKED: Cell<Option<Instant>> = const { Cell::new(None) };
}

const PILL_PLACEMENT_BOTTOM: u8 = 0;
const PILL_PLACEMENT_TOP: u8 = 1;
thread_local! {
    static LAST_TOPMOST_REASSERT: Cell<Option<Instant>> = const { Cell::new(None) };
    static TOPMOST_REASSERT_COUNT: Cell<u32> = const { Cell::new(0) };
    static PILL_PLACEMENT: Cell<u8> = const { Cell::new(PILL_PLACEMENT_BOTTOM) };
}

/// Runs the Windows pill: registers the window class, creates the layered
/// pill window, and drives the message/timer loop until a quit message
/// arrives.
pub fn run(receiver: Receiver<InMessage>) {
    let t0 = Instant::now();
    unsafe {
        let _ = windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(
            windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        );
    }

    let class_name = w!("MausVoicePill");
    let hinstance = unsafe { GetModuleHandleW(None).unwrap() };

    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(wndproc),
        hInstance: hinstance.into(),
        lpszClassName: class_name,
        hCursor: unsafe { LoadCursorW(None, IDC_ARROW).unwrap_or_default() },
        ..Default::default()
    };
    unsafe {
        RegisterClassExW(&wc);
    }

    let (wx, wy) = initial_position();
    // The window keeps room for the below selector slot under the pill, so a
    // side flip animates inside space that is already there. Content math
    // stays on the typing constants, so the pill never moves for it.
    let win_h =
        WINDOW_H_TYPING + rust_pill_shared::placement::below_slot_extra(TOOLTIP_HEIGHT) as i32;
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class_name,
            w!("MausVoicePill"),
            WS_POPUP,
            wx,
            wy,
            WINDOW_W_TYPING,
            win_h,
            None,
            None,
            Some(hinstance.into()),
            None,
        )
        .unwrap()
    };

    HWND_CELL.with(|c| c.set(hwnd));
    eprintln!("[pill] window created in {:?}", t0.elapsed());

    let gfx = Gfx::new(WINDOW_W_TYPING, win_h).expect("Failed to create D2D context");
    eprintln!("[pill] D2D/DWrite initialized in {:?}", t0.elapsed());

    let state = PillState {
        phase: Cell::new(Phase::Idle),
        visibility: Cell::new(Visibility::WhileActive),
        expand_t: Cell::new(0.0),
        expand_velocity: Cell::new(0.0),
        hovered: Cell::new(false),
        wave_phase: Cell::new(0.0),
        current_level: Cell::new(0.0),
        target_level: Cell::new(0.0),
        loading_offset: Cell::new(0.0),
        pending_levels: RefCell::new(Vec::new()),
        style_count: Cell::new(0),
        style_name: RefCell::new(String::new()),
        tooltip_t: Cell::new(0.0),
        tooltip_velocity: Cell::new(0.0),
        tooltip_width: Cell::new(0.0),
        style_tooltip_gate: rust_pill_shared::StyleTooltipGate::default(),
        window_mode: Cell::new(WindowMode::Dictation),
        draw_width: Cell::new(DICTATION_WINDOW_WIDTH as f64),
        draw_height: Cell::new(DICTATION_WINDOW_HEIGHT as f64),
        draw_w_velocity: Cell::new(0.0),
        draw_h_velocity: Cell::new(0.0),
        assistant_active: Cell::new(false),
        assistant_review: RefCell::new(None),
        assistant_input_mode: RefCell::new("voice".to_string()),
        assistant_compact: Cell::new(true),
        assistant_conversation_id: RefCell::new(None),
        assistant_user_prompt: RefCell::new(None),
        assistant_messages: RefCell::new(Vec::new()),
        assistant_streaming: RefCell::new(None),
        assistant_permissions: RefCell::new(Vec::new()),
        panel_open_t: Cell::new(0.0),
        panel_open_velocity: Cell::new(0.0),
        kb_button_t: Cell::new(0.0),
        kb_button_velocity: Cell::new(0.0),
        shimmer_phase: Cell::new(0.0),
        scroll_offset: Cell::new(0.0),
        content_height: Cell::new(0.0),
        viewport_height: Cell::new(0.0),
        should_stick: Cell::new(true),
        click_regions: RefCell::new(Vec::new()),
        mouse_x: Cell::new(-1000.0),
        mouse_y: Cell::new(-1000.0),
        entry_text: RefCell::new(String::new()),
        pause_t: Cell::new(0.0),
        pause_velocity: Cell::new(0.0),
        cancel_t: Cell::new(0.0),
        cancel_velocity: Cell::new(0.0),
        flash_message: RefCell::new(String::new()),
        flash_visible: Cell::new(false),
        flash_t: Cell::new(0.0),
        flash_velocity: Cell::new(0.0),
        flash_timer: Cell::new(0.0),
        flash_is_error: Cell::new(false),
        flash_action: RefCell::new(None),
        flash_action_label: RefCell::new(None),
        flash_reject_action: RefCell::new(None),
        flash_reject_action_label: RefCell::new(None),
        fireworks_active: Cell::new(false),
        fireworks_elapsed: Cell::new(0.0),
        fireworks_next_launch: Cell::new(0),
        fireworks_rockets: RefCell::new(Vec::new()),
        flame_active: Cell::new(false),
        flame_elapsed: Cell::new(0.0),
        flame_tongues: RefCell::new(Vec::new()),
        flash_blue_active: Cell::new(false),
        flash_blue_elapsed: Cell::new(0.0),
        transcript_text: RefCell::new(String::new()),
        transcript_time_since_update: Cell::new(0.0),
        transcript_opacity: Cell::new(0.0),
        transcript_has_message: Cell::new(false),
        long_press_active: Cell::new(false),
        long_press_elapsed: Cell::new(0.0),
        long_press_start_x: Cell::new(0.0),
        long_press_start_y: Cell::new(0.0),
        dragging: Cell::new(false),
        drag_cancelled: Cell::new(false),
        drag_cursor_x: Cell::new(0.0),
        drag_cursor_y: Cell::new(0.0),
        drag_motion: RefCell::new(DragController::new()),
        hover_intent: RefCell::new(HoverIntent::new()),
        selector_placement: RefCell::new(rust_pill_shared::placement::SelectorPlacement::new()),
        has_saved_position: Cell::new(false),
        reset_strategy: Cell::new(ResetStrategy::Current),
        saved_x: Cell::new(0),
        saved_y: Cell::new(0),
        inflate_t: Cell::new(0.0),
        inflate_velocity: Cell::new(0.0),
        drag_label_t: Cell::new(0.0),
        drag_label_velocity: Cell::new(0.0),
        ring_alpha: Cell::new(0.0),
        ring_release_progress: Cell::new(0.0),
        press_elapsed: Cell::new(0.0),
        release_elapsed: Cell::new(rust_pill_shared::LONG_PRESS_RING_FADE),
        arm_t: Cell::new(0.0),
        arm_pulse: Cell::new(rust_pill_shared::PULSE_IDLE),
        pointer_down: Cell::new(false),
        ring_points: RefCell::new(Vec::new()),
        dirty: Cell::new(true),
    };

    STATE.with(|s| *s.borrow_mut() = Some(state));
    GFX.with(|g| *g.borrow_mut() = Some(gfx));
    RECEIVER.with(|r| *r.borrow_mut() = Some(receiver));

    create_edit_overlay(hinstance, hwnd);
    eprintln!("[pill] edit overlay created in {:?}", t0.elapsed());

    unsafe {
        windows::Win32::Media::timeBeginPeriod(1);
        SetTimer(Some(hwnd), TIMER_CURSOR, 60, None);
    }

    eprintln!("[pill] ready after {:?}", t0.elapsed());
    ipc::send(&OutMessage::Ready);

    unsafe {
        let mut msg = MSG::default();
        let frame_interval = Duration::from_micros(16667); // ~60fps
        loop {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT {
                    windows::Win32::Media::timeEndPeriod(1);
                    return;
                }
                if handle_edit_message(&msg) {
                    continue;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if QUIT.with(|q| q.get()) {
                break;
            }

            on_anim_tick(hwnd);

            let elapsed = Instant::now()
                .duration_since(LAST_TICK.with(|c| c.get()).unwrap_or_else(Instant::now));
            if let Some(remaining) = frame_interval.checked_sub(elapsed) {
                std::thread::sleep(remaining);
            }
        }
        windows::Win32::Media::timeEndPeriod(1);
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_TIMER => {
            let timer_id = wparam.0;
            if timer_id == TIMER_CURSOR {
                on_cursor_tick(hwnd);
            }
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            let raw_x = (lparam.0 & 0xFFFF) as i16 as f64;
            let raw_y = ((lparam.0 >> 16) & 0xFFFF) as i16 as f64;
            STATE.with(|s| {
                if let Some(ref state) = *s.borrow() {
                    let (ox, oy) = state.content_offset();
                    let x = raw_x - ox;
                    let y = raw_y - oy;
                    state.mouse_x.set(x);
                    state.mouse_y.set(y);
                    let regions = state.click_regions.borrow();
                    let hit = regions.iter().rev().find(|r| r.contains(x, y));
                    let cursor_id = match hit {
                        Some(r) if matches!(r.action, ClickAction::InputField) => IDC_IBEAM,
                        Some(_) => IDC_HAND,
                        None => IDC_ARROW,
                    };
                    unsafe {
                        SetCursor(LoadCursorW(None, cursor_id).ok());
                    }
                }
            });
            LRESULT(0)
        }
        WM_SETCURSOR => {
            let hit_test = (lparam.0 & 0xFFFF) as i16;
            if hit_test == 1 {
                // HTCLIENT
                LRESULT(1)
            } else {
                unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
            }
        }
        WM_LBUTTONDOWN => {
            let x = (lparam.0 & 0xFFFF) as i16 as f64;
            let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as f64;
            STATE.with(|s| {
                if let Some(ref state) = *s.borrow() {
                    if state.is_typing() {
                        focus_edit_control();
                    }
                    // Start long-press tracking if clicking on the pill body
                    if input::is_on_pill_at(state, x, y) {
                        state.pointer_down.set(true);
                        state.long_press_active.set(true);
                        state.long_press_elapsed.set(0.0);
                        state.long_press_start_x.set(x);
                        state.long_press_start_y.set(y);
                        state.drag_cancelled.set(false);
                    }
                }
            });
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            let x = (lparam.0 & 0xFFFF) as i16 as f64;
            let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as f64;
            STATE.with(|s| {
                if let Some(ref state) = *s.borrow() {
                    // End any drag: persists the drop position and releases the
                    // pointer capture. Returns whether a drag was in progress so
                    // we can suppress the click that would otherwise follow.
                    let was_dragging = end_drag(hwnd, state, true);
                    // Cancel any in-progress long press
                    state.long_press_active.set(false);
                    state.long_press_elapsed.set(0.0);
                    // The button is up, so hover stops being pinned.
                    state.pointer_down.set(false);
                    // Only fire click if the user wasn't dragging
                    if !was_dragging {
                        input::handle_click(state, x, y);
                    }
                    // Hover was pinned for the duration of the gesture; settle
                    // it now that the pointer is free rather than waiting for
                    // the next cursor tick.
                    check_hover(hwnd, state);
                }
            });
            LRESULT(0)
        }
        WM_CAPTURECHANGED => {
            // Another window took the capture (task switch, lock screen, ...).
            // Treat it as the end of the gesture and keep the pill where it is,
            // otherwise `dragging` would stay latched on.
            STATE.with(|s| {
                if let Some(ref state) = *s.borrow() {
                    state.long_press_active.set(false);
                    state.long_press_elapsed.set(0.0);
                    // The gesture is over, so hover stops being pinned.
                    state.pointer_down.set(false);
                    // The capture is already gone, so only persist the position.
                    let _ = end_drag(hwnd, state, true);
                    // Settle hover now rather than staying pinned-expanded for
                    // up to a full cursor tick. check_hover only reads state
                    // and Cells, so it is safe under this immutable borrow.
                    check_hover(hwnd, state);
                }
            });
            LRESULT(0)
        }
        WM_MOUSEWHEEL => {
            let delta = ((wparam.0 >> 16) & 0xFFFF) as i16 as f64;
            let scroll = -delta / 120.0 * 30.0;
            STATE.with(|s| {
                if let Some(ref state) = *s.borrow() {
                    input::handle_scroll(state, scroll);
                }
            });
            LRESULT(0)
        }
        WM_CHAR => {
            let ch = char::from_u32(wparam.0 as u32);
            if let Some(ch) = ch {
                STATE.with(|s| {
                    if let Some(ref state) = *s.borrow() {
                        if ch == '\r' || ch == '\n' {
                            // Enter submits: an insert decision while a
                            // transcript is under review, a message to the
                            // assistant otherwise.
                            if input::submit_entry(state) {
                                set_edit_text("");
                            }
                        } else if ch == '\u{8}' {
                            // Backspace
                            let mut t = state.entry_text.borrow_mut();
                            t.pop();
                        } else if !ch.is_control() {
                            state.entry_text.borrow_mut().push(ch);
                        }
                    }
                });
            }
            LRESULT(0)
        }
        WM_KEYDOWN => {
            if wparam.0 == VK_ESCAPE.0 as usize {
                STATE.with(|s| {
                    if let Some(ref state) = *s.borrow() {
                        // Escape while a transcript is under review is a
                        // cancel decision: the desktop is waiting for an answer.
                        match state.pending_review_id() {
                            Some(review_id) => {
                                input::send_review_decision(&review_id, "cancel", None)
                            }
                            None => {
                                if state.is_typing() {
                                    ipc::send(&OutMessage::AssistantClose);
                                }
                            }
                        }
                    }
                });
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            unsafe {
                PostQuitMessage(0);
            }
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn on_anim_tick(hwnd: HWND) {
    RECEIVER.with(|r| {
        STATE.with(|s| {
            if let (Some(ref rx), Some(ref state)) = (&*r.borrow(), &*s.borrow()) {
                while let Ok(msg) = rx.try_recv() {
                    process_message(msg, state, hwnd);
                }
            }
        });
    });

    if QUIT.with(|q| q.get()) {
        unsafe {
            DestroyWindow(hwnd).ok();
        }
        return;
    }

    let now = Instant::now();
    let dt = LAST_TICK.with(|cell| {
        let prev = cell.get();
        cell.set(Some(now));
        match prev {
            Some(prev) => now.duration_since(prev).as_secs_f64().clamp(0.001, 0.05),
            None => 1.0 / 60.0,
        }
    });

    STATE.with(|s| {
        if let Some(ref state) = *s.borrow() {
            // Safety net: if the button was released without us receiving the
            // event, end the drag here rather than following the cursor forever.
            //
            // Re-entrancy note: end_drag() -> ReleaseCapture() dispatches
            // WM_CAPTURECHANGED synchronously, which re-enters STATE.with() and
            // takes a second immutable borrow. Two immutable RefCell borrows are
            // safe; do NOT upgrade either to borrow_mut() or this path panics.
            tick_drag_release_fallback(hwnd, state);
            tick_drag_frame(hwnd, state, dt);
            tick(state, dt);
            tick_selector_placement(hwnd, state, dt);
            update_visibility(hwnd, state);
            update_typing_focus(hwnd, state);
        }
    });

    maybe_reassert_topmost(hwnd, Instant::now());

    GFX.with(|g| {
        STATE.with(|s| {
            if let (Some(ref mut gfx), Some(ref state)) = (&mut *g.borrow_mut(), &*s.borrow()) {
                if state.needs_redraw() {
                    state.dirty.set(false);
                    draw::draw_all(gfx, state);
                    update_layered(hwnd, gfx);
                }
                update_edit_overlay(hwnd, state);
            }
        });
    });
}

fn on_cursor_tick(hwnd: HWND) {
    STATE.with(|s| {
        if let Some(ref state) = *s.borrow() {
            check_hover(hwnd, state);
            reposition_to_cursor_monitor(hwnd, state);
        }
    });
}

fn maybe_reassert_topmost(hwnd: HWND, now: Instant) {
    let last = LAST_TOPMOST_REASSERT.with(|cell| cell.get());
    if !should_reassert_topmost(last, now) {
        return;
    }
    LAST_TOPMOST_REASSERT.with(|cell| cell.set(Some(now)));
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
    TOPMOST_REASSERT_COUNT.with(|c| c.set(c.get() + 1));
}

fn should_reassert_topmost(last: Option<Instant>, now: Instant) -> bool {
    match last {
        None => true,
        Some(prev) => now.duration_since(prev) >= TOPMOST_REASSERT_INTERVAL,
    }
}

/// Monotonic clock in seconds for the gesture controllers (drag, hover
/// intent). One origin per process; controllers only ever compare samples
/// with each other.
fn drag_now() -> f64 {
    use std::sync::OnceLock;
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64()
}

#[link(name = "user32")]
extern "system" {
    // Raw declaration for SystemParametersInfoW (user32): the pill reads one
    // SPI value, so it declares the single function it needs instead of
    // depending on generated binding names.
    #[link_name = "SystemParametersInfoW"]
    fn system_parameters_info(
        ui_action: u32,
        ui_param: u32,
        pv_param: *mut c_void,
        f_win_ini: u32,
    ) -> i32;
}

/// True when the user turned off Windows animation effects. Win32 has no
/// direct "reduce motion" query; menu animation state follows the same toggle,
/// so it stands in as the proxy. Re-read at most every 2 s.
fn reduced_motion() -> bool {
    let now = Instant::now();
    let stale = REDUCED_MOTION_CHECKED.with(|c| {
        if let Some(prev) = c.get() {
            now.duration_since(prev) >= Duration::from_secs(2)
        } else {
            true
        }
    });
    if !stale {
        return REDUCED_MOTION_CACHED.with(|c| c.get());
    }
    // SPI_GETMENUANIMATION (0x1002 per winuser.h): menu animation state
    // follows the same toggle as the animation effects, so it stands in as
    // the reduced-motion proxy. A failed call degrades to full motion.
    let mut enabled: i32 = 1;
    let off = unsafe {
        // SAFETY: SPI_GETMENUANIMATION writes a BOOL to the out pointer;
        // enabled is a valid, aligned i32 out slot.
        system_parameters_info(
            0x1002,
            0,
            &mut enabled as *mut i32 as *mut c_void,
            0,
        ) != 0
            && enabled == 0
    };
    REDUCED_MOTION_CACHED.with(|c| c.set(off));
    REDUCED_MOTION_CHECKED.with(|c| c.set(Some(now)));
    off
}

fn clear_flash(state: &PillState) {
    rust_pill_shared::clear_flash_state(
        &state.flash_visible,
        &state.flash_timer,
        &state.flash_action,
        &state.flash_action_label,
        &state.flash_reject_action,
        &state.flash_reject_action_label,
    );
}

/// Applies one IPC message to the pill state and marks the surface dirty so
/// the next timer tick repaints.
fn process_message(msg: InMessage, state: &PillState, _hwnd: HWND) {
    // Phase message sequence guard: see ipc::InMessage::Phase.
    thread_local! {
        static LAST_PHASE_SEQ: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    }
    state.dirty.set(true);
    match msg {
        InMessage::Phase { phase, seq } => {
            let stale = LAST_PHASE_SEQ.with(|last| {
                let stale = seq < last.get();
                if !stale {
                    last.set(seq);
                }
                stale
            });
            if stale {
                return;
            }
            let prev = state.phase.get();
            state.phase.set(phase);
            state.style_tooltip_gate.set_take_running(phase == Phase::Recording);
            // A new take sweeps any banner parked above the pill (for example
            // the retranscribing toast) so it cannot sit on the style selector
            // for the whole take. A resume from Paused keeps toasts raised
            // during the take, such as the cancel confirm.
            if phase == Phase::Recording && matches!(prev, Phase::Idle | Phase::Loading) {
                clear_flash(state);
            }
            if phase == Phase::Idle && prev != Phase::Idle {
                state.target_level.set(0.0);
                state.current_level.set(0.0);
                state.wave_phase.set(0.0);
            }
        }
        InMessage::Levels { levels } => {
            *state.pending_levels.borrow_mut() = levels;
        }
        InMessage::StyleInfo { count, name } => {
            state.style_count.set(count);
            *state.style_name.borrow_mut() = name;
        }
        InMessage::Toast {
            message,
            toast_type,
            duration,
            action,
            action_label,
            reject_action,
            reject_action_label,
        } => {
            *state.flash_message.borrow_mut() = message;
            state
                .flash_is_error
                .set(toast_type.as_deref() == Some("error"));
            state.flash_visible.set(true);
            state.flash_timer.set(duration.unwrap_or(FLASH_DURATION));
            *state.flash_action.borrow_mut() = action;
            *state.flash_action_label.borrow_mut() = action_label;
            *state.flash_reject_action.borrow_mut() = reject_action;
            *state.flash_reject_action_label.borrow_mut() = reject_action_label;
        }
        InMessage::DismissToast => {
            clear_flash(state);
        }
        InMessage::Fireworks { message } => {
            *state.flash_message.borrow_mut() = message;
            state.flash_is_error.set(false);
            *state.flash_action.borrow_mut() = None;
            *state.flash_action_label.borrow_mut() = None;
            *state.flash_reject_action.borrow_mut() = None;
            *state.flash_reject_action_label.borrow_mut() = None;
            state.flash_visible.set(true);
            state.flash_timer.set(FIREWORKS_TOTAL_DURATION);
            state.fireworks_active.set(true);
            state.fireworks_elapsed.set(0.0);
            state.fireworks_next_launch.set(0);
            state.fireworks_rockets.borrow_mut().clear();
        }
        InMessage::Flame { message } => {
            *state.flash_message.borrow_mut() = message;
            state.flash_is_error.set(false);
            *state.flash_action.borrow_mut() = None;
            *state.flash_action_label.borrow_mut() = None;
            *state.flash_reject_action.borrow_mut() = None;
            *state.flash_reject_action_label.borrow_mut() = None;
            state.flash_visible.set(true);
            state.flash_timer.set(FLAME_TOTAL_DURATION);

            state.flame_active.set(true);
            state.flame_elapsed.set(0.0);
            state.flame_tongues.borrow_mut().clear();
        }
        InMessage::FlashBlue => {
            state.flash_blue_active.set(true);
            state.flash_blue_elapsed.set(0.0);
        }
        InMessage::BroadcastTranscript { text } => {
            *state.transcript_text.borrow_mut() = text;
            state.transcript_time_since_update.set(0.0);
            state.transcript_has_message.set(true);
        }
        InMessage::Visibility { visibility } => {
            state.visibility.set(visibility);
        }
        InMessage::WindowSize { ref size } => {
            state.window_mode.set(WindowMode::from_str(size));
        }
        InMessage::AssistantState {
            active,
            input_mode,
            compact,
            conversation_id,
            user_prompt,
            messages,
            streaming,
            permissions,
            review,
        } => {
            let was_active = state.assistant_active.get();
            let previous_review_id = state
                .assistant_review
                .borrow()
                .as_ref()
                .map(|r| r.id.clone());
            let review_id = review.as_ref().map(|r| r.id.clone());
            let review_text = review.as_ref().map(|r| r.text.clone());
            *state.assistant_review.borrow_mut() = review;

            // The entry is the review surface: a new transcript loads into it
            // for editing, and answering the review empties it again. An
            // unchanged id leaves the user's edits alone.
            if review_id != previous_review_id {
                let text = review_text.unwrap_or_default();
                *state.entry_text.borrow_mut() = text.clone();
                set_edit_text(&text);
            }
            state.assistant_active.set(active);
            *state.assistant_input_mode.borrow_mut() = input_mode;
            state.assistant_compact.set(compact);
            *state.assistant_conversation_id.borrow_mut() = conversation_id;
            *state.assistant_user_prompt.borrow_mut() = user_prompt;
            *state.assistant_messages.borrow_mut() = messages;
            *state.assistant_streaming.borrow_mut() = streaming;
            *state.assistant_permissions.borrow_mut() = permissions;
            if (active && !was_active) || (review_id.is_some() && review_id != previous_review_id)
            {
                state.should_stick.set(true);
                state.scroll_offset.set(0.0);
            }
        }
        InMessage::ResetPosition { strategy } => {
            state.has_saved_position.set(false);
            state.drag_motion.borrow_mut().reset();
            state.selector_placement.borrow_mut().reset();
            state.reset_strategy.set(strategy);
            state.dirty.set(true);
            let hwnd = HWND_CELL.with(|c| c.get());
            reposition_to_cursor_monitor(hwnd, state);
            let (rect, monitor) = current_pill_geometry(hwnd);
            ipc::send(&OutMessage::PositionChanged {
                has_saved_position: false,
                rect: Some(rect),
                monitor,
            });
        }
        InMessage::RequestPosition => {
            let hwnd = HWND_CELL.with(|c| c.get());
            let (rect, monitor) = current_pill_geometry(hwnd);
            ipc::send(&OutMessage::PositionChanged {
                has_saved_position: state.has_saved_position.get(),
                rect: Some(rect),
                monitor,
            });
        }
        InMessage::PillPlacement { placement } => {
            let code = if placement == "top" {
                PILL_PLACEMENT_TOP
            } else {
                PILL_PLACEMENT_BOTTOM
            };
            PILL_PLACEMENT.with(|c| c.set(code));
            state.dirty.set(true);
        }
        InMessage::Quit => {
            QUIT.with(|q| q.set(true));
        }
    }
}

/// Advances all pill animations by `dt` seconds: audio levels, springs
/// (expand, tooltip, panel, keyboard button, window size, pause crossfade,
/// cancel controls, drag inflate), and the fireworks/flame/flash/transcript
/// sub-tickers.
fn tick(state: &PillState, dt: f64) {
    let phase = state.phase.get();
    let is_active = phase != Phase::Idle;
    let is_recording = phase == Phase::Recording;
    let is_loading = phase == Phase::Loading;
    let hovered = state.hovered.get();
    let frame_scale = dt * 60.0;

    // Audio levels (frame-rate independent)
    if is_recording {
        let levels = state.pending_levels.borrow();
        if !levels.is_empty() {
            let sum: f64 = levels.iter().map(|v| *v as f64).sum();
            let avg = sum / levels.len() as f64;
            let peak = levels.iter().copied().fold(0.0_f32, f32::max) as f64;
            let combined = (avg * 0.9 + peak * 0.85).min(1.0);
            let boosted = (combined.sqrt() * 1.35).min(1.0);
            let target = state.target_level.get();
            let mix = 1.0 - 0.25_f64.powf(frame_scale);
            state
                .target_level
                .set((target * (1.0 - mix) + boosted * mix).min(1.0));
        }
    } else if is_loading {
        let target = state.target_level.get();
        state.target_level.set(target.max(PROCESSING_BASE_LEVEL));
    } else {
        state.target_level.set(0.0);
        state
            .current_level
            .set(state.current_level.get() * 0.4_f64.powf(frame_scale));
        if state.current_level.get() < 0.0002 {
            state.current_level.set(0.0);
        }
    }

    let current = state.current_level.get();
    let target = state.target_level.get();
    let smoothing = 1.0 - (1.0 - LEVEL_SMOOTHING).powf(frame_scale);
    let new_current = current + (target - current) * smoothing;
    state.current_level.set(if new_current < 0.0002 {
        0.0
    } else {
        new_current
    });

    let decay = TARGET_DECAY_PER_FRAME.powf(frame_scale);
    let decayed = target * decay;
    state
        .target_level
        .set(if decayed < 0.0005 { 0.0 } else { decayed });

    let level = state.current_level.get();
    let base_level = if is_loading && !is_recording {
        PROCESSING_BASE_LEVEL
    } else {
        0.0
    };
    let effective_level = level.max(base_level);
    let advance = (WAVE_BASE_PHASE_STEP + WAVE_PHASE_GAIN * effective_level) * frame_scale;
    state
        .wave_phase
        .set((state.wave_phase.get() + advance) % TAU);

    // Paused keeps the pill fully expanded (voice field stays open, not mini mode).
    let expand_target =
        if is_active || hovered || state.assistant_active.get() || phase == Phase::Paused {
            1.0
        } else {
            0.0
        };
    rust_pill_shared::spring::spring_01(
        &state.expand_t,
        &state.expand_velocity,
        expand_target,
        SPRING_STIFFNESS,
        dt,
    );

    let drag_target = if state.dragging.get() || state.long_press_active.get() { 1.0 } else { 0.0 };
    rust_pill_shared::spring::spring_01(&state.drag_label_t, &state.drag_label_velocity, drag_target, rust_pill_shared::LABEL_SPRING_STIFFNESS, dt);

    if is_loading {
        state
            .loading_offset
            .set((state.loading_offset.get() + LOADING_SPEED * frame_scale) % 1.0);
    }

    let tooltip_target = rust_pill_shared::style_tooltip_target(
        &state.style_tooltip_gate,
        state.assistant_active.get(),
        state.style_count.get(),
        matches!(phase, Phase::Paused),
        hovered,
        state.expand_t.get(),
    );
    rust_pill_shared::spring::spring_01(&state.tooltip_t, &state.tooltip_velocity, tooltip_target, SPRING_STIFFNESS, dt);

    let panel_target = if state.owns_panel() { 1.0 } else { 0.0 };
    rust_pill_shared::spring::spring_01(
        &state.panel_open_t,
        &state.panel_open_velocity,
        panel_target,
        SPRING_STIFFNESS,
        dt,
    );

    let is_voice = *state.assistant_input_mode.borrow() == "voice";
    let kb_target = if state.assistant_active.get() && is_voice {
        1.0
    } else {
        0.0
    };
    rust_pill_shared::spring::spring_01(
        &state.kb_button_t,
        &state.kb_button_velocity,
        kb_target,
        SPRING_STIFFNESS,
        dt,
    );

    let mode = state.effective_window_mode();
    let (tw, th) = mode.dimensions();
    rust_pill_shared::spring::spring_px(
        &state.draw_width,
        &state.draw_w_velocity,
        tw as f64,
        SPRING_STIFFNESS,
        dt,
    );
    rust_pill_shared::spring::spring_px(
        &state.draw_height,
        &state.draw_h_velocity,
        th as f64,
        SPRING_STIFFNESS,
        dt,
    );

    state
        .shimmer_phase
        .set((state.shimmer_phase.get() + SHIMMER_SPEED * frame_scale) % 1.0);

    tick_fireworks(state, dt);
    tick_flame(state, dt);
    tick_flash_blue(state, dt);
    tick_transcript(state, dt);
    tick_long_press(state, dt);

    if state.flash_visible.get() {
        let remaining = state.flash_timer.get() - dt;
        if remaining <= 0.0 {
            state.flash_visible.set(false);
            state.flash_timer.set(0.0);
            *state.flash_action.borrow_mut() = None;
            *state.flash_action_label.borrow_mut() = None;
        } else {
            state.flash_timer.set(remaining);
        }
    }
    let flash_target = rust_pill_shared::flash_banner_target(
        state.flash_visible.get(),
        state.flash_action.borrow().is_some() || state.flash_reject_action.borrow().is_some(),
        tooltip_target > 0.5,
    );
    rust_pill_shared::spring::spring_01(&state.flash_t, &state.flash_velocity, flash_target, SPRING_STIFFNESS, dt);

    // Recording <-> paused crossfade driven by the same critically damped
    // spring as the other pill transitions (settles, never overshoots).
    let pause_target = if state.phase.get() == Phase::Paused {
        1.0
    } else {
        0.0
    };
    rust_pill_shared::spring::spring_01(
        &state.pause_t,
        &state.pause_velocity,
        pause_target,
        SPRING_STIFFNESS,
        dt,
    );

    // Cancel + pause controls.
    let controls_phase = state.phase.get();
    let show_controls = !state.assistant_active.get()
        && match controls_phase {
            // Hover-revealed while recording, pinned open while paused.
            Phase::Recording => state.hovered.get(),
            Phase::Paused => true,
            // Post-recording processing: neither cancel nor pause can still
            // act on the take, so the controls fade out with the same spring.
            Phase::Idle | Phase::Loading => false,
        };
    let cancel_target = if show_controls { 1.0 } else { 0.0 };
    rust_pill_shared::spring::spring_01(
        &state.cancel_t,
        &state.cancel_velocity,
        cancel_target,
        SPRING_STIFFNESS * 2.0,
        dt,
    );

    // Inflate animation. The target ramps up partway through the hold (not at
    // the arm moment), so the pill is already growing while the ring fills and
    // arming continues that motion instead of starting a new one.
    let hold_p = draw::long_press_progress(state.long_press_elapsed.get());
    let inflate_target = rust_pill_shared::inflate_target(
        hold_p,
        state.long_press_active.get(),
        state.dragging.get(),
    );
    rust_pill_shared::spring::spring_01(
        &state.inflate_t,
        &state.inflate_velocity,
        inflate_target,
        DRAG_INFLATE_STIFFNESS,
        dt,
    );

    tick_ring(state, dt);

    if state.should_stick.get() && state.assistant_active.get() && !state.assistant_compact.get() {
        let max_scroll = (state.content_height.get() - state.viewport_height.get()).max(0.0);
        state.scroll_offset.set(max_scroll);
    }
}

fn tick_fireworks(state: &PillState, dt: f64) {
    if !state.fireworks_active.get() {
        return;
    }

    let elapsed = state.fireworks_elapsed.get() + dt;
    state.fireworks_elapsed.set(elapsed);

    let ww = state.draw_width.get();
    let wh = state.draw_height.get();
    let (_, pill_y, _, _) = draw::pill_position(state, ww, wh);
    let origin_x = ww / 2.0;
    let origin_y = pill_y - FLASH_GAP - FLASH_HEIGHT / 2.0;

    let mut next = state.fireworks_next_launch.get();
    let mut rockets = state.fireworks_rockets.borrow_mut();

    while next < FIREWORK_LAUNCHES.len() && elapsed >= FIREWORK_LAUNCHES[next].time {
        let launch = &FIREWORK_LAUNCHES[next];
        let angle_rad = launch.angle_deg.to_radians();
        let color = FIREWORK_COLORS[next % FIREWORK_COLORS.len()];
        rockets.push(Rocket {
            x: origin_x,
            y: origin_y,
            vx: launch.speed * angle_rad.sin(),
            vy: -launch.speed * angle_rad.cos(),
            trail: vec![(origin_x, origin_y)],
            fuse: launch.fuse,
            phase: RocketPhase::Rising,
            num_sparks: launch.num_sparks,
            launch_index: next,
            sparks: Vec::new(),
            trail_alpha: 1.0,
            color,
        });
        next += 1;
    }
    state.fireworks_next_launch.set(next);

    for rocket in rockets.iter_mut() {
        match rocket.phase {
            RocketPhase::Rising => {
                rocket.vy += FIREWORKS_GRAVITY * dt;
                rocket.x += rocket.vx * dt;
                rocket.y += rocket.vy * dt;
                rocket.trail.push((rocket.x, rocket.y));
                if rocket.trail.len() > FIREWORKS_TRAIL_MAX {
                    rocket.trail.remove(0);
                }
                rocket.fuse -= dt;
                if rocket.fuse <= 0.0 {
                    rocket.phase = RocketPhase::Exploding;
                    let offset = rocket.launch_index as f64 * 0.7;
                    for i in 0..rocket.num_sparks {
                        let n = rocket.num_sparks.max(1) as f64;
                        let angle = TAU * i as f64 / n + offset;
                        let speed_t = ((i * 7 + 3) % rocket.num_sparks.max(1)) as f64 / n;
                        let speed = FIREWORKS_SPARK_BASE_SPEED * (0.6 + 0.8 * speed_t);
                        rocket.sparks.push(Spark {
                            x: rocket.x,
                            y: rocket.y,
                            vx: speed * angle.cos(),
                            vy: speed * angle.sin(),
                            life: 1.0,
                        });
                    }
                }
            }
            RocketPhase::Exploding => {
                for spark in rocket.sparks.iter_mut() {
                    let drag = (-FIREWORKS_SPARK_DRAG * dt).exp();
                    spark.vx *= drag;
                    spark.vy *= drag;
                    spark.vy += FIREWORKS_GRAVITY * 0.3 * dt;
                    spark.x += spark.vx * dt;
                    spark.y += spark.vy * dt;
                    spark.life -= dt / FIREWORKS_SPARK_LIFE;
                }
                rocket.trail_alpha -= FIREWORKS_TRAIL_FADE_RATE * dt;
                if rocket.trail_alpha < 0.0 {
                    rocket.trail_alpha = 0.0;
                }
            }
        }
    }

    rockets.retain(|r| match r.phase {
        RocketPhase::Rising => true,
        RocketPhase::Exploding => r.trail_alpha > 0.01 || r.sparks.iter().any(|s| s.life > 0.0),
    });

    if elapsed >= FIREWORKS_TOTAL_DURATION && rockets.is_empty() {
        state.fireworks_active.set(false);
    }
}

fn tick_flame(state: &PillState, dt: f64) {
    if !state.flame_active.get() {
        return;
    }
    let elapsed = state.flame_elapsed.get() + dt;
    state.flame_elapsed.set(elapsed);

    let mut tongues = state.flame_tongues.borrow_mut();

    if tongues.is_empty() {
        for i in 0..FLAME_TONGUE_COUNT {
            let t = if FLAME_TONGUE_COUNT > 1 {
                i as f64 / (FLAME_TONGUE_COUNT - 1) as f64
            } else {
                0.5
            };
            let hash = (i as u64).wrapping_mul(2654435761);
            let h_t = (hash % 1000) as f64 / 1000.0;
            let w_t = ((hash >> 10) % 1000) as f64 / 1000.0;
            let phase = ((hash >> 20) % 1000) as f64 / 1000.0 * TAU;
            let speed_var = ((hash >> 30) % 1000) as f64 / 1000.0;

            tongues.push(state::FlameTongue {
                t,
                height: FLAME_MIN_HEIGHT + (FLAME_MAX_HEIGHT - FLAME_MIN_HEIGHT) * h_t,
                width: FLAME_MIN_WIDTH + (FLAME_MAX_WIDTH - FLAME_MIN_WIDTH) * w_t,
                phase,
                speed: FLAME_SPEED_BASE * (0.8 + 0.4 * speed_var),
            });
        }
    }

    for tongue in tongues.iter_mut() {
        tongue.phase += tongue.speed * dt;
    }

    if elapsed >= FLAME_TOTAL_DURATION {
        state.flame_active.set(false);
        tongues.clear();
    }
}

fn tick_flash_blue(state: &PillState, dt: f64) {
    if !state.flash_blue_active.get() {
        return;
    }
    let elapsed = state.flash_blue_elapsed.get() + dt;
    if elapsed >= FLASH_BLUE_DURATION {
        state.flash_blue_active.set(false);
        state.flash_blue_elapsed.set(0.0);
    } else {
        state.flash_blue_elapsed.set(elapsed);
    }
}

fn tick_transcript(state: &PillState, dt: f64) {
    if !state.transcript_has_message.get() && state.transcript_opacity.get() < 0.001 {
        return;
    }
    let since = state.transcript_time_since_update.get() + dt;
    state.transcript_time_since_update.set(since);

    let target = if state.transcript_has_message.get() && since < TRANSCRIPT_FADE_DELAY {
        1.0
    } else {
        0.0
    };

    let speed = if target > 0.5 {
        TRANSCRIPT_RISE_SPEED
    } else {
        TRANSCRIPT_FADE_SPEED
    };
    let opacity = state.transcript_opacity.get();
    let blend = 1.0 - (-speed * dt).exp();
    let next = opacity + (target - opacity) * blend;
    state.transcript_opacity.set(next);

    if target == 0.0 && next < 0.002 {
        state.transcript_opacity.set(0.0);
        state.transcript_has_message.set(false);
        state.transcript_text.borrow_mut().clear();
    }
}

fn update_visibility(hwnd: HWND, state: &PillState) {
    let should_show = rust_pill_shared::should_show_pill(
        state.visibility.get().into(),
        state.phase.get() != Phase::Idle,
        state.owns_panel(),
    );

    unsafe {
        if should_show {
            if !IsWindowVisible(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }
        } else if IsWindowVisible(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}

fn update_typing_focus(_hwnd: HWND, state: &PillState) {
    let is_typing = state.is_typing();
    let was_typing = TYPING_ACTIVE.with(|t| t.get());

    if is_typing && !was_typing {
        TYPING_ACTIVE.with(|t| t.set(true));
        // Sync any existing text to the Edit control and focus it
        let text = state.entry_text.borrow().clone();
        set_edit_text(&text);
        focus_edit_control();
    } else if !is_typing && was_typing {
        TYPING_ACTIVE.with(|t| t.set(false));
        clear_edit_control();
    }
}

/// Recomputes whether the cursor is over the pill, tooltip, or assistant
/// panel and syncs the hovered state (and the hover IPC message) on change.
fn check_hover(hwnd: HWND, state: &PillState) {
    let mut cursor = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut cursor);
    }

    let mut win_rect = RECT::default();
    unsafe {
        let _ = GetWindowRect(hwnd, &mut win_rect);
    }

    let (ox, oy) = state.content_offset();
    let dw = state.draw_width.get();
    let dh = state.draw_height.get();

    // Pill position in screen coordinates
    let (pill_x, pill_y, pill_w, pill_h) = draw::pill_position(state, dw, dh);
    let screen_pill_x = win_rect.left as f64 + ox + pill_x;
    let screen_pill_y = win_rect.top as f64 + oy + pill_y;

    let pad = if state.hovered.get() { 24.0 } else { 8.0 };
    let cx = cursor.x as f64;
    let cy = cursor.y as f64;

    let in_pill = cx >= screen_pill_x - pad
        && cx <= screen_pill_x + pill_w + pad
        && cy >= screen_pill_y - pad
        && cy <= screen_pill_y + pill_h + pad;

    let in_panel = if state.owns_panel() {
        let panel_x = win_rect.left as f64 + ox;
        let panel_y = win_rect.top as f64 + oy;
        cx >= panel_x && cx <= panel_x + dw && cy >= panel_y && cy <= panel_y + dh
    } else {
        false
    };

    let in_tooltip = if state.tooltip_t.get() > 0.1 && state.style_count.get() > 1 {
        let pill_area_top = win_rect.top as f64 + oy + (dh - PILL_AREA_HEIGHT);
        let tooltip_w = state.tooltip_width.get();
        let y_offset = (1.0 - state.tooltip_t.get()) * 4.0;
        let blend = state.selector_placement.borrow().blend();
        let (tooltip_x, tooltip_base) = rust_pill_shared::placement::tooltip_origin(
            win_rect.left as f64 + ox,
            pill_area_top,
            dw,
            PILL_AREA_HEIGHT,
            tooltip_w,
            TOOLTIP_HEIGHT,
            TOOLTIP_GAP,
            blend,
        );
        let tooltip_y = tooltip_base + y_offset * (1.0 - 2.0 * blend);

        cx >= tooltip_x
            && cx <= tooltip_x + tooltip_w
            && cy >= tooltip_y
            && cy <= tooltip_y + TOOLTIP_HEIGHT
    } else {
        false
    };

    // Hover intent: the pointer must dwell on the pill at low speed before
    // expansion and tooltips fire, and they linger through a short grace once
    // it leaves, so fast pass-throughs never flicker the pill. A held button
    // pins hover regardless of the hit tests above: dragging moves the window
    // and easily outruns it, which would collapse the pill mid-gesture.
    let output = state.hover_intent.borrow_mut().advance(&HoverFrame {
        probed: in_pill || in_tooltip || in_panel,
        pointer_x: cx,
        pointer_y: cy,
        now: drag_now(),
        pointer_down: state.pointer_down.get(),
    });
    state.hovered.set(output.hovered);
    if output.entered || output.exited {
        state.dirty.set(true);
        ipc::send(&OutMessage::Hover {
            hovered: output.hovered,
        });
    }
    if !output.hovered {
        state.mouse_x.set(-1000.0);
        state.mouse_y.set(-1000.0);
    }
}

fn update_layered(hwnd: HWND, gfx: &Gfx) {
    unsafe {
        let size = SIZE {
            cx: gfx.width,
            cy: gfx.height,
        };
        let src_point = POINT { x: 0, y: 0 };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        let _ = UpdateLayeredWindow(
            hwnd,
            None,
            None,
            Some(&size),
            Some(gfx.hdc),
            Some(&src_point),
            COLORREF(0),
            Some(&blend),
            ULW_ALPHA,
        );
    }
}

fn initial_position() -> (i32, i32) {
    unsafe {
        let mut cursor = POINT::default();
        let _ = GetCursorPos(&mut cursor);
        let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let _ = GetMonitorInfoW(monitor, &mut info);
        let wa = info.rcWork;
        let wa_w = wa.right - wa.left;
        let wa_h = wa.bottom - wa.top;
        let x = wa.left + (wa_w - WINDOW_W_TYPING) / 2;
        let y = default_pill_y(wa.top, wa_h, WINDOW_H_TYPING);
        (x, y)
    }
}

fn default_pill_y(work_area_top: i32, work_area_height: i32, win_h: i32) -> i32 {
    let placement = PILL_PLACEMENT.with(|c| c.get());
    if placement == PILL_PLACEMENT_TOP {
        work_area_top + MARGIN_BOTTOM
    } else {
        work_area_top + work_area_height - win_h - MARGIN_BOTTOM
    }
}

fn reposition_to_cursor_monitor(hwnd: HWND, state: &PillState) {
    // The frame loop owns the window while a drag is held or settling; the
    // cursor tick must not fight it with a stale saved position.
    if state.dragging.get() || state.drag_motion.borrow().is_settling() {
        return;
    }
    unsafe {
        let mut cursor = POINT::default();
        let _ = GetCursorPos(&mut cursor);

        // The main window keeps extra transparent rows below the pill for the
        // below selector slot, so the live rect is taller than the typing
        // constants — but use the live rect anyway so nothing here assumes a
        // specific mode's size.
        let mut current = RECT::default();
        let _ = GetWindowRect(hwnd, &mut current);
        let win_w = current.right - current.left;
        let win_h = current.bottom - current.top;

        // A parked pill belongs to the monitor it actually lives on. Resolving
        // the monitor from the live cursor here is what made a pinned pill hop
        // monitors (and clamp into the wrong work area) whenever the pointer
        // crossed a screen edge. Drags and their release settles never reach
        // this function; the frame loop positions them on the cursor's monitor.
        let (px, py, pw, ph) =
            draw::pill_position(state, state.draw_width.get(), state.draw_height.get());
        let (cox, coy) = state.content_offset();
        let footprint_cx = (cox + px + pw / 2.0).round() as i32;
        let footprint_cy = (coy + py + ph / 2.0).round() as i32;
        let reset_to_cursor =
            !state.has_saved_position.get() && state.reset_strategy.get() == ResetStrategy::Cursor;
        let monitor = if reset_to_cursor {
            // One-shot re-home onto the cursor's monitor, then revert so the
            // pill stays put on subsequent ticks.
            state.reset_strategy.set(ResetStrategy::Current);
            MonitorFromPoint(cursor, MONITOR_DEFAULTTOPRIMARY)
        } else if state.has_saved_position.get() {
            let saved_center = POINT {
                x: state.saved_x.get() + footprint_cx,
                y: state.saved_y.get() + footprint_cy,
            };
            MonitorFromPoint(saved_center, MONITOR_DEFAULTTONEAREST)
        } else {
            let probe = POINT {
                x: current.left + footprint_cx,
                y: current.top + footprint_cy,
            };
            MonitorFromPoint(probe, MONITOR_DEFAULTTONEAREST)
        };
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let _ = GetMonitorInfoW(monitor, &mut info);
        let wa = info.rcWork;
        let wa_w = wa.right - wa.left;
        let wa_h = wa.bottom - wa.top;

        let bounds = window_clamp_bounds(state, wa, win_w, win_h);
        let (min_x, min_y, max_x, max_y) = (
            bounds.min_x as i32,
            bounds.min_y as i32,
            bounds.max_x as i32,
            bounds.max_y as i32,
        );

        let (x, y) = if state.has_saved_position.get() {
            // Use persisted position from last drag, clamped into the work area
            // of the monitor that position belongs to.
            let mut sx = state.saved_x.get();
            let mut sy = state.saved_y.get();
            sx = sx.max(min_x).min(max_x);
            sy = sy.max(min_y).min(max_y);
            (sx, sy)
        } else {
            let mut x = wa.left + (wa_w - win_w) / 2;
            let mut y = default_pill_y(wa.top, wa_h, win_h);
            x = x.max(min_x).min(max_x);
            y = y.max(min_y).min(max_y);
            (x, y)
        };

        if current.left != x || current.top != y {
            let _ = SetWindowPos(
                hwnd,
                None,
                x,
                y,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }
}

/// Clamp bounds for the window top-left inside a monitor work area.
///
/// The OS window is a fixed transparent canvas; the visible pill is drawn
/// inside it, centred horizontally and bottom-anchored. Clamping the *window*
/// into the work area boxes the pill into the middle of the screen, because
/// the invisible canvas margins eat hundreds of pixels on every side. In dictation
/// mode, clamp the pill's visible footprint instead so it can be parked at the
/// true screen edges; panel/typing modes fill the canvas, so they keep
/// whole-window clamping. Shared by the cursor-tick repositioning and the
/// frame-loop drag so the two can never disagree about the work area.
fn window_clamp_bounds(state: &PillState, wa: RECT, win_w: i32, win_h: i32) -> DragBounds {
    let (px, py, pw, ph) =
        draw::pill_position(state, state.draw_width.get(), state.draw_height.get());
    let (cox, coy) = state.content_offset();
    let (min_x, min_y, max_x, max_y) =
        if state.effective_window_mode() == WindowMode::Dictation
            && !state.assistant_active.get()
        {
            let fx = (cox + px).round() as i32;
            let fy = (coy + py).round() as i32;
            let fw = pw.round().max(1.0) as i32;
            let fh = ph.round().max(1.0) as i32;
            (
                wa.left - fx,
                wa.top - fy,
                wa.right - fx - fw,
                wa.bottom - fy - fh,
            )
        } else {
            (wa.left, wa.top, wa.right - win_w, wa.bottom - win_h)
        };

    // A work area smaller than the clamp target inverts the bounds; keep
    // max >= min so the clamp cannot push the origin off screen.
    DragBounds {
        min_x: min_x as f64,
        min_y: min_y as f64,
        max_x: max_x.max(min_x) as f64,
        max_y: max_y.max(min_y) as f64,
    }
}

/// Frame-loop drag input: the cursor position, the current window rect, and
/// the clamp bounds on the cursor's monitor. A drag (and its release settle)
/// belongs to whichever monitor holds the cursor.
fn drag_placement(hwnd: HWND, state: &PillState) -> (DragBounds, POINT, RECT, rust_pill_shared::edge::EdgeWork) {
    unsafe {
        let mut cursor = POINT::default();
        let _ = GetCursorPos(&mut cursor);
        let mut current = RECT::default();
        let _ = GetWindowRect(hwnd, &mut current);
        let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let _ = GetMonitorInfoW(monitor, &mut info);
        let bounds = window_clamp_bounds(
            state,
            info.rcWork,
            current.right - current.left,
            current.bottom - current.top,
        );
        let work = rust_pill_shared::edge::EdgeWork {
            width: (info.rcWork.right - info.rcWork.left) as f64,
            height: (info.rcWork.bottom - info.rcWork.top) as f64,
        };
        (bounds, cursor, current, work)
    }
}

/// Advances one frame of drag motion: pushes the newest cursor position into
/// the shared controller and applies its output. Runs on the frame clock (not
/// the cursor timer) so a held drag tracks at display rate. When a release
/// settle finishes, the final position is persisted.
fn tick_drag_frame(hwnd: HWND, state: &PillState, dt: f64) {
    let dragging = state.dragging.get();
    let settling = state.drag_motion.borrow().is_settling();
    if !dragging && !settling {
        return;
    }
    let (bounds, cursor, current, work) = drag_placement(hwnd, state);
    let output = state.drag_motion.borrow_mut().advance(&DragFrame {
        pointer_x: cursor.x as f64,
        pointer_y: cursor.y as f64,
        now: drag_now(),
        dt,
        bounds,
        edge_work: Some(work),
        held: dragging,
        reduced_motion: reduced_motion(),
    });
    let x = output.x.round() as i32;
    let y = output.y.round() as i32;
    if current.left != x || current.top != y {
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                None,
                x,
                y,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }
    if settling && output.settled {
        persist_drag_position(hwnd, state);
    }
}

/// Advances the shared selector-placement controller once per animation
/// frame. Headroom comes from the live window rect against the monitor work
/// area, so the selector drops below the pill exactly when the strip above
/// no longer fits it. A missing work area leaves the side alone instead of
/// flapping it.
fn tick_selector_placement(hwnd: HWND, state: &PillState, dt: f64) {
    let (rect, monitor) = current_pill_geometry(hwnd);
    let space_above = monitor.map_or(f64::INFINITY, |work| rect.y - work.y);
    state.selector_placement.borrow_mut().advance(
        &rust_pill_shared::placement::PlacementFrame {
            space_above,
            tooltip_h: TOOLTIP_HEIGHT,
            stiffness: SPRING_STIFFNESS,
            dt,
            reduced_motion: reduced_motion(),
        },
    );
}

fn tick_long_press(state: &PillState, dt: f64) {
    if !state.long_press_active.get() {
        return;
    }

    let phase = state.phase.get();
    if phase != Phase::Idle || state.assistant_active.get() {
        state.long_press_active.set(false);
        state.long_press_elapsed.set(0.0);
        return;
    }

    // Cancel if mouse moved too far from start position (screen coords)
    unsafe {
        let mut cursor = POINT::default();
        let _ = GetCursorPos(&mut cursor);
        // Compare in screen coords — convert start position to screen coords
        // The start position is in window-relative coords, so get window origin
        let mut rect = RECT::default();
        let _ = GetWindowRect(HWND_CELL.with(|c| c.get()), &mut rect);
        let start_screen_x = rect.left as f64 + state.long_press_start_x.get();
        let start_screen_y = rect.top as f64 + state.long_press_start_y.get();
        let dx = cursor.x as f64 - start_screen_x;
        let dy = cursor.y as f64 - start_screen_y;
        if (dx * dx + dy * dy) > LONG_PRESS_MOVE_THRESHOLD * LONG_PRESS_MOVE_THRESHOLD {
            state.long_press_active.set(false);
            state.long_press_elapsed.set(0.0);
            return;
        }
    }

    let elapsed = state.long_press_elapsed.get() + dt;
    state.long_press_elapsed.set(elapsed);

    if elapsed >= LONG_PRESS_DURATION {
        state.long_press_active.set(false);
        state.long_press_elapsed.set(0.0);
        // Enter drag mode directly (skip balloon pop for snappy interaction).
        state.dragging.set(true);
        state.drag_cancelled.set(false);
        // Confirm the arm with the expanding halo, on the exact frame it fires.
        state.arm_pulse.set(rust_pill_shared::pulse_armed());
        unsafe {
            let mut cursor = POINT::default();
            let _ = GetCursorPos(&mut cursor);
            state.drag_cursor_x.set(cursor.x as f64);
            state.drag_cursor_y.set(cursor.y as f64);

            // Anchor the drag to the point the user grabbed so the pill does
            // not jump to have its centre snap under the cursor.
            let hwnd = HWND_CELL.with(|c| c.get());
            let mut rect = RECT::default();
            let _ = GetWindowRect(hwnd, &mut rect);

            // Arm the shared controller with the grab point, and seed it
            // with the arm sample so a quick release still has velocity data.
            let now = drag_now();
            state.drag_motion.borrow_mut().begin_drag(
                cursor.x as f64 - rect.left as f64,
                cursor.y as f64 - rect.top as f64,
                rect.left as f64,
                rect.top as f64,
                now,
            );
            state
                .drag_motion
                .borrow_mut()
                .push_sample(cursor.x as f64, cursor.y as f64, now);

            // Take an OS-level pointer capture so we keep receiving mouse
            // input (and, critically, the button release) even when the
            // pointer travels outside the pill window while dragging.
            let _ = SetCapture(hwnd);
        }
    }
}

/// Reads the pill window's screen rect and the work area of the monitor it
/// lives on, so the desktop can anchor the composer next to the real pill
/// instead of relying on OS-centred placement.
fn current_pill_geometry(hwnd: HWND) -> (Rect, Option<Rect>) {
    unsafe {
        let mut wr = RECT::default();
        let _ = GetWindowRect(hwnd, &mut wr);
        let rect = Rect {
            x: wr.left as f64,
            y: wr.top as f64,
            width: (wr.right - wr.left) as f64,
            height: (wr.bottom - wr.top) as f64,
        };
        let monitor = {
            let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            if mon == HMONITOR::default() {
                None
            } else {
                let mut mi: MONITORINFO = std::mem::zeroed();
                mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
                (GetMonitorInfoW(mon, &mut mi).as_bool()).then(|| Rect {
                    x: mi.rcWork.left as f64,
                    y: mi.rcWork.top as f64,
                    width: (mi.rcWork.right - mi.rcWork.left) as f64,
                    height: (mi.rcWork.bottom - mi.rcWork.top) as f64,
                })
            }
        };
        (rect, monitor)
    }
}

/// Terminate an in-progress drag, persist the drop position and release the
/// pointer capture. Safe to call when no drag is active.
///
/// Every drag must end through this function so the capture is always
/// released — a leaked capture would swallow mouse input system-wide.
fn end_drag(hwnd: HWND, state: &PillState, persist_position: bool) -> bool {
    let was_dragging = state.dragging.get();

    if was_dragging {
        if persist_position {
            // The drop point persists when the release settle finishes (the
            // frame loop calls persist_drag_position on the settled frame),
            // so the saved position always matches where the pill landed.
            state.drag_motion.borrow_mut().end_drag(drag_now());
        } else {
            state.drag_motion.borrow_mut().reset();
        }
    }

    state.dragging.set(false);

    // Release the capture whenever this window still owns it, even if the
    // drag flag was already cleared, so we can never strand it.
    unsafe {
        if GetCapture() == hwnd {
            let _ = ReleaseCapture();
        }
    }

    was_dragging
}

/// Persists the position the pill settled at after a drag: stores the live
/// window origin (not the cursor) and tells the desktop, so the saved point
/// matches the parked pill exactly.
fn persist_drag_position(hwnd: HWND, state: &PillState) {
    // Leave the pill where it was dropped instead of snapping back.
    let mut rect = RECT::default();
    unsafe {
        let _ = GetWindowRect(hwnd, &mut rect);
    }
    state.saved_x.set(rect.left);
    state.saved_y.set(rect.top);
    state.has_saved_position.set(true);
    let (win_rect, monitor) = current_pill_geometry(hwnd);
    ipc::send(&OutMessage::PositionChanged {
        has_saved_position: true,
        rect: Some(win_rect),
        monitor,
    });
}

/// Fallback release detection.
///
/// A capture can be lost without us seeing `WM_LBUTTONUP` (for example when
/// another process steals it, or the session locks). Polling the real button
/// state each tick guarantees a released button can never leave the pill stuck
/// to the cursor — the exact "pill keeps moving after I let go" failure.
fn tick_drag_release_fallback(hwnd: HWND, state: &PillState) {
    if !state.dragging.get() && !state.long_press_active.get() && !state.pointer_down.get() {
        return;
    }

    // The high-order bit marks "currently down"; matches the convention used by
    // the Tauri-side Windows input helpers.
    //
    // GetAsyncKeyState reports the PHYSICAL button, ignoring the SM_SWAPBUTTON
    // remap, so poll the physical key that the (possibly swapped) primary
    // button maps to; otherwise a swapped-button user would see the fallback
    // cancel the gesture on its first tick.
    let primary = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 {
        VK_RBUTTON
    } else {
        VK_LBUTTON
    };
    let button_down = unsafe { GetAsyncKeyState(primary.0 as i32) < 0 };
    if button_down {
        return;
    }

    // The physical button is up, so any gesture in flight is finished. This is
    // also the backstop that releases the hover pin if a release event is lost.
    state.long_press_active.set(false);
    state.long_press_elapsed.set(0.0);
    state.pointer_down.set(false);
    let _ = end_drag(hwnd, state, true);
    // Recompute hover against the real cursor position, so a gesture that ended
    // without a release event does not leave the pill pinned expanded.
    check_hover(hwnd, state);
}

/// Advances the long-press ring for one frame.
///
/// All the policy lives in `rust_pill_shared::advance_ring` so the three
/// platform renderers cannot drift apart; this only marshals `Cell` state in
/// and out of the shared struct, plus the Windows-specific redraw bookkeeping.
fn tick_ring(state: &PillState, dt: f64) {
    let held = state.dragging.get()
        || (state.long_press_active.get()
            && state.long_press_elapsed.get() > LONG_PRESS_HOLD_DELAY);

    let previous_alpha = state.ring_alpha.get();
    let was_pulsing = rust_pill_shared::pulse_is_running(state.arm_pulse.get());

    let mut anim = rust_pill_shared::RingAnim {
        alpha: previous_alpha,
        release_progress: state.ring_release_progress.get(),
        press_elapsed: state.press_elapsed.get(),
        release_elapsed: state.release_elapsed.get(),
        arm_t: state.arm_t.get(),
        arm_pulse: state.arm_pulse.get(),
    };

    rust_pill_shared::advance_ring(
        &mut anim,
        rust_pill_shared::RingTick {
            held,
            dragging: state.dragging.get(),
            progress: draw::long_press_progress(state.long_press_elapsed.get()),
            delta_seconds: dt,
        },
        LONG_PRESS_HOLD_DELAY,
    );

    state.ring_alpha.set(anim.alpha);
    state.ring_release_progress.set(anim.release_progress);
    state.press_elapsed.set(anim.press_elapsed);
    state.release_elapsed.set(anim.release_elapsed);
    state.arm_t.set(anim.arm_t);
    state.arm_pulse.set(anim.arm_pulse);

    // needs_redraw() stops reporting motion once the ring and its pulse are
    // finished, so the frame that clears them must be dirtied explicitly —
    // otherwise the last painted state is never erased and a ghost lingers.
    if (previous_alpha > 0.0 && anim.alpha == 0.0)
        || (was_pulsing && !rust_pill_shared::pulse_is_running(anim.arm_pulse))
    {
        state.dirty.set(true);
    }
}

// ── Native text input overlay ────────────────────────────────────────

const ES_AUTOHSCROLL: u32 = 0x0080;
const EN_CHANGE_NOTIFICATION: u16 = 0x0300;
const EM_SETMARGINS: u32 = 0x00D3;
const EM_GETSEL: u32 = 0x00B0;
const EM_SETSEL: u32 = 0x00B1;
const EM_REPLACESEL: u32 = 0x00C2;
const EC_LEFTMARGIN: u32 = 1;
const EC_RIGHTMARGIN: u32 = 2;
const EDIT_COLOR_KEY: u32 = 0x00010001; // RGB(1,0,1) - unique color for transparency
const EDIT_TEXT_COLOR: u32 = 0x00E8E8E8; // RGB(232, 232, 232)

fn create_edit_overlay(hinstance: HMODULE, main_hwnd: HWND) {
    unsafe {
        let brush = CreateSolidBrush(COLORREF(EDIT_COLOR_KEY));
        EDIT_BG_BRUSH.with(|b| b.set(brush));

        let class_name = w!("MausVoiceInput");
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(edit_container_proc),
            hInstance: hinstance.into(),
            lpszClassName: class_name,
            hbrBackground: brush,
            ..Default::default()
        };
        RegisterClassExW(&wc);

        let container = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED,
            class_name,
            w!(""),
            WS_POPUP | WS_CLIPCHILDREN,
            0,
            0,
            400,
            PANEL_INPUT_HEIGHT as i32,
            Some(main_hwnd),
            None,
            Some(hinstance.into()),
            None,
        )
        .unwrap();

        let edit = CreateWindowExW(
            WS_EX_LEFT,
            w!("EDIT"),
            w!(""),
            WINDOW_STYLE(WS_CHILD.0 | WS_VISIBLE.0 | ES_AUTOHSCROLL),
            0,
            0,
            400,
            PANEL_INPUT_HEIGHT as i32,
            Some(container),
            None,
            Some(hinstance.into()),
            None,
        )
        .unwrap();

        // Always use the embedded Satoshi face for the type-mode editor.
        crate::font::install_embedded_satoshi();
        let mut lf = LOGFONTW::default();
        let face: Vec<u16> = "Satoshi".encode_utf16().collect();
        let n = face.len().min(lf.lfFaceName.len());
        lf.lfFaceName[..n].copy_from_slice(&face[..n]);
        lf.lfHeight = -18;
        lf.lfWeight = 500; // Medium
        let font = CreateFontIndirectW(&lf);
        SendMessageW(
            edit,
            WM_SETFONT,
            Some(WPARAM(font.0 as usize)),
            Some(LPARAM(1)),
        );

        // Set internal margins
        let margins = (8u32 as isize) | ((8u32 as isize) << 16);
        SendMessageW(
            edit,
            EM_SETMARGINS,
            Some(WPARAM((EC_LEFTMARGIN | EC_RIGHTMARGIN) as usize)),
            Some(LPARAM(margins)),
        );

        EDIT_CONTAINER.with(|c| c.set(container));
        EDIT_HWND.with(|e| e.set(edit));
    }
}

unsafe extern "system" fn edit_container_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_CTLCOLOREDIT => {
            let hdc = HDC(wparam.0 as *mut std::ffi::c_void);
            SetTextColor(hdc, COLORREF(EDIT_TEXT_COLOR));
            SetBkMode(hdc, TRANSPARENT);
            let brush = EDIT_BG_BRUSH.with(|b| b.get());
            LRESULT(brush.0 as isize)
        }
        WM_COMMAND => {
            let notification = ((wparam.0 >> 16) & 0xFFFF) as u16;
            if notification == EN_CHANGE_NOTIFICATION {
                // Sync native Edit text → state.entry_text
                let text = get_edit_text();
                STATE.with(|s| {
                    if let Some(ref state) = *s.borrow() {
                        *state.entry_text.borrow_mut() = text;
                    }
                });
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Intercepts messages for the Edit control before TranslateMessage/DispatchMessage.
/// Returns true if the message was consumed and should not be dispatched.
fn handle_edit_message(msg: &MSG) -> bool {
    let edit = EDIT_HWND.with(|e| e.get());
    if msg.hwnd != edit {
        return false;
    }

    match msg.message {
        WM_KEYDOWN => {
            let ctrl = unsafe { (GetKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0 };

            if msg.wParam.0 == VK_RETURN.0 as usize {
                // Enter submits: an insert decision while a transcript is under
                // review, a message to the assistant otherwise. Nothing was
                // sent when the entry holds only blanks, so the text has to
                // stay put instead of being wiped for no result.
                let sent = STATE.with(|s| match *s.borrow() {
                    Some(ref state) => input::submit_entry(state),
                    None => false,
                });
                if sent {
                    unsafe {
                        let _ = SetWindowTextW(edit, w!(""));
                    }
                }
                return true;
            } else if msg.wParam.0 == VK_ESCAPE.0 as usize {
                // Escape while a transcript is under review is a cancel
                // decision: the desktop is waiting for an answer.
                let review_id = STATE.with(|s| {
                    s.borrow().as_ref().and_then(|state| state.pending_review_id())
                });
                match review_id {
                    Some(review_id) => input::send_review_decision(&review_id, "cancel", None),
                    None => ipc::send(&OutMessage::AssistantClose),
                }
                return true;
            } else if ctrl && msg.wParam.0 == 'A' as usize {
                // Select all
                unsafe {
                    SendMessageW(edit, EM_SETSEL, Some(WPARAM(0)), Some(LPARAM(-1)));
                }
                return true;
            } else if ctrl && msg.wParam.0 == VK_BACK.0 as usize {
                ctrl_backspace(edit);
                return true;
            }
            false
        }
        _ => false,
    }
}

fn ctrl_backspace(edit: HWND) {
    unsafe {
        // Get caret position from return value: LOWORD=start, HIWORD=end
        let result = SendMessageW(edit, EM_GETSEL, None, None);
        let caret = ((result.0 >> 16) & 0xFFFF) as usize;
        if caret == 0 {
            return;
        }

        // Get text as UTF-16
        let len = GetWindowTextLengthW(edit);
        if len == 0 {
            return;
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        GetWindowTextW(edit, &mut buf);

        let mut pos = caret.min(len as usize);

        // Skip whitespace backwards
        while pos > 0 && (buf[pos - 1] == b' ' as u16 || buf[pos - 1] == b'\t' as u16) {
            pos -= 1;
        }
        // Skip non-whitespace backwards
        while pos > 0 && buf[pos - 1] != b' ' as u16 && buf[pos - 1] != b'\t' as u16 {
            pos -= 1;
        }

        // Select from word start to caret and replace with empty
        SendMessageW(
            edit,
            EM_SETSEL,
            Some(WPARAM(pos)),
            Some(LPARAM(caret as isize)),
        );
        let empty: [u16; 1] = [0];
        SendMessageW(
            edit,
            EM_REPLACESEL,
            Some(WPARAM(1)),
            Some(LPARAM(empty.as_ptr() as isize)),
        );
    }
}

fn update_edit_overlay(main_hwnd: HWND, state: &PillState) {
    let is_typing = state.is_typing();
    let container = EDIT_CONTAINER.with(|c| c.get());
    let edit = EDIT_HWND.with(|e| e.get());

    if !is_typing {
        unsafe {
            if IsWindowVisible(container).as_bool() {
                let _ = ShowWindow(container, SW_HIDE);
            }
        }
        return;
    }

    // Calculate input field position in screen coordinates
    let (ox, oy) = state.content_offset();
    let ww = state.draw_width.get();
    let wh = state.draw_height.get();

    let panel_w = PANEL_EXPANDED_WIDTH;
    let panel_x = (ww - panel_w) / 2.0;
    let panel_h = wh - PANEL_TOP_MARGIN - PANEL_BOTTOM_MARGIN;
    let y_shift = (1.0 - state.panel_open_t.get()) * 12.0;
    let py = PANEL_TOP_MARGIN + y_shift;
    let input_y = py + panel_h - PANEL_INPUT_HEIGHT;
    let input_x = panel_x + PANEL_CONTENT_SIDE_INSET;
    let send_btn_size = 28.0_f64;
    let input_w = panel_w - PANEL_CONTENT_SIDE_INSET * 2.0 - send_btn_size - 8.0;

    let mut win_rect = RECT::default();
    unsafe {
        let _ = GetWindowRect(main_hwnd, &mut win_rect);
    }

    let screen_x = win_rect.left as f64 + ox + input_x;
    let screen_y = win_rect.top as f64 + oy + input_y + 1.0;
    let h = PANEL_INPUT_HEIGHT - 1.0;

    unsafe {
        // Color key makes the background transparent; alpha matches text to panel opacity
        let alpha = (state.panel_open_t.get() * PANEL_BG_ALPHA * 255.0) as u8;
        let _ = SetLayeredWindowAttributes(
            container,
            COLORREF(EDIT_COLOR_KEY),
            alpha,
            LWA_COLORKEY | LWA_ALPHA,
        );

        let _ = SetWindowPos(
            container,
            None,
            screen_x as i32,
            screen_y as i32,
            input_w as i32,
            h as i32,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
        let _ = SetWindowPos(
            edit,
            None,
            0,
            0,
            input_w as i32,
            h as i32,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOMOVE,
        );
    }

    // If state.entry_text was cleared externally (e.g. send button), sync to Edit
    let state_text = state.entry_text.borrow().clone();
    let edit_text = get_edit_text();
    if state_text.is_empty() && !edit_text.is_empty() {
        set_edit_text("");
    }
}

fn get_edit_text() -> String {
    let edit = EDIT_HWND.with(|e| e.get());
    unsafe {
        let len = GetWindowTextLengthW(edit);
        if len == 0 {
            return String::new();
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        GetWindowTextW(edit, &mut buf);
        String::from_utf16_lossy(&buf[..len as usize])
    }
}

fn set_edit_text(text: &str) {
    let edit = EDIT_HWND.with(|e| e.get());
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let _ = SetWindowTextW(edit, PCWSTR(wide.as_ptr()));
    }
}

pub(crate) fn clear_edit_control() {
    set_edit_text("");
}

pub(crate) fn focus_edit_control() {
    let container = EDIT_CONTAINER.with(|c| c.get());
    let edit = EDIT_HWND.with(|e| e.get());
    unsafe {
        let _ = SetForegroundWindow(container);
        let _ = SetFocus(Some(edit));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topmost_reassert_fires_on_first_tick() {
        assert!(should_reassert_topmost(None, Instant::now()));
    }

    #[test]
    fn topmost_reassert_skips_within_interval() {
        let prev = Instant::now();
        let next = prev + Duration::from_millis(500);
        assert!(!should_reassert_topmost(Some(prev), next));
    }

    #[test]
    fn topmost_reassert_fires_after_interval() {
        let prev = Instant::now();
        let next = prev + TOPMOST_REASSERT_INTERVAL + Duration::from_millis(1);
        assert!(should_reassert_topmost(Some(prev), next));
    }

    #[test]
    fn maybe_reassert_topmost_invokes_setwindowpos() {
        TOPMOST_REASSERT_COUNT.with(|c| c.set(0));
        LAST_TOPMOST_REASSERT.with(|c| c.set(None));

        maybe_reassert_topmost(HWND(std::ptr::null_mut()), Instant::now());
        let after_first = TOPMOST_REASSERT_COUNT.with(|c| c.get());
        assert_eq!(after_first, 1, "first tick should fire reassert");

        maybe_reassert_topmost(HWND(std::ptr::null_mut()), Instant::now());
        let after_second = TOPMOST_REASSERT_COUNT.with(|c| c.get());
        assert_eq!(
            after_second, 1,
            "immediate second tick should be throttled by interval"
        );
    }

    #[test]
    fn default_pill_y_bottom_anchors_to_bottom() {
        PILL_PLACEMENT.with(|c| c.set(PILL_PLACEMENT_BOTTOM));
        assert_eq!(default_pill_y(0, 1080, 362), 1080 - 362 - MARGIN_BOTTOM);
    }

    #[test]
    fn default_pill_y_top_anchors_to_top() {
        PILL_PLACEMENT.with(|c| c.set(PILL_PLACEMENT_TOP));
        assert_eq!(default_pill_y(0, 1080, 362), MARGIN_BOTTOM);
        assert_eq!(default_pill_y(50, 1080, 362), 50 + MARGIN_BOTTOM);
    }
}
