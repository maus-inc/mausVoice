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
/// a settle (for example, when no connected monitor could be resolved to arm
/// the controller before release).
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

    move_toplevel(window, drop_x, drop_y);
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

pub(crate) fn physical_grab_offset(press: (f64, f64), surface_scale: i32) -> (f64, f64) {
    let scale = surface_scale.max(1) as f64;
    (press.0 * scale, press.1 * scale)
}

/// Advances one frame of X11 drag motion on the frame clock: samples the root
/// pointer, runs it through the shared controller, and moves the toplevel.
/// The first frame lazily arms the controller using the physical offset
/// captured at press time, even if the pointer has already crossed monitors.
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
    let (anchor_x, anchor_y) = state.drag_motion.borrow().monitor_anchor(
        (cx as f64, cy as f64), dragging,
    );
    let placement = placement_on_monitor(
        anchor_x, anchor_y, dragging, &display, window, state,
    )
    .or_else(|| {
        let monitor = window.window().and_then(|surface| display.monitor_at_window(&surface))?;
        let (x, y) = monitor_bottom_centre(&monitor);
        placement_on_monitor(x, y, dragging, &display, window, state)
    })
    .or_else(|| {
        let (x, y) = primary_monitor_bottom_centre(&display)?;
        placement_on_monitor(x, y, dragging, &display, window, state)
    });
    let Some(p) = placement else { return };
    let mut motion = state.drag_motion.borrow_mut();
    if dragging && motion.phase() != DragPhase::Held {
        // A re-grab while the previous release still settles re-arms here too;
        // begin_drag cancels the running settle, so the new drag never fights
        // it with a stale grab offset.
        let (grab_x, grab_y) = state.drag_press_offset.get();
        motion.begin_drag(grab_x, grab_y, 0.0, 0.0, now);
    }
    let was_settling = motion.is_settling();
    let output = motion.advance(&DragFrame {
        pointer_x: cx as f64,
        pointer_y: cy as f64,
        now,
        dt,
        bounds: p.bounds,
        edge_work: Some(rust_pill_shared::edge::EdgeWork {
            width: p.work_w,
            height: p.work_h,
            edges: p.edge_mask,
        }),
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

    state.x11_drag_applied.set(init_pos);
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

        // Net for a drag that ended without arming a settle, such as when
        // no monitor could be resolved before release. Normal releases
        // persist the settled position and mark it consumed, so this skips.
        // Past the guard above, dragging is always false here.
        if was_dragging.get() && !state_tick.x11_release_persisted.replace(false) {
            if let Some(pos) = persist_drop_position(&win_tick, &state_tick) {
                state_tick.x11_drag_applied.set(pos);
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
            let prev = state_tick.x11_drag_applied.get();
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
            let prev = state_tick.x11_drag_applied.get();
            if new_x != prev.0 || new_y != prev.1 {
                state_tick.x11_drag_applied.set((new_x, new_y));
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
    Some(monitor_bottom_centre(&primary))
}

fn monitor_bottom_centre(monitor: &gdk::Monitor) -> (f64, f64) {
    let phys = crate::pill::logical_rect_to_physical(
        &monitor.geometry(),
        monitor.scale_factor() as f64,
    );
    let centre_x = phys.x + phys.width / 2.0;
    // Containment is exclusive on the lower edge (`anchor_y < phys.y + phys.height`),
    // so sit one physical pixel inside rather than on the boundary.
    let bottom_y = phys.y + phys.height - 1.0;
    (centre_x, bottom_y)
}

/// Everything the X11 placement math needs about the monitor an anchor point
/// landed on. All coordinates are physical pixels: cursor queries are physical
/// root coords, and monitor geometry/work areas are converted via
/// `logical_rect_to_physical` to match.
pub(crate) struct MonitorPlacement {
    pub bounds: DragBounds,
    pub work_x: f64,
    pub work_y: f64,
    pub work_w: f64,
    pub work_h: f64,
    pub win_w: f64,
    pub content_h: f64,
    pub margin: f64,
    pub edge_mask: rust_pill_shared::edge::EdgeMask,
}

/// Resolves physical root coordinates without passing them to GDK's logical
/// point API. Missing handles during hot-unplug do not stop the search.
pub(crate) fn monitor_at_physical_point(display: &gdk::Display, x: f64, y: f64) -> Option<gdk::Monitor> {
    (0..display.n_monitors()).filter_map(|i| display.monitor(i)).find(|monitor| {
        let rect = crate::pill::logical_rect_to_physical(
            &monitor.geometry(), monitor.scale_factor() as f64,
        );
        x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
    })
}

/// Finds the monitor an anchor point belongs to and resolves its work area,
/// scale, and clamp bounds. Shared by the slow-timer parking and the
/// frame-tick drag so the two can never disagree about the work area.
fn placement_on_monitor(
    anchor_x: f64,
    anchor_y: f64,
    seams_open: bool,
    display: &gdk::Display,
    window: &gtk::Window,
    state: &PillState,
) -> Option<MonitorPlacement> {
    let monitor = monitor_at_physical_point(display, anchor_x, anchor_y)?;
    let scale = monitor.scale_factor() as f64;
    let seam_point = if seams_open {
        crate::pill::x11_pill_center(state, scale)
            .unwrap_or((anchor_x, anchor_y))
    } else {
        (anchor_x, anchor_y)
    };
    let wa = crate::pill::logical_rect_to_physical(&monitor.workarea(), scale);
    let monitor_geometry = monitor.geometry();
    let full = crate::pill::logical_rect_to_physical(&monitor_geometry, scale);
    let neighbors: Vec<_> = if seams_open {
        (0..display.n_monitors())
            .filter_map(|index| display.monitor(index))
            .filter(|candidate| {
                let geometry = candidate.geometry();
                geometry.x() != monitor_geometry.x()
                    || geometry.y() != monitor_geometry.y()
                    || geometry.width() != monitor_geometry.width()
                    || geometry.height() != monitor_geometry.height()
            })
            .map(|candidate| {
                let rect = crate::pill::logical_rect_to_physical(
                    &candidate.geometry(),
                    candidate.scale_factor() as f64,
                );
                rust_pill_shared::edge::MonitorRect {
                    x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                }
            })
            .collect()
    } else {
        Vec::new()
    };
    let region = rust_pill_shared::edge::drag_region(
        rust_pill_shared::edge::MonitorRect {
            x: full.x, y: full.y, width: full.width, height: full.height,
        },
        rust_pill_shared::edge::MonitorRect {
            x: wa.x, y: wa.y, width: wa.width, height: wa.height,
        },
        &neighbors,
        seam_point,
    );
    let area = region.bounds;
    let (alloc_w, alloc_h) = window.size();
    // window.size() returns logical pixels; XMoveWindow and the
    // workarea math above are in physical pixels, so scale here too.
    let win_w = alloc_w as f64 * scale;
    let content_h = crate::state::content_canvas_height(
        alloc_h as f64, state.below_slot_extra(),
    ) * scale;
    let margin = MARGIN_BOTTOM as f64 * scale;

    // The toplevel is a fixed-size transparent canvas; the visible pill
    // is drawn inside it, centred horizontally and bottom-anchored.
    // Clamping the *toplevel* into the work area boxes the pill into
    // the middle of the monitor — the invisible canvas margins eat
    // hundreds of pixels on every side. In dictation mode, clamp the
    // pill's visible footprint instead so it can be parked at the true
    // screen edges; panel/typing modes fill the canvas, so they keep
    // content-canvas clamping (the selector tail is transparent).
    //
    // Normalize impossible ranges before clamping. On a shared axis this
    // preserves the seam side; otherwise it safely collapses to the minimum.
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
                area.x - fx,
                area.y - fy,
                area.right() - fx - fw,
                area.bottom() - fy - fh,
            )
        } else {
            (area.x, area.y, area.right() - win_w, area.bottom() - content_h)
        };
    let (px, py, pw, ph) = crate::draw::pill_position(
        state, state.draw_width.get(), state.draw_height.get(),
    );
    let (content_x, content_y) = state.content_offset();
    let center_x = (content_x + px + pw / 2.0) * scale;
    let center_y = (content_y + py + ph / 2.0) * scale;
    let mut bounds = DragBounds { min_x, min_y, max_x, max_y };
    if seams_open {
        bounds.apply_shared_seam_bounds(area, (center_x, center_y), region.edge_mask);
    }
    bounds.collapse_inverted(region.edge_mask.preferred_minimum());

    Some(MonitorPlacement {
        bounds,
        work_x: wa.x,
        work_y: wa.y,
        work_w: wa.width,
        work_h: wa.height,
        win_w,
        content_h,
        margin,
        edge_mask: region.edge_mask,
    })
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
    let p = placement_on_monitor(
        anchor_x,
        anchor_y,
        dragging,
        display,
        window,
        state,
    )?;

    if dragging {
        // Keep the grabbed point of the window under the cursor (1:1
        // tracking instead of snapping the window centre to it),
        // clamped so the pill's footprint stays in the work area.
        let (drag_x, drag_y) = state.drag_press_offset.get();
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
        (p.work_y + p.work_h - p.content_h - p.margin) as c_int,
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

#[cfg(test)]
mod press_scale_tests {
    use super::*;

    #[test]
    fn first_frame_uses_the_physical_grab_captured_on_the_press_surface() {
        let grab = physical_grab_offset((40.0, 15.0), 2);
        let mut motion = rust_pill_shared::drag::DragController::new();
        motion.begin_drag(grab.0, grab.1, 0.0, 0.0, 0.0);
        // These are the destination monitor's physical bounds. Its logical
        // scale must not reinterpret the offset captured on the old surface.
        let output = motion.advance(&DragFrame {
            pointer_x: 500.0,
            pointer_y: 400.0,
            now: 0.02,
            dt: 0.02,
            bounds: DragBounds { min_x: 0.0, min_y: 0.0, max_x: 1000.0, max_y: 1000.0 },
            held: true,
            reduced_motion: true,
            edge_work: None,
        });
        assert!((output.x - 420.0).abs() < 1e-6);
        assert!((output.y - 370.0).abs() < 1e-6);
    }
}
