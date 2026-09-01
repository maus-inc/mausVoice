use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use gtk::gdk;
use gtk::glib::{self, ControlFlow};
use gtk::prelude::*;
use gtk_layer_shell::LayerShell;

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

/// Runs the GTK pill: picks the display backend, creates the frameless
/// window, and drives the message/event loop until a quit message arrives.
pub fn run(receiver: Receiver<InMessage>) {
    // Phase message sequence guard: see ipc::InMessage::Phase.
    thread_local! {
        static LAST_PHASE_SEQ: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    }
    let backend = if gtk_layer_shell::is_supported() {
        Backend::LayerShell
    } else {
        let display = gdk::Display::default().expect("display");
        if display.type_().name() == "GdkX11Display" {
            Backend::X11
        } else {
            Backend::PlainWayland
        }
    };

    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    if backend != Backend::PlainWayland {
        window.set_default_size(WINDOW_W_TYPING, WINDOW_H_TYPING);
    }
    window.set_decorated(false);
    window.set_app_paintable(true);

    {
        let screen: gdk::Screen = gtk::prelude::WidgetExt::screen(&window).expect("screen");
        if let Some(visual) = screen.rgba_visual() {
            window.set_visual(Some(&visual));
        }
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
        drawing_area.set_size_request(WINDOW_W_TYPING, WINDOW_H_TYPING);
    }
    overlay_widget.add(&drawing_area);

    let entry = gtk::Entry::new();
    entry.set_placeholder_text(Some("Type a message..."));
    entry.set_has_frame(false);
    entry.set_halign(gtk::Align::Fill);
    entry.set_valign(gtk::Align::End);
    entry.set_visible(false);
    entry.set_no_show_all(true);
    overlay_widget.add_overlay(&entry);

    window.add(&overlay_widget);

    let state = Rc::new(PillState {
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
        has_saved_position: Cell::new(false),
        reset_strategy: Cell::new(ResetStrategy::Current),
        saved_x: Cell::new(0.0),
        saved_y: Cell::new(0.0),
        x11_release_persisted: Cell::new(false),
        drag_draw_offset_x: Cell::new(0.0),
        drag_draw_offset_y: Cell::new(0.0),
        cancel_flash: Cell::new(0.0),
        alloc_width: Cell::new(0.0),
        alloc_height: Cell::new(0.0),
        backend: Cell::new(backend),
    });

    if backend == Backend::X11 {
        let state_realize = state.clone();
        window.connect_realize(move |window| x11::setup_x11_window(window, state_realize.clone()));
    }

    if backend == Backend::PlainWayland {
        let state_alloc = state.clone();
        window.connect_size_allocate(move |_, alloc| {
            state_alloc.alloc_width.set(alloc.width() as f64);
            state_alloc.alloc_height.set(alloc.height() as f64);
        });
    }

    window.add_events(
        gdk::EventMask::ENTER_NOTIFY_MASK
            | gdk::EventMask::LEAVE_NOTIFY_MASK
            | gdk::EventMask::POINTER_MOTION_MASK
            | gdk::EventMask::BUTTON_PRESS_MASK
            | gdk::EventMask::BUTTON_RELEASE_MASK
            | gdk::EventMask::FOCUS_CHANGE_MASK
            | gdk::EventMask::SCROLL_MASK
            | gdk::EventMask::SMOOTH_SCROLL_MASK,
    );

    let state_enter = state.clone();
    window.connect_enter_notify_event(move |win, event| {
        let (mx, my) = event.position();
        let is_over_pill = input::is_over_pill_area(&state_enter, mx, my);
        if is_over_pill {
            state_enter.hovered.set(true);
            ipc::send(&OutMessage::Hover { hovered: true });
        }
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
        if state_motion.pointer_down.get()
            && !event.state().contains(gdk::ModifierType::BUTTON1_MASK)
        {
            clear_pointer_pin(&state_motion, &win_motion);
        }

        // A held button owns the pointer, so the hit test cannot be trusted:
        // dragging moves the window and easily outruns it.
        let is_over_pill = rust_pill_shared::resolve_hover(
            input::is_over_pill_area(&state_motion, mx, my),
            state_motion.pointer_down.get(),
        );
        let was_hovered = state_motion.hovered.get();
        if is_over_pill != was_hovered {
            state_motion.hovered.set(is_over_pill);
            ipc::send(&OutMessage::Hover { hovered: is_over_pill });
        }

        if state_motion.long_press_active.get() {
            let start_x = state_motion.long_press_start_x.get();
            let start_y = state_motion.long_press_start_y.get();
            let dx = mx - start_x;
            let dy = my - start_y;
            if (dx * dx + dy * dy) > LONG_PRESS_MOVE_THRESHOLD * LONG_PRESS_MOVE_THRESHOLD {
                state_motion.long_press_active.set(false);
                state_motion.long_press_elapsed.set(0.0);
                state_motion.drag_cancelled.set(true);
                state_motion.cancel_flash.set(CANCEL_FLASH_DURATION);
            }
        }

        // While dragging, translate the Wayland draw position to follow the
        // pointer (X11 handles its own toplevel movement elsewhere).
        if state_motion.dragging.get() && state_motion.backend.get() != Backend::X11 {
            let grab_x = state_motion.drag_cursor_x.get();
            let grab_y = state_motion.drag_cursor_y.get();
            state_motion.drag_draw_offset_x.set(mx - grab_x);
            state_motion.drag_draw_offset_y.set(my - grab_y);
        }

        glib::Propagation::Proceed
    });

    let state_leave = state.clone();
    window.connect_leave_notify_event(move |_, event| {
        // Dragging the pill drags its window out from under the pointer, so
        // mid-gesture crossings are an artefact, not the user leaving.
        if event.mode() == gdk::CrossingMode::Normal && !state_leave.pointer_down.get() {
            state_leave.hovered.set(false);
            ipc::send(&OutMessage::Hover { hovered: false });
        }
        glib::Propagation::Proceed
    });

    let state_press = state.clone();
    let entry_press = entry.clone();
    let win_press = window.clone();
    let backend_press = backend;
    window.connect_button_press_event(move |_, event| {
        let (x, y) = event.position();
        let is_typing = state_press.assistant_active.get()
            && *state_press.assistant_input_mode.borrow() == "type";
        if is_typing {
            if backend_press == Backend::X11 {
                x11::force_keyboard_focus(&win_press);
            }
            entry_press.grab_focus();
        }
        if input::is_on_pill_at(&state_press, x, y) {
            state_press.x11_release_persisted.set(false);
            state_press.pointer_down.set(true);
            state_press.long_press_active.set(true);
            state_press.long_press_elapsed.set(0.0);
            state_press.long_press_start_x.set(x);
            state_press.long_press_start_y.set(y);
            state_press.drag_cancelled.set(false);
            state_press.drag_cursor_x.set(x);
            state_press.drag_cursor_y.set(y);
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
        if !was_dragging {
            let (x, y) = event.position();
            input::handle_click(&state_click, x, y);
        }

        // Hover was pinned for the duration of the gesture; settle it against
        // the cursor's real position now that the pointer is free.
        let (rx, ry) = event.position();
        let now_hovered = input::is_over_pill_area(&state_click, rx, ry);
        if now_hovered != state_click.hovered.get() {
            state_click.hovered.set(now_hovered);
            ipc::send(&OutMessage::Hover { hovered: now_hovered });
        }
        glib::Propagation::Proceed
    });

    let state_scroll = state.clone();
    window.connect_scroll_event(move |_, event| {
        input::handle_scroll(&state_scroll, event);
        glib::Propagation::Proceed
    });

    let state_focus_in = state.clone();
    let entry_focus_in = entry.clone();
    window.connect_focus_in_event(move |_, _| {
        let is_typing = state_focus_in.assistant_active.get()
            && *state_focus_in.assistant_input_mode.borrow() == "type";
        if is_typing {
            entry_focus_in.grab_focus();
        }
        glib::Propagation::Proceed
    });

    let state_focus_out = state.clone();
    let entry_focus_out = entry.clone();
    window.connect_focus_out_event(move |_, _| {
        let is_typing = state_focus_out.assistant_active.get()
            && *state_focus_out.assistant_input_mode.borrow() == "type";
        if is_typing {
            entry_focus_out.select_region(0, 0);
        }
        glib::Propagation::Proceed
    });

    let state_draw = state.clone();
    let win_draw = window.clone();
    drawing_area.connect_draw(move |_area, cr| {
        // draw_tooltip() computes tooltip_width during this pass. The tick
        // rebuilds the Wayland input region *before* drawing, so on the frame
        // the tooltip first appears the region was built with a width of 0.0
        // and build_input_region() left the tooltip out. Rebuild the region
        // here when the width changes, so the tooltip is never painted outside
        // its own input shape.
        let width_before = state_draw.tooltip_width.get();
        draw::draw_all(cr, &state_draw);
        let width_changed = state_draw.tooltip_width.get() != width_before;
        if let Some(gdk_win) = win_draw.window().filter(|_| width_changed) {
            input::update_input_region(&gdk_win, &state_draw);
        }
        glib::Propagation::Proceed
    });

    let state_entry = state.clone();
    entry.connect_activate(move |e| {
        let text = e.text().to_string();
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            ipc::send(&OutMessage::TypedMessage { text: trimmed.to_string() });
            e.set_text("");
            *state_entry.entry_text.borrow_mut() = String::new();
        }
    });

    let state_entry_changed = state.clone();
    entry.connect_changed(move |e| {
        *state_entry_changed.entry_text.borrow_mut() = e.text().to_string();
    });

    let receiver = Rc::new(RefCell::new(receiver));
    let state_tick = state.clone();
    let da = drawing_area.clone();
    let win_tick = window.clone();
    let entry_tick = entry.clone();
    let quit_flag = Rc::new(Cell::new(false));
    let quit_tick = quit_flag.clone();
    let backend_tick = backend;
    glib::timeout_add_local(Duration::from_millis(16), move || {
        let rx = receiver.borrow();
        while let Ok(msg) = rx.try_recv() {
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
                        continue;
                    }
                    let prev = state_tick.phase.get();
                    state_tick.phase.set(phase);
                    state_tick.style_tooltip_gate.set_take_running(phase == Phase::Recording);
                    // A new take sweeps any banner parked above the pill (for
                    // example the retranscribing toast) so it cannot sit on the
                    // style selector for the whole take. A resume from Paused
                    // keeps toasts raised during the take, such as the cancel
                    // confirm.
                    if phase == Phase::Recording && matches!(prev, Phase::Idle | Phase::Loading) {
                        clear_flash(&state_tick);
                    }
                    if phase == Phase::Idle && prev != Phase::Idle {
                        state_tick.target_level.set(0.0);
                        state_tick.current_level.set(0.0);
                        state_tick.wave_phase.set(0.0);
                    }
                }
                InMessage::Levels { levels } => {
                    *state_tick.pending_levels.borrow_mut() = levels;
                }
                InMessage::StyleInfo { count, name } => {
                    state_tick.style_count.set(count);
                    *state_tick.style_name.borrow_mut() = name;
                }
                InMessage::Toast { message, toast_type, duration, action, action_label } => {
                    *state_tick.flash_message.borrow_mut() = message;
                    state_tick.flash_is_error.set(toast_type.as_deref() == Some("error"));
                    state_tick.flash_visible.set(true);
                    state_tick.flash_timer.set(duration.unwrap_or(FLASH_DURATION));
                    *state_tick.flash_action.borrow_mut() = action;
                    *state_tick.flash_action_label.borrow_mut() = action_label;
                }
                InMessage::DismissToast => {
                    clear_flash(&state_tick);
                }
                InMessage::Fireworks { message } => {
                    *state_tick.flash_message.borrow_mut() = message;
                    state_tick.flash_is_error.set(false);
                    *state_tick.flash_action.borrow_mut() = None;
                    *state_tick.flash_action_label.borrow_mut() = None;
                    state_tick.flash_visible.set(true);
                    state_tick.flash_timer.set(FIREWORKS_TOTAL_DURATION);

                    state_tick.fireworks_active.set(true);
                    state_tick.fireworks_elapsed.set(0.0);
                    state_tick.fireworks_next_launch.set(0);
                    state_tick.fireworks_rockets.borrow_mut().clear();
                }
                InMessage::Flame { message } => {
                    *state_tick.flash_message.borrow_mut() = message;
                    state_tick.flash_is_error.set(false);
                    *state_tick.flash_action.borrow_mut() = None;
                    *state_tick.flash_action_label.borrow_mut() = None;
                    state_tick.flash_visible.set(true);
                    state_tick.flash_timer.set(FLAME_TOTAL_DURATION);

                    state_tick.flame_active.set(true);
                    state_tick.flame_elapsed.set(0.0);
                    state_tick.flame_tongues.borrow_mut().clear();
                }
                InMessage::FlashBlue => {
                    state_tick.flash_blue_active.set(true);
                    state_tick.flash_blue_elapsed.set(0.0);
                }
                InMessage::BroadcastTranscript { text } => {
                    *state_tick.transcript_text.borrow_mut() = text;
                    state_tick.transcript_time_since_update.set(0.0);
                    state_tick.transcript_has_message.set(true);
                }
                InMessage::Visibility { visibility } => {
                    state_tick.visibility.set(visibility);
                }
                InMessage::WindowSize { ref size } => {
                    let mode = WindowMode::from_str(size);
                    state_tick.window_mode.set(mode);
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
                } => {
                    let was_active = state_tick.assistant_active.get();
                    state_tick.assistant_active.set(active);
                    *state_tick.assistant_input_mode.borrow_mut() = input_mode;
                    state_tick.assistant_compact.set(compact);
                    *state_tick.assistant_conversation_id.borrow_mut() = conversation_id;
                    *state_tick.assistant_user_prompt.borrow_mut() = user_prompt;
                    *state_tick.assistant_messages.borrow_mut() = messages;
                    *state_tick.assistant_streaming.borrow_mut() = streaming;
                    *state_tick.assistant_permissions.borrow_mut() = permissions;

                    if active && !was_active {
                        state_tick.should_stick.set(true);
                        state_tick.scroll_offset.set(0.0);
                    }
                }
                InMessage::ResetPosition { strategy } => {
                    state_tick.drag_draw_offset_x.set(0.0);
                    state_tick.drag_draw_offset_y.set(0.0);
                    state_tick.has_saved_position.set(false);
                    state_tick.reset_strategy.set(strategy);
                    let (rect, monitor) = pill_geometry(&win_tick, &state_tick);
                    ipc::send(&OutMessage::PositionChanged {
                        has_saved_position: false,
                        rect,
                        monitor,
                    });
                }
                InMessage::Quit => {
                    quit_tick.set(true);
                }
            }
        }

        if quit_tick.get() {
            return ControlFlow::Break;
        }

        release_pointer_if_button_up(&win_tick, &state_tick);
        tick(&state_tick);

        // Show/hide entry for typing mode
        let is_typing = state_tick.assistant_active.get()
            && *state_tick.assistant_input_mode.borrow() == "type";
        if is_typing && !gtk::prelude::WidgetExt::is_visible(&entry_tick) {
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
            let margin_end = (right_margin + (dw - panel_x - panel_w) + PANEL_CONTENT_SIDE_INSET) as i32;
            let ah = state_tick.alloc_height.get();
            let bottom_margin = if ah > 0.0 {
                ah - oy - dh
            } else {
                0.0
            };
            let margin_bottom = (bottom_margin + PANEL_BOTTOM_MARGIN) as i32;
            entry_tick.set_margin_start(margin_start);
            entry_tick.set_margin_end(margin_end);
            entry_tick.set_margin_bottom(margin_bottom);
            entry_tick.set_height_request(PANEL_INPUT_HEIGHT as i32);
            entry_tick.set_visible(true);
            entry_tick.show();
            match backend_tick {
                Backend::LayerShell => {
                    win_tick.set_keyboard_mode(gtk_layer_shell::KeyboardMode::OnDemand);
                    glib::idle_add_local_once({
                        let e = entry_tick.clone();
                        move || { e.grab_focus(); }
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
                        move || { e.grab_focus(); }
                    });
                }
            }
        } else if !is_typing && gtk::prelude::WidgetExt::is_visible(&entry_tick) {
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
        let should_show = should_show_pill(
            state_tick.visibility.get(),
            state_tick.phase.get(),
            state_tick.assistant_active.get(),
        );
        if should_show {
            win_tick.show();
        } else {
            win_tick.hide();
        }

        if let Some(gdk_win) = win_tick.window() {
            input::update_input_region(&gdk_win, &state_tick);
        }
        da.queue_draw();
        ControlFlow::Continue
    });

    window.show_all();
    entry.hide();
    ipc::send(&OutMessage::Ready);

    if backend == Backend::LayerShell {
        let window_ref = window.clone();
        let quit_monitor = quit_flag.clone();
        let state_monitor = state.clone();
        let last_geom: Rc<Cell<(i32, i32, i32, i32)>> = Rc::new(Cell::new((0, 0, 0, 0)));
        glib::timeout_add_local(Duration::from_millis(100), move || {
            if quit_monitor.get() {
                return ControlFlow::Break;
            }
            let display = match gdk::Display::default() {
                Some(d) => d,
                None => return ControlFlow::Continue,
            };
            // Only re-home the overlay to the pointer's monitor for the FIRST
            // placement (last_geom is still the sentinel) or while the user is
            // actively dragging across screens. Chasing the pointer the rest
            // of the time is what made the pinned pill hop displays whenever
            // the cursor crossed an edge.
            // The one exception: when the monitor the pill was homed on gets
            // DISCONNECTED, the stored geometry stops matching any connected
            // monitor and the layer-shell surface dies with the dead output —
            // fall through so the pill is re-homed onto a live monitor.
            let placed_once = last_geom.get() != (0, 0, 0, 0);
            // A reset with the "cursor" strategy forces one re-home pass onto
            // the pointer's monitor; the strategy is consumed once applied.
            let reset_to_cursor = !state_monitor.dragging.get()
                && state_monitor.reset_strategy.get() == ResetStrategy::Cursor;
            if placed_once && !state_monitor.dragging.get() && !reset_to_cursor {
                let stored = last_geom.get();
                let still_connected = (0..display.n_monitors()).any(|i| {
                    display.monitor(i).is_some_and(|monitor| {
                        let g = monitor.geometry();
                        (g.x(), g.y(), g.width(), g.height()) == stored
                    })
                });
                if still_connected {
                    return ControlFlow::Continue;
                }
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
                if new_geom != last_geom.get() {
                    last_geom.set(new_geom);
                    window_ref.set_monitor(&monitor);
                }
                if reset_to_cursor {
                    state_monitor.reset_strategy.set(ResetStrategy::Current);
                }
            }
            ControlFlow::Continue
        });
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
pub(crate) fn pill_geometry(window: &gtk::Window, state: &PillState) -> (Option<Rect>, Option<Rect>) {
    let (w, h) = window.size();
    let scale = window
        .window()
        .map(|gdk_win| gdk_win.scale_factor() as f64)
        .unwrap_or(1.0);
    let display = window.display();
    let monitor = window
        .window()
        .and_then(|gdk_win| display.monitor_at_window(&gdk_win))
        .or_else(|| {
            display.monitor_at_point(
                (state.saved_x.get() + (w as f64 / 2.0) * scale) as i32,
                (state.saved_y.get() + (h as f64 / 2.0) * scale) as i32,
            )
        })
        .or_else(|| display.primary_monitor())
        .or_else(|| display.monitor(0));
    let monitor_rect = monitor.map(|m| {
        // `workarea()` is in logical pixels while the pill rect below is
        // physical (`saved_x`/`saved_y` are X11 root coordinates and the
        // logical window size is scaled). The two rects must share one
        // coordinate space for the desktop's composer-anchoring math, so
        // scale the workarea by its monitor's own scale factor — via the
        // shared logical→physical conversion the X11 placement math also
        // uses (`pill_pos_on_monitor`).
        let monitor_scale = m.scale_factor() as f64;
        logical_rect_to_physical(&m.workarea(), monitor_scale)
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

/// Converts a GDK logical-pixel rectangle (a monitor's geometry or work area)
/// into the physical root-pixel space used for X11 window positioning and
/// `Rect` reporting. This is the single source of truth for the
/// logical→physical conversion: `pill_geometry` here and the placement math
/// in `pill_pos_on_monitor` both go through it, so any scaling tweak lands in
/// exactly one place. `Rectangle` is plain data, so this stays unit-testable
/// without a display connection.
pub(crate) fn logical_rect_to_physical(g: &gdk::Rectangle, scale: f64) -> Rect {
    Rect {
        x: g.x() as f64 * scale,
        y: g.y() as f64 * scale,
        width: g.width() as f64 * scale,
        height: g.height() as f64 * scale,
    }
}

/// Ends the gesture and tears down any active drag.
///
/// Clears the hover pin and gesture flags. If a drag was in progress, the
/// dropped position is persisted (X11 repositions via the window; other
/// backends keep their draw offset) so a missed release caught by the
/// frame-tick backstop does not strand the pill at its old position.
fn clear_pointer_pin(state: &PillState, window: &gtk::Window) {
    if state.dragging.get() {
        if state.backend.get() == Backend::X11 {
            let persisted = x11::persist_drop_position(window, state);
            state.x11_release_persisted.set(persisted);
        } else {
            state.has_saved_position.set(true);
            let (rect, monitor) = pill_geometry(window, state);
            ipc::send(&OutMessage::PositionChanged {
                has_saved_position: true,
                rect,
                monitor,
            });
        }
    }
    state.dragging.set(false);
    state.long_press_active.set(false);
    state.long_press_elapsed.set(0.0);
    state.pointer_down.set(false);
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
    let (_, _, _, mask) = gdk_window.device_position(&pointer);
    if !mask.contains(gdk::ModifierType::BUTTON1_MASK) {
        clear_pointer_pin(state, window);
    }
}

fn clear_flash(state: &PillState) {
    state.flash_visible.set(false);
    state.flash_timer.set(0.0);
    *state.flash_action.borrow_mut() = None;
    *state.flash_action_label.borrow_mut() = None;
}

fn tick(state: &PillState) {
    tick_long_press(state);
    let phase = state.phase.get();
    let is_active = phase != Phase::Idle;
    let is_loading = phase == Phase::Loading;
    let hovered = state.hovered.get();

    tick_audio_levels(state, phase);

    // Pill expand/collapse (spring)
    let expand_target = if is_active || hovered || state.assistant_active.get() || phase == Phase::Paused { 1.0 } else { 0.0 };
    spring_anim(&state.expand_t, &state.expand_velocity, expand_target, SPRING_STIFFNESS);

    // Loading offset
    if is_loading {
        state.loading_offset.set((state.loading_offset.get() + LOADING_SPEED) % 1.0);
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
    spring_anim(&state.tooltip_t, &state.tooltip_velocity, tooltip_target, SPRING_STIFFNESS);

    // Panel open/close (spring)
    let panel_target = if state.assistant_active.get() { 1.0 } else { 0.0 };
    spring_anim(&state.panel_open_t, &state.panel_open_velocity, panel_target, SPRING_STIFFNESS);

    // Keyboard button (spring)
    let is_voice = *state.assistant_input_mode.borrow() == "voice";
    let kb_target = if state.assistant_active.get() && is_voice { 1.0 } else { 0.0 };
    spring_anim(&state.kb_button_t, &state.kb_button_velocity, kb_target, SPRING_STIFFNESS);

    // Animate content dimensions toward target mode
    let mode = state.window_mode.get();
    let (tw, th) = mode.dimensions();
    spring_px(&state.draw_width, &state.draw_w_velocity, tw as f64, SPRING_STIFFNESS);
    spring_px(&state.draw_height, &state.draw_h_velocity, th as f64, SPRING_STIFFNESS);

    // Shimmer phase for thinking animation
    state.shimmer_phase.set((state.shimmer_phase.get() + SHIMMER_SPEED) % 1.0);

    // Fireworks
    tick_fireworks(state);

    // Flame
    tick_flame(state);

    // Flash blue border
    tick_flash_blue(state);

    // Broadcast transcript
    tick_transcript(state);

    tick_flash(state, tooltip_target > 0.5);

    // Long-press cancel flash timer
    if state.cancel_flash.get() > 0.0 {
        let remaining = state.cancel_flash.get() - SPRING_DT;
        state.cancel_flash.set(remaining.max(0.0));
    }

    // Recording <-> paused crossfade driven by the same critically damped
    // spring as the other pill transitions (settles, never overshoots).
    let pause_target = if state.phase.get() == Phase::Paused { 1.0 } else { 0.0 };
    spring_anim(&state.pause_t, &state.pause_velocity, pause_target, SPRING_STIFFNESS);

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
    spring_anim(&state.cancel_t, &state.cancel_velocity, cancel_target, SPRING_STIFFNESS * 2.0);

    // Inflate animation. The target ramps up partway through the hold (not at
    // the arm moment), so the pill is already growing while the ring fills and
    // arming continues that motion instead of starting a new one.
    let hold_p = draw::long_press_progress(state.long_press_elapsed.get());
    let inflate_target = rust_pill_shared::inflate_target(
        hold_p,
        state.long_press_active.get(),
        state.dragging.get(),
    );
    spring_anim(&state.inflate_t, &state.inflate_velocity, inflate_target, DRAG_INFLATE_STIFFNESS);

    let drag_target = if state.dragging.get() || state.long_press_active.get() { 1.0 } else { 0.0 };
    spring_anim(&state.drag_label_t, &state.drag_label_velocity, drag_target, rust_pill_shared::LABEL_SPRING_STIFFNESS);

    tick_ring(state);

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
        let levels = state.pending_levels.borrow();
        if !levels.is_empty() {
            let sum: f64 = levels.iter().map(|v| *v as f64).sum();
            let avg = sum / levels.len() as f64;
            let peak = levels.iter().copied().fold(0.0_f32, f32::max) as f64;
            let combined = (avg * 0.9 + peak * 0.85).min(1.0);
            let boosted = (combined.sqrt() * 1.35).min(1.0);
            let target = state.target_level.get();
            state.target_level.set((target * 0.25 + boosted * 0.75).min(1.0));
        }
    } else if is_loading {
        let target = state.target_level.get();
        state.target_level.set(target.max(PROCESSING_BASE_LEVEL));
    } else {
        state.target_level.set(0.0);
        state.current_level.set(state.current_level.get() * 0.4);
        if state.current_level.get() < 0.0002 {
            state.current_level.set(0.0);
        }
    }

    let current = state.current_level.get();
    let target = state.target_level.get();
    let new_current = current + (target - current) * LEVEL_SMOOTHING;
    state.current_level.set(if new_current < 0.0002 { 0.0 } else { new_current });

    let decayed = target * TARGET_DECAY_PER_FRAME;
    state.target_level.set(if decayed < 0.0005 { 0.0 } else { decayed });

    let level = state.current_level.get();
    let base_level = if is_loading && !is_recording { PROCESSING_BASE_LEVEL } else { 0.0 };
    let effective_level = level.max(base_level);
    let advance = WAVE_BASE_PHASE_STEP + WAVE_PHASE_GAIN * effective_level;
    state.wave_phase.set((state.wave_phase.get() + advance) % TAU);
}

/// Flash banner (native pill toast) expiry and fade spring. An action-less
/// banner yields the strip above the pill to a revealed style tooltip, so the
/// banner and the selector never sit on top of each other.
fn tick_flash(state: &PillState, tooltip_revealed: bool) {
    if state.flash_visible.get() {
        let remaining = state.flash_timer.get() - SPRING_DT;
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
        state.flash_action.borrow().is_some(),
        tooltip_revealed,
    );
    spring_anim(&state.flash_t, &state.flash_velocity, flash_target, SPRING_STIFFNESS);
}

fn tick_long_press(state: &PillState) {
    if !state.long_press_active.get() {
        return;
    }

    if state.phase.get() != Phase::Idle || state.assistant_active.get() {
        state.long_press_active.set(false);
        state.long_press_elapsed.set(0.0);
        return;
    }

    let elapsed = state.long_press_elapsed.get() + SPRING_DT;
    state.long_press_elapsed.set(elapsed);
    if elapsed >= LONG_PRESS_DURATION {
        state.long_press_active.set(false);
        state.long_press_elapsed.set(0.0);
        state.dragging.set(true);
        // Confirm the arm with the expanding halo, on the exact frame it fires.
        state.arm_pulse.set(rust_pill_shared::pulse_armed());
    }
}

/// Advances the long-press ring for one frame.
///
/// All the policy lives in `rust_pill_shared::advance_ring` so the three
/// platform renderers cannot drift apart; this only marshals `Cell` state in
/// and out of the shared struct.
fn tick_ring(state: &PillState) {
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
            delta_seconds: SPRING_DT,
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

    let speed = if target > 0.5 { TRANSCRIPT_RISE_SPEED } else { TRANSCRIPT_FADE_SPEED };
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

fn spring_anim(value: &Cell<f64>, velocity: &Cell<f64>, target: f64, stiffness: f64) {
    let v = value.get();
    let vel = velocity.get();
    if v == target && vel == 0.0 { return; }
    let damping = 2.0 * stiffness.sqrt();
    let force = stiffness * (target - v) - damping * vel;
    let new_vel = vel + force * SPRING_DT;
    let new_v = v + new_vel * SPRING_DT;
    if (new_v - target).abs() < 0.002 && new_vel.abs() < 0.5 {
        value.set(target);
        velocity.set(0.0);
    } else {
        value.set(new_v.clamp(0.0, 1.0));
        velocity.set(if !(0.0..=1.0).contains(&new_v) { 0.0 } else { new_vel });
    }
}

fn spring_px(value: &Cell<f64>, velocity: &Cell<f64>, target: f64, stiffness: f64) {
    let v = value.get();
    let vel = velocity.get();
    if v == target && vel == 0.0 { return; }
    let damping = 2.0 * stiffness.sqrt();
    let force = stiffness * (target - v) - damping * vel;
    let new_vel = vel + force * SPRING_DT;
    let new_v = v + new_vel * SPRING_DT;
    if (new_v - target).abs() < 0.5 && (new_vel * SPRING_DT).abs() < 0.5 {
        value.set(target);
        velocity.set(0.0);
    } else {
        value.set(new_v);
        velocity.set(new_vel);
    }
}

/// Shared pill visibility policy.
///
/// Every backend (X11, Layer Shell, Plain Wayland) resolves visibility through
/// this one function, so the user's preference means the same thing everywhere.
///
/// | Visibility     | Idle   | Recording | Assistant |
/// |----------------|--------|-----------|-----------|
/// | `Hidden`       | hidden | hidden    | visible   |
/// | `WhileActive`  | hidden | visible   | visible   |
/// | `Persistent`   | visible| visible   | visible   |
///
/// Assistant mode is a deliberate exception: the pill is the assistant's own
/// surface, so it shows even when the preference is `Hidden`.
pub(crate) fn should_show_pill(
    visibility: Visibility,
    phase: Phase,
    is_assistant: bool,
) -> bool {
    let is_active = phase != Phase::Idle;
    match visibility {
        Visibility::Hidden => is_assistant,
        Visibility::WhileActive => is_active || is_assistant,
        Visibility::Persistent => true,
    }
}

#[cfg(test)]
mod visibility_tests {
    use super::*;

    #[test]
    fn hidden_stays_hidden_while_recording() {
        // The Wayland regression: a Hidden pill used to appear while recording.
        assert!(!should_show_pill(Visibility::Hidden, Phase::Recording, false));
        assert!(!should_show_pill(Visibility::Hidden, Phase::Idle, false));
    }

    #[test]
    fn hidden_still_shows_for_assistant() {
        assert!(should_show_pill(Visibility::Hidden, Phase::Idle, true));
        assert!(should_show_pill(Visibility::Hidden, Phase::Recording, true));
    }

    #[test]
    fn while_active_shows_only_when_busy() {
        assert!(!should_show_pill(Visibility::WhileActive, Phase::Idle, false));
        assert!(should_show_pill(Visibility::WhileActive, Phase::Recording, false));
        assert!(should_show_pill(Visibility::WhileActive, Phase::Idle, true));
    }

    #[test]
    fn persistent_always_shows() {
        assert!(should_show_pill(Visibility::Persistent, Phase::Idle, false));
        assert!(should_show_pill(Visibility::Persistent, Phase::Recording, false));
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
    fn logical_rect_is_scaled_into_physical_pixels() {
        // A 2000x1000 logical work area at origin (100, 50) on a 2x monitor
        // must come out in the same physical space the pill rect uses.
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
