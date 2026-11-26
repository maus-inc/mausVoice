pub(crate) use rust_pill_shared::indicator::DictationIndicator;
use std::cell::{Cell, RefCell};

pub(crate) use rust_pill_shared::fireworks::{Rocket, RocketPhase};
pub(crate) use rust_pill_shared::flame::FlameTongue;

use crate::ipc::{Phase, PillMessage, PillPermission, PillReview, PillStreaming, Rect, Visibility};

use crate::constants::*;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowMode {
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

/// A drop a save guard deferred, held until the retry may write it.
///
/// The rectangle and the display it belonged to are captured together, at the
/// moment the gesture ended, so a reconciliation that moves the window during the
/// hold cannot make the retry pair the retained rectangle with a panel the drop
/// was never on. `frame` is in Cocoa's bottom-up space, because that is what the
/// idle tick parks the window with; `monitor` and `display_id` are in the
/// desktop's top-down space, because that is what the record stores.
///
/// `primary_top` is the basis `monitor` was flipped against, kept so the retry
/// flips `frame` against the same line. Re-reading it at the retry would convert
/// a frame captured against one primary top with another, so a primary-display
/// height change during the hold would publish a rectangle offset from the
/// `monitor` beside it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct DropRecord {
    pub(crate) frame: (f64, f64, f64, f64),
    /// The pill centre inside the frame at the drop. Retained because the live
    /// centre moves with the panel and hover state, and a retry that recomputed
    /// it could resolve a different display than the one the user dropped on.
    pub(crate) point: (f64, f64),
    /// `None` when the window was on no screen at the drop, so the report carries
    /// no monitor rather than a fabricated one.
    pub(crate) monitor: Option<Rect>,
    pub(crate) display_id: Option<u64>,
    pub(crate) primary_top: f64,
}

#[derive(Debug, Clone)]

pub(crate) struct PillState {
    pub(crate) visibility: Cell<Visibility>,
    pub(crate) indicator: DictationIndicator<Phase>,
    pub(crate) ui_scale: f64,

    // Window sizing
    pub(crate) window_mode: Cell<WindowMode>,
    pub(crate) draw_width: Cell<f64>,
    pub(crate) draw_height: Cell<f64>,
    pub(crate) draw_w_velocity: Cell<f64>,
    pub(crate) draw_h_velocity: Cell<f64>,

    // Assistant state
    pub(crate) assistant_active: Cell<bool>,
    pub(crate) assistant_input_mode: RefCell<String>,
    pub(crate) assistant_compact: Cell<bool>,
    pub(crate) assistant_conversation_id: RefCell<Option<String>>,
    pub(crate) assistant_user_prompt: RefCell<Option<String>>,
    pub(crate) assistant_messages: RefCell<Vec<PillMessage>>,
    pub(crate) assistant_streaming: RefCell<Option<PillStreaming>>,
    pub(crate) assistant_permissions: RefCell<Vec<PillPermission>>,
    pub(crate) assistant_review: RefCell<Option<PillReview>>,

    // Assistant UI animation
    pub(crate) panel_open_t: Cell<f64>,
    pub(crate) panel_open_velocity: Cell<f64>,
    pub(crate) kb_button_t: Cell<f64>,
    pub(crate) kb_button_velocity: Cell<f64>,
    pub(crate) shimmer_phase: Cell<f64>,

    // Scroll
    pub(crate) scroll_offset: Cell<f64>,
    pub(crate) content_height: Cell<f64>,
    pub(crate) viewport_height: Cell<f64>,
    pub(crate) should_stick: Cell<bool>,

    // Click regions (rebuilt each frame)
    pub(crate) click_regions: RefCell<Vec<ClickRegion>>,

    // Entry text (for typing mode)
    pub(crate) entry_text: RefCell<String>,

    // Recording <-> paused crossfade (0 = live waveform, 1 = paused bar)
    pub(crate) pause_t: Cell<f64>,
    pub(crate) pause_velocity: Cell<f64>,

    // Cancel button animation
    pub(crate) cancel_t: Cell<f64>,
    pub(crate) cancel_velocity: Cell<f64>,

    // Flash message / toast
    pub(crate) flash_message: RefCell<String>,
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

    // Fireworks
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
    /// Shared drag-motion controller: owns pointer samples, release velocity,
    /// and the release settle spring. The frame tick advances it while a drag
    /// is held or settling; see rust_pill_shared::drag.
    pub(crate) drag_motion: RefCell<rust_pill_shared::drag::DragController>,
    /// Hover-intent state machine: dwells before arming hover and lingers
    /// through a grace before exiting, so fast pass-throughs never flicker
    /// the pill. See rust_pill_shared::hover.
    pub(crate) hover_intent: RefCell<rust_pill_shared::hover::HoverIntent>,
    /// Crossing-deformation state machine: squeezes the paint briefly when
    /// the pill changes monitors. See rust_pill_shared::deform.
    pub(crate) crossing: RefCell<rust_pill_shared::deform::CrossingDeform>,
    /// Selector-placement state machine: picks above or below from the live
    /// headroom and eases the blend between them. See
    /// rust_pill_shared::placement.
    pub(crate) selector_placement: RefCell<rust_pill_shared::placement::SelectorPlacement>,
    pub(crate) has_saved_position: Cell<bool>,
    /// Monitor strategy for the next re-home after a reset-position command.
    pub(crate) saved_x: Cell<f64>,
    pub(crate) saved_y: Cell<f64>,
    /// Stable token of the display the saved position belongs to, or `None` when
    /// it could not be named. Published with the position so the stored record
    /// can name the display rather than only its rectangle.
    pub(crate) saved_display_id: Cell<Option<u64>>,
    /// A stored record the startup pass could not resolve because no display was
    /// connected yet. The frame tick applies it as soon as one is, and a reset or a
    /// clear spends it first.
    pub(crate) pending_restore: RefCell<Option<rust_pill_shared::restore::ParkedWindow>>,
    /// The work area the saved position was clamped into, kept so a pill whose
    /// panel is unplugged remaps from the geometry it was saved against rather
    /// than from the survivor it happens to be nearest to.
    pub(crate) saved_work_area: Cell<rust_pill_shared::edge::MonitorRect>,
    /// When a drop that the display-change hold refused may be written, or `None`
    /// when no save is owed. The drag controller reports `settled` exactly once,
    /// so a refused save has to be retried from here or the drop is lost.
    pub(crate) drag_save_due: Cell<Option<f64>>,
    /// The window frame the gesture ended at, kept while a guarded save is owed,
    /// together with the display it was on when it landed.
    ///
    /// The retry runs after a delay, and the pill's own reconciliation can move the
    /// window in between. `saved_x`/`saved_y` still describe the position from
    /// before the drop, so they cannot answer where it landed; this can.
    ///
    /// A whole frame rather than an origin, because the report needs the frame
    /// flipped into the desktop's top-down space while `saved_x`/`saved_y` need the
    /// origin in Cocoa's bottom-up one. Keeping one value and deriving both is what
    /// stops the two from describing different places. The display is retained with
    /// it for the same reason: reading the live screen at retry time would pair the
    /// retained rectangle with the panel reconciliation moved the window onto, so a
    /// restart would restore the drop against the wrong monitor.
    pub(crate) drop_frame: Cell<Option<DropRecord>>,
    /// Holds position saves until the display layout has been steady, so a frame
    /// macOS forced during a display change is never stored as the user's
    /// position. See rust_pill_shared::layout::SaveGuard.
    pub(crate) save_guard: RefCell<rust_pill_shared::layout::SaveGuard>,
    /// The display-arrangement signature this pill last reconciled against, and
    /// when it last looked. `didChangeScreenParameters` is the primary signal;
    /// the poll covers a notification that arrives while the app is not
    /// frontmost, which macOS can drop.
    pub(crate) layout_poll: RefCell<rust_pill_shared::layout::LayoutPoll>,
    /// True once the pill has been placed at least once. A brand-new window
    /// sits at (0, 0) before its first layout, so an origin check alone would
    /// mistake a legitimately-placed window for "never positioned" and keep
    /// chasing the cursor; this flag lets the first placement follow the cursor
    /// and then stays put.
    pub(crate) first_placement_done: Cell<bool>,
    /// Why this pill has no stored position and where a due placement goes.
    pub(crate) anchor: Cell<rust_pill_shared::layout::Anchor>,

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

    pub(crate) fn content_offset(&self) -> (f64, f64) {
        let dw = self.draw_width.get();
        let dh = self.draw_height.get();
        (
            (WINDOW_W_TYPING as f64 - dw) / 2.0,
            WINDOW_H_TYPING as f64 - dh,
        )
    }
}

rust_pill_shared::impl_ring_host!(
    PillState,
    SPRING_STIFFNESS,
    fn reduced_motion(&self) -> bool {
        crate::app::reduced_motion()
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
rust_pill_shared::impl_celebration_host!(crate::state::PillState);
