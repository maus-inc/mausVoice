use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use gtk::gdk;
use gtk::glib::{self, ControlFlow};
use gtk::prelude::*;
use gtk_layer_shell::LayerShell;
pub(crate) use rust_pill_shared::clock::monotonic_now as drag_clock_now;
use rust_pill_shared::restore::ParkedWindow;

use crate::constants::*;
use crate::ipc::{self, InMessage, OutMessage, Phase, Rect, ResetStrategy, Visibility};
use crate::state::{FlameTongue, PillState, Rocket, RocketPhase, Spark, WindowMode};
use crate::{draw, input, x11};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Backend {
    LayerShell,
    X11,
    PlainWayland,
}

/// The value `x11_drag_applied` holds until a position has actually been applied.
///
/// Distinct from zero and from any negative origin, both of which are real places
/// on an X11 virtual screen.
pub(crate) const UNAPPLIED_ORIGIN: i32 = i32::MIN;

// Wayland cannot expose a portable absolute work area. This finite safety
// envelope replaces an unbounded clamp on every held/release frame.
const WAYLAND_DRAG_BOUNDS: rust_pill_shared::drag::DragBounds =
    rust_pill_shared::drag::DragBounds {
        min_x: -1e9,
        min_y: -1e9,
        max_x: 1e9,
        max_y: 1e9,
    };

// Phase message sequence guard: see ipc::InMessage::Phase.
thread_local! {
    static LAST_PHASE_SEQ: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Apply every message waiting on the channel before the frame steps.
///
/// Draining here, rather than from a separate glib source, keeps message order and
/// frame order the same: a phase that arrives mid-frame is applied on that frame,
/// never after the tick that follows it.
/// Apply every message waiting on the channel before the frame steps.
///
/// Draining here, rather than from a separate glib source, keeps message order and
/// frame order the same: a phase that arrives mid-frame is applied on that frame,
/// never after the tick that follows it.
///
/// Dispatch only: each message has its own handler below. They used to be match
/// arms in a single body, which made seventeen unrelated decisions into one
/// function, so a change to, say, toast timing had to be read next to display
/// reconciliation.
fn drain_messages(
    receiver: &RefCell<Receiver<InMessage>>,
    state_tick: &Rc<PillState>,
    win_tick: &gtk::Window,
    entry_tick: &gtk::Entry,
    quit: &Rc<Cell<bool>>,
) {
    let rx = receiver.borrow();
    while let Ok(msg) = rx.try_recv() {
        match msg {
            InMessage::Phase { phase, seq } => on_phase(phase, seq, state_tick),
            InMessage::Levels { levels } => on_levels(levels, state_tick),
            InMessage::StyleInfo { count, name } => on_style_info(count, name, state_tick),
            InMessage::Toast { .. } => on_toast(msg, state_tick),
            InMessage::DismissToast => on_dismiss_toast(state_tick),
            InMessage::Fireworks { message } => on_fireworks(message, state_tick),
            InMessage::Flame { message } => on_flame(message, state_tick),
            InMessage::FlashBlue => on_flash_blue(state_tick),
            InMessage::BroadcastTranscript { text } => on_broadcast_transcript(text, state_tick),
            InMessage::StageText { text } => on_stage_text(text, state_tick),
            InMessage::Visibility { visibility } => on_visibility(visibility, state_tick),
            InMessage::WindowSize { ref size } => on_window_size(size, state_tick),
            InMessage::AssistantState { .. } => on_assistant_state(msg, state_tick, entry_tick),
            InMessage::ResetPosition { strategy } => {
                on_reset_position(strategy, state_tick, win_tick)
            }
            InMessage::ForgetPosition => on_forget_position(state_tick),
            InMessage::RequestPosition => on_request_position(state_tick, win_tick),
            InMessage::Quit => on_quit(quit),
        }
    }
}

/// Applies `InMessage::Phase`.
fn on_phase(phase: Phase, seq: u64, state_tick: &Rc<PillState>) {
    let stale = LAST_PHASE_SEQ.with(|last| {
        let stale = seq < last.get();
        if !stale {
            last.set(seq);
        }
        stale
    });
    if stale {
        // A stale phase is skipped, exactly as `continue` did when this was a
        // match arm inside the drain loop.
        return;
    }
    let prev = state_tick.phase.get();
    state_tick.phase.set(phase);
    state_tick
        .style_tooltip_gate
        .set_take_running(phase == Phase::Recording);
    // A new take sweeps any banner parked above the pill (for
    // example the retranscribing toast) so it cannot sit on the
    // style selector for the whole take. A resume from Paused
    // keeps toasts raised during the take, such as the cancel
    // confirm.
    if phase == Phase::Recording && matches!(prev, Phase::Idle | Phase::Loading) {
        clear_flash(state_tick);
    }
    if rust_pill_shared::should_clear_stage_text_on_phase(
        prev == Phase::Loading,
        phase == Phase::Idle,
        phase == Phase::Loading,
    ) {
        *state_tick.stage_text.borrow_mut() = None;
    }
    if phase == Phase::Loading && prev != Phase::Loading {
        let offset = if reduced_motion() { 0.5 } else { 0.0 };
        state_tick.loading_offset.set(offset);
    }
    if phase == Phase::Idle && prev != Phase::Idle {
        state_tick.pending_levels.borrow_mut().clear();
        state_tick.target_level.set(0.0);
        state_tick.current_level.set(0.0);
        state_tick.wave_phase.set(0.0);
        state_tick.loading_offset.set(0.0);
    }
}

/// Applies `InMessage::Levels`.
fn on_levels(levels: Vec<f32>, state_tick: &Rc<PillState>) {
    *state_tick.pending_levels.borrow_mut() = levels;
}

/// Applies `InMessage::StyleInfo`.
fn on_style_info(count: u32, name: String, state_tick: &Rc<PillState>) {
    state_tick.style_count.set(count);
    *state_tick.style_name.borrow_mut() = name;
}

/// Applies `InMessage::Toast`.
fn on_toast(msg: InMessage, state_tick: &Rc<PillState>) {
    let InMessage::Toast {
        message,
        toast_type,
        duration,
        action,
        action_label,
        reject_action,
        reject_action_label,
    } = msg
    else {
        return;
    };
    *state_tick.flash_message.borrow_mut() = message;
    state_tick
        .flash_is_error
        .set(toast_type.as_deref() == Some("error"));
    state_tick.flash_visible.set(true);
    state_tick
        .flash_timer
        .set(duration.unwrap_or(FLASH_DURATION));
    *state_tick.flash_action.borrow_mut() = action;
    *state_tick.flash_action_label.borrow_mut() = action_label;
    *state_tick.flash_reject_action.borrow_mut() = reject_action;
    *state_tick.flash_reject_action_label.borrow_mut() = reject_action_label;
}

/// Applies `InMessage::DismissToast`.
fn on_dismiss_toast(state_tick: &Rc<PillState>) {
    clear_flash(state_tick);
}

/// Applies `InMessage::Fireworks`.
fn on_fireworks(message: String, state_tick: &Rc<PillState>) {
    *state_tick.flash_message.borrow_mut() = message;
    state_tick.flash_is_error.set(false);
    *state_tick.flash_action.borrow_mut() = None;
    *state_tick.flash_action_label.borrow_mut() = None;
    *state_tick.flash_reject_action.borrow_mut() = None;
    *state_tick.flash_reject_action_label.borrow_mut() = None;
    state_tick.flash_visible.set(true);
    state_tick.flash_timer.set(FIREWORKS_TOTAL_DURATION);

    state_tick.fireworks_active.set(true);
    state_tick.fireworks_elapsed.set(0.0);
    state_tick.fireworks_next_launch.set(0);
    state_tick.fireworks_rockets.borrow_mut().clear();
}

/// Applies `InMessage::Flame`.
fn on_flame(message: String, state_tick: &Rc<PillState>) {
    *state_tick.flash_message.borrow_mut() = message;
    state_tick.flash_is_error.set(false);
    *state_tick.flash_action.borrow_mut() = None;
    *state_tick.flash_action_label.borrow_mut() = None;
    *state_tick.flash_reject_action.borrow_mut() = None;
    *state_tick.flash_reject_action_label.borrow_mut() = None;
    state_tick.flash_visible.set(true);
    state_tick.flash_timer.set(FLAME_TOTAL_DURATION);

    state_tick.flame_active.set(true);
    state_tick.flame_elapsed.set(0.0);
    state_tick.flame_tongues.borrow_mut().clear();
}

/// Applies `InMessage::FlashBlue`.
fn on_flash_blue(state_tick: &Rc<PillState>) {
    state_tick.flash_blue_active.set(true);
    state_tick.flash_blue_elapsed.set(0.0);
}

/// Applies `InMessage::BroadcastTranscript`.
fn on_broadcast_transcript(text: String, state_tick: &Rc<PillState>) {
    *state_tick.transcript_text.borrow_mut() = text;
    state_tick.transcript_time_since_update.set(0.0);
    state_tick.transcript_has_message.set(true);
}

/// Applies `InMessage::StageText`.
fn on_stage_text(text: Option<String>, state_tick: &Rc<PillState>) {
    let stage = rust_pill_shared::active_stage_text(text.as_deref());
    *state_tick.stage_text.borrow_mut() = stage.map(str::to_owned);
}

/// Applies `InMessage::Visibility`.
fn on_visibility(visibility: Visibility, state_tick: &Rc<PillState>) {
    state_tick.visibility.set(visibility);
}

/// Applies `InMessage::WindowSize`.
fn on_window_size(size: &str, state_tick: &Rc<PillState>) {
    let mode = WindowMode::from_str(size);
    state_tick.window_mode.set(mode);
}

/// Applies `InMessage::AssistantState`.
fn on_assistant_state(msg: InMessage, state_tick: &Rc<PillState>, entry_tick: &gtk::Entry) {
    let InMessage::AssistantState {
        active,
        input_mode,
        compact,
        conversation_id,
        user_prompt,
        messages,
        streaming,
        permissions,
        review,
    } = msg
    else {
        return;
    };
    let was_active = state_tick.assistant_active.get();
    state_tick.assistant_active.set(active);
    *state_tick.assistant_input_mode.borrow_mut() = input_mode;
    state_tick.assistant_compact.set(compact);
    *state_tick.assistant_conversation_id.borrow_mut() = conversation_id;
    *state_tick.assistant_user_prompt.borrow_mut() = user_prompt;
    *state_tick.assistant_messages.borrow_mut() = messages;
    *state_tick.assistant_streaming.borrow_mut() = streaming;
    *state_tick.assistant_permissions.borrow_mut() = permissions;
    let previous_review_id = state_tick
        .assistant_review
        .borrow()
        .as_ref()
        .map(|r| r.id.clone());
    let review_id = review.as_ref().map(|r| r.id.clone());
    let review_text = review.as_ref().map(|r| r.text.clone());
    *state_tick.assistant_review.borrow_mut() = review.map(|review| *review);

    // The entry is the review surface: a new transcript loads
    // into it for editing, and answering the review empties it
    // again. An unchanged id leaves the user's edits alone.
    if review_id != previous_review_id {
        let text = review_text.unwrap_or_default();
        state_tick.entry_text.borrow_mut().clone_from(&text);
        entry_tick.set_text(&text);
    } else if crate::input::entry_should_be_cleared(
        &state_tick.entry_text.borrow(),
        &entry_tick.text(),
    ) {
        // The mirror was emptied somewhere that had no widget -- the
        // Send-button click, or `submit_entry` -- and the id did not change,
        // so the reload above did not run. Without this the widget keeps
        // showing text that has already been sent. Windows reconciles the
        // same way in its window procedure; this is that line.
        entry_tick.set_text("");
    }

    if (active && !was_active) || (review_id.is_some() && review_id != previous_review_id) {
        state_tick.should_stick.set(true);
        state_tick.scroll_offset.set(0.0);
    }
}

/// Applies `InMessage::ResetPosition`.
fn on_reset_position(strategy: ResetStrategy, state_tick: &Rc<PillState>, win_tick: &gtk::Window) {
    state_tick.dragging.set(false);
    state_tick.pointer_down.set(false);
    state_tick.long_press_active.set(false);
    state_tick.long_press_elapsed.set(0.0);
    state_tick.drag_cancelled.set(true);
    // The X11 idle timer must not save the cancelled gesture
    // through its missed-release fallback after this reset.
    state_tick.x11_release_persisted.set(true);
    state_tick.drag_draw_offset_x.set(0.0);
    state_tick.drag_draw_offset_y.set(0.0);
    state_tick.drag_motion.borrow_mut().reset();
    state_tick.selector_placement.borrow_mut().reset();
    state_tick.crossing.borrow_mut().reset();
    state_tick.has_saved_position.set(false);
    state_tick.saved_display_id.set(None);
    // A save still owed from the previous gesture would publish the
    // pre-reset origin and recreate the row the reset just deleted.
    state_tick.drag_save_due.set(None);
    // A reset is a placement the user asked for, so the pill is due
    // one even though nothing is stored.
    state_tick
        .anchor
        .set(rust_pill_shared::layout::Anchor::from_reset(
            strategy == ResetStrategy::Cursor,
        ));
    let (rect, monitor) = pill_geometry(win_tick, state_tick);
    ipc::send(&OutMessage::PositionChanged {
        report: rust_pill_shared::restore::PositionReport::new(false, rect, monitor, None),
    });
}

/// Applies `InMessage::ForgetPosition`.
fn on_forget_position(state_tick: &Rc<PillState>) {
    // A drag still held, or a settle that has not finished, would reach
    // a save path on a later frame and publish a saved position again --
    // recreating the row the clear just deleted. Cancel the gesture
    // first; a drag started after the clear still saves normally.
    state_tick.dragging.set(false);
    state_tick.pointer_down.set(false);
    state_tick.long_press_active.set(false);
    state_tick.drag_cancelled.set(true);
    state_tick.x11_release_persisted.set(true);
    state_tick.drag_motion.borrow_mut().reset();
    // Stop treating where the pill is sitting as the saved position.
    // Local data was just cleared, and the next `RequestPosition`
    // republishes this flag, so leaving it set would write the row back.
    state_tick.has_saved_position.set(false);
    state_tick.saved_display_id.set(None);
    // A retry parked against the pre-clear position is the same
    // hazard one frame later: it would publish the flag back as
    // true and recreate the row the clear just removed.
    state_tick.drag_save_due.set(None);
    // A clear drops the record without moving the window, and it
    // cancels any placement still owed.
    state_tick
        .anchor
        .set(rust_pill_shared::layout::Anchor::from_forget());
}

/// Applies `InMessage::RequestPosition`.
fn on_request_position(state_tick: &Rc<PillState>, win_tick: &gtk::Window) {
    let (rect, monitor) = pill_geometry(win_tick, state_tick);
    ipc::send(&OutMessage::PositionChanged {
        report: rust_pill_shared::restore::PositionReport::new(
            state_tick.has_saved_position.get(),
            rect,
            monitor,
            state_tick.saved_display_id.get(),
        ),
    });
}

/// Applies `InMessage::Quit`.
fn on_quit(quit: &Rc<Cell<bool>>) {
    quit.set(true);
}

/// Runs the GTK pill: picks the display backend, creates the frameless
/// window, and drives the message/event loop until a quit message arrives.
/// One frame of the 16 ms loop, as a free function.
///
/// This was the body of a closure registered inside `run`, which is why `run`
/// carried a cyclomatic complexity of 69: the loop's seventeen decisions were
/// counted against the function that merely started it. The handles it used to
/// capture are parameters now, so the frame reads on its own.
///
/// `ControlFlow::Break` ends the loop, which is how a `Quit` message stops it.
fn frame_tick(
    receiver: &Rc<RefCell<Receiver<InMessage>>>,
    state_tick: &Rc<PillState>,
    win_tick: &gtk::Window,
    entry_tick: &gtk::Entry,
    da: &gtk::DrawingArea,
    quit_tick: &Rc<Cell<bool>>,
    backend_tick: Backend,
) -> ControlFlow {
    drain_messages(receiver, state_tick, win_tick, entry_tick, quit_tick);

    if quit_tick.get() {
        return ControlFlow::Break;
    }

    release_pointer_if_button_up(win_tick, state_tick);
    // X11 does not move a window when RandR reconfigures the outputs, so a
    // display disappearing leaves the pill parked over empty root space with
    // nothing painted under it. Watching the arrangement here is what brings
    // it back, and the poll backs up the event because a change can land while
    // the toplevel is unmapped.
    if backend_tick == Backend::X11 {
        poll_display_layout(win_tick, state_tick);
    }
    // One measured step for the whole frame: the transition springs and
    // the drag controller share it, so a long frame slows everything
    // together instead of each measuring a different slice.
    let dt_tick = frame_dt();
    tick(state_tick, dt_tick);
    tick_drag_frame(
        win_tick,
        state_tick,
        backend_tick,
        drag_clock_now(),
        dt_tick,
    );
    // A drop the display change held back is written as soon as both holds
    // have passed. The frame loop is the retry: the release is reported once,
    // so nothing else would come back for it.
    if state_tick.drag_save_due.get().is_some() {
        retry_drag_save(win_tick, state_tick);
    }
    tick_hover_frame(state_tick);
    tick_selector_placement(win_tick, state_tick, dt_tick);
    tick_crossing_frame(win_tick, state_tick, dt_tick);

    // Show/hide entry for typing mode
    let is_typing = state_tick.is_typing();
    if is_typing {
        // Recomputed every frame rather than once on show. The window is
        // resized by one message and the state that opens the entry by
        // another, so a size that lands second would otherwise leave the
        // entry sitting at the old geometry.
        let (ox, oy) = state_tick.content_offset();
        let dw = state_tick.draw_width.get();
        let dh = state_tick.draw_height.get();
        let panel_w = PANEL_EXPANDED_WIDTH;
        let panel_x = (dw - panel_w) / 2.0;
        let margin_start = (ox + panel_x + PANEL_CONTENT_SIDE_INSET) as i32;
        let aw = state_tick.alloc_width.get();
        let right_margin = if aw > 0.0 {
            aw - ox - dw
        } else {
            WINDOW_W_TYPING as f64 - ox - dw
        };
        let margin_end =
            (right_margin + (dw - panel_x - panel_w) + PANEL_CONTENT_SIDE_INSET) as i32;
        let ah = state_tick.alloc_height.get();
        let bottom_margin = if ah > 0.0 { ah - oy - dh } else { 0.0 };
        let margin_bottom = (bottom_margin + PANEL_BOTTOM_MARGIN) as i32;
        entry_tick.set_margin_start(margin_start);
        entry_tick.set_margin_end(margin_end);
        entry_tick.set_margin_bottom(margin_bottom);
        entry_tick.set_height_request(PANEL_INPUT_HEIGHT as i32);
    }
    if is_typing && !gtk::prelude::WidgetExt::is_visible(entry_tick) {
        entry_tick.set_visible(true);
        entry_tick.show();
        match backend_tick {
            Backend::LayerShell => {
                win_tick.set_keyboard_mode(gtk_layer_shell::KeyboardMode::OnDemand);
                glib::idle_add_local_once({
                    let e = entry_tick.clone();
                    move || {
                        e.grab_focus();
                    }
                });
            }
            Backend::X11 => {
                win_tick.set_accept_focus(true);
                glib::timeout_add_local(Duration::from_millis(100), {
                    let e = entry_tick.clone();
                    let w = win_tick.clone();
                    move || {
                        x11::force_keyboard_focus(&w);
                        e.grab_focus();
                        ControlFlow::Break
                    }
                });
            }
            Backend::PlainWayland => {
                win_tick.set_accept_focus(true);
                glib::idle_add_local_once({
                    let e = entry_tick.clone();
                    move || {
                        e.grab_focus();
                    }
                });
            }
        }
    } else if !is_typing && gtk::prelude::WidgetExt::is_visible(entry_tick) {
        entry_tick.select_region(0, 0);
        entry_tick.set_visible(false);
        entry_tick.hide();
        match backend_tick {
            Backend::LayerShell => {
                win_tick.set_keyboard_mode(gtk_layer_shell::KeyboardMode::None);
            }
            _ => {
                win_tick.set_accept_focus(false);
            }
        }
    }

    // One visibility policy for every backend. LayerShell and PlainWayland
    // previously keyed off `phase == Recording` alone, which ignored the
    // user's preference: a pill set to Hidden still appeared while
    // recording, and Persistent never showed when idle.
    let should_show = rust_pill_shared::should_show_pill(
        state_tick.visibility.get().into(),
        state_tick.phase.get() != Phase::Idle,
        state_tick.owns_panel(),
    );
    if should_show {
        win_tick.show();
    } else {
        win_tick.hide();
    }

    if let Some(gdk_win) = win_tick.window() {
        input::update_input_region(&gdk_win, state_tick);
    }
    da.queue_draw();
    ControlFlow::Continue
}

/// The things a signal handler needs to reach. Passed as one value because the
/// alternative is seven positional arguments of which four are clones of the same
/// three widgets.
struct Wiring<'a> {
    window: &'a gtk::Window,
    entry: &'a gtk::Entry,
    drawing_area: &'a gtk::DrawingArea,
    state: &'a Rc<PillState>,
    receiver: &'a Rc<RefCell<Receiver<InMessage>>>,
    backend: Backend,
    quit_flag: &'a Rc<Cell<bool>>,
}

/// The signals that are about text and keys rather than the pointer.
///
/// Split from `wire_events` so neither function holds all thirteen: the pointer
/// half (enter, motion, leave, press, release, scroll) and this one touch disjoint
/// state, and the only thing they shared was being registered in one place.
fn wire_entry_and_keys(wiring: Wiring) {
    let Wiring {
        window,
        entry,
        drawing_area,
        state,
        ..
    } = wiring;
    let state_focus_in = state.clone();
    let entry_focus_in = entry.clone();
    window.connect_focus_in_event(move |_, _| {
        let is_typing = state_focus_in.is_typing();
        if is_typing {
            entry_focus_in.grab_focus();
        }
        glib::Propagation::Proceed
    });

    let state_focus_out = state.clone();
    let entry_focus_out = entry.clone();
    window.connect_focus_out_event(move |_, _| {
        let is_typing = state_focus_out.is_typing();
        if is_typing {
            entry_focus_out.select_region(0, 0);
        }
        glib::Propagation::Proceed
    });

    let state_draw = state.clone();
    let win_draw = window.clone();
    let last_draw_error = Cell::new(None::<Instant>);
    drawing_area.connect_draw(move |_area, cr| {
        // draw_tooltip() computes tooltip_width during this pass. The tick
        // rebuilds the Wayland input region *before* drawing, so on the frame
        // the tooltip first appears the region was built with a width of 0.0
        // and build_input_region() left the tooltip out. Rebuild the region
        // here when the width changes, so the tooltip is never painted outside
        // its own input shape.
        //
        // The toast buttons need the same treatment for the same reason, and
        // for one more: draw_flash_message() scales the banner about its centre
        // from half size up to full, so it re-registers both buttons at new
        // coordinates every frame of the animation. A shape left to the next
        // tick is a whole frame of the animation behind the painted button.
        let width_before = state_draw.tooltip_width.get();
        let flash_before = input::flash_click_signature(&state_draw);
        draw::draw_all(cr, &state_draw);
        if let Err(error) = cr.status() {
            let now = Instant::now();
            if last_draw_error
                .get()
                .is_none_or(|last| now.duration_since(last) >= Duration::from_secs(2))
            {
                eprintln!("pill drawing failed: {error}");
                last_draw_error.set(Some(now));
            }
        }
        let shape_is_stale = state_draw.tooltip_width.get() != width_before
            || input::flash_click_signature(&state_draw) != flash_before;
        if let Some(gdk_win) = win_draw.window().filter(|_| shape_is_stale) {
            input::update_input_region(&gdk_win, &state_draw);
        }
        glib::Propagation::Proceed
    });

    let state_entry = state.clone();
    entry.connect_activate(move |e| {
        // Enter submits: an insert decision while a transcript is under
        // review, a message to the assistant otherwise.
        *state_entry.entry_text.borrow_mut() = e.text().to_string();
        if input::submit_entry(&state_entry) {
            e.set_text("");
        }
    });

    let state_entry_changed = state.clone();
    entry.connect_changed(move |e| {
        *state_entry_changed.entry_text.borrow_mut() = e.text().to_string();
    });

    let state_escape = state.clone();
    window.connect_key_press_event(move |_, event| {
        // Escape while a transcript is under review is a cancel decision, the
        // same as on the Windows pill: the desktop is waiting for an answer.
        // The window sees the key before the focused entry does, so this works
        // whether or not the entry holds the keyboard.
        if event.keyval() != gdk::keys::constants::Escape {
            return glib::Propagation::Proceed;
        }
        match state_escape.pending_review_id() {
            Some(review_id) => {
                input::send_review_decision(&review_id, "cancel", None);
                glib::Propagation::Stop
            }
            None => glib::Propagation::Proceed,
        }
    });
}

/// Clear a pin whose release event never arrived.
///
/// A button-release is not guaranteed -- a grab can be broken by another client --
/// but the motion event carries the live button mask, so a stale pin shows up
/// here. The frame tick runs the same check against the pointer device, which
/// covers a missed release with no subsequent motion.
fn clear_pin_if_released(state: &Rc<PillState>, window: &gtk::Window, mask: gdk::ModifierType) {
    if state.pointer_down.get() && !mask.contains(gdk::ModifierType::BUTTON1_MASK) {
        clear_pointer_pin(state, window);
    }
}

/// A long press becomes a drag once the pointer travels far enough; past that
/// threshold the gesture is cancelled and the cancel flash marks it.
fn cancel_long_press_if_moved(state: &Rc<PillState>, mx: f64, my: f64) {
    if !state.long_press_active.get() {
        return;
    }
    let dx = mx - state.long_press_start_x.get();
    let dy = my - state.long_press_start_y.get();
    if (dx * dx + dy * dy) > LONG_PRESS_MOVE_THRESHOLD * LONG_PRESS_MOVE_THRESHOLD {
        state.long_press_active.set(false);
        state.long_press_elapsed.set(0.0);
        state.drag_cancelled.set(true);
        state.cancel_flash.set(CANCEL_FLASH_DURATION);
    }
}

/// While dragging on Wayland, record the newest pointer sample; the frame tick
/// applies it through the shared controller (newest wins, so a burst of motion
/// events coalesces into one move per frame). X11 samples the root pointer on
/// the frame clock instead.
fn record_drag_sample_if_dragging(state: &Rc<PillState>, mx: f64, my: f64) {
    if state.dragging.get() && state.backend.get() != Backend::X11 {
        state.drag_last_x.set(mx);
        state.drag_last_y.set(my);
        state
            .drag_motion
            .borrow_mut()
            .push_sample(mx, my, drag_clock_now());
    }
}

/// Everything that reacts to an event on the pill window.
///
/// `run` used to hold this inline: 292 lines registering sixteen GTK signals
/// between the window construction and the first frame, which is why Sonar scored
/// it 102 against a limit of 30. The closures are unchanged; only the borrows
/// they capture moved.
fn wire_events(wiring: Wiring) {
    let Wiring {
        window,
        entry,
        drawing_area,
        state,
        receiver,
        backend,
        ..
    } = wiring;
    window.add_events(
        gdk::EventMask::ENTER_NOTIFY_MASK
            | gdk::EventMask::LEAVE_NOTIFY_MASK
            | gdk::EventMask::POINTER_MOTION_MASK
            | gdk::EventMask::BUTTON_PRESS_MASK
            | gdk::EventMask::BUTTON_RELEASE_MASK
            | gdk::EventMask::FOCUS_CHANGE_MASK
            | gdk::EventMask::KEY_PRESS_MASK
            | gdk::EventMask::SCROLL_MASK
            | gdk::EventMask::SMOOTH_SCROLL_MASK,
    );

    let state_enter = state.clone();
    window.connect_enter_notify_event(move |win, event| {
        let (mx, my) = event.position();
        // Record the probe; the frame tick runs it through the hover-intent
        // controller, so entering the window does not expand the pill until
        // the pointer actually dwells on it.
        state_enter
            .hover_probed
            .set(input::is_over_pill_area(&state_enter, mx, my));
        state_enter.hover_probe_x.set(mx);
        state_enter.hover_probe_y.set(my);
        if let Some(gdk_win) = win.window() {
            input::set_expanded_input_region(&gdk_win, &state_enter);
        }
        glib::Propagation::Proceed
    });

    let state_motion = state.clone();
    let win_motion = window.clone();
    window.connect_motion_notify_event(move |_, event| {
        let (mx, my) = event.position();
        // A button-release event is not guaranteed to arrive (a grab can be
        // broken by another client). The motion event carries the live button
        // mask, so clear a stale pin before reading it. The frame tick runs the
        // same check against the pointer device, which covers a missed release
        // with no subsequent motion.
        clear_pin_if_released(&state_motion, &win_motion, event.state());

        // Record the probe; the frame tick runs it through the hover-intent
        // controller (dwell to arm, grace to exit, pin while held), so bursts
        // of motion coalesce into one hover decision per frame.
        state_motion
            .hover_probed
            .set(input::is_over_pill_area(&state_motion, mx, my));
        state_motion.hover_probe_x.set(mx);
        state_motion.hover_probe_y.set(my);

        cancel_long_press_if_moved(&state_motion, mx, my);

        // While dragging on Wayland, record the newest pointer sample; the frame
        // tick applies it through the shared controller (newest wins, so a
        // burst of motion events coalesces into one move per frame). X11
        // samples the root pointer on the frame clock instead.
        record_drag_sample_if_dragging(&state_motion, mx, my);

        glib::Propagation::Proceed
    });

    let state_leave = state.clone();
    window.connect_leave_notify_event(move |_, event| {
        // Dragging the pill drags its window out from under the pointer, so
        // mid-gesture crossings are an artefact, not the user leaving.
        if event.mode() == gdk::CrossingMode::Normal && !state_leave.pointer_down.get() {
            // The pointer left for real; the tick's exit grace still applies,
            // so a leave immediately followed by a re-enter does not flicker.
            state_leave.hover_probed.set(false);
        }
        glib::Propagation::Proceed
    });

    let state_press = state.clone();
    let entry_press = entry.clone();
    let win_press = window.clone();
    let backend_press = backend;
    window.connect_button_press_event(move |_, event| {
        state_press.drag_cancelled.set(false);
        let (x, y) = event.position();
        let is_typing = state_press.is_typing();
        if is_typing {
            if backend_press == Backend::X11 {
                x11::force_keyboard_focus(&win_press);
            }
            entry_press.grab_focus();
        }
        if input::is_on_pill_at(&state_press, x, y) {
            if state_press.drag_motion.borrow_mut().interrupt_settle() {
                persist_drag_position(&win_press, &state_press);
            }
            state_press.pointer_down.set(true);
            state_press.long_press_active.set(true);
            state_press.long_press_elapsed.set(0.0);
            state_press.long_press_start_x.set(x);
            state_press.long_press_start_y.set(y);
            state_press.drag_cursor_x.set(x);
            state_press.drag_cursor_y.set(y);
            state_press
                .drag_press_offset
                .set(x11::physical_grab_offset((x, y), win_press.scale_factor()));
            // Seed the Wayland sample so the first drag frame has a sane
            // pointer even if no motion event arrived since the press.
            state_press.drag_last_x.set(x);
            state_press.drag_last_y.set(y);
        }
        glib::Propagation::Proceed
    });

    {
        let win_ep = window.clone();
        let backend_ep = backend;
        entry.connect_button_press_event(move |e, _| {
            if backend_ep == Backend::X11 {
                x11::force_keyboard_focus(&win_ep);
            }
            e.grab_focus();
            glib::Propagation::Proceed
        });
    }

    let state_click = state.clone();
    let win_click = window.clone();
    let last_click: Rc<Cell<Option<Instant>>> = Rc::new(Cell::new(None));
    window.connect_button_release_event(move |_, event| {
        let now = Instant::now();
        if let Some(prev) = last_click.get() {
            if now.duration_since(prev) < Duration::from_millis(150) {
                return glib::Propagation::Proceed;
            }
        }
        last_click.set(Some(now));
        let was_dragging = state_click.dragging.get();
        // End the gesture and persist the dropped position (if still dragging)
        // through the shared teardown, so the button-release path and the
        // frame-tick missed-release backstop cannot drift apart.
        clear_pointer_pin(&state_click, &win_click);
        if !was_dragging && !state_click.drag_cancelled.get() {
            let (x, y) = event.position();
            input::handle_click(&state_click, x, y);
        }

        // Hover was pinned for the duration of the gesture; re-probe against
        // the cursor's real position now that the pointer is free. The frame
        // tick applies it (with exit grace), so releasing outside fades out
        // instead of snapping off.
        let (rx, ry) = event.position();
        state_click
            .hover_probed
            .set(input::is_over_pill_area(&state_click, rx, ry));
        state_click.hover_probe_x.set(rx);
        state_click.hover_probe_y.set(ry);
        glib::Propagation::Proceed
    });

    let state_scroll = state.clone();
    window.connect_scroll_event(move |_, event| {
        input::handle_scroll(&state_scroll, event);
        glib::Propagation::Proceed
    });

    // `frame_tick` takes borrowed handles, so these are the owned ones the
    // timeout keeps alive. `receiver` and `quit_flag` are already owned by `run`.
    let state_tick = state.clone();
    let da = drawing_area.clone();
    let win_tick = window.clone();
    let entry_tick = entry.clone();
    let receiver_tick = receiver.clone();
    let quit_tick = wiring.quit_flag.clone();
    let backend_tick = backend;
    glib::timeout_add_local(Duration::from_millis(16), move || {
        frame_tick(
            &receiver_tick,
            &state_tick,
            &win_tick,
            &entry_tick,
            &da,
            &quit_tick,
            backend_tick,
        )
    });

    wire_entry_and_keys(wiring);
}

/// The pill's initial state.
///
/// This was a 120-line literal inside `run`. A literal is not testable -- there
/// is no way to construct the at-rest state without also building a window and a
/// GDK display -- and it buried `run`'s own logic under field initialisation.
fn initial_state(backend: Backend, restored_position: Option<ParkedWindow>) -> Rc<PillState> {
    Rc::new(PillState {
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
        style_name: RefCell::default(),
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
        assistant_input_mode: RefCell::new("voice".to_string()),
        assistant_compact: Cell::new(true),
        assistant_conversation_id: RefCell::new(None),
        assistant_user_prompt: RefCell::new(None),
        assistant_messages: RefCell::new(Vec::new()),
        assistant_streaming: RefCell::new(None),
        assistant_permissions: RefCell::new(Vec::new()),
        assistant_review: RefCell::new(None),
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
        entry_text: RefCell::default(),
        pause_t: Cell::new(0.0),
        pause_velocity: Cell::new(0.0),
        cancel_t: Cell::new(0.0),
        cancel_velocity: Cell::new(0.0),
        flash_message: RefCell::default(),
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
        transcript_text: RefCell::default(),
        transcript_time_since_update: Cell::new(0.0),
        transcript_opacity: Cell::new(0.0),
        transcript_has_message: Cell::new(false),
        stage_text: RefCell::new(None),
        long_press_active: Cell::new(false),
        long_press_elapsed: Cell::new(0.0),
        long_press_start_x: Cell::new(0.0),
        long_press_start_y: Cell::new(0.0),
        dragging: Cell::new(false),
        drag_cancelled: Cell::new(false),
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
        drag_cursor_x: Cell::new(0.0),
        drag_cursor_y: Cell::new(0.0),
        drag_press_offset: Cell::new((0.0, 0.0)),
        drag_motion: RefCell::new(rust_pill_shared::drag::DragController::new()),
        drag_last_x: Cell::new(0.0),
        drag_last_y: Cell::new(0.0),
        hover_intent: RefCell::new(rust_pill_shared::hover::HoverIntent::new()),
        selector_placement: RefCell::new(rust_pill_shared::placement::SelectorPlacement::new()),
        crossing: RefCell::new(rust_pill_shared::deform::CrossingDeform::new()),
        hover_probed: Cell::new(false),
        hover_probe_x: Cell::new(0.0),
        hover_probe_y: Cell::new(0.0),
        has_saved_position: Cell::new(false),
        saved_display_id: Cell::new(None),
        save_guard: RefCell::new(rust_pill_shared::layout::SaveGuard::new()),
        layout_poll: RefCell::new(rust_pill_shared::layout::LayoutPoll::new()),
        saved_x: Cell::new(0.0),
        saved_y: Cell::new(0.0),
        restored_position: Cell::new(restored_position),
        x11_release_persisted: Cell::new(false),
        drag_save_due: Cell::new(None),
        x11_drag_applied: Cell::new((UNAPPLIED_ORIGIN, UNAPPLIED_ORIGIN)),
        anchor: Cell::new(rust_pill_shared::layout::Anchor::LaunchAtCursor),
        drag_draw_offset_x: Cell::new(0.0),
        drag_draw_offset_y: Cell::new(0.0),
        cancel_flash: Cell::new(0.0),
        alloc_width: Cell::new(0.0),
        alloc_height: Cell::new(0.0),
        backend: Cell::new(backend),
    })
}

/// Which windowing protocol the pill has to speak.
fn detect_backend() -> Backend {
    if gtk_layer_shell::is_supported() {
        return Backend::LayerShell;
    }
    let display = gdk::Display::default().expect("display");
    if display.type_().name() == "GdkX11Display" {
        Backend::X11
    } else {
        Backend::PlainWayland
    }
}

/// X11 keeps room for the below selector slot under the pill, so a side flip
/// animates inside space that is already there. LayerShell is bottom anchored (a
/// taller surface would lift the pill) and PlainWayland is fullscreen, so both
/// keep the typing size. X11 content and parking math exclude these reserved
/// rows, preserving the visible pill and entry origin.
fn pill_window_height(backend: Backend) -> i32 {
    if backend == Backend::X11 {
        WINDOW_H_TYPING + rust_pill_shared::placement::below_slot_extra(TOOLTIP_HEIGHT) as i32
    } else {
        WINDOW_H_TYPING
    }
}

/// The toplevel, with the backend's own window hints already applied.
///
/// `run` used to open with sixty lines of window class, transparent visual,
/// per-backend hints and the stylesheet before it registered a single signal.
fn build_pill_window(
    backend: Backend,
    window_h: i32,
) -> (gtk::Window, gtk::Overlay, gtk::DrawingArea) {
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    if backend != Backend::PlainWayland {
        window.set_default_size(WINDOW_W_TYPING, window_h);
    }
    window.set_decorated(false);
    window.set_app_paintable(true);

    let screen: gdk::Screen = gtk::prelude::WidgetExt::screen(&window).expect("screen");
    if let Some(visual) = screen.rgba_visual() {
        window.set_visual(Some(&visual));
    }

    match backend {
        Backend::LayerShell => {
            window.init_layer_shell();
            window.set_layer(gtk_layer_shell::Layer::Overlay);
            window.set_anchor(gtk_layer_shell::Edge::Bottom, true);
            window.set_layer_shell_margin(gtk_layer_shell::Edge::Bottom, MARGIN_BOTTOM);
            window.set_keyboard_mode(gtk_layer_shell::KeyboardMode::None);
            window.set_exclusive_zone(0);
            window.set_namespace("mausvoice-pill");
        }
        Backend::X11 => {}
        Backend::PlainWayland => {
            window.set_type_hint(gdk::WindowTypeHint::Dock);
            window.set_keep_above(true);
            window.set_accept_focus(false);
            window.maximize();
        }
    }

    let css = gtk::CssProvider::new();
    let _ = css.load_from_data(
        b"window { background: transparent; }
          entry { background: transparent; border: none; color: rgba(255,255,255,0.92); }
          entry:focus { box-shadow: none; outline: none; }",
    );
    if let Some(screen) = gdk::Screen::default() {
        gtk::StyleContext::add_provider_for_screen(
            &screen,
            &css,
            gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
        );
    }

    let overlay_widget = gtk::Overlay::new();
    let drawing_area = gtk::DrawingArea::new();
    if backend != Backend::PlainWayland {
        drawing_area.set_size_request(WINDOW_W_TYPING, window_h);
    }
    overlay_widget.add(&drawing_area);
    (window, overlay_widget, drawing_area)
}

/// Keep the overlay homed on a live monitor.
///
/// LayerShell positions the surface, so a disconnected output leaves the pill on
/// nothing. This is the only place that answers "which monitor", and it has to be
/// a poll: the arrangements are not all events, and a change can land while the
/// toplevel is unmapped.
fn start_display_poll(window: &gtk::Window, state: &Rc<PillState>, quit_flag: &Rc<Cell<bool>>) {
    let window_ref = window.clone();
    let quit_monitor = quit_flag.clone();
    let state_monitor = state.clone();
    // Which output the pill was homed on, and the geometry it had at the time.
    // The identity is what answers "is it still there"; the geometry only exists
    // so a resize can re-home within the same output instead of being mistaken
    // for its disappearance.
    type Homed = (gdk::Monitor, (i32, i32, i32, i32));
    let homed: Rc<RefCell<Option<Homed>>> = Rc::new(RefCell::new(None));
    glib::timeout_add_local(Duration::from_millis(100), move || {
        if quit_monitor.get() {
            return ControlFlow::Break;
        }
        let display = match gdk::Display::default() {
            Some(d) => d,
            None => return ControlFlow::Continue,
        };
        // Only re-home the overlay to the pointer's monitor for the FIRST
        // placement or while the user is actively dragging across screens.
        // Chasing the pointer the rest of the time is what made the pinned pill
        // hop displays whenever the cursor crossed an edge.
        //
        // "Still connected" is asked of the monitor itself, not of its geometry.
        // Geometry was the older test, and it reads a resize or a rearrange as a
        // disconnection: the stored rectangle stops matching every connected
        // monitor, so a pill parked on the screen the user just resized was
        // yanked onto the pointer's screen. An output keeps its identity across
        // both, so that is what gets remembered.
        let placed_once = homed.borrow().is_some();
        let still_connected = {
            let homed = homed.borrow();
            match *homed {
                Some((ref monitor, _)) => {
                    (0..display.n_monitors()).any(|i| display.monitor(i).as_ref() == Some(monitor))
                }
                None => false,
            }
        };
        // A reset with the "cursor" strategy forces one re-home pass onto
        // the pointer's monitor; the strategy is consumed once applied.
        let reset_to_cursor =
            !state_monitor.dragging.get() && state_monitor.anchor.get().follows_pointer();
        if placed_once && !state_monitor.dragging.get() && !reset_to_cursor && still_connected {
            // Still on the same output, so the pointer has no say here. A resize
            // or a rearrange does change the geometry, though, and the surface
            // has to be told: re-homing within this monitor is not chasing the
            // cursor, it is keeping up with the screen the pill already lives on.
            let resized = {
                let homed = homed.borrow();
                match *homed {
                    Some((ref monitor, geom)) => {
                        let g = monitor.geometry();
                        ((g.x(), g.y(), g.width(), g.height()) != geom)
                            .then(|| (monitor.clone(), (g.x(), g.y(), g.width(), g.height())))
                    }
                    None => None,
                }
            };
            if let Some((monitor, geom)) = resized {
                homed.borrow_mut().replace((monitor.clone(), geom));
                window_ref.set_monitor(&monitor);
            }
            return ControlFlow::Continue;
        }
        let seat = match display.default_seat() {
            Some(s) => s,
            None => return ControlFlow::Continue,
        };
        let pointer = match seat.pointer() {
            Some(p) => p,
            None => return ControlFlow::Continue,
        };
        let (_, x, y) = pointer.position();
        // If the pointer itself sits on dead/missing output hardware, fall
        // back to the primary monitor so the pill always has a home.
        let monitor = display
            .monitor_at_point(x, y)
            .or_else(|| display.primary_monitor())
            .or_else(|| display.monitor(0));
        if let Some(monitor) = monitor {
            let g = monitor.geometry();
            let new_geom = (g.x(), g.y(), g.width(), g.height());
            let unchanged = homed
                .borrow()
                .as_ref()
                .is_some_and(|(stored, geom)| *stored == monitor && *geom == new_geom);
            if !unchanged {
                homed.borrow_mut().replace((monitor.clone(), new_geom));
                window_ref.set_monitor(&monitor);
            }
            if reset_to_cursor {
                // Consumed once applied, so the pill is homed once rather than
                // chased by the timer.
                state_monitor
                    .anchor
                    .set(rust_pill_shared::layout::Anchor::ResetAtCurrent);
            }
        }
        ControlFlow::Continue
    });
}

pub fn run(receiver: Receiver<InMessage>, restored_position: Option<ParkedWindow>) {
    let backend = detect_backend();

    let window_h = pill_window_height(backend);
    let (window, overlay_widget, drawing_area) = build_pill_window(backend, window_h);

    let entry = gtk::Entry::new();
    // Kept so a send can empty the widget from anywhere, the way the Windows pill reaches
    // its Edit control. `connect_activate` closes over its own clone; the Send-button click
    // is handled in `input.rs`, which has no widget.
    ENTRY.with(|slot| *slot.borrow_mut() = Some(entry.clone()));
    entry.set_placeholder_text(Some("Type a message..."));
    entry.set_has_frame(false);
    entry.set_halign(gtk::Align::Fill);
    entry.set_valign(gtk::Align::End);
    entry.set_visible(false);
    entry.set_no_show_all(true);
    overlay_widget.add_overlay(&entry);

    window.add(&overlay_widget);

    let state = initial_state(backend, restored_position);
    // The flag is shared by the message handler, the frame loop and the display
    // poll; whichever sees `Quit` first sets it and the others stop.
    let quit_flag = Rc::new(Cell::new(false));
    let receiver = Rc::new(RefCell::new(receiver));

    if backend == Backend::X11 {
        let state_realize = state.clone();
        window.connect_realize(move |window| x11::setup_x11_window(window, state_realize.clone()));
    }

    let state_alloc = state.clone();
    window.connect_size_allocate(move |_, alloc| {
        state_alloc.alloc_width.set(alloc.width() as f64);
        state_alloc.alloc_height.set(alloc.height() as f64);
    });

    wire_events(Wiring {
        window: &window,
        entry: &entry,
        drawing_area: &drawing_area,
        state: &state,
        receiver: &receiver,
        backend,
        quit_flag: &quit_flag,
    });

    window.show_all();
    entry.hide();
    ipc::send(&OutMessage::Ready);

    if backend == Backend::LayerShell {
        start_display_poll(&window, &state, &quit_flag);
    }

    let main_loop = glib::MainLoop::new(None, false);
    let ml = main_loop.clone();
    let _quit_watch = glib::timeout_add_local(Duration::from_millis(100), move || {
        if quit_flag.get() {
            ml.quit();
            return ControlFlow::Break;
        }
        ControlFlow::Continue
    });
    main_loop.run();
}

/// Builds the pill window rect and the work area of the monitor it lives on,
/// for the desktop to anchor the composer next to the real pill. Both rects
/// are reported in physical pixels: the desktop compares them against each
/// other and positions the composer via Tauri, which on X11 also works in
/// physical pixels. On X11 the pill has a true saved position, so both are
/// reported; on Wayland (where the layer-shell compositor owns placement and
/// there is no queryable absolute position) only the monitor is reported and
/// the rect is omitted.
pub(crate) fn pill_geometry(
    window: &gtk::Window,
    state: &PillState,
) -> (Option<Rect>, Option<Rect>) {
    let (w, h) = window.size();
    let scale = x11::x11_root_scale(window);
    let monitor = pill_monitor(window, state);
    let monitor_rect = monitor.map(|m| {
        let workarea = m.workarea();
        let monitor_scale = m.scale_factor() as f64;
        if state.backend.get() == Backend::X11 {
            // GTK 3 X11 uses a screen-wide scale shared by the toplevel and
            // every monitor rectangle, so all root-space conversions use it.
            logical_rect_to_physical(&workarea, scale)
        } else {
            // Wayland has no queryable root position. Keep its existing
            // compositor-layout origin and scaled extent for the monitor-only
            // geometry sent to the composer.
            Rect {
                x: workarea.x() as f64,
                y: workarea.y() as f64,
                width: workarea.width() as f64 * monitor_scale,
                height: workarea.height() as f64 * monitor_scale,
            }
        }
    });
    let rect = if state.has_saved_position.get() && state.backend.get() == Backend::X11 {
        Some(Rect {
            x: state.saved_x.get(),
            y: state.saved_y.get(),
            width: w as f64 * scale,
            height: h as f64 * scale,
        })
    } else {
        None
    };
    (rect, monitor_rect)
}

/// Converts GDK's application-pixel monitor rectangle into X11 root pixels.
pub(crate) fn logical_rect_to_physical(g: &gdk::Rectangle, scale: f64) -> Rect {
    Rect {
        x: g.x() as f64 * scale,
        y: g.y() as f64 * scale,
        width: g.width() as f64 * scale,
        height: g.height() as f64 * scale,
    }
}

/// The visible work areas of every connected monitor, each with its token, plus
/// the root scale their coordinates are in.
///
/// `None` when the display reports no monitors, which happens briefly while X
/// reconfigures outputs. A caller must read that as "nothing to act on", not as
/// "the pill's monitor was unplugged".
fn monitor_areas(
    display: &gdk::Display,
    scale: f64,
) -> Option<Vec<rust_pill_shared::edge::MonitorRect>> {
    // The rectangle and the token are both built by x11.rs, so the work area a
    // restore resolves against and the one a reconcile resolves against cannot
    // disagree about which monitor is which.
    let areas: Vec<_> = (0..display.n_monitors().max(0))
        .filter_map(|index| display.monitor(index))
        .map(|monitor| crate::x11::work_area_rect(&monitor, scale))
        .collect();
    (!areas.is_empty()).then_some(areas)
}

/// Reconcile the pill's toplevel against the monitors connected right now.
///
/// An X11 window does not get moved by the server when RandR changes, which
/// sounds like an advantage and is not: the window simply stays at its root
/// coordinates, so if the monitor that used to be there is gone the window is now
/// in dead space with nothing painted under it, still running and still
/// invisible. Then the next release settle stores that stranded origin.
///
/// So the same three steps run here as on the other platforms: hold saves until
/// the layout settles, resolve the position against the new layout, and adopt the
/// resolved origin so the stored record follows the pill.
fn reconcile_display_layout(window: &gtk::Window, state: &PillState) {
    if state.backend.get() != Backend::X11 {
        // Wayland has no queryable absolute position, so there is nothing to
        // reconcile: the compositor owns placement outright.
        return;
    }
    let now = drag_clock_now();
    state.save_guard.borrow_mut().layout_changed(now);
    if state.dragging.get() {
        // A drag held across the change cannot be saved when it ends: the frame
        // it would record is the one the X server left the window at.
        state
            .save_guard
            .borrow_mut()
            .layout_changed_during_drag(now);
    }
    let display = window.display();
    let scale = x11::x11_root_scale(window);
    let Some(areas) = monitor_areas(&display, scale) else {
        return;
    };
    let (alloc_w, alloc_h) = window.size();
    let window_w = alloc_w as f64 * scale;
    let window_h = alloc_h as f64 * scale;
    if window_w <= 0.0 || window_h <= 0.0 {
        return;
    }
    // The pill sits centred and bottom-anchored inside its transparent
    // toplevel, so the window origin has to be derived from where the pill is
    // drawn rather than read off the surface.
    let (offset_x, offset_y, pill_w, pill_h) =
        crate::draw::pill_position(state, state.draw_width.get(), state.draw_height.get());
    let (content_x, content_y) = state.content_offset();
    let footprint_offset = (
        (content_x + offset_x) * scale,
        (content_y + offset_y) * scale,
    );
    let footprint_size = (pill_w * scale, pill_h * scale);

    // Where the pill actually is. `saved_x`/`saved_y` are only the stored record,
    // and a reset or a forget deliberately leaves them holding the previous
    // position: reconciling against them would re-save a position the user just
    // cleared, on a display the window may no longer be on at all. The applied
    // origin is what the window was last moved to, so it is the honest answer --
    // including after `ForgetPosition`, which drops the record without moving the
    // window, and which must not be undone by the idle timer below re-deriving a
    // default corner from a latch that reads as "never placed".
    let (origin_x, origin_y) = state.x11_drag_applied.get();
    let (origin_x, origin_y) = (origin_x as f64, origin_y as f64);
    if is_unapplied(origin_x, origin_y) {
        // Nothing has been applied yet, so there is no window to reconcile.
        // The sentinel is the only negative value the latch can hold: testing
        // "both negative" treated a window parked on a monitor to the left of the
        // primary one, above it, or both, as never having been moved at all, so
        // unplugging that display left the pill with nowhere to reconcile from.
        return;
    }
    // Describe the display the pill is on: named when possible, else whichever
    // monitor contains the pill's centre, else the nearest one. Containment alone
    // fails at a shared edge and in the notch between two displays of different
    // heights, and that "nowhere" answer used to be replaced with a rectangle
    // built from the stale stored origin.
    let footprint_centre = (
        origin_x + footprint_offset.0 + footprint_size.0 / 2.0,
        origin_y + footprint_offset.1 + footprint_size.1 / 2.0,
    );
    let Some(parked) = rust_pill_shared::layout::describe_parked(
        &areas,
        (origin_x, origin_y),
        (window_w, window_h),
        footprint_centre,
        state.saved_display_id.get(),
    ) else {
        return;
    };

    let relocation = rust_pill_shared::layout::reconcile(
        parked,
        &areas,
        (window_w, window_h),
        |_work, _window| (footprint_offset, footprint_size),
        |work, _window| footprint_bounds_for(work, footprint_offset, footprint_size),
    );

    match relocation {
        rust_pill_shared::layout::Relocation::Keep => {}
        rust_pill_shared::layout::Relocation::Stranded => {
            // Nowhere to move it to. Leaving it keeps the stored position.
        }
        rust_pill_shared::layout::Relocation::Move { x, y } => {
            x11::move_toplevel(window, x.round() as i32, y.round() as i32);
            // Record the origin this move applied, before anything can return.
            //
            // The latch is what the rest of the file reads as "where the window
            // is": `x11_pill_center` builds the seam and crossing points from it,
            // the selector headroom reads its Y, and `publish_saved_geometry`
            // derives the monitor from it. `move_toplevel` only calls `XMoveWindow`
            // and cannot update it, so without this the pill keeps being described
            // at its pre-relocation origin and the record published below can name a
            // display the window has already left.
            state
                .x11_drag_applied
                .set((x.round() as i32, y.round() as i32));
            // A forget or a reset leaves the pill deliberately unsaved: the move
            // still has to happen, but it must not write the row back.
            if !state.has_saved_position.get() {
                return;
            }
            state.saved_x.set(x.round());
            state.saved_y.set(y.round());
            state.has_saved_position.set(true);
            // Nearest when containment fails, so a pill parked at a shared edge
            // still records the display it is meant to be on instead of losing the
            // identity and downgrading every later save to geometry matching.
            state
                .saved_display_id
                .set(rust_pill_shared::layout::display_id_of(
                    &areas,
                    (x.round(), y.round()),
                    (
                        x.round() + footprint_offset.0 + footprint_size.0 / 2.0,
                        y.round() + footprint_offset.1 + footprint_size.1 / 2.0,
                    ),
                ));
            // The move was the pill's, not a drag, so it does not go through the
            // save guard: this position is the only place the pill can be, and
            // storing it is what stops the next launch restoring a stranded
            // origin.
            publish_saved_geometry(window, state);
        }
    }
}

/// Clamp bounds for the pill's visible footprint inside a work area.
fn footprint_bounds_for(
    work: rust_pill_shared::edge::MonitorRect,
    offset: (f64, f64),
    size: (f64, f64),
) -> rust_pill_shared::drag::DragBounds {
    rust_pill_shared::restore::footprint_bounds(work, offset, size)
}

/// Reconcile if the display arrangement changed and no event said so.
fn poll_display_layout(window: &gtk::Window, state: &PillState) {
    if state.backend.get() != Backend::X11 {
        return;
    }
    let now = drag_clock_now();
    let display = window.display();
    let scale = x11::x11_root_scale(window);
    let Some(areas) = monitor_areas(&display, scale) else {
        return;
    };
    let outcome = state
        .layout_poll
        .borrow_mut()
        .observe(now, rust_pill_shared::layout::layout_signature(&areas));
    if outcome == rust_pill_shared::layout::PollOutcome::Changed {
        reconcile_display_layout(window, state);
    }
}

/// Ends the gesture and tears down any active drag.
///
/// Clears the hover pin and gesture flags. If a drag was in progress, the
/// release settle starts; the frame tick persists the settled position, so a
/// missed release caught by the frame-tick backstop does not strand the pill
/// at its old position.
fn clear_pointer_pin(state: &PillState, window: &gtk::Window) {
    if state.dragging.get() {
        // Flush the final held sample through the backend before ending. This
        // also arms sub-frame drags and re-grabs that never reached a tick.
        let now = drag_clock_now();
        tick_drag_frame(window, state, state.backend.get(), now, 0.0);
        state.drag_motion.borrow_mut().end_drag(now);
    }
    state.dragging.set(false);
    state.long_press_active.set(false);
    state.long_press_elapsed.set(0.0);
    state.pointer_down.set(false);
}

thread_local! {
    /// The pill's entry widget, for the code paths that must empty it without holding a
    /// clone. Same shape as the Windows pill's `EDIT_HWND`, and for the same reason: the
    /// mirror (`state.entry_text`) is not the widget, and clearing one does not clear the
    /// other.
    static ENTRY: std::cell::RefCell<Option<gtk::Entry>> =
        const { std::cell::RefCell::new(None) };
}

/// Empty the entry widget, if there is one.
///
/// Does nothing when the widget is already empty, and does not touch `state.entry_text`:
/// that is the mirror's own business, and the caller has just cleared it.
pub(crate) fn clear_entry() {
    ENTRY.with(|slot| {
        if let Some(entry) = slot.borrow().as_ref() {
            entry.set_text("");
        }
    });
}

thread_local! {
    static LAST_FRAME: Cell<Option<Instant>> = const { Cell::new(None) };
}

/// Measured frame step shared by the transition springs and the drag
/// motion, clamped like the other pills so a stall cannot explode a spring.
fn frame_dt() -> f64 {
    let now = Instant::now();
    LAST_FRAME.with(|c| {
        let prev = c.get();
        c.set(Some(now));
        match prev {
            Some(p) => now.duration_since(p).as_secs_f64().clamp(0.001, 0.05),
            None => 1.0 / 60.0,
        }
    })
}

/// True when the desktop asks GTK clients not to animate.
pub(crate) fn reduced_motion() -> bool {
    !gtk::Settings::default()
        .map(|s| s.property::<bool>("gtk-enable-animations"))
        .unwrap_or(true)
}

/// Advances one frame of drag motion on the frame clock. X11 samples the root
/// pointer and moves the toplevel; the Wayland backends run the same
/// controller in window-relative offset space (the compositor owns the
/// toplevel there).
fn tick_drag_frame(window: &gtk::Window, state: &PillState, backend: Backend, now: f64, dt: f64) {
    let dragging = state.dragging.get();
    let settling = state.drag_motion.borrow().is_settling();
    if !dragging && !settling {
        return;
    }
    match backend {
        Backend::X11 => x11::tick_drag_frame(window, state, now, dt),
        Backend::LayerShell | Backend::PlainWayland => {
            tick_wayland_drag_frame(window, state, now, dt)
        }
    }
}

/// Whether the applied-origin latch has never been set.
///
/// X11 virtual screen coordinates are signed, and a second monitor placed to the
/// left of or above the primary one owns negative coordinates. The latch therefore
/// cannot use "negative" to mean unset; it uses one sentinel value, set at startup.
fn is_unapplied(x: f64, y: f64) -> bool {
    x == UNAPPLIED_ORIGIN as f64 && y == UNAPPLIED_ORIGIN as f64
}

/// Publish this window as the saved position.
///
/// Two callers reach it and they must not drift: the drop, and the reconcile that
/// moves a stranded pill. X11 has its own applier because the applied origin is
/// authoritative there, so this is the Wayland half of the same decision.
fn publish_saved_geometry(window: &gtk::Window, state: &PillState) {
    state.has_saved_position.set(true);
    let (rect, monitor) = pill_geometry(window, state);
    ipc::send(&OutMessage::PositionChanged {
        report: rust_pill_shared::restore::PositionReport::new(
            true,
            rect,
            monitor,
            state.saved_display_id.get(),
        ),
    });
}

fn persist_drag_position(window: &gtk::Window, state: &PillState) {
    if state.backend.get() == Backend::X11 {
        let (x, y) = state.x11_drag_applied.get();
        x11::persist_window_position(window, state, x as f64, y as f64);
        return;
    }
    publish_saved_geometry(window, state);
}

/// Retry a save the guard refused, without re-recording the drop.
///
/// `persist_drag_position` records the drop, and that record is what starts the
/// drag hold. Calling it every frame would restart the hold every frame, so the
/// drop it is meant to protect would never be written.
fn retry_drag_save(window: &gtk::Window, state: &PillState) {
    if state.backend.get() == Backend::X11 {
        let (x, y) = state.x11_drag_applied.get();
        x11::write_window_position(window, state, x as f64, y as f64, drag_clock_now());
        return;
    }
    // Wayland and LayerShell placements are applied by the compositor, so the
    // guard never holds a save back there and nothing can be owed.
    publish_saved_geometry(window, state);
}

fn begin_wayland_drag(
    motion: &mut rust_pill_shared::drag::DragController,
    press: (f64, f64),
    offset: (f64, f64),
    now: f64,
) {
    motion.begin_drag(
        press.0 - offset.0,
        press.1 - offset.1,
        offset.0,
        offset.1,
        now,
    );
}

/// One frame of Wayland/LayerShell drag motion: the newest motion sample runs
/// through the shared controller and its output becomes the pill draw offset.
/// The bounds stay wide open. Without absolute coordinates there is no work
/// area to clamp to, matching the unclamped event-driven math this replaces.
fn tick_wayland_drag_frame(window: &gtk::Window, state: &PillState, now: f64, dt: f64) {
    let dragging = state.dragging.get();
    let mut motion = state.drag_motion.borrow_mut();
    if dragging && motion.phase() != rust_pill_shared::drag::DragPhase::Held {
        // First frame, or a re-grab while the previous release still settles:
        // Preserve the drawn origin and latch the press relative to it.
        // Re-arming also cancels the running settle.
        begin_wayland_drag(
            &mut motion,
            (state.drag_cursor_x.get(), state.drag_cursor_y.get()),
            (
                state.drag_draw_offset_x.get(),
                state.drag_draw_offset_y.get(),
            ),
            now,
        );
    }
    let was_settling = motion.is_settling();
    let output = motion.advance(&rust_pill_shared::drag::DragFrame {
        pointer_x: state.drag_last_x.get(),
        pointer_y: state.drag_last_y.get(),
        now,
        dt,
        bounds: WAYLAND_DRAG_BOUNDS,
        // No work area on this backend: the compositor owns placement, so the
        // ease stays off and the wide-open clamp above stands.
        edge_work: None,
        held: dragging,
        reduced_motion: reduced_motion(),
    });
    drop(motion);
    state.drag_draw_offset_x.set(output.x);
    state.drag_draw_offset_y.set(output.y);
    if was_settling && output.settled {
        persist_drag_position(window, state);
    }
}

/// Work-area monitor: prefer the visible X11 pill center, since a large
/// transparent host may still belong to a different monitor. Other backends
/// and lookup gaps retain window, saved-center, primary, first fallbacks.
fn pill_monitor(window: &gtk::Window, state: &PillState) -> Option<gdk::Monitor> {
    if let Some((monitor, _, _)) = x11_pill_monitor(window, state) {
        return Some(monitor);
    }
    let display = window.display();
    if let Some(gdk_win) = window.window() {
        if let Some(monitor) = display.monitor_at_window(&gdk_win) {
            return Some(monitor);
        }
    }
    if state.backend.get() == Backend::X11 {
        let (w, h) = window.size();
        let scale = x11::x11_root_scale(window);
        return x11::monitor_at_physical_point(
            &display,
            state.saved_x.get() + (w as f64 / 2.0) * scale,
            state.saved_y.get() + (h as f64 / 2.0) * scale,
            scale,
        )
        .or_else(|| display.primary_monitor())
        .or_else(|| display.monitor(0));
    }
    display.primary_monitor().or_else(|| display.monitor(0))
}

fn selector_visible_headroom(local_top: f64, surface_y: f64, work_y: f64, scale: f64) -> f64 {
    local_top.min(local_top + (surface_y - work_y) / scale)
}

/// Headroom is limited by both the drawable surface and the monitor work area.
/// Plain Wayland has no absolute origin, so it uses its drawable surface.
fn selector_headroom(window: &gtk::Window, state: &PillState) -> f64 {
    let (_, oy) = state.content_offset();
    let (_, pill_y, ..) =
        draw::pill_position(state, state.draw_width.get(), state.draw_height.get());
    let local_top = oy + pill_y;
    if state.backend.get() == Backend::PlainWayland {
        return local_top;
    }
    let Some(monitor) = pill_monitor(window, state) else {
        return local_top;
    };
    let scale = if state.backend.get() == Backend::X11 {
        x11::x11_root_scale(window)
    } else {
        monitor.scale_factor() as f64
    };
    if !scale.is_finite() || scale <= 0.0 {
        return local_top;
    }
    let work = logical_rect_to_physical(&monitor.workarea(), scale);
    let surface_y = if state.backend.get() == Backend::X11 {
        let (applied_x, applied_y) = state.x11_drag_applied.get();
        if is_unapplied(applied_x as f64, applied_y as f64) {
            return local_top;
        }
        let y = applied_y;
        y as f64
    } else {
        let geometry = logical_rect_to_physical(&monitor.geometry(), scale);
        geometry.y + geometry.height - (window.allocated_height() + MARGIN_BOTTOM) as f64 * scale
    };
    selector_visible_headroom(local_top, surface_y, work.y, scale)
}

/// Advances the shared selector-placement controller once per frame from the
/// live headroom, so the selector drops below the pill exactly when the strip
/// above no longer fits it. Draw and the input region read the blend back
/// every frame, so both track the animation.
fn tick_selector_placement(window: &gtk::Window, state: &PillState, dt: f64) {
    let space_above = selector_headroom(window, state);
    state
        .selector_placement
        .borrow_mut()
        .advance(&rust_pill_shared::placement::PlacementFrame {
            space_above,
            tooltip_h: TOOLTIP_HEIGHT,
            stiffness: SPRING_STIFFNESS,
            dt,
            reduced_motion: reduced_motion(),
        });
}

/// Center coordinates in the supplied X11 scale space.
#[derive(Clone, Copy)]
pub(crate) struct X11PillCenter {
    /// Absolute center in root pixels when the window origin is available.
    pub(crate) root: Option<(f64, f64)>,
    /// Center offset from the toplevel origin, in physical pixels.
    pub(crate) offset: (f64, f64),
}

/// Compute the rendered pill center once for all X11 seam calculations.
///
/// The local `offset` is scaled into the supplied scale space; `root` is a
/// true root-pixel point only when `scale` is the window surface scale. GTK 3
/// X11 uses one screen-wide factor for every monitor rectangle, so all live
/// callers must pass that same surface scale (never an anchor-monitor scale).
/// The toplevel origin is already in root pixels.
pub(crate) fn x11_pill_center(state: &PillState, scale: f64) -> Option<X11PillCenter> {
    if state.backend.get() != Backend::X11 || !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let (ox, oy) = state.content_offset();
    let (px, py, pw, ph) =
        draw::pill_position(state, state.draw_width.get(), state.draw_height.get());
    let offset = ((ox + px + pw / 2.0) * scale, (oy + py + ph / 2.0) * scale);
    let (window_x, window_y) = state.x11_drag_applied.get();
    let root = if is_unapplied(window_x as f64, window_y as f64) {
        None
    } else {
        Some((window_x as f64 + offset.0, window_y as f64 + offset.1))
    };
    Some(X11PillCenter { root, offset })
}

/// Resolve the monitor and rendered pill center from the applied X11 origin.
/// The stable token of the monitor the visible pill is on, if it can be named.
///
/// This is the same resolution [`x11_pill_monitor`] uses for reconciliation, so a
/// published position and the work area published beside it cannot disagree about
/// which display they describe.
pub(crate) fn pill_monitor_id(window: &gtk::Window, state: &PillState) -> Option<u64> {
    let (monitor, ..) = x11_pill_monitor(window, state)?;
    x11::monitor_display_id(&monitor)
}

fn x11_pill_monitor(window: &gtk::Window, state: &PillState) -> Option<(gdk::Monitor, f64, f64)> {
    if state.backend.get() != Backend::X11 {
        return None;
    }
    let scale = x11::x11_root_scale(window);
    let center = x11_pill_center(state, scale)?;
    let (cx, cy) = center.root?;
    let monitor = x11::monitor_at_physical_point(&window.display(), cx, cy, scale)?;
    Some((monitor, cx, cy))
}

fn crossing_monitor(window: &gtk::Window, state: &PillState) -> (f64, f64, f64, f64, f64, f64) {
    let unknown = (f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN);
    let Some((monitor, cx, cy)) = x11_pill_monitor(window, state) else {
        return unknown;
    };
    let scale = x11::x11_root_scale(window);
    if !scale.is_finite() || scale <= 0.0 {
        return unknown;
    }
    let g = logical_rect_to_physical(&monitor.geometry(), scale);
    (g.x, g.y, g.width, g.height, cx, cy)
}

/// Advances the shared crossing-deformation controller once per frame from
/// the monitor under the pill center. A reduced-motion trigger arms the
/// border flash instead of deforming.
fn tick_crossing_frame(window: &gtk::Window, state: &PillState, dt: f64) {
    let (mx, my, mw, mh, cx, cy) = crossing_monitor(window, state);
    let rm = reduced_motion();
    let out = state
        .crossing
        .borrow_mut()
        .advance(&rust_pill_shared::deform::CrossingFrame {
            monitor_x: mx,
            monitor_y: my,
            monitor_width: mw,
            monitor_height: mh,
            pill_cx: cx,
            pill_cy: cy,
            now: drag_clock_now(),
            dt,
            stiffness: SPRING_STIFFNESS,
            reduced_motion: rm,
        });
    if out.triggered && rm {
        state.flash_blue_active.set(true);
        state.flash_blue_elapsed.set(0.0);
    }
}

/// Advances hover intent one frame from the latest probe and reports edges.
/// The hover IPC fires only on entered/exited, so every platform reports each
/// transition exactly once.
fn tick_hover_frame(state: &PillState) {
    let output = state
        .hover_intent
        .borrow_mut()
        .advance(&rust_pill_shared::hover::HoverFrame {
            probed: state.hover_probed.get(),
            pointer_x: state.hover_probe_x.get(),
            pointer_y: state.hover_probe_y.get(),
            now: drag_clock_now(),
            pointer_down: state.pointer_down.get(),
        });
    state.hovered.set(output.hovered);
    if output.entered || output.exited {
        ipc::send(&OutMessage::Hover {
            hovered: output.hovered,
        });
    }
}

/// Frame-level backstop for a missed button release.
///
/// A release event can be lost outright — a grab stolen by another client, or
/// the session locking. Polling the pointer's live modifier mask each frame
/// means a stationary missed release still self-heals; relying on the motion
/// handler alone would leave the pill pinned open until the pointer moved.
fn release_pointer_if_button_up(window: &gtk::Window, state: &PillState) {
    if !state.pointer_down.get() {
        return;
    }
    let Some(gdk_window) = window.window() else {
        return;
    };
    let Some(pointer) = gdk::Display::default()
        .and_then(|d| d.default_seat())
        .and_then(|s| s.pointer())
    else {
        return;
    };
    let (.., mask) = gdk_window.device_position(&pointer);
    if !mask.contains(gdk::ModifierType::BUTTON1_MASK) {
        clear_pointer_pin(state, window);
        // Teardown can flush a final drag move. Query again afterwards so the
        // coordinates belong to the new window origin, not the previous frame.
        let (_, x, y, _) = gdk_window.device_position(&pointer);
        state
            .hover_probed
            .set(input::is_over_pill_area(state, x as f64, y as f64));
        state.hover_probe_x.set(x as f64);
        state.hover_probe_y.set(y as f64);
    }
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

fn tick(state: &PillState, dt: f64) {
    tick_long_press(state, dt);
    let phase = state.phase.get();
    let is_active = phase != Phase::Idle;
    let is_loading = phase == Phase::Loading;
    let hovered = state.hovered.get();

    tick_audio_levels(state, phase);

    // Pill expand/collapse — PILL_EXPAND_STIFFNESS is snappier than the
    // generic 200 so the primary affordance feels instant. The spring
    // still settles without overshoot (critically damped).
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
        rust_pill_shared::PILL_EXPAND_STIFFNESS,
        dt,
    );

    // Loading offset
    if is_loading {
        let next_offset = rust_pill_shared::advance_loading_offset(
            state.loading_offset.get(),
            LOADING_SPEED,
            dt,
            reduced_motion(),
        );
        state.loading_offset.set(next_offset);
    }

    // Tooltip animation (spring)
    // Hover-revealed in every phase except Paused, so the chevrons stay
    // clickable mid-take. A take that starts under a parked pointer fades
    // the tooltip until the pointer leaves the pill and comes back;
    // rust_pill_shared owns the rule, every port agrees.
    let tooltip_target = rust_pill_shared::style_tooltip_target(
        &state.style_tooltip_gate,
        state.assistant_active.get(),
        state.style_count.get(),
        matches!(phase, Phase::Paused),
        hovered,
        state.expand_t.get(),
    );
    rust_pill_shared::spring::spring_01(
        &state.tooltip_t,
        &state.tooltip_velocity,
        tooltip_target,
        SPRING_STIFFNESS,
        dt,
    );

    // Panel open/close (spring)
    // A pending review holds the panel open on its own: the transcript must
    // stay visible until the user answers it.
    let panel_target = if state.owns_panel() { 1.0 } else { 0.0 };
    rust_pill_shared::spring::spring_01(
        &state.panel_open_t,
        &state.panel_open_velocity,
        panel_target,
        SPRING_STIFFNESS,
        dt,
    );

    // Keyboard button (spring)
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

    // Animate content dimensions toward target mode
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

    // Shimmer phase for thinking animation
    state
        .shimmer_phase
        .set((state.shimmer_phase.get() + SHIMMER_SPEED) % 1.0);

    // Fireworks
    tick_fireworks(state);

    // Flame
    tick_flame(state);

    // Flash blue border
    tick_flash_blue(state);

    // Broadcast transcript
    tick_transcript(state);

    tick_flash(state, tooltip_target > 0.5, dt);

    // Long-press cancel flash timer
    if state.cancel_flash.get() > 0.0 {
        let remaining = state.cancel_flash.get() - dt;
        state.cancel_flash.set(remaining.max(0.0));
    }

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

    let drag_target = if state.dragging.get() || state.long_press_active.get() {
        1.0
    } else {
        0.0
    };
    rust_pill_shared::spring::spring_01(
        &state.drag_label_t,
        &state.drag_label_velocity,
        drag_target,
        rust_pill_shared::LABEL_SPRING_STIFFNESS,
        dt,
    );

    tick_ring(state, dt);

    // Auto-scroll to bottom when new content arrives
    if state.should_stick.get() && state.assistant_active.get() && !state.assistant_compact.get() {
        let max_scroll = (state.content_height.get() - state.viewport_height.get()).max(0.0);
        state.scroll_offset.set(max_scroll);
    }
}

/// Audio-level meters and the waveform phase they drive: pending input levels
/// fold into the target level, decay toward silence when idle, and advance the
/// wave animation at a level-dependent rate.
fn tick_audio_levels(state: &PillState, phase: Phase) {
    let is_recording = phase == Phase::Recording;
    let is_loading = phase == Phase::Loading;

    if is_recording {
        let levels = std::mem::take(&mut *state.pending_levels.borrow_mut());
        if !levels.is_empty() {
            let sum: f64 = levels.iter().map(|v| *v as f64).sum();
            let avg = sum / levels.len() as f64;
            let peak = levels.iter().copied().fold(0.0_f32, f32::max) as f64;
            let combined = (avg * 0.9 + peak * 0.85).min(1.0);
            let boosted = (combined.sqrt() * 1.35).min(1.0);
            let target = state.target_level.get();
            state
                .target_level
                .set((target * 0.25 + boosted * 0.75).min(1.0));
        }
    } else {
        // Levels queued while not recording are stale. Without this they stay in
        // the mailbox until the next recording starts and are then folded into
        // that recording's first frame, so a burst of audio captured while the
        // pill sat idle or loading moves the meter before any of it was spoken.
        // Same guard as `rust_windows_pill::pill`.
        state.pending_levels.borrow_mut().clear();
        if is_loading {
            let target = state.target_level.get();
            state.target_level.set(target.max(PROCESSING_BASE_LEVEL));
        } else {
            state.target_level.set(0.0);
            state.current_level.set(state.current_level.get() * 0.4);
            if state.current_level.get() < 0.0002 {
                state.current_level.set(0.0);
            }
        }
    }

    let current = state.current_level.get();
    let target = state.target_level.get();
    let new_current = current + (target - current) * LEVEL_SMOOTHING;
    state.current_level.set(if new_current < 0.0002 {
        0.0
    } else {
        new_current
    });

    let decayed = target * TARGET_DECAY_PER_FRAME;
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
    let advance = WAVE_BASE_PHASE_STEP + WAVE_PHASE_GAIN * effective_level;
    state
        .wave_phase
        .set((state.wave_phase.get() + advance) % TAU);
}

/// Flash banner (native pill toast) expiry and fade spring. An action-less
/// banner yields the strip above the pill to a revealed style tooltip, so the
/// banner and the selector never sit on top of each other.
fn tick_flash(state: &PillState, tooltip_revealed: bool, dt: f64) {
    if state.flash_visible.get() {
        let remaining = state.flash_timer.get() - dt;
        if remaining <= 0.0 {
            clear_flash(state);
        } else {
            state.flash_timer.set(remaining);
        }
    }
    let flash_target = rust_pill_shared::flash_banner_target(
        state.flash_visible.get(),
        state.flash_action.borrow().is_some() || state.flash_reject_action.borrow().is_some(),
        tooltip_revealed,
    );
    rust_pill_shared::spring::spring_01(
        &state.flash_t,
        &state.flash_velocity,
        flash_target,
        SPRING_STIFFNESS,
        dt,
    );
}

fn tick_long_press(state: &PillState, dt: f64) {
    if !state.long_press_active.get() {
        return;
    }

    if state.phase.get() != Phase::Idle || state.assistant_active.get() {
        state.long_press_active.set(false);
        state.long_press_elapsed.set(0.0);
        return;
    }

    let elapsed = state.long_press_elapsed.get() + dt;
    state.long_press_elapsed.set(elapsed);
    if elapsed >= LONG_PRESS_DURATION {
        state.long_press_active.set(false);
        state.long_press_elapsed.set(0.0);
        state.dragging.set(true);
        state.x11_release_persisted.set(false);
        // A save still owed from the previous gesture belongs to a drop the user
        // has already made. Left armed, the frame loop's retry would fire during
        // this drag and store the window while it is moving -- a position nobody
        // chose. The owed drop was for a gesture that is over, and this one will
        // produce its own.
        state.drag_save_due.set(None);
        // Every drag starts by clearing the "a layout change interrupted this"
        // latch. Without this the latch set during one interrupted drag outlived
        // it and refused every later save, so a pill that once had a display pulled
        // out from under it silently stopped remembering its position at all.
        state.save_guard.borrow_mut().drag_started();
        // Confirm the arm with the expanding halo, on the exact frame it fires.
        state.arm_pulse.set(rust_pill_shared::pulse_armed());
    }
}

/// Advances the long-press ring for one frame.
///
/// All the policy lives in `rust_pill_shared::advance_ring` so the three
/// platform renderers cannot drift apart; this only marshals `Cell` state in
/// and out of the shared struct.
fn tick_ring(state: &PillState, dt: f64) {
    let held = state.dragging.get()
        || (state.long_press_active.get()
            && state.long_press_elapsed.get() > LONG_PRESS_HOLD_DELAY);

    let mut anim = rust_pill_shared::RingAnim {
        alpha: state.ring_alpha.get(),
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
}

fn tick_fireworks(state: &PillState) {
    if !state.fireworks_active.get() {
        return;
    }

    let dt = SPRING_DT;
    let elapsed = state.fireworks_elapsed.get() + dt;
    state.fireworks_elapsed.set(elapsed);

    let ww = state.draw_width.get();
    let wh = state.draw_height.get();
    let (_, pill_y, ..) = draw::pill_position(state, ww, wh);
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

fn tick_flame(state: &PillState) {
    if !state.flame_active.get() {
        return;
    }
    let dt = SPRING_DT;
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

            let h_t = 1.0 - (t - 0.5).abs() * 2.0;
            let w_t = h_t;
            let phase = t * std::f64::consts::PI * 2.0;
            let speed_var = (i as f64 * 2.3 + 1.0).sin() * 0.5 + 0.5;

            tongues.push(FlameTongue {
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

fn tick_flash_blue(state: &PillState) {
    if !state.flash_blue_active.get() {
        return;
    }
    let dt = SPRING_DT;
    let elapsed = state.flash_blue_elapsed.get() + dt;
    if elapsed >= FLASH_BLUE_DURATION {
        state.flash_blue_active.set(false);
        state.flash_blue_elapsed.set(0.0);
    } else {
        state.flash_blue_elapsed.set(elapsed);
    }
}

fn tick_transcript(state: &PillState) {
    if !state.transcript_has_message.get() && state.transcript_opacity.get() < 0.001 {
        return;
    }
    let dt = SPRING_DT;
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

#[cfg(test)]
mod geometry_tests {
    use super::*;

    /// Tolerance for float assertions — the repo's usual test epsilon (see
    /// rust_pill_shared). The conversions here produce integral pixel values,
    /// but comparing approximately keeps the tests robust if intermediate
    /// math or types ever change.
    const EPSILON: f64 = 1e-6;

    fn assert_rect_close(actual: &Rect, expected: &Rect) {
        let fields = [
            ("x", actual.x, expected.x),
            ("y", actual.y, expected.y),
            ("width", actual.width, expected.width),
            ("height", actual.height, expected.height),
        ];
        for (name, a, e) in fields {
            assert!(
                (a - e).abs() < EPSILON,
                "{name}: expected ~{e}, got {a} (rect {actual:?} vs {expected:?})"
            );
        }
    }

    #[test]
    fn wayland_regrab_keeps_the_draw_offset_and_applies_the_last_sample() {
        use rust_pill_shared::drag::{DragController, DragFrame};
        for offset in [(0.0, 0.0), (120.0, -35.0), (-55.0, 70.0)] {
            let mut motion = DragController::new();
            begin_wayland_drag(&mut motion, (200.0, 100.0), offset, 0.0);
            let mut frame = DragFrame {
                pointer_x: 200.0,
                pointer_y: 100.0,
                now: 0.01,
                dt: 0.0,
                bounds: WAYLAND_DRAG_BOUNDS,
                edge_work: None,
                held: true,
                reduced_motion: true,
            };
            let unchanged = motion.advance(&frame);
            assert_eq!((unchanged.x, unchanged.y), offset);
            frame.pointer_x += 18.0;
            frame.pointer_y += 14.0;
            let tracked = motion.advance(&frame);
            assert_eq!((tracked.x, tracked.y), (offset.0 + 18.0, offset.1 + 14.0));
            motion.end_drag(0.01);
            assert!(motion.is_settling());
            begin_wayland_drag(&mut motion, (218.0, 114.0), (tracked.x, tracked.y), 0.02);
            let regrabbed = motion.advance(&frame);
            assert_eq!((regrabbed.x, regrabbed.y), (tracked.x, tracked.y));
        }
    }

    #[test]
    fn selector_headroom_respects_surface_and_scaled_monitor_edges() {
        assert_eq!(selector_visible_headroom(24.0, 500.0, 0.0, 1.0), 24.0);
        assert_eq!(selector_visible_headroom(80.0, -120.0, 0.0, 2.0), 20.0);
        assert_eq!(selector_visible_headroom(80.0, -1120.0, -1000.0, 2.0), 20.0);
    }

    #[test]
    fn logical_rect_scales_monitor_origin_and_extent_into_root_pixels() {
        let rect = logical_rect_to_physical(&gdk::Rectangle::new(100, 50, 2000, 1000), 2.0);
        assert_rect_close(
            &rect,
            &Rect {
                x: 200.0,
                y: 100.0,
                width: 4000.0,
                height: 2000.0,
            },
        );
        let left_monitor =
            logical_rect_to_physical(&gdk::Rectangle::new(-1920, 0, 1920, 1080), 2.0);
        assert_eq!(left_monitor.x, -3840.0);
        assert_eq!(left_monitor.width, 3840.0);
    }

    #[test]
    fn logical_rect_scale_one_is_unchanged() {
        let rect = logical_rect_to_physical(&gdk::Rectangle::new(-1920, 0, 1920, 1080), 1.0);
        assert_rect_close(
            &rect,
            &Rect {
                x: -1920.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
        );
    }

    #[test]
    fn pill_rect_and_workarea_share_physical_space() {
        // Regression guard for the split coordinate spaces: a 200-logical-px
        // pill parked at physical x=3800 on a 2000-logical-wide (4000 physical)
        // work area at 2x must overflow the monitor in *both* spaces alike.
        let scale = 2.0;
        let monitor = logical_rect_to_physical(&gdk::Rectangle::new(0, 0, 2000, 1000), scale);
        let pill = Rect {
            x: 3800.0,
            y: 0.0,
            width: 200.0 * scale,
            height: 80.0 * scale,
        };
        // With the old unscaled workarea (2000 wide) this comparison used the
        // wrong space at any scale != 1. Inequality assertions, so no epsilon
        // needed here.
        assert!(pill.x + pill.width > monitor.x + monitor.width);
        assert!(pill.x < monitor.x + monitor.width);
    }
}
