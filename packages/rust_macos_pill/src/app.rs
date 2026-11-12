use std::cell::{Cell, RefCell};
use std::ffi::{c_char, c_void};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;

use cocoa::appkit::{
    NSApp, NSApplication, NSApplicationActivationPolicyAccessory, NSBackingStoreBuffered, NSWindow,
    NSWindowCollectionBehavior,
};
use cocoa::base::{id, nil, NO, YES};
use cocoa::foundation::{NSAutoreleasePool, NSPoint, NSRect, NSSize};
use objc::declare::ClassDecl;
use objc::runtime::{Class, Object, Sel, BOOL};
// Note: `Object` import kept for potential future use (currently only `&Object` is needed)

use crate::constants::*;
use crate::draw;
use crate::gfx::{self, Ctx};
use crate::input;
use crate::ipc::{self, InMessage, OutMessage, Phase, Rect, ResetStrategy, Visibility};
use crate::nsstring::with_ns_string;
use rust_pill_shared::clock::monotonic_now as drag_now;
use rust_pill_shared::drag::{DragBounds, DragController, DragFrame};
use rust_pill_shared::hover::{HoverFrame, HoverIntent};
use rust_pill_shared::restore::ParkedWindow;

// ── Safe wrappers around common Cocoa FFI patterns ─────────────────────
// Issue #4: These reduce the blast radius of unsafe blocks by encapsulating
// individual msg_send! calls behind safe (well-defined semantics) wrappers.

/// Returns the current global mouse position in screen coordinates (bottom-up).
unsafe fn mouse_location() -> NSPoint {
    msg_send![class!(NSEvent), mouseLocation]
}

/// Returns a window's frame in screen coordinates.
unsafe fn window_frame(window: id) -> NSRect {
    msg_send![window, frame]
}

/// Sets a window's origin (top-left anchor in bottom-up coordinates).
unsafe fn set_window_origin(window: id, origin: NSPoint) {
    let _: () = msg_send![window, setFrameOrigin:origin];
}

/// Converts a point from view coords to window coords.
unsafe fn convert_point_to_view(view: id, point: NSPoint) -> NSPoint {
    msg_send![view, convertPoint:point fromView:nil]
}

/// Returns all screens.
unsafe fn screens() -> id {
    msg_send![class!(NSScreen), screens]
}

/// A display's UUID, which CoreFoundation owns until it is released.
type CFUUIDRef = *mut c_void;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGDisplayCreateUUIDFromDisplayID(display: u32) -> CFUUIDRef;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFUUIDCreateString(allocator: *const c_void, uuid: CFUUIDRef) -> id;
    fn CFRelease(value: *const c_void);
}

/// Returns the visible frame of a screen.
unsafe fn screen_visible_frame(screen: id) -> NSRect {
    msg_send![screen, visibleFrame]
}

/// The stable token of a screen, or `None` when it cannot be named.
///
/// `NSScreen`'s device description carries an `NSScreenNumber`, which is a
/// `CGDirectDisplayID`. That id is only stable for the life of the display's
/// connection: it changes across reboots, when a panel is replugged, and when
/// the arrangement changes enough for the window server to renumber. Storing it
/// would make a saved position unrecognisable after a restart, which is the
/// exact case the record exists for.
///
/// `CGDisplayCreateUUIDFromDisplayID` gives the display's UUID, which macOS
/// keeps for the physical panel, so the same monitor is recognised across
/// reconnects and reboots. The UUID is released after it is read; only its
/// string form matters here, and that is immediately reduced to a token.
unsafe fn screen_display_id(screen: id) -> Option<u64> {
    let description: id = msg_send![screen, deviceDescription];
    if description.is_null() {
        return None;
    }
    let number: id = msg_send![description, objectForKey: ns_string("NSScreenNumber")];
    if number.is_null() {
        return None;
    }
    let display: u32 = msg_send![number, unsignedIntValue];
    let uuid = CGDisplayCreateUUIDFromDisplayID(display);
    if uuid.is_null() {
        return None;
    }
    let uuid_string: id = CFUUIDCreateString(std::ptr::null(), uuid);
    CFRelease(uuid as *const c_void);
    if uuid_string.is_null() {
        return None;
    }
    let utf8: *const c_char = msg_send![uuid_string, UTF8String];
    let name = if utf8.is_null() {
        None
    } else {
        std::ffi::CStr::from_ptr(utf8)
            .to_str()
            .ok()
            .map(str::to_string)
    };
    CFRelease(uuid_string as *const c_void);
    name.and_then(|name| rust_pill_shared::layout::display_identity(&name))
}

/// A static `NSString` for a literal key, which is how an `NSDictionary` lookup
/// has to be spelled when the key is not already an `id`.
unsafe fn ns_string(value: &str) -> id {
    let string: id = msg_send![class!(NSString), alloc];
    let string: id =
        msg_send![string, initWithBytes:value.as_ptr() length:value.len() encoding:4u64];
    let _: id = msg_send![string, autorelease];
    string
}

/// Converts an AppKit (bottom-left origin, y-up) rectangle into the top-left,
/// y-down coordinate space Tauri uses for window positions. `primary_top` is
/// the AppKit y of the primary screen's top edge, so windows on screens above
/// the primary correctly come out with negative y values.
fn to_top_down(rect: NSRect, primary_top: f64) -> Rect {
    Rect {
        x: rect.origin.x,
        y: primary_top - (rect.origin.y + rect.size.height),
        width: rect.size.width,
        height: rect.size.height,
    }
}

/// Reads the pill window's screen rect and the visible frame of the monitor it
/// lives on, already flipped into Tauri's top-down coordinate space, so the
/// desktop can anchor the composer next to the real pill.
unsafe fn pill_geometry(window: id) -> (Rect, Rect) {
    let frame = window_frame(window);
    let screen: id = msg_send![window, screen];

    // `NSScreen.screens` can be EMPTY -- briefly when every display disconnects, the lid
    // closes, or the display sleeps. `objectAtIndex:0` on an empty array raises
    // `NSRangeException`, which is an Objective-C exception: it cannot be caught from Rust and
    // takes the pill process down with it. This runs from `tick_spatial_feedback` every frame,
    // and from `ResetPosition`, `RequestPosition` and `persist_drag_position`, so the window is
    // wide.
    //
    // `pill_center_monitor` already guards exactly this and returns `unknown`; the shape is
    // copied here. There is no meaningful monitor to report with no displays, so the window's
    // own frame stands in for both, which keeps the returned pair self-consistent instead of
    // measuring against a zeroed rect.
    let primary_screens = screens();
    let count: usize = msg_send![primary_screens, count];
    let primary_top = if count > 0 {
        let primary: id = msg_send![primary_screens, objectAtIndex: 0usize];
        let pf: NSRect = msg_send![primary, frame];
        pf.origin.y + pf.size.height
    } else {
        frame.origin.y + frame.size.height
    };

    let rect = to_top_down(frame, primary_top);
    // `msg_send![window, screen]` is nil when the window is on no display. Sending
    // `visibleFrame` to nil yields a zeroed NSRect, and the y-offset arithmetic above would
    // then be computed against nothing, so the frame stands in for it as well.
    let monitor = if (screen as *mut std::ffi::c_void).is_null() {
        to_top_down(frame, primary_top)
    } else {
        to_top_down(screen_visible_frame(screen), primary_top)
    };
    (rect, monitor)
}

use crate::state::{FlameTongue, PillState, Rocket, RocketPhase, Spark, WindowMode};

// ── CVDisplayLink & timing ───────────────────────────────────────

#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    fn CVDisplayLinkCreateWithActiveCGDisplays(link_out: *mut *mut c_void) -> i32;
    fn CVDisplayLinkSetOutputCallback(
        link: *mut c_void,
        callback: extern "C" fn(
            *mut c_void,
            *const c_void,
            *const c_void,
            u64,
            *mut u64,
            *mut c_void,
        ) -> i32,
        context: *mut c_void,
    ) -> i32;
    fn CVDisplayLinkStart(link: *mut c_void) -> i32;
}

extern "C" {
    fn dispatch_async_f(queue: *mut c_void, context: *mut c_void, work: extern "C" fn(*mut c_void));
    static _dispatch_main_q: u8;
}

// ── Thread-local shared state ─────────────────────────────────────

struct AppContext {
    state: Rc<PillState>,
    receiver: RefCell<Receiver<InMessage>>,
    window: id,
    view: id,
    entry: id,
    quit: Cell<bool>,
    last_tick_time: Cell<f64>,
    embedded: bool,
}

thread_local! {
    static APP_CTX: RefCell<Option<AppContext>> = const { RefCell::new(None) };
}

fn with_ctx<R>(f: impl FnOnce(&AppContext) -> R) -> Option<R> {
    APP_CTX.with(|cell| cell.borrow().as_ref().map(f))
}

// ── CVDisplayLink vsync callback ─────────────────────────────────

static NEEDS_TICK: AtomicBool = AtomicBool::new(false);

extern "C" fn display_link_callback(
    _link: *mut c_void,
    _now: *const c_void,
    _output_time: *const c_void,
    _flags_in: u64,
    _flags_out: *mut u64,
    _context: *mut c_void,
) -> i32 {
    if !NEEDS_TICK.swap(true, Ordering::Release) {
        unsafe {
            let main_q = &_dispatch_main_q as *const u8 as *mut c_void;
            dispatch_async_f(main_q, std::ptr::null_mut(), main_thread_tick);
        }
    }
    0
}

extern "C" fn main_thread_tick(_context: *mut c_void) {
    NEEDS_TICK.store(false, Ordering::Release);
    perform_tick();
}

// ── Custom NSView ─────────────────────────────────────────────────

fn register_pill_view_class() -> &'static Class {
    let superclass = Class::get("NSView").unwrap();
    let mut decl = ClassDecl::new("MausVoicePillView", superclass).unwrap();

    unsafe {
        decl.add_method(
            sel!(drawRect:),
            draw_rect as extern "C" fn(&Object, Sel, NSRect),
        );
        decl.add_method(
            sel!(isFlipped),
            is_flipped as extern "C" fn(&Object, Sel) -> BOOL,
        );
        decl.add_method(
            sel!(acceptsFirstResponder),
            accepts_first_responder as extern "C" fn(&Object, Sel) -> BOOL,
        );
        decl.add_method(
            sel!(acceptsFirstMouse:),
            accepts_first_mouse as extern "C" fn(&Object, Sel, id) -> BOOL,
        );
        decl.add_method(
            sel!(mouseDown:),
            mouse_down as extern "C" fn(&Object, Sel, id),
        );
        decl.add_method(
            sel!(mouseEntered:),
            mouse_entered as extern "C" fn(&Object, Sel, id),
        );
        decl.add_method(
            sel!(mouseExited:),
            mouse_exited as extern "C" fn(&Object, Sel, id),
        );
        decl.add_method(sel!(mouseUp:), mouse_up as extern "C" fn(&Object, Sel, id));
        decl.add_method(
            sel!(scrollWheel:),
            scroll_wheel as extern "C" fn(&Object, Sel, id),
        );
        decl.add_method(
            sel!(updateTrackingAreas),
            update_tracking_areas as extern "C" fn(&Object, Sel),
        );
        decl.add_method(
            sel!(tick:),
            tick_callback as extern "C" fn(&Object, Sel, id),
        );
        decl.add_method(
            sel!(hitTest:),
            hit_test as extern "C" fn(&Object, Sel, NSPoint) -> id,
        );
        decl.add_method(
            sel!(textFieldAction:),
            text_field_action as extern "C" fn(&Object, Sel, id),
        );
        decl.add_method(
            sel!(controlTextDidChange:),
            control_text_did_change as extern "C" fn(&Object, Sel, id),
        );
        decl.add_method(
            sel!(control:textView:doCommandBySelector:),
            control_do_command as extern "C" fn(&Object, Sel, id, id, Sel) -> BOOL,
        );
        decl.add_method(
            sel!(cancelOperation:),
            cancel_operation as extern "C" fn(&Object, Sel, id),
        );
    }

    decl.register()
}

fn register_pill_window_class() -> &'static Class {
    let superclass = Class::get("NSPanel").unwrap();
    let mut decl = ClassDecl::new("MausVoicePillWindow", superclass).unwrap();

    unsafe {
        decl.add_method(
            sel!(canBecomeKeyWindow),
            can_become_key_window as extern "C" fn(&Object, Sel) -> BOOL,
        );
    }

    decl.register()
}

/// Registers the object that listens for a screen-parameter change.
///
/// macOS has no per-window notification for "the displays changed". It posts
/// `NSApplicationDidChangeScreenParametersNotification` on the default
/// notification centre, and a response is required: when a display sleeps,
/// disconnects, changes resolution or changes scale, AppKit relocates the
/// windows it thinks no longer fit, and nothing tells the window whether the
/// move was its or the user's. Without an observer the pill is left wherever
/// AppKit put it, and its next save stores that instead of the place the user
/// chose.
fn register_screen_observer_class() -> &'static Class {
    if let Some(known) = Class::get("MausVoiceScreenObserver") {
        return known;
    }
    let superclass = Class::get("NSObject").unwrap();
    let mut decl = ClassDecl::new("MausVoiceScreenObserver", superclass).unwrap();
    // SAFETY: the selector and the trampoline agree on the signature
    // `(self, _cmd, NSNotification *)`, which is what the notification centre
    // sends.
    unsafe {
        decl.add_method(
            sel!(screenParametersChanged:),
            screen_parameters_changed as extern "C" fn(&Object, Sel, id),
        );
    }
    decl.register()
}

/// `NSApplicationDidChangeScreenParametersNotification` handler.
///
/// Runs on the main thread, synchronously with the notification, which is the
/// only point at which the new display list is guaranteed to be readable.
extern "C" fn screen_parameters_changed(_this: &Object, _sel: Sel, _notification: id) {
    with_ctx(|ctx| unsafe {
        reconcile_display_layout(ctx.window, &ctx.state);
    });
}

/// Start observing screen-parameter changes. The observer is never removed: the
/// pill owns it for the life of the process, and the notification centre holds it
/// weakly enough that a leaked registration cannot outlive the app.
unsafe fn observe_screen_parameters() {
    let observer_class = register_screen_observer_class();
    let observer: id = msg_send![observer_class, new];
    let center: id = msg_send![class!(NSNotificationCenter), defaultCenter];
    let name: id = ns_string("NSApplicationDidChangeScreenParametersNotification");
    let _: () = msg_send![center,
        addObserver:observer
        selector:sel!(screenParametersChanged:)
        name:name
        object:nil
    ];
}

// ── ObjC method implementations ──────────────────────────────────

extern "C" fn is_flipped(_this: &Object, _sel: Sel) -> BOOL {
    YES
}

extern "C" fn accepts_first_responder(_this: &Object, _sel: Sel) -> BOOL {
    YES
}

extern "C" fn can_become_key_window(_this: &Object, _sel: Sel) -> BOOL {
    let is_typing = with_ctx(|ctx| ctx.state.is_typing());
    if is_typing.unwrap_or(false) {
        YES
    } else {
        NO
    }
}

extern "C" fn accepts_first_mouse(_this: &Object, _sel: Sel, _event: id) -> BOOL {
    YES
}

extern "C" fn mouse_down(_this: &Object, _sel: Sel, event: id) {
    // Don't call super — prevents the window from stealing focus on click
    with_ctx(|ctx| {
        unsafe {
            let loc: NSPoint = msg_send![event, locationInWindow];
            let view_loc = convert_point_to_view(_this as *const _ as *mut _, loc);
            ctx.state.drag_cancelled.set(false);
            // Start long-press tracking if clicking on the pill body
            if input::is_on_pill_at(&ctx.state, view_loc.x, view_loc.y) {
                if ctx.state.drag_motion.borrow_mut().interrupt_settle() {
                    persist_drag_position(&ctx.state, ctx.window);
                }
                ctx.state.pointer_down.set(true);
                ctx.state.long_press_active.set(true);
                ctx.state.long_press_elapsed.set(0.0);
                ctx.state.long_press_start_x.set(view_loc.x);
                ctx.state.long_press_start_y.set(view_loc.y);
                // A display change while this gesture is live makes the drop
                // suspect, so the guard has to know a drag is in flight before the
                // change arrives rather than afterwards.
                ctx.state.save_guard.borrow_mut().drag_started();
            }
        }
    });
}

extern "C" fn draw_rect(this: &Object, _sel: Sel, _dirty: NSRect) {
    with_ctx(|ctx| unsafe {
        let ns_ctx: id = msg_send![class!(NSGraphicsContext), currentContext];
        let cg_ctx: gfx::CGContextRef = msg_send![ns_ctx, CGContext];
        let bounds: NSRect = msg_send![this, bounds];
        let gfx_ctx = Ctx::new(cg_ctx);
        draw::draw_all(&gfx_ctx, &ctx.state, bounds.size.width, bounds.size.height);
    });
}

extern "C" fn mouse_entered(_this: &Object, _sel: Sel, _event: id) {}

extern "C" fn mouse_exited(_this: &Object, _sel: Sel, _event: id) {
    with_ctx(|ctx| {
        // Dragging the pill drags its window, so the pointer routinely crosses
        // the tracking area's edge mid-gesture. Honouring that exit would
        // collapse the pill under the user's own drag.
        if ctx.state.pointer_down.get() {
            return;
        }
        // Leaving the tracking area is decisive: exit now instead of waiting
        // out the grace, and reset the controller so it cannot disagree.
        let was_hovered = ctx.state.hover_intent.borrow_mut().reset();
        ctx.state.hovered.set(false);
        if was_hovered {
            ipc::send(&OutMessage::Hover { hovered: false });
        }
    });
}

extern "C" fn mouse_up(_this: &Object, _sel: Sel, event: id) {
    with_ctx(|ctx| {
        // Track whether we were dragging (to suppress click on release)
        let was_dragging = ctx.state.dragging.get();
        // End the gesture and start the release settle (if still dragging)
        // through the shared teardown, so the mouseUp path and the frame-tick
        // missed-release backstop cannot drift apart.
        let now = drag_now();
        end_drag(&ctx.state, ctx.window, now);

        // Only fire click if the user wasn't dragging
        if !was_dragging && !ctx.state.drag_cancelled.get() {
            unsafe {
                let loc: NSPoint = msg_send![event, locationInWindow];
                let view_loc = convert_point_to_view(_this as *const _ as *mut _, loc);
                input::handle_click(&ctx.state, view_loc.x, view_loc.y);
            }
        }

        // Hover was pinned for the duration of the gesture; now that the
        // pointer is free, settle it against the cursor's real position so a
        // drag ending away from the pill collapses instead of staying open.
        update_hover(ctx.view, ctx);
    });
}

extern "C" fn scroll_wheel(_this: &Object, _sel: Sel, event: id) {
    with_ctx(|ctx| unsafe {
        let precise: bool = msg_send![event, hasPreciseScrollingDeltas];
        let dy: f64 = if precise {
            msg_send![event, scrollingDeltaY]
        } else {
            let line_dy: f64 = msg_send![event, deltaY];
            line_dy * 30.0
        };
        input::handle_scroll(&ctx.state, dy);
    });
}

extern "C" fn update_tracking_areas(this: &Object, _sel: Sel) {
    unsafe {
        // Remove existing tracking areas
        let areas: id = msg_send![this, trackingAreas];
        let count: usize = msg_send![areas, count];
        for i in (0..count).rev() {
            let area: id = msg_send![areas, objectAtIndex:i];
            let _: () = msg_send![this, removeTrackingArea:area];
        }

        // Add new tracking area for the full bounds
        let bounds: NSRect = msg_send![this, bounds];
        let options: usize = 0x01 | 0x02 | 0x10 | 0x20;
        // NSTrackingMouseEnteredAndExited | NSTrackingMouseMoved | NSTrackingActiveAlways | NSTrackingInVisibleRect
        let area: id = msg_send![class!(NSTrackingArea), alloc];
        let area: id = msg_send![area, initWithRect:bounds options:options owner:this userInfo:nil];
        let _: () = msg_send![this, addTrackingArea:area];

        // Call super
        let superclass = Class::get("NSView").unwrap();
        let _: () = msg_send![super(this, superclass), updateTrackingAreas];
    }
}

extern "C" fn hit_test(this: &Object, _sel: Sel, point: NSPoint) -> id {
    let interactive = with_ctx(|ctx| unsafe {
        let local: NSPoint = msg_send![this, convertPoint:point fromView:nil];
        input::is_interactive_at(&ctx.state, local.x, local.y)
    });

    if interactive.unwrap_or(false) {
        unsafe {
            let superclass = Class::get("NSView").unwrap();
            msg_send![super(this, superclass), hitTest:point]
        }
    } else {
        nil
    }
}

/// Read what a text field currently holds. A field that hands back nothing at
/// all reads as an empty string, and bytes that are not valid UTF-8 are
/// replaced rather than dropping the whole entry.
///
/// # Safety
/// `field` must be a live `NSTextField`.
unsafe fn field_string(field: id) -> String {
    let ns_text: id = msg_send![field, stringValue];
    if ns_text.is_null() {
        return String::new();
    }
    let cstr: *const std::os::raw::c_char = msg_send![ns_text, UTF8String];
    if cstr.is_null() {
        return String::new();
    }
    std::ffi::CStr::from_ptr(cstr)
        .to_string_lossy()
        .into_owned()
}

extern "C" fn text_field_action(_this: &Object, _sel: Sel, sender: id) {
    with_ctx(|ctx| {
        unsafe {
            *ctx.state.entry_text.borrow_mut() = field_string(sender);
        }
        // Enter submits: an insert decision while a transcript is under review,
        // a message to the assistant otherwise.
        if input::submit_entry(&ctx.state) {
            set_entry_text("");
        }
    });
}

/// Mirror every keystroke into state, the way the GTK pill does on `changed`.
///
/// The field only fires its action once the edit is committed, so without this
/// the buttons on the review panel would answer with the text as it stood at
/// the last frame instead of the text on screen.
extern "C" fn control_text_did_change(_this: &Object, _sel: Sel, notification: id) {
    with_ctx(|ctx| unsafe {
        let control: id = msg_send![notification, object];
        *ctx.state.entry_text.borrow_mut() = field_string(control);
        // ...and the other direction: the mirror emptied without the field being told, so
        // it is still showing text that has already gone. Safe to read here because
        // `entry_text` mirrors every keystroke, so it is empty only when something emptied
        // it. The Windows pill reconciles the same way; GTK does it where the entry reloads.
        if input::entry_should_be_cleared(&ctx.state.entry_text.borrow(), &field_string(control)) {
            set_entry_text("");
        }
    });
}

/// Escape while a transcript is under review cancels it, the same as on the
/// Windows pill. The field editor holds the keyboard while the entry is being
/// edited, and it routes Escape here as `cancelOperation:`. Every other command
/// keeps its standard behaviour.
extern "C" fn control_do_command(
    _this: &Object,
    _sel: Sel,
    _control: id,
    _text_view: id,
    command: Sel,
) -> BOOL {
    if command != sel!(cancelOperation:) {
        return NO;
    }
    if cancel_pending_review() {
        YES
    } else {
        NO
    }
}

/// Escape when the panel, rather than its entry, holds the keyboard.
///
/// The chain deliberately stops here: an Escape with no review to answer must
/// not travel up to the panel, which would close the pill window.
extern "C" fn cancel_operation(_this: &Object, _sel: Sel, _sender: id) {
    cancel_pending_review();
}

/// Send a cancel decision for the transcript under review, if there is one.
/// Returns whether a review was cancelled.
fn cancel_pending_review() -> bool {
    with_ctx(|ctx| match ctx.state.pending_review_id() {
        Some(review_id) => {
            input::send_review_decision(&review_id, "cancel", None);
            true
        }
        None => false,
    })
    .unwrap_or(false)
}

/// Put `text` in the panel's text field. Used to load a transcript into the
/// entry for review and to empty the field once it has been answered.
pub(crate) fn set_entry_text(text: &str) {
    with_ctx(|ctx| unsafe {
        with_ns_string(text, |ns| {
            let _: () = msg_send![ctx.entry, setStringValue:ns];
        });
    });
}

/// NSTimer callback: triggers one animation/interaction tick.
extern "C" fn tick_callback(_this: &Object, _sel: Sel, _timer: id) {
    perform_tick();
}

/// Runs one frame of the pill loop: processes queued IPC messages, advances
/// the springs/animations, and repaints when the state changed.
fn perform_tick() {
    // Phase message sequence guard: see ipc::InMessage::Phase.
    thread_local! {
        static LAST_PHASE_SEQ: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    }
    APP_CTX.with(|cell| {
        let borrow = cell.borrow();
        let Some(ctx) = borrow.as_ref() else { return };

        // Delta time (frame-rate independent animation)
        let now = drag_now();
        let prev = ctx.last_tick_time.get();
        ctx.last_tick_time.set(now);
        let dt = if prev == 0.0 {
            1.0 / 60.0
        } else {
            (now - prev).clamp(0.001, 0.05)
        };

        // Process IPC messages
        let rx = ctx.receiver.borrow();
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
                    let prev = ctx.state.phase.get();
                    ctx.state.phase.set(phase);
                    ctx.state
                        .style_tooltip_gate
                        .set_take_running(phase == Phase::Recording);
                    // A new take sweeps any banner parked above the pill (for
                    // example the retranscribing toast) so it cannot sit on the
                    // style selector for the whole take. A resume from Paused
                    // keeps toasts raised during the take, such as the cancel
                    // confirm.
                    if phase == Phase::Recording && matches!(prev, Phase::Idle | Phase::Loading) {
                        clear_flash(&ctx.state);
                    }
                    if rust_pill_shared::should_clear_stage_text_on_phase(
                        prev == Phase::Loading,
                        phase == Phase::Idle,
                        phase == Phase::Loading,
                    ) {
                        *ctx.state.stage_text.borrow_mut() = None;
                    }
                    if phase == Phase::Loading && prev != Phase::Loading {
                        let offset = if reduced_motion() { 0.5 } else { 0.0 };
                        ctx.state.loading_offset.set(offset);
                    }
                    if phase == Phase::Idle && prev != Phase::Idle {
                        ctx.state.pending_levels.borrow_mut().clear();
                        ctx.state.target_level.set(0.0);
                        ctx.state.current_level.set(0.0);
                        ctx.state.wave_phase.set(0.0);
                        ctx.state.loading_offset.set(0.0);
                    }
                }
                InMessage::Levels { levels } => {
                    *ctx.state.pending_levels.borrow_mut() = levels;
                }
                InMessage::StyleInfo { count, name } => {
                    ctx.state.style_count.set(count);
                    *ctx.state.style_name.borrow_mut() = name;
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
                    *ctx.state.flash_message.borrow_mut() = message;
                    ctx.state
                        .flash_is_error
                        .set(toast_type.as_deref() == Some("error"));
                    ctx.state.flash_visible.set(true);
                    ctx.state
                        .flash_timer
                        .set(duration.unwrap_or(FLASH_DURATION));
                    *ctx.state.flash_action.borrow_mut() = action;
                    *ctx.state.flash_action_label.borrow_mut() = action_label;
                    *ctx.state.flash_reject_action.borrow_mut() = reject_action;
                    *ctx.state.flash_reject_action_label.borrow_mut() = reject_action_label;
                }
                InMessage::DismissToast => {
                    clear_flash(&ctx.state);
                }
                InMessage::Fireworks { message } => {
                    *ctx.state.flash_message.borrow_mut() = message;
                    ctx.state.flash_is_error.set(false);
                    *ctx.state.flash_action.borrow_mut() = None;
                    *ctx.state.flash_action_label.borrow_mut() = None;
                    *ctx.state.flash_reject_action.borrow_mut() = None;
                    *ctx.state.flash_reject_action_label.borrow_mut() = None;
                    ctx.state.flash_visible.set(true);
                    ctx.state.flash_timer.set(FIREWORKS_TOTAL_DURATION);

                    ctx.state.fireworks_active.set(true);
                    ctx.state.fireworks_elapsed.set(0.0);
                    ctx.state.fireworks_next_launch.set(0);
                    ctx.state.fireworks_rockets.borrow_mut().clear();
                }
                InMessage::Flame { message } => {
                    *ctx.state.flash_message.borrow_mut() = message;
                    ctx.state.flash_is_error.set(false);
                    *ctx.state.flash_action.borrow_mut() = None;
                    *ctx.state.flash_action_label.borrow_mut() = None;
                    *ctx.state.flash_reject_action.borrow_mut() = None;
                    *ctx.state.flash_reject_action_label.borrow_mut() = None;
                    ctx.state.flash_visible.set(true);
                    ctx.state.flash_timer.set(FLAME_TOTAL_DURATION);

                    ctx.state.flame_active.set(true);
                    ctx.state.flame_elapsed.set(0.0);
                    ctx.state.flame_tongues.borrow_mut().clear();
                }
                InMessage::FlashBlue => {
                    ctx.state.flash_blue_active.set(true);
                    ctx.state.flash_blue_elapsed.set(0.0);
                }
                InMessage::BroadcastTranscript { text } => {
                    *ctx.state.transcript_text.borrow_mut() = text;
                    ctx.state.transcript_time_since_update.set(0.0);
                    ctx.state.transcript_has_message.set(true);
                }
                InMessage::StageText { text } => {
                    let stage = rust_pill_shared::active_stage_text(text.as_deref());
                    *ctx.state.stage_text.borrow_mut() = stage.map(str::to_owned);
                }
                InMessage::Visibility { visibility } => {
                    ctx.state.visibility.set(visibility);
                }
                InMessage::WindowSize { ref size } => {
                    let mode = WindowMode::from_str(size);
                    ctx.state.window_mode.set(mode);
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
                    let was_active = ctx.state.assistant_active.get();
                    let previous_review_id = ctx
                        .state
                        .assistant_review
                        .borrow()
                        .as_ref()
                        .map(|r| r.id.clone());
                    let review_id = review.as_ref().map(|r| r.id.clone());
                    let review_text = review.as_ref().map(|r| r.text.clone());
                    *ctx.state.assistant_review.borrow_mut() = review.map(|review| *review);

                    // The entry is the review surface: a new transcript loads
                    // into it for editing, and answering the review empties it
                    // again. An unchanged id leaves the user's edits alone.
                    if review_id != previous_review_id {
                        let text = review_text.unwrap_or_default();
                        *ctx.state.entry_text.borrow_mut() = text.clone();
                        set_entry_text(&text);
                    }
                    ctx.state.assistant_active.set(active);
                    *ctx.state.assistant_input_mode.borrow_mut() = input_mode;
                    ctx.state.assistant_compact.set(compact);
                    *ctx.state.assistant_conversation_id.borrow_mut() = conversation_id;
                    *ctx.state.assistant_user_prompt.borrow_mut() = user_prompt;
                    *ctx.state.assistant_messages.borrow_mut() = messages;
                    *ctx.state.assistant_streaming.borrow_mut() = streaming;
                    *ctx.state.assistant_permissions.borrow_mut() = permissions;

                    if (active && !was_active)
                        || (review_id.is_some() && review_id != previous_review_id)
                    {
                        ctx.state.should_stick.set(true);
                        ctx.state.scroll_offset.set(0.0);
                    }
                }
                InMessage::ResetPosition { strategy } => {
                    // Cancel ownership, not a normal release: no final sample
                    // or old drop may re-arm/overwrite this reset.
                    ctx.state.dragging.set(false);
                    ctx.state.pointer_down.set(false);
                    ctx.state.long_press_active.set(false);
                    ctx.state.long_press_elapsed.set(0.0);
                    ctx.state.drag_cancelled.set(true);
                    ctx.state.has_saved_position.set(false);
                    ctx.state.drag_motion.borrow_mut().reset();
                    ctx.state.selector_placement.borrow_mut().reset();
                    ctx.state.crossing.borrow_mut().reset();
                    ctx.state
                        .anchor
                        .set(rust_pill_shared::layout::Anchor::from_reset(
                            strategy == ResetStrategy::Cursor,
                        ));
                    reposition_window(ctx.window, &ctx.state, dt, now);
                    let (rect, monitor) = unsafe { pill_geometry(ctx.window) };
                    ipc::send(&OutMessage::PositionChanged {
                        report: rust_pill_shared::restore::PositionReport::new(
                            false,
                            Some(rect),
                            Some(monitor),
                            None,
                        ),
                    });
                }
                InMessage::ForgetPosition => {
                    // Stop treating where the pill is sitting as the saved position.
                    // Local data was just cleared, and the next `RequestPosition`
                    // republishes this flag, so leaving it set would write the row back.
                    ctx.state.has_saved_position.set(false);
                    // A clear drops the record without moving the window, and it also
                    // cancels any placement still owed: a pill the user has been
                    // looking at must not follow the pointer because a database was
                    // wiped.
                    ctx.state.drag_save_due.set(None);
                    ctx.state
                        .anchor
                        .set(rust_pill_shared::layout::Anchor::from_forget());
                }
                InMessage::RequestPosition => {
                    let (rect, monitor) = unsafe { pill_geometry(ctx.window) };
                    ipc::send(&OutMessage::PositionChanged {
                        report: rust_pill_shared::restore::PositionReport::new(
                            ctx.state.has_saved_position.get(),
                            Some(rect),
                            Some(monitor),
                            ctx.state.saved_display_id.get(),
                        ),
                    });
                }
                InMessage::Quit => {
                    ctx.quit.set(true);
                }
            }
        }
        drop(rx);

        if ctx.quit.get() {
            unsafe {
                if ctx.embedded {
                    let _: () = msg_send![ctx.window, orderOut:nil];
                } else {
                    let app: id = msg_send![class!(NSApplication), sharedApplication];
                    let _: () = msg_send![app, terminate:nil];
                }
            }
            return;
        }

        // A mouseUp can be missed (another app steals the event, the session
        // locks). Poll the real button state so a released button can never
        // leave hover pinned open — the same backstop the Windows pill uses.
        release_pointer_if_button_up(&ctx.state, ctx.window);

        // Compute hover from actual mouse position over pill area
        update_hover(ctx.view, ctx);

        tick(&ctx.state, ctx.window, dt);

        // Show/hide entry for typing mode
        let is_typing = ctx.state.is_typing();
        unsafe {
            let entry = ctx.entry;
            let entry_hidden: BOOL = msg_send![entry, isHidden];
            if is_typing && entry_hidden != NO {
                let _: () = msg_send![entry, setHidden:NO];
                let _: () = msg_send![ctx.window, makeKeyWindow];
                let _: () = msg_send![ctx.window, makeFirstResponder:entry];
            } else if !is_typing && entry_hidden == NO {
                let _: () = msg_send![entry, setHidden:YES];
                let _: () = msg_send![ctx.window, resignKeyWindow];
            }

            // Sync entry text to state. `controlTextDidChange:` already does
            // this on every keystroke; this covers changes the delegate does
            // not see, such as a paste routed by the system.
            if is_typing {
                *ctx.state.entry_text.borrow_mut() = field_string(entry);
            }
        }

        // Visibility
        let should_show = rust_pill_shared::should_show_pill(
            ctx.state.visibility.get().into(),
            ctx.state.phase.get() != Phase::Idle,
            ctx.state.owns_panel(),
        );
        unsafe {
            if should_show {
                let _: () = msg_send![ctx.window, orderFront:nil];
            } else {
                let _: () = msg_send![ctx.window, orderOut:nil];
            }
        }

        // The notification is the primary signal, but macOS can drop it while the
        // app is not frontmost, and a screen that sleeps and wakes within one run
        // loop turn can produce no notification at all. A cheap signature of the
        // arrangement catches what the notification misses, only later.
        unsafe {
            poll_display_layout(ctx.window, &ctx.state, now);
        }

        // Reposition window: follow cursor when dragging, auto-center otherwise
        reposition_window(ctx.window, &ctx.state, dt, now);
        // Reset/rehome must finish before the detector seeds its next sample.
        tick_spatial_feedback(ctx.window, &ctx.state, dt, now);

        // Request redraw
        unsafe {
            let _: () = msg_send![ctx.view, setNeedsDisplay:YES];
        }
    });
}

// ── Hover detection ──────────────────────────────────────────────

/// Clears the pointer-down pin if the physical button is no longer held.
///
/// `mouseUp:` is not guaranteed to arrive — another process can steal the
/// event, or the session can lock mid-gesture. Without this backstop a lost
/// release would pin hover open until the next click.
/// Ends the gesture and tears down any active drag.
///
/// Persists the dropped window position when a drag was in progress, then
/// clears the drag and gesture flags, so a missed `mouseUp:` caught by the
/// frame-tick backstop does not strand the pill at its old position.
fn end_drag(state: &PillState, _window: id, now: f64) {
    if state.dragging.get() {
        // The drop point persists when the release settle finishes (the frame
        // tick calls persist_drag_position on the settled frame), so the saved
        // position always matches where the pill landed.
        state.drag_motion.borrow_mut().end_drag(now);
    }
    state.dragging.set(false);
    state.long_press_active.set(false);
    state.long_press_elapsed.set(0.0);
    state.pointer_down.set(false);
}

/// Retains the settled position and tells the desktop, which stores it so the
/// next launch can restore it.
///
/// The live window origin (not the cursor) is what is kept, so the saved point
/// matches where the pill landed. The state copy stays in Cocoa's bottom-left
/// space for this process's own placement, while the record the desktop stores
/// is the published top-down rect, so save and restore use one space.
fn persist_drag_position(state: &PillState, window: id) {
    let now = drag_now();
    // The drop is recorded exactly here, once per gesture. Retries must not come
    // through this function: `drag_ended` is what starts the drag hold, so a retry
    // that called it would push the hold's start forward on every frame and the
    // hold would never expire.
    state.save_guard.borrow_mut().drag_ended(now);
    write_drag_position(state, window, now);
}

/// Write a drop the guard has allowed, without re-recording when it landed.
///
/// This is the retry path. It only asks whether the holds have passed; the drop
/// time it is measured against was set once, by the release.
fn write_drag_position(state: &PillState, window: id, now: f64) {
    // Read before the save is attempted: a successful save clears it.
    let due = state.save_guard.borrow().save_due_at(now);
    if !state.save_guard.borrow().allows_save(now) {
        // The layout changed under this drag, so the frame it ended on is one
        // AppKit chose. Storing it would replace the position the user actually
        // picked with the one macOS improvised, and afterwards the two are
        // indistinguishable.
        //
        // The drop is still the user's, and the controller reports `settled` only
        // once, so the deadline is what keeps it from being lost.
        //
        // The origin is recorded now, while it is still the drop. Waiting for the
        // retry would read whatever the window had been moved to by then, and the
        // drop this deadline exists to protect would be replaced by the idle
        // placement it was parked at.
        let frame = unsafe { window_frame(window) };
        state.saved_x.set(frame.origin.x);
        state.saved_y.set(frame.origin.y);
        state.drag_save_due.set(due);
        return;
    }
    let frame = unsafe { window_frame(window) };
    state.saved_x.set(frame.origin.x);
    state.saved_y.set(frame.origin.y);
    state.has_saved_position.set(true);
    // The pending drop has been recorded, so no retry is owed.
    state.drag_save_due.set(None);
    // Name the display in the same breath as the origin, so the record can
    // recognise this panel after it is unplugged and replugged.
    let display_id = unsafe {
        let screen: id = msg_send![window, screen];
        if screen.is_null() {
            None
        } else {
            screen_display_id(screen)
        }
    };
    state.saved_display_id.set(display_id);
    let (rect, monitor) = unsafe { pill_geometry(window) };
    ipc::send(&OutMessage::PositionChanged {
        report: rust_pill_shared::restore::PositionReport::new(
            true,
            Some(rect),
            Some(monitor),
            display_id,
        ),
    });
}

/// True when macOS accessibility asks for reduced motion.
fn reduced_motion() -> bool {
    unsafe {
        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let reduce: BOOL = msg_send![workspace, accessibilityDisplayShouldReduceMotion];
        reduce == YES
    }
}

/// Clears the pointer-down pin if the physical button is no longer held.
///
/// `mouseUp:` is not guaranteed to arrive — another process can steal the
/// event, or the session can lock mid-gesture. Without this backstop a lost
/// release would pin hover open until the next click.
fn release_pointer_if_button_up(state: &PillState, window: id) {
    if !state.pointer_down.get() {
        return;
    }
    // Bit 0 is the primary button; NSEvent reports the physical state, so this
    // is independent of any left/right swap.
    let buttons: u64 = unsafe { msg_send![class!(NSEvent), pressedMouseButtons] };
    if buttons & 1 != 0 {
        return;
    }
    let now = drag_now();
    end_drag(state, window, now);
}

fn update_hover(view: id, ctx: &AppContext) {
    let (probed, mouse_x, mouse_y) = unsafe {
        let window: id = msg_send![view, window];
        let mouse_screen: NSPoint = msg_send![class!(NSEvent), mouseLocation];
        let mouse_win: NSPoint = msg_send![window, convertPointFromScreen:mouse_screen];
        let mouse_view: NSPoint = msg_send![view, convertPoint:mouse_win fromView:nil];
        (
            input::is_in_hover_zone(&ctx.state, mouse_view.x, mouse_view.y),
            mouse_view.x,
            mouse_view.y,
        )
    };

    // Hover intent: the pointer must dwell on the pill at low speed before
    // expansion and tooltips fire, and they linger through a short grace once
    // it leaves, so fast pass-throughs never flicker the pill. A held button
    // pins hover regardless of the hit test above.
    let output = ctx.state.hover_intent.borrow_mut().advance(&HoverFrame {
        probed,
        pointer_x: mouse_x,
        pointer_y: mouse_y,
        now: drag_now(),
        pointer_down: ctx.state.pointer_down.get(),
    });
    ctx.state.hovered.set(output.hovered);
    if output.entered || output.exited {
        ipc::send(&OutMessage::Hover {
            hovered: output.hovered,
        });
    }
}

// ── Animation tick ────────────────────────────────────────────────

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

fn ns_rect_to_monitor_rect(frame: NSRect) -> rust_pill_shared::edge::MonitorRect {
    rust_pill_shared::edge::MonitorRect::without_id(
        frame.origin.x,
        frame.origin.y,
        frame.size.width,
        frame.size.height,
    )
}

fn crossing_identity(
    frame: NSRect,
    primary_top: f64,
    cx_up: f64,
    cy_up: f64,
) -> (f64, f64, f64, f64, f64, f64) {
    let monitor = to_top_down(frame, primary_top);
    (
        monitor.x,
        monitor.y,
        monitor.width,
        monitor.height,
        cx_up,
        primary_top - cy_up,
    )
}

/// Full bounds of the screen containing the pill center, plus the center
/// itself, in top-down points. Drives the crossing detector; the transparent
/// canvas may straddle a boundary the pill itself has not crossed. Unknown
/// when no screen contains the center.
unsafe fn pill_center_monitor(window: id, state: &PillState) -> (f64, f64, f64, f64, f64, f64) {
    let unknown = (f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN);
    let frame = window_frame(window);
    let (px, py, pw, ph) =
        draw::pill_position(state, state.draw_width.get(), state.draw_height.get());
    let (cox, coy) = state.content_offset();
    // View is flipped y-down; the window origin is bottom-left y-up.
    let cx_up = frame.origin.x + cox + px + pw / 2.0;
    let cy_up = frame.origin.y + frame.size.height - (coy + py + ph / 2.0);
    let screens = screens();
    let count: usize = msg_send![screens, count];
    let primary: id = if count > 0 {
        msg_send![screens, objectAtIndex:0usize]
    } else {
        return unknown;
    };
    let pf: NSRect = msg_send![primary, frame];
    let primary_top = pf.origin.y + pf.size.height;
    for i in 0..count {
        let screen: id = msg_send![screens, objectAtIndex:i];
        let frame: NSRect = msg_send![screen, frame];
        if cx_up >= frame.origin.x
            && cx_up < frame.origin.x + frame.size.width
            && cy_up >= frame.origin.y
            && cy_up < frame.origin.y + frame.size.height
        {
            return crossing_identity(frame, primary_top, cx_up, cy_up);
        }
    }
    unknown
}

fn tick_spatial_feedback(window: id, state: &PillState, dt: f64, now: f64) {
    // Monitor crossing from the pill center: deformation is paint-only, so
    // hit regions and saved positions never see it. A reduced-motion trigger
    // arms the border flash instead.
    let (mon_x, mon_y, mon_w, mon_h, pcx, pcy) = unsafe { pill_center_monitor(window, state) };
    let rm = reduced_motion();
    let out = state
        .crossing
        .borrow_mut()
        .advance(&rust_pill_shared::deform::CrossingFrame {
            monitor_x: mon_x,
            monitor_y: mon_y,
            monitor_width: mon_w,
            monitor_height: mon_h,
            pill_cx: pcx,
            pill_cy: pcy,
            now,
            dt,
            stiffness: SPRING_STIFFNESS,
            reduced_motion: rm,
        });
    if out.triggered && rm {
        state.flash_blue_active.set(true);
        state.flash_blue_elapsed.set(0.0);
    }

    // Selector side from the live headroom: the selector drops below the
    // pill exactly when the strip above no longer fits it. Draw and hit
    // testing read the blend back every frame, so both track the animation.
    let space_above = unsafe {
        let (rect, monitor) = pill_geometry(window);
        let (_, oy) = state.content_offset();
        let (_, pill_y, _, _) =
            draw::pill_position(state, state.draw_width.get(), state.draw_height.get());
        (rect.y - monitor.y) / state.ui_scale + oy + pill_y
    };
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

/// Advances all pill animations by `dt` seconds: audio levels, springs
/// (expand, tooltip, panel, keyboard button, window size, pause crossfade,
/// cancel controls, drag inflate), and the fireworks/flame/flash/transcript
/// sub-tickers.
fn tick(state: &PillState, window: id, dt: f64) {
    let phase = state.phase.get();
    let is_active = phase != Phase::Idle;
    let is_recording = phase == Phase::Recording;
    let is_loading = phase == Phase::Loading;
    let hovered = state.hovered.get();
    let frame_scale = dt * 60.0; // Scale factor relative to 60fps baseline

    // Audio levels (frame-rate independent)
    if is_recording {
        let levels = std::mem::take(&mut *state.pending_levels.borrow_mut());
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
            state
                .current_level
                .set(state.current_level.get() * 0.4_f64.powf(frame_scale));
            if state.current_level.get() < 0.0002 {
                state.current_level.set(0.0);
            }
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

    // Pill expand/collapse (spring) — snappier than tooltip/panel so the
    // primary affordance feels instant. See PILL_EXPAND_STIFFNESS.
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

    // Shimmer phase
    state
        .shimmer_phase
        .set((state.shimmer_phase.get() + SHIMMER_SPEED * frame_scale) % 1.0);

    // Fireworks
    tick_fireworks(state, dt);

    // Flame
    tick_flame(state, dt);

    // Flash blue border
    tick_flash_blue(state, dt);

    // Broadcast transcript
    tick_transcript(state, dt);

    // Long-press balloon pop + drag
    tick_long_press(state, window, dt);

    // Flash message timer
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
        tooltip_target > 0.5,
    );
    rust_pill_shared::spring::spring_01(
        &state.flash_t,
        &state.flash_velocity,
        flash_target,
        SPRING_STIFFNESS,
        dt,
    );

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

    // Auto-scroll to bottom
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

    // Launch rockets on schedule
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

fn tick_long_press(state: &PillState, window: id, dt: f64) {
    if !state.long_press_active.get() {
        return;
    }

    // Don't allow long-press while recording, loading, paused, or in assistant mode
    let phase = state.phase.get();
    if phase != Phase::Idle || state.assistant_active.get() {
        state.long_press_active.set(false);
        state.long_press_elapsed.set(0.0);
        return;
    }

    // Cancel if mouse moved too far from start position (all coords in screen space).
    unsafe {
        let mouse = mouse_location();
        let origin = window_frame(window).origin;
        let start_screen_x = origin.x + state.long_press_start_x.get();
        let start_screen_y = origin.y + state.long_press_start_y.get();
        let dx = mouse.x - start_screen_x;
        let dy = mouse.y - start_screen_y;
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

        // Anchor the drag to the point the user grabbed so the pill tracks the
        // cursor 1:1 instead of jumping to centre itself under the pointer.
        unsafe {
            let mouse = mouse_location();
            let origin = window_frame(window).origin;
            // Arm the shared controller with the grab point, and seed it
            // with the arm sample so a quick release still has velocity data.
            let now = drag_now();
            state.drag_motion.borrow_mut().begin_drag(
                mouse.x - origin.x,
                mouse.y - origin.y,
                origin.x,
                origin.y,
                now,
            );
            state
                .drag_motion
                .borrow_mut()
                .push_sample(mouse.x, mouse.y, now);
        }
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

// ── Window positioning ────────────────────────────────────────────

fn reposition_window(window: id, state: &PillState, dt: f64, now: f64) {
    unsafe {
        let mouse_loc = mouse_location();
        let screens = screens();
        let count: usize = msg_send![screens, count];

        let win_frame = window_frame(window);
        let win_w = win_frame.size.width;
        let win_h = win_frame.size.height;

        // A drag uses the cursor screen and settles on its drop screen. Everything else
        // belongs to the screen the pill actually lives on — resolving the
        // screen from the live cursor here is what made a pinned pill hop
        // monitors (and clamp into the wrong visible frame) whenever the
        // pointer crossed a screen edge.
        let dragging = state.dragging.get();
        let settling = state.drag_motion.borrow().is_settling();
        // One question, answered in one place: is this pill due a placement, and
        // does that placement follow the pointer? The shared model owns both
        // halves so the three pills cannot answer differently.
        let anchor = if state.has_saved_position.get() {
            rust_pill_shared::layout::Anchor::Saved
        } else {
            state.anchor.get()
        };
        // A reset is a placement the user asked for, so it is due even though the
        // pill has already been placed once in this process. Only an initial launch
        // is one-shot; the anchor's variant is what makes a reset follow the
        // pointer, and demoting it is what stops the pill being chased.
        // A launch placement happens once per process; a reset is due every time it
        // is asked for. `first_placement_done` is only that one-shot latch.
        let first_placement = anchor == rust_pill_shared::layout::Anchor::LaunchAtCursor
            && !state.first_placement_done.get();
        let reset_placement = matches!(
            anchor,
            rust_pill_shared::layout::Anchor::ResetAtCursor
                | rust_pill_shared::layout::Anchor::ResetAtCurrent
        );
        let (px, py, pw, ph) =
            draw::pill_position(state, state.draw_width.get(), state.draw_height.get());
        let (cox, coy) = state.content_offset();
        let fx = cox + px;
        let fy = coy + py;
        // View is flipped y-down; screen origin is bottom-left (y-up).
        let footprint_center = |origin_x: f64, origin_y: f64| {
            (origin_x + fx + pw / 2.0, origin_y + win_h - fy - ph / 2.0)
        };
        // Three placements, in priority order, and they are not the same thing:
        //
        //   * a held or settling drag owns the window and follows the pointer;
        //   * a first placement happens once per process and follows the pointer;
        //   * a reset the user asked for is due a placement even though one has
        //     already happened, and follows the pointer only when it asked to.
        //
        // Only the first two are one-shot. A reset must not be, or the pill the
        // user just asked to re-home stays exactly where it was, and a first
        // placement must be, or it chases the pointer forever.
        let follows_pointer = dragging || settling || first_placement;
        let (anchor_x, anchor_y) = if follows_pointer {
            if first_placement {
                // Mark it done only when it is acted on, so a frame that bails out
                // earlier cannot consume the one-shot placement, and demote the
                // anchor so later ticks stay put instead of chasing the pointer.
                state.first_placement_done.set(true);
                state
                    .anchor
                    .set(rust_pill_shared::layout::Anchor::ResetAtCurrent);
            }
            state
                .drag_motion
                .borrow()
                .monitor_anchor((mouse_loc.x, mouse_loc.y), dragging)
        } else if reset_placement && anchor.follows_pointer() {
            // A cleared pill never reaches here: the guard below returns before
            // placement, so this branch only serves a reset that named the pointer.
            (mouse_loc.x, mouse_loc.y)
        } else if state.has_saved_position.get() {
            footprint_center(state.saved_x.get(), state.saved_y.get())
        } else {
            footprint_center(win_frame.origin.x, win_frame.origin.y)
        };

        // Resolve monitor bounds in Cocoa's global point space. A connected
        // neighbor opens only its shared edge; the visible frame remains the
        // clamp on exposed edges to keep the Dock and menu bar clear.
        let monitor_frames: Vec<rust_pill_shared::edge::MonitorRect> = (0..count)
            .map(|i| {
                let screen: id = msg_send![screens, objectAtIndex:i];
                let frame: NSRect = msg_send![screen, frame];
                ns_rect_to_monitor_rect(frame)
            })
            .collect();
        let mut chosen: Option<(
            NSRect,
            rust_pill_shared::edge::MonitorRect,
            rust_pill_shared::edge::EdgeMask,
        )> = None;
        for i in 0..count {
            let screen: id = msg_send![screens, objectAtIndex:i];
            let frame: NSRect = msg_send![screen, frame];
            if anchor_x >= frame.origin.x
                && anchor_x < frame.origin.x + frame.size.width
                && anchor_y >= frame.origin.y
                && anchor_y < frame.origin.y + frame.size.height
            {
                let visible = screen_visible_frame(screen);
                let full = ns_rect_to_monitor_rect(frame);
                let work_area = ns_rect_to_monitor_rect(visible);
                let seam_point = footprint_center(win_frame.origin.x, win_frame.origin.y);
                let region = if dragging {
                    state.drag_motion.borrow_mut().resolve_drag_region(
                        full,
                        work_area,
                        &monitor_frames,
                        seam_point,
                    )
                } else {
                    rust_pill_shared::edge::drag_region(
                        full,
                        work_area,
                        &monitor_frames,
                        seam_point,
                    )
                };
                chosen = Some((visible, region.bounds, region.edge_mask));
                break;
            }
        }

        // If a display disappears mid-drag, retain the primary screen's safe
        // visible frame rather than freezing at stale coordinates.
        let (visible, drag_region, edge_mask) = match chosen {
            Some(resolved) => resolved,
            None if count > 0 => {
                let primary: id = msg_send![screens, objectAtIndex:0usize];
                let frame: NSRect = msg_send![primary, frame];
                let visible = screen_visible_frame(primary);
                let full = ns_rect_to_monitor_rect(frame);
                let work_area = ns_rect_to_monitor_rect(visible);
                let seam_point = footprint_center(win_frame.origin.x, win_frame.origin.y);
                let region = if dragging {
                    state.drag_motion.borrow_mut().resolve_drag_region(
                        full,
                        work_area,
                        &monitor_frames,
                        seam_point,
                    )
                } else {
                    rust_pill_shared::edge::drag_region(
                        full,
                        work_area,
                        &monitor_frames,
                        seam_point,
                    )
                };
                (visible, region.bounds, region.edge_mask)
            }
            None => return,
        };

        // Keep the work-area clamp on exposed sides, but use the full display
        // edge on shared seams so the grab point can cross without resistance.
        let clamp_frame = if dragging {
            drag_region
        } else {
            rust_pill_shared::edge::MonitorRect {
                x: visible.origin.x,
                y: visible.origin.y,
                width: visible.size.width,
                height: visible.size.height,
                id: None,
            }
        };
        // The OS window is a fixed transparent canvas; clamp the visible pill
        // footprint in dictation mode so transparent canvas margins do not
        // box the pill away from the actual screen edge.
        let (min_x, min_y, max_x, max_y) = if state.effective_window_mode() == WindowMode::Dictation
            && !state.assistant_active.get()
        {
            (
                clamp_frame.x - fx,
                clamp_frame.y - win_h + fy + ph,
                clamp_frame.right() - fx - pw,
                clamp_frame.bottom() - win_h + fy,
            )
        } else {
            (
                clamp_frame.x,
                clamp_frame.y,
                clamp_frame.right() - win_w,
                clamp_frame.bottom() - win_h,
            )
        };
        let mut bounds = DragBounds {
            min_x,
            min_y,
            max_x,
            max_y,
        };
        if dragging {
            bounds.apply_shared_seam_bounds(
                drag_region,
                (fx + pw / 2.0, win_h - fy - ph / 2.0),
                edge_mask,
            );
        }

        let edge_work_mask = if dragging {
            edge_mask
        } else {
            rust_pill_shared::edge::EdgeMask::ALL
        };
        bounds.collapse_inverted(edge_work_mask, (win_frame.origin.x, win_frame.origin.y));

        if dragging || settling {
            drive_drag_frame(
                window,
                state,
                DragTick {
                    pointer: (mouse_loc.x, mouse_loc.y),
                    now,
                    dt,
                    bounds,
                    visible,
                    edges: edge_work_mask,
                    dragging,
                    settling,
                },
            );
            return;
        }

        // A drop the display change held back is written as soon as both holds
        // have passed: the controller reports `settled` once, so nothing else
        // would come back for it.
        //
        // Checked before the idle placement, not after: while a save is owed the
        // window is still standing where the user dropped it, and parking it first
        // would move it off that spot before the retry could read it.
        if state.drag_save_due.get().is_some() {
            write_drag_position(state, window, drag_now());
            return;
        }

        park_window(window, state, anchor, visible, bounds, win_h);
    }
}

/// One frame of a held or settling drag.
struct DragTick {
    pointer: (f64, f64),
    now: f64,
    dt: f64,
    bounds: rust_pill_shared::drag::DragBounds,
    visible: NSRect,
    edges: rust_pill_shared::edge::EdgeMask,
    dragging: bool,
    settling: bool,
}

/// Advance the shared drag controller and move the window to where it lands.
///
/// Drag motion is direct 1:1 tracking while held and a velocity-aware settle after
/// release. Both apply every frame with no deadband, so the window never trails the
/// cursor; the parked path keeps its 1 px deadband against jitter.
fn drive_drag_frame(window: id, state: &PillState, tick: DragTick) {
    let output = state.drag_motion.borrow_mut().advance(&DragFrame {
        pointer_x: tick.pointer.0,
        pointer_y: tick.pointer.1,
        now: tick.now,
        dt: tick.dt,
        bounds: tick.bounds,
        edge_work: Some(rust_pill_shared::edge::EdgeWork {
            width: tick.visible.size.width,
            height: tick.visible.size.height,
            edges: tick.edges,
        }),
        held: tick.dragging,
        reduced_motion: reduced_motion(),
    });
    unsafe { set_window_origin(window, NSPoint::new(output.x, output.y)) };
    if tick.settling && output.settled {
        persist_drag_position(state, window);
    }
}

/// Hold the window at the parked origin for this frame.
///
/// The saved origin comes from the last drag and is clamped into the visible
/// frame of the screen that position belongs to; with nothing saved, the pill
/// centres at the bottom of its own screen. Both are the *idle* placement, which
/// is the one case that has no cursor to follow.
fn park_window(
    window: id,
    state: &PillState,
    anchor: rust_pill_shared::layout::Anchor,
    visible: NSRect,
    bounds: rust_pill_shared::drag::DragBounds,
    win_h: f64,
) {
    if !anchor.places() {
        // No stored position and nothing asked for a placement: the flag was
        // cleared deliberately, by `ForgetPosition` after a local-data clear.
        // That command's contract is that the pill stays where it is, so falling
        // through to the default anchor would move a visible pill as a side
        // effect of wiping the database.
        return;
    }
    let (target_x, target_y) = if state.has_saved_position.get() {
        let tx = state.saved_x.get().max(bounds.min_x).min(bounds.max_x);
        let ty = state.saved_y.get().max(bounds.min_y).min(bounds.max_y);
        (tx, ty)
    } else {
        let win_w = unsafe { window_frame(window) }.size.width;
        let tx = visible.origin.x + (visible.size.width - win_w) / 2.0;
        (tx, default_content_origin_y(visible.origin.y, win_h))
    };

    let current_origin = unsafe { window_frame(window).origin };
    if (current_origin.x - target_x).abs() > 1.0 || (current_origin.y - target_y).abs() > 1.0 {
        unsafe { set_window_origin(window, NSPoint::new(target_x, target_y)) };
    }
    // The clamp is what the window is held at, so it is what the stored record
    // has to say. Leaving the pre-clamp origin behind publishes a spot the pill
    // is not on, and the next tick would put it back there.
    if (target_x - state.saved_x.get()).abs() > f64::EPSILON
        || (target_y - state.saved_y.get()).abs() > f64::EPSILON
    {
        state.saved_x.set(target_x);
        state.saved_y.set(target_y);
    }
}

fn default_content_origin_y(work_bottom: f64, window_height: f64) -> f64 {
    let below_content = (window_height - WINDOW_H_TYPING as f64).max(0.0);
    work_bottom + MARGIN_BOTTOM as f64 - below_content
}

// The native entry shares the fixed content coordinates used by draw_all and
// hit testing. Extra window space is reserved only for the below selector.
fn typing_entry_frame() -> NSRect {
    let panel_x = (WINDOW_W_TYPING as f64 - PANEL_EXPANDED_WIDTH) / 2.0;
    let top_pad = 12.0;
    NSRect::new(
        NSPoint::new(
            panel_x + PANEL_CONTENT_SIDE_INSET,
            WINDOW_H_TYPING as f64 - PANEL_BOTTOM_MARGIN - PANEL_INPUT_HEIGHT + top_pad,
        ),
        NSSize::new(
            PANEL_EXPANDED_WIDTH - PANEL_CONTENT_SIDE_INSET * 2.0 - 36.0,
            PANEL_INPUT_HEIGHT - top_pad,
        ),
    )
}

// ── Display changes ──────────────────────────────────────────────

/// Every connected screen's visible frame in top-down points, each with its
/// stable token, plus the primary display's top edge.
///
/// Returns `None` with no screens, which happens briefly when every display
/// disconnects or the lid closes. A caller must read that as "nothing to
/// act on", not as "the pill's display was unplugged".
unsafe fn display_areas() -> Option<(Vec<rust_pill_shared::edge::MonitorRect>, f64)> {
    let screen_list = screens();
    if screen_list.is_null() {
        return None;
    }
    let count: usize = msg_send![screen_list, count];
    if count == 0 {
        return None;
    }
    let primary: id = msg_send![screen_list, objectAtIndex: 0usize];
    let primary_frame: NSRect = msg_send![primary, frame];
    let primary_top = primary_frame.origin.y + primary_frame.size.height;

    let mut areas = Vec::with_capacity(count);
    for index in 0..count {
        let screen: id = msg_send![screen_list, objectAtIndex: index];
        let area = to_top_down(screen_visible_frame(screen), primary_top);
        areas.push(rust_pill_shared::edge::MonitorRect {
            x: area.x,
            y: area.y,
            width: area.width,
            height: area.height,
            id: screen_display_id(screen),
        });
    }
    Some((areas, primary_top))
}

/// Reconcile the pill's window against the displays connected right now.
///
/// macOS moves and re-clamps windows itself when a display sleeps, disconnects
/// or changes resolution, and it does not tell the window whether the move was
/// its or the user's. So the same three steps run here as on the other
/// platforms: hold saves until the layout settles, resolve the position against
/// the new layout, and adopt whatever the resolution decides so the next launch
/// restores the place the user can actually see.
unsafe fn reconcile_display_layout(window: id, state: &PillState) {
    let now = drag_now();
    state.save_guard.borrow_mut().layout_changed(now);
    if state.dragging.get() {
        // A drag held across the change cannot be saved when it ends: the frame
        // it would record is the one macOS put the window in.
        state
            .save_guard
            .borrow_mut()
            .layout_changed_during_drag(now);
    }
    let Some((areas, primary_top)) = display_areas() else {
        // No screens is not evidence that the pill's screen is gone: every
        // display disconnecting briefly looks like this. Leaving the window alone
        // is what keeps its position intact for when one comes back.
        return;
    };
    let frame = window_frame(window);
    let (window_w, window_h) = (frame.size.width, frame.size.height);
    if window_w <= 0.0 || window_h <= 0.0 {
        return;
    }
    let top_down = to_top_down(frame, primary_top);
    // The window's own screen decides which display this record is about, and its
    // token is what makes that decision survive a replug. The remembered token is
    // the fallback for the moment the window is on no screen at all.
    let current_screen: id = msg_send![window, screen];
    let current_id = if current_screen.is_null() {
        state.saved_display_id.get()
    } else {
        screen_display_id(current_screen).or(state.saved_display_id.get())
    };
    // The display the pill is on: named when possible, else the one containing the
    // footprint centre, else the nearest. The shared helper owns all three so no
    // platform can pick a different fallback.
    let (footprint_offset, footprint_size) = rust_pill_shared::restore::centered_bottom_footprint(
        (window_w, window_h),
        (MIN_PILL_WIDTH, MIN_PILL_HEIGHT),
        COLLAPSED_BOTTOM_INSET + rust_pill_shared::placement::below_slot_extra(TOOLTIP_HEIGHT),
    );
    let Some(parked) = rust_pill_shared::layout::describe_parked(
        &areas,
        (top_down.x, top_down.y),
        (window_w, window_h),
        (
            top_down.x + footprint_offset.0 + footprint_size.0 / 2.0,
            top_down.y + footprint_offset.1 + footprint_size.1 / 2.0,
        ),
        current_id,
    ) else {
        return;
    };

    let relocation = rust_pill_shared::layout::reconcile(
        parked,
        &areas,
        (window_w, window_h),
        |_work, window| {
            rust_pill_shared::restore::centered_bottom_footprint(
                window,
                (MIN_PILL_WIDTH, MIN_PILL_HEIGHT),
                COLLAPSED_BOTTOM_INSET
                    + rust_pill_shared::placement::below_slot_extra(TOOLTIP_HEIGHT),
            )
        },
        |work, _window| {
            // The same footprint clamp `reposition_window` applies when idle, so
            // a reconciled origin is a fixed point of the idle tick.
            rust_pill_shared::restore::footprint_bounds(work, footprint_offset, footprint_size)
        },
    );

    match relocation {
        rust_pill_shared::layout::Relocation::Keep => {}
        rust_pill_shared::layout::Relocation::Stranded => {
            // Nowhere to move it to. Leaving it keeps the stored position.
        }
        rust_pill_shared::layout::Relocation::Move { x, y } => {
            // Back into Cocoa's bottom-left space exactly once, at the point of
            // use.
            let origin = NSPoint::new(x, primary_top - (y + window_h));
            set_window_origin(window, origin);
            // A forget or a reset leaves the pill deliberately unsaved: the move
            // still has to happen, but it must not write the row back.
            if !state.anchor.get().records_relocation() {
                return;
            }
            state.saved_x.set(origin.x);
            state.saved_y.set(origin.y);
            state.has_saved_position.set(true);
            state
                .saved_display_id
                .set(rust_pill_shared::layout::display_id_of(
                    &areas,
                    (origin.x, origin.y),
                    (
                        x + footprint_offset.0 + footprint_size.0 / 2.0,
                        y + footprint_offset.1 + footprint_size.1 / 2.0,
                    ),
                ));
            persist_reconciled_position(state, window);
        }
    }
}

/// Reconcile if the display arrangement changed and no notification said so.
///
/// Coarse on purpose: the signature only has to notice that something about the
/// arrangement is different, and the reconciliation decides what to do.
/// Enumerating screens every frame would be wasteful, so this looks a few times
/// a second, far faster than a display changes and far slower than a frame.
unsafe fn poll_display_layout(window: id, state: &PillState, now: f64) {
    let Some((areas, _)) = display_areas() else {
        return;
    };
    let outcome = state
        .layout_poll
        .borrow_mut()
        .observe(now, rust_pill_shared::layout::layout_signature(&areas));
    if outcome == rust_pill_shared::layout::PollOutcome::Changed {
        unsafe { reconcile_display_layout(window, state) };
    }
}

/// Tell the desktop where the pill ended up after a display change made the pill
/// move itself.
///
/// This is not a drag save, so it does not go through the save guard: the pill
/// chose this position, and it is the only place the pill can be. Storing it is
/// what stops the next launch restoring an origin that no longer has a screen
/// under it.
unsafe fn persist_reconciled_position(state: &PillState, window: id) {
    let (rect, monitor) = pill_geometry(window);
    ipc::send(&OutMessage::PositionChanged {
        report: rust_pill_shared::restore::PositionReport::new(
            true,
            Some(rect),
            Some(monitor),
            state.saved_display_id.get(),
        ),
    });
}

// ── Shared setup (used by both standalone and embedded modes) ─────

unsafe fn setup(
    receiver: Receiver<InMessage>,
    embedded: bool,
    saved_position: Option<ParkedWindow>,
) {
    let view_class = register_pill_view_class();
    let window_class = register_pill_window_class();

    let ui_scale = 1.0; // macOS handles Retina scaling automatically

    let window_w = WINDOW_W_TYPING as f64;
    // The window keeps room for the below selector slot under the pill, so a
    // side flip animates inside space that is already there. Content math
    // stays on the typing constants, so the pill never moves for it.
    let window_h =
        WINDOW_H_TYPING as f64 + rust_pill_shared::placement::below_slot_extra(TOOLTIP_HEIGHT);

    // Create window (NSPanel with non-activating mask so clicks don't steal focus)
    let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(window_w, window_h));
    let non_activating_mask: u64 = 1 << 7; // NSWindowStyleMaskNonactivatingPanel
    let window: id = msg_send![window_class, alloc];
    let window: id = msg_send![window,
        initWithContentRect:rect
        styleMask:non_activating_mask
        backing:NSBackingStoreBuffered
        defer:NO
    ];

    let _: () = msg_send![window, setBecomesKeyOnlyIfNeeded:YES];
    window.setLevel_(1000); // NSScreenSaverWindowLevel
    window.setOpaque_(NO);
    let clear_color: id = msg_send![class!(NSColor), clearColor];
    window.setBackgroundColor_(clear_color);
    window.setHasShadow_(NO);
    window.setCollectionBehavior_(
        NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle,
    );

    // Create custom view (layer-backed for GPU-accelerated compositing)
    let view: id = msg_send![view_class, alloc];
    let view: id = msg_send![view, initWithFrame:rect];
    let _: () = msg_send![view, setWantsLayer:YES];
    window.setContentView_(view);

    // From this point the pill reacts to displays appearing, disappearing,
    // moving and rescaling instead of being stranded by them.
    observe_screen_parameters();

    // Create text field for typing mode
    let entry_frame = typing_entry_frame();
    let entry: id = msg_send![class!(NSTextField), alloc];
    let entry: id = msg_send![entry, initWithFrame:entry_frame];
    let _: () = msg_send![entry, setBordered:NO];
    let _: () = msg_send![entry, setDrawsBackground:NO];
    let _: () = msg_send![entry, setFocusRingType:1u64]; // NSFocusRingTypeNone

    let white: id = msg_send![class!(NSColor),
        colorWithSRGBRed:1.0_f64
        green:1.0_f64
        blue:1.0_f64
        alpha:0.92_f64
    ];
    let _: () = msg_send![entry, setTextColor:white];

    let font: id = crate::font::satoshi_font(14.0, false);
    let _: () = msg_send![entry, setFont:font];

    with_ns_string("Type a message...", |placeholder| {
        let _: () = msg_send![entry, setPlaceholderString:placeholder];
    });

    let _: () = msg_send![entry, setTarget:view];
    let _: () = msg_send![entry, setAction:sel!(textFieldAction:)];
    // The view is also the field's editing delegate: it mirrors each keystroke
    // into state and turns Escape into a cancel decision while a transcript is
    // under review.
    let _: () = msg_send![entry, setDelegate:view];
    let _: () = msg_send![entry, setHidden:YES];
    let _: () = msg_send![view, addSubview:entry];

    // Initialize state
    // Resolve the stored position against the displays connected now, before
    // the state exists. A saved origin only means something on the display it
    // was captured on, so an unplugged, resized or moved display is dealt with
    // here instead of dragging the window to a coordinate with no screen under
    // it.
    //
    // The record is stored in the top-down space the pill publishes, so this
    // works in that space and converts the answer back to Cocoa's bottom-left
    // origin once, at the end.
    // The destination token travels with the frame: when the saved display is
    // gone the frame is remapped onto one that remains, and the state must name
    // the display it actually landed on.
    let mut restored_display_id: Option<u64> = None;
    let restored = saved_position.and_then(|parked| {
        let screen_list = screens();
        let count: usize = unsafe { msg_send![screen_list, count] };
        if count == 0 {
            return None;
        }
        let primary: id = unsafe { msg_send![screen_list, objectAtIndex: 0usize] };
        let primary_frame: NSRect = unsafe { msg_send![primary, frame] };
        let primary_top = primary_frame.origin.y + primary_frame.size.height;

        // The visible area is what the record stores and what the pill publishes,
        // so it is the same rect used here to recognise the saved display.
        let mut display_rects = Vec::with_capacity(count);
        for index in 0..count {
            let (area, id) = unsafe {
                let screen: id = msg_send![screen_list, objectAtIndex: index];
                (
                    to_top_down(screen_visible_frame(screen), primary_top),
                    screen_display_id(screen),
                )
            };
            display_rects.push(rust_pill_shared::edge::MonitorRect {
                x: area.x,
                y: area.y,
                width: area.width,
                height: area.height,
                id,
            });
        }

        // At rest the pill is collapsed, so `expand_t` is 0 and the draw size is
        // the collapsed size.
        let resting_pill_w = MIN_PILL_WIDTH;
        let resting_pill_h = MIN_PILL_HEIGHT;
        let placement = rust_pill_shared::restore::restore(
            parked,
            &display_rects,
            (window_w, window_h),
            |work, _window| {
                // The pill's visible footprint, not the OS window. The window is
                // a large transparent canvas with the pill drawn inside it, so
                // clamping the canvas pulls a pill parked at an edge inward by
                // hundreds of pixels, and the idle tick in `reposition_window`
                // then puts it back: the restore looks like it was ignored.
                //
                // The pill starts collapsed, so its resting arrangement is the
                // shared one: centred, sitting `COLLAPSED_BOTTOM_INSET` above the
                // window's bottom edge.
                let (offset, size) = rust_pill_shared::restore::centered_bottom_footprint(
                    (window_w, window_h),
                    (resting_pill_w, resting_pill_h),
                    COLLAPSED_BOTTOM_INSET
                        + rust_pill_shared::placement::below_slot_extra(TOOLTIP_HEIGHT),
                );
                rust_pill_shared::restore::footprint_bounds(work, offset, size)
            },
        );
        match placement {
            rust_pill_shared::restore::Placement::Restore { x, y, display_id } => {
                restored_display_id = display_id;
                Some(NSRect::new(
                    NSPoint::new(x, primary_top - (y + window_h)),
                    NSSize::new(window_w, window_h),
                ))
            }
            rust_pill_shared::restore::Placement::PlatformDefault => None,
        }
    });

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
        ui_scale,
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
        stage_text: RefCell::new(None),
        long_press_active: Cell::new(false),
        long_press_elapsed: Cell::new(0.0),
        long_press_start_x: Cell::new(0.0),
        long_press_start_y: Cell::new(0.0),
        dragging: Cell::new(false),
        drag_cancelled: Cell::new(false),
        drag_motion: RefCell::new(DragController::new()),
        hover_intent: RefCell::new(HoverIntent::new()),
        crossing: RefCell::new(rust_pill_shared::deform::CrossingDeform::new()),
        selector_placement: RefCell::new(rust_pill_shared::placement::SelectorPlacement::new()),
        has_saved_position: Cell::new(restored.is_some()),
        saved_x: Cell::new(restored.map_or(0.0, |window| window.origin.x)),
        saved_y: Cell::new(restored.map_or(0.0, |window| window.origin.y)),
        saved_display_id: Cell::new(
            restored_display_id.or_else(|| saved_position.and_then(|window| window.display_id)),
        ),
        drag_save_due: Cell::new(None),
        save_guard: RefCell::new(rust_pill_shared::layout::SaveGuard::new()),
        layout_poll: RefCell::new(rust_pill_shared::layout::LayoutPoll::new()),
        first_placement_done: Cell::new(false),
        anchor: Cell::new(rust_pill_shared::layout::Anchor::LaunchAtCursor),
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
    });

    // Store in thread-local
    APP_CTX.with(|cell| {
        *cell.borrow_mut() = Some(AppContext {
            state,
            receiver: RefCell::new(receiver),
            window,
            view,
            entry,
            quit: Cell::new(false),
            last_tick_time: Cell::new(0.0),
            embedded,
        });
    });

    // Set up CVDisplayLink for vsync-aligned rendering (falls back to NSTimer)
    let mut display_link: *mut c_void = std::ptr::null_mut();
    if CVDisplayLinkCreateWithActiveCGDisplays(&mut display_link) == 0 {
        CVDisplayLinkSetOutputCallback(display_link, display_link_callback, std::ptr::null_mut());
        CVDisplayLinkStart(display_link);
    } else {
        let _: id = msg_send![class!(NSTimer),
            scheduledTimerWithTimeInterval:0.016_f64
            target:view
            selector:sel!(tick:)
            userInfo:nil
            repeats:YES
        ];
    }

    // A restored position is applied to the window here, before the first
    // frame, so the pill appears where the user left it rather than moving
    // there once the run loop starts.
    if let Some(frame) = restored {
        set_window_origin(window, frame.origin);
    }

    // Position and show (orderFront only — don't steal focus from other apps)
    with_ctx(|ctx| {
        reposition_window(window, &ctx.state, 1.0 / 60.0, drag_now());
    });
    let _: () = msg_send![window, orderFront:nil];

    ipc::send(&OutMessage::Ready);
}

// ── Standalone binary entry point ────────────────────────────────

#[allow(dead_code)]
pub fn run(receiver: Receiver<InMessage>, saved_position: Option<ParkedWindow>) {
    unsafe {
        let _pool = NSAutoreleasePool::new(nil);
        let app = NSApp();
        app.setActivationPolicy_(NSApplicationActivationPolicyAccessory);

        setup(receiver, false, saved_position);

        app.run();
    }
}

// ── Embedded library entry point ─────────────────────────────────
// Hooks into the host app's existing NSApplication run loop.

#[allow(dead_code)]
pub(crate) fn run_embedded(receiver: Receiver<InMessage>, saved_position: Option<ParkedWindow>) {
    unsafe {
        setup(receiver, true, saved_position);
    }
}

#[cfg(test)]
mod typing_geometry_tests {
    use super::*;

    #[test]
    fn crossing_identity_uses_full_screen_bounds_and_preserves_horizontal_coordinates() {
        let screen = NSRect::new(NSPoint::new(-1920.0, 100.0), NSSize::new(1920.0, 1080.0));
        assert_eq!(
            crossing_identity(screen, 1080.0, -500.0, 600.0),
            (-1920.0, -100.0, 1920.0, 1080.0, -500.0, 480.0)
        );
    }

    #[test]
    fn below_selector_slot_does_not_lift_the_content_canvas() {
        let content_h = WINDOW_H_TYPING as f64;
        let extra = rust_pill_shared::placement::below_slot_extra(TOOLTIP_HEIGHT);
        for bottom in [0.0, -1080.0, 70.0] {
            let old_top = default_content_origin_y(bottom, content_h) + content_h;
            let new_top = default_content_origin_y(bottom, content_h + extra) + content_h + extra;
            assert!((old_top - new_top).abs() < 1e-6);
        }
    }

    #[test]
    fn native_entry_stays_inside_the_painted_input_row() {
        let frame = typing_entry_frame();
        let panel_bottom = WINDOW_H_TYPING as f64 - PANEL_BOTTOM_MARGIN;
        let input_top = panel_bottom - PANEL_INPUT_HEIGHT;
        assert!(frame.origin.y >= input_top);
        assert!(frame.size.height > 0.0);
        assert_eq!(frame.origin.y + frame.size.height, panel_bottom);
    }
}
