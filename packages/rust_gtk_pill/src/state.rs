pub(crate) use rust_pill_shared::indicator::DictationIndicator;
use std::cell::{Cell, RefCell};

pub(crate) use rust_pill_shared::fireworks::{Rocket, RocketPhase};
pub(crate) use rust_pill_shared::flame::FlameTongue;

use crate::ipc::{Phase, PillMessage, PillPermission, PillReview, PillStreaming, Visibility};

use crate::constants::*;
use crate::pill::Backend;

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

/// Axis-aligned rect containment. Hover pads the pill rect before testing it
/// and click dispatch tests the unpadded rect, so both live here and share one
/// edge rule instead of repeating the comparison inline.
pub(crate) fn rect_contains(px: f64, py: f64, rx: f64, ry: f64, rw: f64, rh: f64) -> bool {
    px >= rx && px <= rx + rw && py >= ry && py <= ry + rh
}

/// [`rect_contains`] widened by `pad` on every edge. Only the anticipatory
/// hover zone may use this: a click that lands in the pad belongs to whatever
/// window is behind the pill, so click dispatch stays on the unpadded rect.
pub(crate) fn rect_contains_padded(
    px: f64,
    py: f64,
    rx: f64,
    ry: f64,
    rw: f64,
    rh: f64,
    pad: f64,
) -> bool {
    rect_contains(px, py, rx - pad, ry - pad, rw + 2.0 * pad, rh + 2.0 * pad)
}

impl ClickRegion {
    pub(crate) fn contains(&self, px: f64, py: f64) -> bool {
        rect_contains(px, py, self.x, self.y, self.w, self.h)
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

/// A drop a refused save still owes, read at the instant of the release.
///
/// The retry runs after the display hold, and reconciliation moves the window
/// in between. Retaining the origin and the display it landed on keeps the
/// retry writing the user's drop instead of the frame the layout chose.
pub(crate) struct OwedDrop {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) monitor: Option<rust_pill_shared::edge::MonitorRect>,
    pub(crate) display_id: Option<u64>,
}

pub(crate) struct PillState {
    pub(crate) visibility: Cell<Visibility>,

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

    // Long-press drag state
    pub(crate) long_press_active: Cell<bool>,
    pub(crate) long_press_elapsed: Cell<f64>,
    pub(crate) long_press_start_x: Cell<f64>,
    pub(crate) long_press_start_y: Cell<f64>,
    pub(crate) dragging: Cell<bool>,
    pub(crate) drag_cancelled: Cell<bool>,
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
    pub(crate) drag_cursor_x: Cell<f64>,
    pub(crate) drag_cursor_y: Cell<f64>,
    /// Physical X11 grabbed offset, captured with the press-time surface scale.
    pub(crate) drag_press_offset: Cell<(f64, f64)>,
    /// Shared drag-motion controller: owns pointer samples, release velocity,
    /// and the release settle spring. The frame tick advances it while a drag
    /// is held or settling; see rust_pill_shared::drag.
    pub(crate) drag_motion: RefCell<rust_pill_shared::drag::DragController>,
    // Newest motion-event position while dragging on Wayland (window-relative).
    // Motion events only record; the frame tick applies them through the
    // shared controller so bursts coalesce into one move per frame.
    pub(crate) drag_last_x: Cell<f64>,
    pub(crate) drag_last_y: Cell<f64>,
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
    // Latest hover probe (hit test plus pointer position). Motion, enter,
    // leave, and release handlers only record; the frame tick runs the probe
    // through the controller so bursts coalesce into one decision per frame.
    pub(crate) hover_probed: Cell<bool>,
    pub(crate) hover_probe_x: Cell<f64>,
    pub(crate) hover_probe_y: Cell<f64>,
    // X11 drop position, in physical root coordinates, persisted when a drag
    // ends so the toplevel stays parked until the user moves it again.
    pub(crate) has_saved_position: Cell<bool>,
    /// Monitor strategy for the next re-home after a reset-position command.
    pub(crate) saved_x: Cell<f64>,
    pub(crate) saved_y: Cell<f64>,
    /// Stable token of the display the saved position belongs to, or `None` when
    /// GDK could not name it. Published with the position so the stored record
    /// can name the display rather than only its rectangle.
    pub(crate) saved_display_id: Cell<Option<u64>>,
    /// The work area the saved position was clamped into, kept so a pill whose
    /// panel is unplugged remaps from the geometry it was saved against instead
    /// of from the survivor it happens to be nearest to. Written beside
    /// `saved_display_id`; both describe the same drop.
    pub(crate) saved_work_area: Cell<rust_pill_shared::edge::MonitorRect>,
    /// Holds position saves until the display layout has been steady, so a frame
    /// the X server or the window manager forced during a RandR change is never
    /// stored as the user's position. See rust_pill_shared::layout::SaveGuard.
    pub(crate) save_guard: RefCell<rust_pill_shared::layout::SaveGuard>,
    /// The display-arrangement signature this pill last reconciled against, and
    /// when it last looked. The RandR event is the primary signal; the poll covers
    /// a change that lands before the event is selected or while the window is
    /// unmapped.
    pub(crate) layout_poll: RefCell<rust_pill_shared::layout::LayoutPoll>,
    /// Position the host stored for this pill in a previous session, already
    /// parsed. Taken once during realize and resolved against the monitors that
    /// are connected then; see `rust_pill_shared::restore`.
    pub(crate) restored_position: Cell<Option<rust_pill_shared::restore::ParkedWindow>>,
    // Set by explicit release-settle or interruption persistence; consumed by
    // the slow timer so a later cursor poll cannot overwrite the saved point.
    // The slow-timer fallback itself does not set this flag.
    pub(crate) x11_release_persisted: Cell<bool>,
    /// When a drop that the display-change hold refused may be written, or `None`
    /// when no save is owed. The release is reported once per settle, so a refused
    /// save has to be retried from the frame loop or the drop is lost.
    pub(crate) drag_save_due: Cell<Option<f64>>,
    /// The drop a refused save still owes, read at the release.
    ///
    /// The retry runs after the hold, and display reconciliation moves the
    /// window in the meantime: `x11_drag_applied` then names the frame the
    /// layout chose, not the one the user dropped. The origin, the monitor and
    /// its token are retained here so the retry writes the drop, the way the
    /// Windows and macOS paths do. Cleared when a new gesture settles.
    pub(crate) x11_drop_owed: RefCell<Option<OwedDrop>>,
    // Last window origin the frame tick applied during an X11 drag, so steady
    // frames skip the X round trip. Seeded out of range to force the first move.
    pub(crate) x11_drag_applied: Cell<(i32, i32)>,
    /// Why this pill has no stored position and where a due placement goes.
    pub(crate) anchor: Cell<rust_pill_shared::layout::Anchor>,
    // PlainWayland draws the pill on a maximized overlay window, so dragging
    // translates the pill's draw position rather than moving the toplevel.
    pub(crate) drag_draw_offset_x: Cell<f64>,
    pub(crate) drag_draw_offset_y: Cell<f64>,

    // Brief red flash shown when a long-press is cancelled by movement.
    pub(crate) cancel_flash: Cell<f64>,

    // Actual window allocation (used by PlainWayland for fullscreen overlay positioning)
    pub(crate) alloc_width: Cell<f64>,
    pub(crate) alloc_height: Cell<f64>,

    pub(crate) indicator: DictationIndicator<Phase>,
    // Active backend, so draw-side positioning can stay backend aware.
    pub(crate) backend: Cell<Backend>,
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

    pub(crate) fn below_slot_extra(&self) -> f64 {
        if self.backend.get() == crate::pill::Backend::X11 {
            rust_pill_shared::placement::below_slot_extra(TOOLTIP_HEIGHT)
        } else {
            0.0
        }
    }

    pub(crate) fn content_offset(&self) -> (f64, f64) {
        content_origin(
            self.alloc_width.get(),
            self.alloc_height.get(),
            self.draw_width.get(),
            self.draw_height.get(),
            self.below_slot_extra(),
        )
    }
}

/// The X11 selector tail is transparent reserve, not part of the panel canvas.
/// Parking, drawing, native entry margins and input geometry share this height.
pub(crate) fn content_canvas_height(allocation_height: f64, below_slot: f64) -> f64 {
    (allocation_height - below_slot).max(0.0)
}

fn content_origin(aw: f64, ah: f64, dw: f64, dh: f64, below_slot: f64) -> (f64, f64) {
    if aw > 0.0 && ah > 0.0 {
        (
            (aw - dw) / 2.0,
            content_canvas_height(ah, below_slot) - dh - MARGIN_BOTTOM as f64,
        )
    } else {
        // Before the first size-allocate the allocation cells are still zero, so
        // this branch stands in for the size the window is about to have. It has
        // to agree with the allocated branch or a caller that runs at realize --
        // the X11 restore does -- lands MARGIN_BOTTOM pixels high. The X11
        // selector slot cancels in the vertical term (it is added to the height
        // and subtracted again as `below_slot`), so the typing height alone is
        // the correct stand-in.
        (
            (WINDOW_W_TYPING as f64 - dw) / 2.0,
            WINDOW_H_TYPING as f64 - dh - MARGIN_BOTTOM as f64,
        )
    }
}

rust_pill_shared::impl_ring_host!(
    PillState,
    SPRING_STIFFNESS,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn x11_selector_reserve_does_not_move_parked_content_or_the_entry() {
        let old_h = WINDOW_H_TYPING as f64;
        let slot = rust_pill_shared::placement::below_slot_extra(TOOLTIP_HEIGHT);
        let full_h = old_h + slot;
        let width = WINDOW_W_TYPING as f64;
        let (old_x, old_y) = content_origin(width, old_h, 200.0, 100.0, 0.0);
        let (x, y) = content_origin(width, full_h, 200.0, 100.0, slot);
        assert_eq!((x, y), (old_x, old_y));
        // Native entry is bottom aligned; the extra rows must be in its margin.
        let old_entry_margin = old_h - old_y - 100.0 + PANEL_BOTTOM_MARGIN;
        let entry_margin = full_h - y - 100.0 + PANEL_BOTTOM_MARGIN;
        assert_eq!(entry_margin - old_entry_margin, slot);
        assert_eq!(full_h - entry_margin, old_h - old_entry_margin);
        for scale in [1.0, 2.0] {
            let work_bottom = 1080.0 * scale;
            let margin = MARGIN_BOTTOM as f64 * scale;
            let old_window_y = work_bottom - old_h * scale - margin;
            let window_y = work_bottom - content_canvas_height(full_h, slot) * scale - margin;
            assert_eq!(window_y + y * scale, old_window_y + old_y * scale);
        }
        let pill_bottom = y + 100.0 - 6.0;
        assert!(pill_bottom + TOOLTIP_GAP + TOOLTIP_HEIGHT <= full_h);
    }

    #[test]
    fn backends_without_a_selector_reserve_keep_the_existing_origin() {
        assert_eq!(
            content_origin(1000.0, 800.0, 200.0, 100.0, 0.0),
            (400.0, 700.0 - MARGIN_BOTTOM as f64)
        );
    }

    #[test]
    fn pre_allocation_origin_matches_the_allocated_origin() {
        // The fallback stands in for the size the window is about to have, so it
        // must agree with the allocated branch once that size is known. The X11
        // restore runs at realize and reads the fallback; a mismatch parks the
        // pill off by the difference. Covered for both the X11 slot and none.
        let dw = 200.0;
        let dh = 100.0;
        for slot in [
            0.0,
            rust_pill_shared::placement::below_slot_extra(TOOLTIP_HEIGHT),
        ] {
            assert_eq!(
                content_origin(0.0, 0.0, dw, dh, slot),
                content_origin(
                    WINDOW_W_TYPING as f64,
                    WINDOW_H_TYPING as f64 + slot,
                    dw,
                    dh,
                    slot,
                ),
            );
        }
    }
}
