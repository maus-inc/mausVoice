//! Dictation presentation state shared by the native pills. Platform code owns
//! its window and queries reduced-motion preferences only when entering loading.

use crate::{should_clear_stage_text_on_phase, StyleTooltipGate};
use std::cell::{Cell, RefCell};

/// The native IPC enums keep their serde wire format outside this std-only crate.
/// Other states (in particular Paused) are neither a new take nor loading.
pub trait RecordingPhase: Copy + Eq {
    const IDLE: Self;
    const RECORDING: Self;
    const LOADING: Self;
}

/// Binds a platform's IPC phase enum to the indicator's three named phases.
///
/// Every renderer names its variants `Idle`, `Recording` and `Loading`, so the
/// mapping is written once here rather than three times beside the enums.
#[macro_export]
macro_rules! impl_recording_phase {
    ($phase:ty) => {
        impl $crate::indicator::RecordingPhase for $phase {
            const IDLE: Self = Self::Idle;
            const RECORDING: Self = Self::Recording;
            const LOADING: Self = Self::Loading;
        }
    };
}

#[derive(Debug, Clone)]
pub struct DictationIndicator<P: RecordingPhase> {
    last_sequence: Cell<u64>,
    pub phase: Cell<P>,
    pub expand_t: Cell<f64>,
    pub expand_velocity: Cell<f64>,
    pub hovered: Cell<bool>,
    pub wave_phase: Cell<f64>,
    pub current_level: Cell<f64>,
    pub target_level: Cell<f64>,
    pub loading_offset: Cell<f64>,
    pub pending_levels: RefCell<Vec<f32>>,
    pub stage_text: RefCell<Option<String>>,
    pub style_count: Cell<u32>,
    pub style_name: RefCell<String>,
    pub tooltip_t: Cell<f64>,
    pub tooltip_velocity: Cell<f64>,
    pub tooltip_width: Cell<f64>,
    pub style_tooltip_gate: StyleTooltipGate,
    /// Where the flash banner's centre was on the frame it was last painted.
    ///
    /// The paint is the only place that knows how the message wrapped, so it
    /// records the centre here and the celebration reads it back. `None` until
    /// the banner first paints.
    pub banner_center: Cell<Option<(f64, f64)>>,
    /// Lines the flash banner painted last frame.
    ///
    /// The celebration's tick runs before the paint that wraps the text, so the
    /// painter caches the count here for the next tick to launch from. It lives
    /// on the shared indicator rather than on each pill's own state because the
    /// banner is shared: three declarations of the same field, initialised with
    /// the same literal, was three chances for the count to mean two things.
    pub banner_lines: Cell<usize>,
}

impl<P: RecordingPhase> Default for DictationIndicator<P> {
    fn default() -> Self {
        Self {
            phase: Cell::new(P::IDLE),
            last_sequence: Cell::default(),
            expand_t: Cell::default(),
            expand_velocity: Cell::default(),
            hovered: Cell::default(),
            wave_phase: Cell::default(),
            current_level: Cell::default(),
            target_level: Cell::default(),
            loading_offset: Cell::default(),
            pending_levels: RefCell::default(),
            stage_text: RefCell::default(),
            style_count: Cell::default(),
            style_name: RefCell::default(),
            tooltip_t: Cell::default(),
            tooltip_velocity: Cell::default(),
            tooltip_width: Cell::default(),
            style_tooltip_gate: StyleTooltipGate::default(),
            banner_center: Cell::new(None),
            banner_lines: Cell::new(crate::flash_banner::BANNER_LINES_AT_REST),
        }
    }
}

impl<P: RecordingPhase> DictationIndicator<P> {
    /// Apply a phase to this pill, not a previous window on the same UI thread.
    /// Equal sequence numbers are valid: older senders use zero throughout.
    pub fn apply_phase(
        &self,
        phase: P,
        seq: u64,
        reduced_motion: impl FnOnce() -> bool,
        clear_banner: impl FnOnce(),
    ) {
        if seq < self.last_sequence.get() {
            return;
        }
        self.last_sequence.set(seq);
        let prev = self.phase.replace(phase);
        self.style_tooltip_gate
            .set_take_running(phase == P::RECORDING);
        if phase == P::RECORDING && (prev == P::IDLE || prev == P::LOADING) {
            clear_banner();
        }
        if should_clear_stage_text_on_phase(
            prev == P::LOADING,
            phase == P::IDLE,
            phase == P::LOADING,
        ) {
            self.stage_text.take();
        }
        if phase == P::LOADING && prev != P::LOADING {
            self.loading_offset
                .set(if reduced_motion() { 0.5 } else { 0.0 });
        }
        if phase == P::IDLE && prev != P::IDLE {
            self.pending_levels.borrow_mut().clear();
            self.target_level.set(0.0);
            self.current_level.set(0.0);
            self.wave_phase.set(0.0);
            self.loading_offset.set(0.0);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Wire {
        Idle,
        Recording,
        Paused,
        Loading,
    }
    impl RecordingPhase for Wire {
        const IDLE: Self = Self::Idle;
        const RECORDING: Self = Self::Recording;
        const LOADING: Self = Self::Loading;
    }

    #[test]
    fn ignores_older_messages_but_accepts_equal_and_legacy_zero() {
        let pill = DictationIndicator::<Wire>::default();
        let clears = Cell::new(0);
        let clear = || clears.set(clears.get() + 1);
        pill.apply_phase(Wire::Recording, 0, || false, clear);
        assert_eq!(clears.get(), 1);
        pill.apply_phase(Wire::Paused, 7, || false, clear);
        pill.apply_phase(Wire::Loading, 6, || panic!("stale motion query"), clear);
        assert_eq!(pill.phase.get(), Wire::Paused);
        pill.apply_phase(Wire::Recording, 7, || false, clear);
        assert_eq!(pill.phase.get(), Wire::Recording);
        assert!(pill.style_tooltip_gate.is_suppressed(true));
        assert_eq!(clears.get(), 1, "resuming a take must preserve its banner");
    }

    #[test]
    fn enters_loading_once_and_clears_stage_and_meter_on_exit() {
        for (reduce, offset) in [(true, 0.5), (false, 0.0)] {
            let pill = DictationIndicator::<Wire>::default();
            *pill.stage_text.borrow_mut() = Some("queued".into());
            pill.apply_phase(Wire::Loading, 2, || reduce, || ());
            assert_eq!(pill.stage_text.borrow().as_deref(), Some("queued"));
            assert_eq!(pill.loading_offset.get(), offset);
            pill.loading_offset.set(0.7);
            pill.apply_phase(Wire::Loading, 3, || panic!("duplicate loading"), || ());
            assert_eq!(pill.loading_offset.get(), 0.7);
            pill.pending_levels.borrow_mut().push(0.75);
            pill.target_level.set(0.5);
            pill.current_level.set(0.25);
            pill.wave_phase.set(1.0);
            pill.apply_phase(Wire::Idle, 4, || reduce, || ());
            assert!(pill.stage_text.borrow().is_none());
            assert!(pill.pending_levels.borrow().is_empty());
            assert_eq!(
                (
                    pill.target_level.get(),
                    pill.current_level.get(),
                    pill.wave_phase.get(),
                    pill.loading_offset.get()
                ),
                (0.0, 0.0, 0.0, 0.0)
            );
        }
    }

    #[test]
    fn new_take_after_loading_sweeps_the_banner_and_stage_not_the_wave() {
        let pill = DictationIndicator::<Wire>::default();
        pill.apply_phase(Wire::Loading, 1, || false, || ());
        *pill.stage_text.borrow_mut() = Some("transcribing".into());
        pill.current_level.set(0.25);
        let banner = Cell::new(true);
        pill.apply_phase(Wire::Recording, 2, || false, || banner.set(false));
        assert!(!banner.get());
        assert!(pill.stage_text.borrow().is_none());
        assert_eq!(pill.current_level.get(), 0.25);
    }
}
