use std::cell::Cell;
use std::ffi::{c_int, c_ulong, c_void};
use std::rc::Rc;
use std::time::Duration;

use gtk::gdk;
use gtk::glib::{self, ControlFlow};
use gtk::prelude::*;

use crate::constants::MARGIN_BOTTOM;
use crate::ipc::{self, OutMessage};
use crate::state::{PillState, WindowMode};

type XDisplay = c_void;
type XWindow = c_ulong;

extern "C" {
    fn gdk_x11_display_get_xdisplay(display: *mut c_void) -> *mut XDisplay;
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

/// Persists the X11 drop position at button-release time.
///
/// The timer in `setup_x11_window` remains a fallback for release events that
/// GTK misses, but normal releases must use the pointer position from the
/// release handler rather than a later 100 ms poll.
pub(crate) fn persist_drop_position(
    window: &gtk::Window,
    state: &PillState,
) -> bool {
    let display = window.display();
    let xdisplay = unsafe {
        gdk_x11_display_get_xdisplay(
            glib::translate::ToGlibPtr::<*mut gdk::ffi::GdkDisplay>::to_glib_none(&display).0
                as *mut c_void,
        )
    };
    let (root_x, root_y) = query_root_pointer(xdisplay);
    let Some((drop_x, drop_y)) = pill_pos_on_monitor(
        root_x as f64,
        root_y as f64,
        true,
        &display,
        window,
        state,
    ) else {
        return false;
    };

    state.saved_x.set(drop_x as f64);
    state.saved_y.set(drop_y as f64);
    state.has_saved_position.set(true);
    ipc::send(&OutMessage::PositionChanged {
        has_saved_position: true,
    });
    true
}

pub(crate) fn setup_x11_window(window: &gtk::Window, state: Rc<PillState>) {
    use std::ffi::{c_char, c_int, c_uchar, c_uint, c_ulong, c_void};

    type XDisplay = c_void;
    type XWindow = c_ulong;
    type XAtom = c_ulong;

    const XA_ATOM: XAtom = 4;

    extern "C" {
        fn gdk_x11_display_get_xdisplay(display: *mut c_void) -> *mut XDisplay;
        fn gdk_x11_window_get_xid(window: *mut c_void) -> XWindow;
    }

    #[link(name = "X11")]
    extern "C" {
        fn XInternAtom(
            display: *mut XDisplay, name: *const c_char, only_if_exists: c_int,
        ) -> XAtom;
        fn XChangeProperty(
            display: *mut XDisplay, w: XWindow, property: XAtom, type_: XAtom,
            format: c_int, mode: c_int, data: *const c_uchar, nelements: c_int,
        ) -> c_int;
        fn XMoveWindow(display: *mut XDisplay, w: XWindow, x: c_int, y: c_int) -> c_int;
        fn XFlush(display: *mut XDisplay) -> c_int;
        fn XDefaultRootWindow(display: *mut XDisplay) -> XWindow;
        fn XQueryPointer(
            display: *mut XDisplay, w: XWindow,
            root_return: *mut XWindow, child_return: *mut XWindow,
            root_x_return: *mut c_int, root_y_return: *mut c_int,
            win_x_return: *mut c_int, win_y_return: *mut c_int,
            mask_return: *mut c_uint,
        ) -> c_int;
    }

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

        // Drag just ended: persist the actual drop point. `last_pos` is only
        // refreshed on the placement tick (up to a 100ms cadence), so reusing
        // it here can persist a position one interval behind the real drop.
        // Query the pointer at release and resolve the top-left directly.
        if !dragging
            && was_dragging.get()
            && !state_tick.x11_release_persisted.replace(false)
        {
            let (cx, cy) = cursor_pos();
            let (dx, dy) = pill_pos_on_monitor(
                cx as f64,
                cy as f64,
                true,
                &display,
                &win_tick,
                &state_tick,
            )
            .unwrap_or_else(|| last_pos.get());
            // `pill_pos_on_monitor` returns the window top-left, and
            // `saved_x`/`saved_y` are used verbatim as the top-left when parked
            // (see the has_saved_position branch), so store it directly.
            last_pos.set((dx, dy));
            state_tick.saved_x.set(dx as f64);
            state_tick.saved_y.set(dy as f64);
            state_tick.has_saved_position.set(true);
            ipc::send(&OutMessage::PositionChanged { has_saved_position: true });
        }
        was_dragging.set(dragging);

        // Pick the anchor that decides which monitor owns the pill: the cursor
        // while dragging, the saved drop point when parked, else wherever the
        // pill already is. Resolving the monitor from the live cursor
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

        let (anchor_x, anchor_y) = if dragging {
            let (ax, ay) = cursor_pos();
            (ax as f64, ay as f64)
        } else if state_tick.has_saved_position.get() {
            (
                state_tick.saved_x.get() + center_x,
                state_tick.saved_y.get() + center_y,
            )
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
    let g = primary.geometry();
    let scale = primary.scale_factor() as f64;
    let centre_x = (g.x() as f64 + g.width() as f64 / 2.0) * scale;
    // Containment is exclusive on the lower edge (`anchor_y < phys_y + phys_h`),
    // so sit one physical pixel inside rather than on the boundary.
    let bottom_y = (g.y() as f64 + g.height() as f64) * scale - 1.0;
    Some((centre_x, bottom_y))
}

/// Computes where the toplevel belongs, given the anchor point that decides
/// which monitor owns the pill. All coordinates are physical pixels: cursor
/// queries are physical root coords, and monitor geometry is scaled to match.
fn pill_pos_on_monitor(
    anchor_x: f64,
    anchor_y: f64,
    dragging: bool,
    display: &gdk::Display,
    window: &gtk::Window,
    state: &PillState,
) -> Option<(c_int, c_int)> {
    let n = display.n_monitors();
    for i in 0..n {
        // A monitor can disappear between the count query and this handle query
        // mid hot-unplug; skip it and keep scanning the remaining monitors
        // instead of abandoning the whole placement.
        let Some(monitor) = display.monitor(i) else {
            continue;
        };
        let g = monitor.geometry();
        let scale = monitor.scale_factor() as f64;
        let phys_x = g.x() as f64 * scale;
        let phys_y = g.y() as f64 * scale;
        let phys_w = g.width() as f64 * scale;
        let phys_h = g.height() as f64 * scale;
        if anchor_x >= phys_x
            && anchor_x < phys_x + phys_w
            && anchor_y >= phys_y
            && anchor_y < phys_y + phys_h
        {
            let wa = monitor.workarea();
            let wa_x = wa.x() as f64 * scale;
            let wa_y = wa.y() as f64 * scale;
            let wa_w = wa.width() as f64 * scale;
            let wa_h = wa.height() as f64 * scale;
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
            let (min_x, min_y, max_x, max_y) =
                if state.window_mode.get() == WindowMode::Dictation
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
                        wa_x - fx,
                        wa_y - fy,
                        wa_x + wa_w - fx - fw,
                        wa_y + wa_h - fy - fh,
                    )
                } else {
                    (wa_x, wa_y, wa_x + wa_w - win_w, wa_y + wa_h - win_h)
                };

            // Guard against inverted bounds (e.g. a zero-size work area or a
            // footprint larger than the monitor): normalize the max to the min so
            // the clamp below resolves to the minimum boundary instead of placing
            // the window outside the work area.
            let max_x = max_x.max(min_x);
            let max_y = max_y.max(min_y);

            if dragging {
                // Keep the grabbed point of the window under the cursor (1:1
                // tracking instead of snapping the window centre to it),
                // clamped so the pill's footprint stays in the work area.
                let drag_x = state.drag_cursor_x.get() * scale;
                let drag_y = state.drag_cursor_y.get() * scale;
                let mut x = anchor_x - drag_x;
                let mut y = anchor_y - drag_y;
                x = x.max(min_x).min(max_x);
                y = y.max(min_y).min(max_y);
                return Some((x as c_int, y as c_int));
            }

            if state.has_saved_position.get() {
                // Park at the persisted drop position, clamped into the work
                // area of the monitor that position belongs to.
                let mut x = state.saved_x.get();
                let mut y = state.saved_y.get();
                x = x.max(min_x).min(max_x);
                y = y.max(min_y).min(max_y);
                return Some((x as c_int, y as c_int));
            }

            return Some((
                (wa_x + (wa_w - win_w) / 2.0) as c_int,
                (wa_y + wa_h - win_h - margin) as c_int,
            ));
        }
    }
    None
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