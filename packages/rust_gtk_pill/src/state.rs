use std::cell::{Cell, RefCell};

use crate::ipc::{Phase, PillMessage, PillPermission, PillStreaming, ResetStrategy, Visibility};

use crate::constants::*;
use crate::pill::Backend;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum RocketPhase {
    Rising,
    Exploding,
}

#[derive(Debug, Clone)]
pub(crate) struct Spark {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) vx: f64,
    pub(crate) vy: f64,
    pub(crate) life: f64,
}

#[derive(Debug, Clone)]
pub(crate) struct Rocket {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) vx: f64,
    pub(crate) vy: f64,
    pub(crate) trail: Vec<(f64, f64)>,
    pub(crate) fuse: f64,
    pub(crate) phase: RocketPhase,
    pub(crate) num_sparks: usize,
    pub(crate) launch_index: usize,
    pub(crate) sparks: Vec<Spark>,
    pub(crate) trail_alpha: f64,
    pub(crate) color: (f64, f64, f64),
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
    SendButton,
    FlashAction,
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

#[derive(Debug, Clone)]
pub(crate) struct FlameTongue {
    pub(crate) t: f64,
    pub(crate) height: f64,
    pub(crate) width: f64,
    pub(crate) phase: f64,
    pub(crate) speed: f64,
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

pub(crate) struct PillState {
    pub(crate) phase: Cell<Phase>,
    pub(crate) visibility: Cell<Visibility>,
    pub(crate) expand_t: Cell<f64>,
    pub(crate) expand_velocity: Cell<f64>,
    pub(crate) hovered: Cell<bool>,
    pub(crate) wave_phase: Cell<f64>,
    pub(crate) current_level: Cell<f64>,
    pub(crate) target_level: Cell<f64>,
    pub(crate) loading_offset: Cell<f64>,
    pub(crate) pending_levels: RefCell<Vec<f32>>,
    pub(crate) style_count: Cell<u32>,
    pub(crate) style_name: RefCell<String>,
    pub(crate) tooltip_t: Cell<f64>,
    pub(crate) tooltip_velocity: Cell<f64>,
    pub(crate) tooltip_width: Cell<f64>,
    pub(crate) style_tooltip_gate: rust_pill_shared::StyleTooltipGate,

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
    // Master alpha for the long-press outline. Pinned at 1 while the gesture is
    // held, eased to 0 over LONG_PRESS_RING_FADE after release, so the outline
    // never fades under an active press.
    pub(crate) ring_alpha: Cell<f64>,

    // Ring fill level captured at release; the post-release fade animates from
    // this level rather than snapping to a complete outline.
    pub(crate) ring_release_progress: Cell<f64>,

    // Time since the current press began / since the last release, driving the
    // ring's eased fade-in and fade-out.
    pub(crate) press_elapsed: Cell<f64>,
    pub(crate) release_elapsed: Cell<f64>,

    // 0..1 arm state, ramped after the long press completes. Lifts the ring's
    // brightness and retires the comet head.
    pub(crate) arm_t: Cell<f64>,

    // Seconds since the gesture armed, or -1 when no pulse is running. Drives
    // the expanding confirmation halo.
    pub(crate) arm_pulse: Cell<f64>,

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
    // X11 drop position, in physical root coordinates, persisted when a drag
    // ends so the toplevel stays parked until the user moves it again.
    pub(crate) has_saved_position: Cell<bool>,
    /// Monitor strategy for the next re-home after a reset-position command.
    pub(crate) reset_strategy: Cell<ResetStrategy>,
    pub(crate) saved_x: Cell<f64>,
    pub(crate) saved_y: Cell<f64>,
    // Set by the release handler when X11 already persisted the exact drop;
    // the timer uses it to avoid overwriting that point with a later cursor poll.
    pub(crate) x11_release_persisted: Cell<bool>,
    // PlainWayland draws the pill on a maximized overlay window, so dragging
    // translates the pill's draw position rather than moving the toplevel.
    pub(crate) drag_draw_offset_x: Cell<f64>,
    pub(crate) drag_draw_offset_y: Cell<f64>,

    // Brief red flash shown when a long-press is cancelled by movement.
    pub(crate) cancel_flash: Cell<f64>,

    // Actual window allocation (used by PlainWayland for fullscreen overlay positioning)
    pub(crate) alloc_width: Cell<f64>,
    pub(crate) alloc_height: Cell<f64>,

    // Active backend, so draw-side positioning can stay backend aware.
    pub(crate) backend: Cell<Backend>,
}

impl PillState {
    pub(crate) fn content_offset(&self) -> (f64, f64) {
        let dw = self.draw_width.get();
        let dh = self.draw_height.get();
        let aw = self.alloc_width.get();
        let ah = self.alloc_height.get();
        if aw > 0.0 && ah > 0.0 {
            ((aw - dw) / 2.0, ah - dh - MARGIN_BOTTOM as f64)
        } else {
            ((WINDOW_W_TYPING as f64 - dw) / 2.0, WINDOW_H_TYPING as f64 - dh)
        }
    }
}
