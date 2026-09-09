use std::cell::Cell;
use std::ffi::{c_char, c_int, c_uchar, c_uint, c_ulong, c_void};
use std::rc::Rc;
use std::time::Duration;

use gtk::gdk;
use gtk::glib::{self, ControlFlow};
use gtk::prelude::*;

use crate::constants::MARGIN_BOTTOM;
use crate::ipc::{self, OutMessage, ResetStrategy};
use crate::state::{PillState, WindowMode};
use rust_pill_shared::drag::{DragBounds, DragFrame, DragPhase};

type XDisplay = c_void;
type XWindow = c_ulong;
type XAtom = c_ulong;

extern "C" {
    fn gdk_x11_display_get_xdisplay(display: *mut c_void) -> *mut XDisplay;
    fn gdk_x11_window_get_xid(window: *mut c_void) -> XWindow;
}

#[link(name = "X11")]
extern "C" {
    fn XDefaultRootWindow(display: *mut XDisplay) -> XWindow;
    fn XQueryPointer(
        display: *mut XDisplay,
        window: XWindow,
        root_return: *mut XWindow,
        child_return: *mut XWindow,
        root_x_return: *mut c_int,
        root_y_return: *mut c_int,
        win_x_return: *mut c_int,
        win_y_return: *mut c_int,
        mask_return: *mut u32,
    ) -> c_int;
    fn XInternAtom(
        display: *mut XDisplay, name: *const c_char, only_if_exists: c_int,
    ) -> XAtom;
    fn XChangeProperty(
        display: *mut XDisplay, w: XWindow, property: XAtom, type_: XAtom,
        format: c_int, mode: c_int, data: *const c_uchar, nelements: c_int,
    ) -> c_int;
    fn XMoveWindow(display: *mut XDisplay, w: XWindow, x: c_int, y: c_int) -> c_int;
    fn XFlush(display: *mut XDisplay) -> c_int;
}

fn query_root_pointer(xdisplay: *mut XDisplay) -> (c_int, c_int) {
    unsafe {
        let root = XDefaultRootWindow(xdisplay);
        let (mut root_x, mut root_y) = (0, 0);
        let (mut child, mut root_window) = (0 as XWindow, 0 as XWindow);
        let (mut window_x, mut window_y) = (0, 0);
        let mut mask = 0_u32;
        XQueryPointer(
            xdisplay,
            root,
            &mut root_window,
            &mut child,
            &mut root_x,
            &mut root_y,
            &mut window_x,
            &mut window_y,
            &mut mask,
        );
        (root_x, root_y)
    }
}

fn xdisplay_for_window(window: &gtk::Window) -> *mut XDisplay {
    let display = window.display();
    unsafe {
        gdk_x11_display_get_xdisplay(
            glib::translate::ToGlibPtr::<*mut gdk::ffi::GdkDisplay>::to_glib_none(&display).0
                as *mut c_void,
        )
    }
}

fn toplevel_xid(window: &gtk::Window) -> Option<XWindow> {
    let gdk_window = window.window()?;
    unsafe {
        Some(gdk_x11_window_get_xid(
            glib::translate::ToGlibPtr::<*mut gdk::ffi::GdkWindow>::to_glib_none(&gdk_window).0
                as *mut c_void,
        ))
    }
}

/// Current root-pointer position in physical pixels.
fn root_pointer(window: &gtk::Window) -> (c_int, c_int) {
    query_root_pointer(xdisplay_for_window(window))
}

/// Moves the toplevel to an absolute root position.
fn move_toplevel(window: &gtk::Window, x: c_int, y: c_int) {
    let Some(xid) = toplevel_xid(window) else {
        return;
    };
    let xdisplay = xdisplay_for_window(window);
    unsafe {
        XMoveWindow(xdisplay, xid, x, y);
        XFlush(xdisplay);
    }
}

/// Persists the X11 drop position derived from the live pointer.
///
/// Only the slow timer calls this now, as a net for drags that ended without
/// a settle (a release landing between the arm moment and the first drag
/// frame, which starts no settle because the controller never left idle).
/// Normal releases persist the settled window position instead, so the saved
/// point matches where the pill landed rather than where the pointer is.
pub(crate) fn persist_drop_position(
    window: &gtk::Window,
    state: &PillState,
) -> Option<(c_int, c_int)> {
    let (root_x, root_y) = root_pointer(window);
    let (drop_x, drop_y) = pill_pos_on_monitor(
        root_x as f64,
        root_y as f64,
        true,
        &window.display(),
        window,
        state,
    )?;

    state.saved_x.set(drop_x as f64);
    state.saved_y.set(drop_y as f64);
    state.has_saved_position.set(true);
    let (rect, monitor) = crate::pill::pill_geometry(window, state);
    ipc::send(&OutMessage::PositionChanged {
        has_saved_position: true,
        rect,
        monitor,
    });
    Some((drop_x, drop_y))
}

/// Persists an explicit window position as the X11 drop point (the frame tick
/// calls this when a release settle finishes) and marks the release consumed
/// so the slow timer cannot overwrite it with a later cursor poll.
pub(crate) fn persist_window_position(
    window: &gtk::Window,
    state: &PillState,
    x: f64,
    y: f64,
) {
    state.saved_x.set(x);
    state.saved_y.set(y);
    state.has_saved_position.set(true);
    state.x11_release_persisted.set(true);
    let (rect, monitor) = crate::pill::pill_geometry(window, state);
    ipc::send(&OutMessage::PositionChanged {
        has_saved_position: true,
        rect,
        monitor,
    });
}

/// Advances one frame of X11 drag motion on the frame clock: samples the root
/// pointer, runs it through the shared controller, and moves the toplevel.
/// The first frame lazily arms the controller (the arm moment has no display
/// access; the press point and monitor scale are identical a frame later).
pub(crate) fn tick_drag_frame(
    window: &gtk::Window,
    state: &PillState,
    now: f64,
    dt: f64,
) {
    let dragging = state.dragging.get();
    {
        let motion = state.drag_motion.borrow();
        if !dragging && !motion.is_settling() {
            return;
        }
    }
    let display = window.display();
    let (cx, cy) = root_pointer(window);
    let Some(p) = placement_on_monitor(cx as f64, cy as f64, &display, window, state) else {
        return;
    };
    let mut motion = state.drag_motion.borrow_mut();
    if dragging && motion.phase() != DragPhase::Held {
        // A re-grab while the previous release still settles re-arms here too;
        // begin_drag cancels the running settle, so the new drag never fights
        // it with a stale grab offset.
        motion.begin_drag(
            state.drag_cursor_x.get() * p.scale,
            state.drag_cursor_y.get() * p.scale,
            0.0,
            0.0,
            now,
        );
    }
    let was_settling = motion.is_settling();
    let output = motion.advance(&DragFrame {
        pointer_x: cx as f64,
        pointer_y: cy as f64,
        now,
        dt,
        bounds: p.bounds,
        held: dragging,
        reduced_motion: crate::pill::reduced_motion(),
    });
    drop(motion);
    let x = output.x.round() as c_int;
    let y = output.y.round() as c_int;
    if state.x11_drag_applied.get() != (x, y) {
        state.x11_drag_applied.set((x, y));
        move_toplevel(window, x, y);
    }
    if was_settling && output.settled {
        persist_window_position(window, state, output.x.round(), output.y.round());
    }
}

pub(crate) fn setup_x11_window(window: &gtk::Window, state: Rc<PillState>) {
    const XA_ATOM: XAtom = 4;

    let display = window.display();
    let gdk_window = window.window().expect("window after realize");

    let xdisplay = unsafe {
        gdk_x11_display_get_xdisplay(
            glib::translate::ToGlibPtr::<*mut gdk::ffi::GdkDisplay>::to_glib_none(&display).0
                as *mut c_void,
        )
    };
    let xwindow = unsafe {
        gdk_x11_window_get_xid(
            glib::translate::ToGlibPtr::<*mut gdk::ffi::GdkWindow>::to_glib_none(&gdk_window).0
                as *mut c_void,
        )
    };

    unsafe {
        let intern = |name: &[u8]| -> XAtom {
            XInternAtom(xdisplay, name.as_ptr() as *const c_char, 0)
        };

        let wm_window_type = intern(b"_NET_WM_WINDOW_TYPE\0");
        let type_dock = intern(b"_NET_WM_WINDOW_TYPE_DOCK\0");
        XChangeProperty(
            xdisplay, xwindow, wm_window_type, XA_ATOM, 32, 0,
            &type_dock as *const XAtom as *const c_uchar, 1,
        );

        let wm_state = intern(b"_NET_WM_STATE\0");
        let states = [
            intern(b"_NET_WM_STATE_ABOVE\0"),
            intern(b"_NET_WM_STATE_STICKY\0"),
            intern(b"_NET_WM_STATE_SKIP_TASKBAR\0"),
            intern(b"_NET_WM_STATE_SKIP_PAGER\0"),
        ];
        XChangeProperty(
            xdisplay, xwindow, wm_state, XA_ATOM, 32, 0,
            states.as_ptr() as *const c_uchar, states.len() as c_int,
        );

        XFlush(xdisplay);
    }

    let cursor_pos = move || -> (c_int, c_int) {
        unsafe {
            let root = XDefaultRootWindow(xdisplay);
            let (mut rx, mut ry) = (0 as c_int, 0 as c_int);
            let (mut dw1, mut dw2) = (0 as XWindow, 0 as XWindow);
            let (mut dx, mut dy) = (0 as c_int, 0 as c_int);
            let mut dm: c_uint = 0;
            XQueryPointer(
                xdisplay, root, &mut dw1, &mut dw2,
                &mut rx, &mut ry, &mut dx, &mut dy, &mut dm,
            );
            (rx, ry)
        }
    };

    let (cx, cy) = cursor_pos();
    let init_pos = pill_pos_on_monitor(
        cx as f64,
        cy as f64,
        state.dragging.get(),
        &display,
        window,
        &state,
    )
    // Transient hot-plug states can leave the cursor on a monitor whose handle
    // is momentarily missing from the list, so no probe matches. Falling back
    // to (0, 0) would throw the pill into the top-left corner of the root
    // window; park it bottom-centre on the primary monitor instead — the same
    // anchor the idle placement logic uses for first paint.
    .or_else(|| primary_monitor_bottom_centre(&display).and_then(|(bx, by)| {
        pill_pos_on_monitor(
            bx,
            by,
            state.dragging.get(),
            &display,
            window,
            &state,
        )
    }))
    .unwrap_or((0, 0));
    unsafe {
        XMoveWindow(xdisplay, xwindow, init_pos.0, init_pos.1);
        XFlush(xdisplay);
    }

    let last_pos = Rc::new(Cell::new(init_pos));
    let was_dragging = Rc::new(Cell::new(false));
    let win_tick = window.clone();
    let state_tick = state.clone();
    glib::timeout_add_local(Duration::from_millis(100), move || {
        let dragging = state_tick.dragging.get();

        // The frame tick owns the window while a drag is held or settling;
        // this slow timer only parks idle pills and heals hot-plug states.
        if dragging || state_tick.drag_motion.borrow().is_settling() {
            was_dragging.set(dragging);
            return ControlFlow::Continue;
        }

        // Net for a drag that ended without a settle (a release landing
        // between the arm moment and the first drag frame). Normal releases
        // persist the settled position and mark it consumed, so this skips.
        // Past the guard above, dragging is always false here.
        if was_dragging.get() && !state_tick.x11_release_persisted.replace(false) {
            if let Some(pos) = persist_drop_position(&win_tick, &state_tick) {
                last_pos.set(pos);
            }
        }
        was_dragging.set(false);

        // Pick the anchor that decides which monitor owns the pill: the saved
        // drop point when parked, else wherever the pill already is. (Drags
        // never reach this timer; the frame tick owns the window while one is
        // held or settling.) Resolving the monitor from the live cursor
        // unconditionally is what used to make the pill leap to another
        // screen — and snap back to bottom-centre — on every crossing.
        //
        // The parked/idle anchors are window CENTRES, not toplevel origins —
        // matching the macOS/Windows implementations. The toplevel may
        // legitimately overhang the work-area edge now that drag clamping uses
        // the pill's visible footprint, so a raw top-left origin can sit on
        // the wrong monitor near a shared edge. (window.size() is logical and
        // monitor geometry is physical, so convert with the surface scale —
        // the toplevel lives on the monitor being resolved.)
        let surface_scale = win_tick
            .window()
            .map(|gdk_window| gdk_window.scale_factor() as f64)
            .unwrap_or(1.0);

        let (ox, oy) = state_tick.content_offset();
        let (pill_x, pill_y, pill_w, pill_h) = crate::draw::pill_position(
            &state_tick,
            state_tick.draw_width.get(),
            state_tick.draw_height.get(),
        );
        let center_x = (ox + pill_x + pill_w / 2.0) * surface_scale;
        let center_y = (oy + pill_y + pill_h / 2.0) * surface_scale;

        // A reset with the "cursor" strategy re-homes onto the monitor under
        // the pointer exactly once; the strategy is consumed so later ticks
        // keep the pill where it landed instead of chasing the cursor.
        let reset_to_cursor = !state_tick.has_saved_position.get()
            && state_tick.reset_strategy.get() == ResetStrategy::Cursor;

        let (anchor_x, anchor_y) = if state_tick.has_saved_position.get() {
            (
                state_tick.saved_x.get() + center_x,
                state_tick.saved_y.get() + center_y,
            )
        } else if reset_to_cursor {
            state_tick.reset_strategy.set(ResetStrategy::Current);
            let (ax, ay) = cursor_pos();
            (ax as f64, ay as f64)
        } else {
            let prev = last_pos.get();
            (prev.0 as f64 + center_x, prev.1 as f64 + center_y)
        };

        if let Some((new_x, new_y)) = pill_pos_on_monitor(
            anchor_x,
            anchor_y,
            dragging,
            &display,
            &win_tick,
            &state_tick,
        ) {
            let prev = last_pos.get();
            if new_x != prev.0 || new_y != prev.1 {
                last_pos.set((new_x, new_y));
                unsafe {
                    XMoveWindow(xdisplay, xwindow, new_x, new_y);
                    XFlush(xdisplay);
                }
            }
        } else {
            // Monitor resolution failed (e.g. display reconfig mid-tick): leave
            // the window where it is rather than mutating saved-position state or
            // snapping to the origin.
        }
        ControlFlow::Continue
    });
}

/// Returns a bottom-centre anchor point (in physical pixels) for the primary
/// monitor (or monitor 0 if there is no primary). Used as the initial-placement
/// anchor when the cursor sits on a transiently-missing monitor at realize().
fn primary_monitor_bottom_centre(display: &gdk::Display) -> Option<(f64, f64)> {
    let primary = display.primary_monitor().or_else(|| display.monitor(0))?;
    let phys = crate::pill::logical_rect_to_physical(
        &primary.geometry(),
        primary.scale_factor() as f64,
    );
    let centre_x = phys.x + phys.width / 2.0;
    // Containment is exclusive on the lower edge (`anchor_y < phys.y + phys.height`),
    // so sit one physical pixel inside rather than on the boundary.
    let bottom_y = phys.y + phys.height - 1.0;
    Some((centre_x, bottom_y))
}

/// Everything the X11 placement math needs about the monitor an anchor point
/// landed on. All coordinates are physical pixels: cursor queries are physical
/// root coords, and monitor geometry/work areas are converted via
/// `logical_rect_to_physical` to match.
pub(crate) struct MonitorPlacement {
    pub bounds: DragBounds,
    pub scale: f64,
    pub work_x: f64,
    pub work_y: f64,
    pub work_w: f64,
    pub work_h: f64,
    pub win_w: f64,
    pub win_h: f64,
    pub margin: f64,
}

/// Finds the monitor an anchor point belongs to and resolves its work area,
/// scale, and clamp bounds. Shared by the slow-timer parking and the
/// frame-tick drag so the two can never disagree about the work area.
fn placement_on_monitor(
    anchor_x: f64,
    anchor_y: f64,
    display: &gdk::Display,
    window: &gtk::Window,
    state: &PillState,
) -> Option<MonitorPlacement> {
    let n = display.n_monitors();
    for i in 0..n {
        // A monitor can disappear between the count query and this handle query
        // mid hot-unplug; skip it and keep scanning the remaining monitors
        // instead of abandoning the whole placement.
        let Some(monitor) = display.monitor(i) else {
            continue;
        };
        let scale = monitor.scale_factor() as f64;
        // Monitor geometry and work areas come back in logical pixels; the
        // hit-test and placement math below (and XMoveWindow itself) work in
        // physical root pixels, so convert through the shared helper.
        let phys = crate::pill::logical_rect_to_physical(&monitor.geometry(), scale);
        if anchor_x >= phys.x
            && anchor_x < phys.x + phys.width
            && anchor_y >= phys.y
            && anchor_y < phys.y + phys.height
        {
            let wa = crate::pill::logical_rect_to_physical(&monitor.workarea(), scale);
            let (alloc_w, alloc_h) = window.size();
            // window.size() returns logical pixels; XMoveWindow and the
            // workarea math above are in physical pixels, so scale here too.
            let win_w = alloc_w as f64 * scale;
            let win_h = alloc_h as f64 * scale;
            let margin = MARGIN_BOTTOM as f64 * scale;

            // The toplevel is a fixed-size transparent canvas; the visible pill
            // is drawn inside it, centred horizontally and bottom-anchored.
            // Clamping the *toplevel* into the work area boxes the pill into
            // the middle of the monitor — the invisible canvas margins eat
            // hundreds of pixels on every side. In dictation mode, clamp the
            // pill's visible footprint instead so it can be parked at the true
            // screen edges; panel/typing modes fill the canvas, so they keep
            // whole-window clamping.
            //
            // Inverted bounds (a zero-size work area or a footprint larger than
            // the monitor) are fine to pass through: `clamp_point` normalizes
            // max to min, so the clamp resolves to the minimum boundary instead
            // of placing the window outside the work area.
            let (min_x, min_y, max_x, max_y) =
                if state.effective_window_mode() == WindowMode::Dictation
                    && !state.assistant_active.get()
                {
                    let (px, py, pw, ph) = crate::draw::pill_position(
                        state,
                        state.draw_width.get(),
                        state.draw_height.get(),
                    );
                    let (cox, coy) = state.content_offset();
                    let fx = (cox + px) * scale;
                    let fy = (coy + py) * scale;
                    let fw = pw * scale;
                    let fh = ph * scale;
                    (
                        wa.x - fx,
                        wa.y - fy,
                        wa.x + wa.width - fx - fw,
                        wa.y + wa.height - fy - fh,
                    )
                } else {
                    (wa.x, wa.y, wa.x + wa.width - win_w, wa.y + wa.height - win_h)
                };

            return Some(MonitorPlacement {
                bounds: DragBounds {
                    min_x,
                    min_y,
                    max_x,
                    max_y,
                },
                scale,
                work_x: wa.x,
                work_y: wa.y,
                work_w: wa.width,
                work_h: wa.height,
                win_w,
                win_h,
                margin,
            });
        }
    }
    None
}

/// Computes where the toplevel belongs, given the anchor point that decides
/// which monitor owns the pill. All coordinates are physical pixels.
fn pill_pos_on_monitor(
    anchor_x: f64,
    anchor_y: f64,
    dragging: bool,
    display: &gdk::Display,
    window: &gtk::Window,
    state: &PillState,
) -> Option<(c_int, c_int)> {
    let p = placement_on_monitor(anchor_x, anchor_y, display, window, state)?;

    if dragging {
        // Keep the grabbed point of the window under the cursor (1:1
        // tracking instead of snapping the window centre to it),
        // clamped so the pill's footprint stays in the work area.
        let drag_x = state.drag_cursor_x.get() * p.scale;
        let drag_y = state.drag_cursor_y.get() * p.scale;
        let (x, y) = p
            .bounds
            .clamp_point(anchor_x - drag_x, anchor_y - drag_y);
        return Some((x as c_int, y as c_int));
    }

    if state.has_saved_position.get() {
        // Park at the persisted drop position, clamped into the work
        // area of the monitor that position belongs to.
        let (x, y) = p
            .bounds
            .clamp_point(state.saved_x.get(), state.saved_y.get());
        return Some((x as c_int, y as c_int));
    }

    Some((
        (p.work_x + (p.work_w - p.win_w) / 2.0) as c_int,
        (p.work_y + p.work_h - p.win_h - p.margin) as c_int,
    ))
}

pub(crate) fn force_keyboard_focus(window: &gtk::Window) {
    type XDisplay = c_void;
    type XWindow = c_ulong;

    extern "C" {
        fn gdk_x11_display_get_xdisplay(display: *mut c_void) -> *mut XDisplay;
        fn gdk_x11_window_get_xid(window: *mut c_void) -> XWindow;
    }

    #[link(name = "X11")]
    extern "C" {
        fn XSetInputFocus(
            display: *mut XDisplay, focus: XWindow, revert_to: c_int, time: c_ulong,
        ) -> c_int;
        fn XFlush(display: *mut XDisplay) -> c_int;
    }

    let gdk_window = match window.window() {
        Some(w) if w.is_visible() => w,
        _ => return,
    };
    let display = window.display();

    unsafe {
        let xdisplay = gdk_x11_display_get_xdisplay(
            glib::translate::ToGlibPtr::<*mut gdk::ffi::GdkDisplay>::to_glib_none(&display).0
                as *mut c_void,
        );
        let xwindow = gdk_x11_window_get_xid(
            glib::translate::ToGlibPtr::<*mut gdk::ffi::GdkWindow>::to_glib_none(&gdk_window).0
                as *mut c_void,
        );
        XSetInputFocus(xdisplay, xwindow, 1, 0);
        XFlush(xdisplay);
    }
}