pub(crate) use rust_pill_shared::indicator::DictationIndicator;
use std::cell::{Cell, RefCell};

use crate::constants::*;
pub(crate) use rust_pill_shared::fireworks::{Rocket, RocketPhase};
pub(crate) use rust_pill_shared::flame::FlameTongue;

use crate::ipc::{Phase, PillMessage, PillPermission, PillReview, PillStreaming, Visibility};

/// Everything a drop reported to the desktop has to agree on.
///
/// Captured at the settle, when the origin is the one the user released at, so
/// the origin, its work area and its display token all describe one instant. The
/// guarded retry and the shutdown writer both publish this record rather than
/// re-resolving any of it, because between the drop and either of those the
/// layout can change and a late resolution would name a display the pill was
/// never on.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct DropRecord {
    pub(crate) x: i32,
    pub(crate) y: i32,
    /// The window's size at the drop, so the reported rectangle is one
    /// instant's worth of geometry. A DPI change while the save is deferred
    /// resizes the live window, and pairing that size with this origin would
    /// describe a window the user never released.
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) work_area: Option<rust_pill_shared::edge::MonitorRect>,
    pub(crate) display_id: Option<u64>,
}

#[derive(Debug, Clone)]
pub(crate) enum ClickAction {
    Pill,
    StyleForward,
    StyleBackward,
    AssistantClose,
    OpenInNew,
    KeyboardButton,
    CancelDictation,
    PauseDictation,
    ResumeDictation,
    PermissionAllow(String),
    PermissionDeny(String),
    PermissionAlwaysAllow(String),
    /// Review-before-insert decisions. The id identifies the reviewed
    /// transcript so a decision can never be applied to a newer one.
    ReviewInsert(String),
    ReviewCopy(String),
    ReviewEdit(String),
    ReviewCancel(String),
    SendButton,
    InputField,
    FlashAction,
    FlashReject,
}

#[derive(Debug, Clone)]
pub(crate) struct ClickRegion {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) w: f64,
    pub(crate) h: f64,
    pub(crate) action: ClickAction,
}

impl ClickRegion {
    pub(crate) fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && px <= self.x + self.w && py >= self.y && py <= self.y + self.h
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum WindowMode {
    #[default]
    Dictation,
    AssistantCompact,
    AssistantExpanded,
    AssistantTyping,
}

impl WindowMode {
    pub(crate) fn from_str(s: &str) -> Self {
        match s {
            "assistant_compact" => Self::AssistantCompact,
            "assistant_expanded" => Self::AssistantExpanded,
            "assistant_typing" => Self::AssistantTyping,
            _ => Self::Dictation,
        }
    }

    pub(crate) fn dimensions(&self) -> (i32, i32) {
        match self {
            Self::Dictation => (DICTATION_WINDOW_WIDTH, DICTATION_WINDOW_HEIGHT),
            Self::AssistantCompact => (WINDOW_W_COMPACT, WINDOW_H_COMPACT),
            Self::AssistantExpanded => (WINDOW_W_EXPANDED, WINDOW_H_EXPANDED),
            Self::AssistantTyping => (WINDOW_W_TYPING, WINDOW_H_TYPING),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct PillState {
    pub(crate) visibility: Cell<Visibility>,

    pub(crate) window_mode: Cell<WindowMode>,
    pub(crate) draw_width: Cell<f64>,
    pub(crate) draw_height: Cell<f64>,
    pub(crate) draw_w_velocity: Cell<f64>,
    pub(crate) draw_h_velocity: Cell<f64>,
    /// How the fixed drawing canvas maps onto the window surface. It is 1.0 until
    /// a per-monitor scale change resizes the surface, and it is the one value
    /// drawing, pointer mapping and published geometry all read, so they cannot
    /// describe the pill at different sizes.
    pub(crate) content_scale: Cell<f64>,

    pub(crate) assistant_active: Cell<bool>,
    pub(crate) assistant_input_mode: RefCell<String>,
    pub(crate) assistant_compact: Cell<bool>,
    pub(crate) assistant_conversation_id: RefCell<Option<String>>,
    pub(crate) assistant_user_prompt: RefCell<Option<String>>,
    pub(crate) assistant_messages: RefCell<Vec<PillMessage>>,
    pub(crate) assistant_streaming: RefCell<Option<PillStreaming>>,
    pub(crate) assistant_permissions: RefCell<Vec<PillPermission>>,
    pub(crate) assistant_review: RefCell<Option<PillReview>>,

    pub(crate) panel_open_t: Cell<f64>,
    pub(crate) panel_open_velocity: Cell<f64>,
    pub(crate) kb_button_t: Cell<f64>,
    pub(crate) kb_button_velocity: Cell<f64>,
    pub(crate) shimmer_phase: Cell<f64>,

    pub(crate) scroll_offset: Cell<f64>,
    pub(crate) content_height: Cell<f64>,
    pub(crate) viewport_height: Cell<f64>,
    pub(crate) should_stick: Cell<bool>,

    pub(crate) click_regions: RefCell<Vec<ClickRegion>>,
    pub(crate) mouse_x: Cell<f64>,
    pub(crate) mouse_y: Cell<f64>,

    pub(crate) entry_text: RefCell<String>,

    // Recording <-> paused crossfade (0 = live waveform, 1 = paused bar)
    pub(crate) pause_t: Cell<f64>,
    pub(crate) pause_velocity: Cell<f64>,

    // Cancel button animation
    pub(crate) cancel_t: Cell<f64>,
    pub(crate) cancel_velocity: Cell<f64>,

    // Flash message / toast
    pub(crate) flash_message: RefCell<String>,
    /// Lines the banner painted last frame; the celebration's tick reads it
    /// because that tick runs before the paint that measures the wrap.
    pub(crate) flash_lines: Cell<usize>,
    pub(crate) flash_visible: Cell<bool>,
    pub(crate) flash_t: Cell<f64>,
    pub(crate) flash_velocity: Cell<f64>,
    pub(crate) flash_timer: Cell<f64>,
    pub(crate) flash_is_error: Cell<bool>,
    pub(crate) flash_action: RefCell<Option<String>>,
    pub(crate) flash_action_label: RefCell<Option<String>>,
    pub(crate) flash_reject_action: RefCell<Option<String>>,
    pub(crate) flash_reject_action_label: RefCell<Option<String>>,

    pub(crate) fireworks_active: Cell<bool>,
    pub(crate) fireworks_elapsed: Cell<f64>,
    pub(crate) fireworks_next_launch: Cell<usize>,
    pub(crate) fireworks_rockets: RefCell<Vec<Rocket>>,

    // Flame
    pub(crate) flame_active: Cell<bool>,
    pub(crate) flame_elapsed: Cell<f64>,
    pub(crate) flame_tongues: RefCell<Vec<FlameTongue>>,

    // Flash blue border
    pub(crate) flash_blue_active: Cell<bool>,
    pub(crate) flash_blue_elapsed: Cell<f64>,

    // Broadcast transcript (live text above the pill)
    pub(crate) transcript_text: RefCell<String>,
    pub(crate) transcript_time_since_update: Cell<f64>,
    pub(crate) transcript_opacity: Cell<f64>,
    pub(crate) transcript_has_message: Cell<bool>,

    // Long-press balloon pop + drag
    pub(crate) long_press_active: Cell<bool>,
    pub(crate) long_press_elapsed: Cell<f64>,
    pub(crate) long_press_start_x: Cell<f64>,
    pub(crate) long_press_start_y: Cell<f64>,
    pub(crate) dragging: Cell<bool>,
    pub(crate) drag_cancelled: Cell<bool>,
    pub(crate) drag_cursor_x: Cell<f64>,
    pub(crate) drag_cursor_y: Cell<f64>,
    /// Shared drag-motion controller: owns pointer samples, release velocity,
    /// and the release settle spring. The frame loop advances it while a drag
    /// is held or settling; see rust_pill_shared::drag.
    pub(crate) drag_motion: RefCell<rust_pill_shared::drag::DragController>,
    /// Last complete Win32 monitor snapshot for the active drag. A failed or
    /// partial enumeration must not look like a monitor hot-unplug to the seam
    /// tracker and clear its hysteresis latch.
    pub(crate) last_monitor_topology: RefCell<Option<Vec<rust_pill_shared::edge::MonitorRect>>>,
    /// Hover-intent state machine: dwells before arming hover and lingers
    /// through a grace before exiting, so fast pass-throughs never flicker
    /// the pill. See rust_pill_shared::hover.
    pub(crate) hover_intent: RefCell<rust_pill_shared::hover::HoverIntent>,
    /// Selector-placement state machine: picks above or below from the live
    /// headroom and eases the blend between them. See
    /// rust_pill_shared::placement.
    pub(crate) selector_placement: RefCell<rust_pill_shared::placement::SelectorPlacement>,
    /// Crossing-deformation state machine: squeezes the paint briefly when
    /// the pill changes monitors. See rust_pill_shared::deform.
    pub(crate) crossing: RefCell<rust_pill_shared::deform::CrossingDeform>,
    pub(crate) has_saved_position: Cell<bool>,
    /// Why this pill has no stored position and where a due placement goes.
    /// Defaults to a launch placement, because that is what a process with no
    /// record is.
    pub(crate) anchor: Cell<rust_pill_shared::layout::Anchor>,
    /// Whether a drag's final position is still waiting to be stored. Set when
    /// the frame loop wants to save but the input lock is held, so a destroy that
    /// arrives before the lock clears can still store it.
    pub(crate) pending_drag_position: Cell<bool>,
    /// The complete record of a drop while a guarded save is owed.
    ///
    /// `saved_x`/`saved_y` still describe the position from *before* the drop, so
    /// they cannot be asked where the pill was released. Keeping the released
    /// origin here lets the retry write the drop the user made rather than
    /// whatever it finds on the frame it finally runs.
    ///
    /// The work area and the display token are part of the record because the
    /// retry can run after the layout changed. Resolving them at retry time puts
    /// the released origin beside a display it was never on, and the next launch
    /// then finds an exact match for that display and clamps the origin instead of
    /// carrying the relative place over from the panel that went away.
    pub(crate) drop_record: Cell<Option<DropRecord>>,
    /// When a drop that the display-change hold refused may be written, or `None`
    /// when no save is owed. The drop is reported once, so a refused save has to
    /// be retried from here or the position is lost.
    pub(crate) drag_save_due: Cell<Option<f64>>,
    pub(crate) saved_x: Cell<i32>,
    pub(crate) saved_y: Cell<i32>,
    /// Stable token of the display the saved position belongs to, or `None` when
    /// the display could not be named. Published with the position so the stored
    /// record can name the display rather than only its rectangle.
    pub(crate) saved_display_id: Cell<Option<u64>>,
    /// A stored record the launch could not resolve because display enumeration
    /// failed. The cursor tick applies it once an enumeration succeeds, and a reset
    /// or a clear spends it first.
    pub(crate) pending_restore: Cell<Option<rust_pill_shared::restore::ParkedWindow>>,
    /// A surface size `resize` refused, kept so the frame loop retries it before the
    /// next presentation. Without the retry the window stays at the new size while
    /// the surface keeps the old one, and the next frame presents the old size and
    /// resizes the window back.
    pub(crate) pending_surface: Cell<Option<(i32, i32)>>,
    /// The work area the saved position was clamped into, kept so a pill whose
    /// panel is unplugged remaps from the geometry it was saved against rather
    /// than from the survivor it happens to be nearest to.
    pub(crate) saved_work_area: Cell<rust_pill_shared::edge::MonitorRect>,
    /// When the current drag started, and which layout was in effect. A layout
    /// change while a drag is held has to be remembered as interrupting it, so
    /// the settle that follows is not saved as the user's choice.
    pub(crate) drag_started_at: Cell<Option<f64>>,
    /// Holds position saves until the display layout has been steady, so a frame
    /// the system forced during a display change is never stored as the user's
    /// position. See rust_pill_shared::layout::SaveGuard.
    pub(crate) save_guard: RefCell<rust_pill_shared::layout::SaveGuard>,
    /// The last display-arrangement signature this pill reconciled against, and
    /// when. Used to notice a layout change even if the platform message is
    /// missed: a hidden window receives no `WM_DPICHANGED`, and a window that is
    /// briefly off-screen may receive no `WM_DISPLAYCHANGE` either.
    pub(crate) layout_poll: RefCell<rust_pill_shared::layout::LayoutPoll>,

    // Inflate animation — pill slightly expands when entering drag, contracts on release.
    pub(crate) inflate_t: Cell<f64>,
    pub(crate) inflate_velocity: Cell<f64>,
    pub(crate) drag_label_t: Cell<f64>,
    pub(crate) drag_label_velocity: Cell<f64>,

    // The long-press outline and the locate replay. Owned by the shared crate so
    // the field list and the tick exist once for all three platforms.
    pub(crate) ring: rust_pill_shared::RingState,

    // True from press until release, regardless of whether the long press or
    // drag survived. The move threshold cancels `long_press_active` before
    // `dragging` arms, so neither flag alone can answer "is the button still
    // down?" — which is what hover needs to stay pinned.
    pub(crate) pointer_down: Cell<bool>,

    // Scratch buffer for the evenly-resampled ring perimeter. Owned by the
    // state so the render path reuses one allocation across frames.
    pub(crate) ring_points: RefCell<Vec<(f64, f64, f64)>>,

    pub(crate) indicator: DictationIndicator<Phase>,
    // Dirty flag — when false, the rendered output is identical to the previous
    // frame so we can skip draw + UpdateLayeredWindow entirely.
    pub(crate) dirty: Cell<bool>,
}

impl PillState {
    /// Shared paint/input visibility during a selector side transition.
    pub(crate) fn tooltip_opacity(&self) -> f64 {
        rust_pill_shared::placement::tooltip_opacity(
            self.tooltip_t.get(),
            self.selector_placement.borrow().blend(),
        )
    }

    /// The transcript waiting for a review decision, if there is one.
    pub(crate) fn pending_review_id(&self) -> Option<String> {
        self.assistant_review
            .borrow()
            .as_ref()
            .map(|review| review.id.clone())
    }

    /// Whether the panel, rather than the bare pill, owns the window.
    ///
    /// The assistant owns it while it runs, and a transcript under review owns
    /// it too: the review draws its buttons in the panel area, so hit testing,
    /// hover and the clickable window region all have to cover the panel even
    /// when no assistant session is open.
    pub(crate) fn owns_panel(&self) -> bool {
        self.assistant_active.get() || self.assistant_review.borrow().is_some()
    }

    /// The window mode to lay the content out in.
    ///
    /// A transcript under review needs the panel and its entry whatever size
    /// the desktop last asked for. The review and the window size arrive as two
    /// independent messages, so the pill decides its own room rather than
    /// drawing a panel into a pill-sized box until the other message lands.
    pub(crate) fn effective_window_mode(&self) -> WindowMode {
        if self.assistant_review.borrow().is_some() {
            WindowMode::AssistantTyping
        } else {
            self.window_mode.get()
        }
    }

    /// Whether the panel shows its text entry.
    ///
    /// Assistant type mode owns the entry, and so does a transcript under
    /// review: the entry is where the transcript is edited before it is
    /// inserted, so the review reuses the assistant surface instead of opening
    /// a window of its own.
    pub(crate) fn is_typing(&self) -> bool {
        (self.assistant_active.get() && *self.assistant_input_mode.borrow() == "type")
            || self.assistant_review.borrow().is_some()
    }

    /// A pointer position in window pixels mapped into drawing-canvas pixels.
    ///
    /// Every click region and hit test is laid out on the fixed canvas, while
    /// mouse messages arrive in the surface's own pixels. They agree until a
    /// scale change shrinks the surface, so the pointer has to take the same
    /// mapping the renderer does or a click lands where the pill is not drawn.
    pub(crate) fn pointer_to_canvas(&self, x: f64, y: f64) -> (f64, f64) {
        let scale = self.content_scale.get();
        if scale > 0.0 && scale != 1.0 {
            (x / scale, y / scale)
        } else {
            (x, y)
        }
    }

    /// The mapping `pointer_to_canvas` undoes: canvas pixels to window pixels.
    ///
    /// A real child window sits in screen coordinates, so anything placed from
    /// canvas math has to be mapped or it lands at the wrong spot once a scale
    /// change has shrunk the surface.
    pub(crate) fn canvas_to_window(&self, x: f64, y: f64) -> (f64, f64) {
        let scale = self.content_scale.get();
        if scale > 0.0 && scale != 1.0 {
            (x * scale, y * scale)
        } else {
            (x, y)
        }
    }

    pub(crate) fn content_offset(&self) -> (f64, f64) {
        let dw = self.draw_width.get();
        let dh = self.draw_height.get();
        (
            (WINDOW_W_TYPING as f64 - dw) / 2.0,
            WINDOW_H_TYPING as f64 - dh,
        )
    }

    pub(crate) fn needs_redraw(&self) -> bool {
        if self.dirty.get() {
            return true;
        }

        // Continuous animations driven by phase
        if self.phase.get() != Phase::Idle {
            return true;
        }

        // Spring animations still in motion
        if self.expand_velocity.get() != 0.0 {
            return true;
        }
        if self.tooltip_velocity.get() != 0.0 {
            return true;
        }
        if self.selector_placement.borrow().blend_velocity() != 0.0 {
            return true;
        }
        if self.crossing.borrow().animating() {
            return true;
        }
        if self.panel_open_velocity.get() != 0.0 {
            return true;
        }
        if self.kb_button_velocity.get() != 0.0 {
            return true;
        }
        if self.draw_w_velocity.get() != 0.0 {
            return true;
        }
        if self.draw_h_velocity.get() != 0.0 {
            return true;
        }
        if self.flash_velocity.get() != 0.0 {
            return true;
        }
        if self.cancel_velocity.get() != 0.0 {
            return true;
        }
        if self.pause_velocity.get() != 0.0 {
            return true;
        }
        if self.inflate_velocity.get() != 0.0 {
            return true;
        }

        // Active visual effects
        if self.fireworks_active.get() {
            return true;
        }
        if self.flame_active.get() {
            return true;
        }
        if self.flash_visible.get() {
            return true;
        }
        if self.flash_blue_active.get() {
            return true;
        }
        if self.transcript_has_message.get() {
            return true;
        }
        if self.transcript_opacity.get() > 0.001 {
            return true;
        }

        // Long-press balloon pop + drag (the ring keeps drawing while the
        // release fade is in flight).
        if self.long_press_active.get() {
            return true;
        }
        if self.ring.locate_active() {
            return true;
        }
        if self.dragging.get() {
            return true;
        }
        if self.ring.alpha() > 0.0 {
            return true;
        }
        // The arm-confirmation halo outlives the ring's own alpha, so it needs
        // its own liveness check or the pulse would be culled mid-flight.
        if rust_pill_shared::pulse_is_running(self.ring.arm_pulse()) {
            return true;
        }
        if self.ring.arm_t() > 0.0 {
            return true;
        }

        // Assistant panel has shimmer and streaming content
        if self.assistant_active.get() {
            return true;
        }

        // A pending review keeps the panel on screen until it is answered.
        if self.assistant_review.borrow().is_some() {
            return true;
        }

        false
    }
}

rust_pill_shared::impl_ring_host!(
    PillState,
    SPRING_STIFFNESS,
    /// The surface only repaints when something reports motion, so the frame
    /// that clears the ring has to be dirtied by hand or the last painted
    /// state lingers as a ghost.
    fn ring_cleared(&self) {
        self.dirty.set(true);
    },
    fn reduced_motion(&self) -> bool {
        crate::pill::reduced_motion()
    }
);

// Native paint and input code read the same indicator that receives phase IPC.
impl std::ops::Deref for PillState {
    type Target = DictationIndicator<Phase>;

    fn deref(&self) -> &Self::Target {
        &self.indicator
    }
}

rust_pill_shared::impl_flash_host!(crate::state::PillState);
