//! The waveform meter's frame update, shared by the three pill renderers.
//!
//! The level a pill draws is not the level the audio callback last sent: it is a
//! smoothed follower with a decay, held up to a floor while the take is being
//! processed, and the waveform's phase advances faster the louder it is. Every
//! pill has to answer that identically -- the meter is the same instrument on all
//! three platforms, so a different smoothing constant is a different instrument,
//! not a platform difference.
//!
//! This is the one extraction in this change that *removes* duplication rather
//! than reshaping it. The three renderers had a byte-identical copy of this
//! arithmetic in their frame tick; the listener here reaches into the state its
//! caller already holds and ticks it in place, so the call site is one line
//! rather than a rebuilt state object. The pills' `PillState` types are per
//! platform (they carry GDI, AppKit and GTK handles) and cannot move here, but
//! the reflection on four `Cell<f64>` and a `RefCell<Vec<f32>>` can.
//!
//! The stale-level rule stays at the call site, because it is a decision about
//! the pill's mailbox rather than about the meter.

use std::cell::{Cell, RefCell};

/// The five values the meter reads and writes, as the caller's own cells.
///
/// Borrowed rather than owned so a tick writes straight through to the caller's
/// state -- building a copy, ticking it and copying it back was three places to
/// transpose two fields, and it left each renderer holding the same eight lines
/// of glue.
pub struct Meter<'a> {
    pub current: &'a Cell<f64>,
    pub target: &'a Cell<f64>,
    pub wave_phase: &'a Cell<f64>,
    pub pending_levels: &'a RefCell<Vec<f32>>,
}

/// Constants the meter is defined in terms of.
///
/// The three pills used to carry identical copies of these in their own
/// `constants.rs`. A shared home means the meter cannot be tuned on one platform
/// without the others following, which is what the copies allowed.
pub const LEVEL_SMOOTHING: f64 = 0.18;
pub const TARGET_DECAY_PER_FRAME: f64 = 0.985;
pub const WAVE_BASE_PHASE_STEP: f64 = 0.11;
pub const WAVE_PHASE_GAIN: f64 = 0.32;
/// Meter level held while the take is being processed, so the pill does not read
/// as silent between the release and the transcript.
pub const PROCESSING_BASE_LEVEL: f64 = 0.16;
/// Below this the level is snapped to zero: an exponential decay never reaches it,
/// and a meter frozen at 0.0001 is indistinguishable from a stuck one.
pub const LEVEL_FLOOR: f64 = 0.0002;
/// The target decays faster than it is smoothed, so the meter falls away between
/// syllables instead of sitting at the loudest thing said in the session.
pub const TARGET_FLOOR: f64 = 0.0005;
/// How much of an incoming burst survives per frame at 60 Hz.
/// `powf(frame_scale)` makes this frame-rate independent.
pub const BURST_PER_FRAME: f64 = 0.25;

impl Meter<'_> {
    /// Fold one batch of incoming levels into a single loudness figure.
    ///
    /// `avg` and `peak` are weighted so a burst of speech reads louder than steady
    /// quiet, then square-rooted: loudness is perceived roughly logarithmically, and
    /// a linear meter barely leaves the floor until the speaker shouts.
    ///
    /// `None` for an empty batch, which is the common case and must not move the
    /// meter -- `sum / 0.0` would be `NaN`, and `NaN` propagates through the
    /// smoothing into the drawn waveform for the rest of the take.
    fn loudness(levels: &[f32]) -> Option<f64> {
        if levels.is_empty() {
            return None;
        }
        let sum: f64 = levels.iter().map(|v| *v as f64).sum();
        let avg = sum / levels.len() as f64;
        let peak = levels.iter().copied().fold(0.0_f32, f32::max) as f64;
        let combined = (avg * 0.9 + peak * 0.85).min(1.0);
        Some((combined.sqrt() * 1.35).min(1.0))
    }

    /// Advance the meter by one frame and write the result back.
    ///
    /// `recording` and `loading` are the pill's phase; `frame_scale` is `dt` in
    /// 60 Hz units, so every rate here is frame-rate independent and a 30 Hz
    /// display decays at the same speed per second as a 120 Hz one.
    ///
    /// A batch that arrives while the pill is not recording is dropped rather than
    /// folded in: it was captured while the pill sat idle or loading, and folding
    /// it into the next take's first frame moves the meter before anything was
    /// spoken.
    pub fn tick(&self, recording: bool, loading: bool, frame_scale: f64) -> f64 {
        let levels = std::mem::take(&mut *self.pending_levels.borrow_mut());
        let level = if recording {
            Self::loudness(&levels)
        } else {
            None
        };

        let mut current = self.current.get();
        let mut target = self.target.get();

        if recording {
            if let Some(level) = level {
                let mix = 1.0 - BURST_PER_FRAME.powf(frame_scale);
                target = (target * (1.0 - mix) + level * mix).min(1.0);
            }
        } else if loading {
            // Held at a visible floor: the take is being processed, and a pill that
            // falls to nothing reads as finished rather than busy.
            target = target.max(PROCESSING_BASE_LEVEL);
        } else {
            target = 0.0;
            current *= 0.4_f64.powf(frame_scale);
            if current < LEVEL_FLOOR {
                current = 0.0;
            }
        }

        let smoothing = 1.0 - (1.0 - LEVEL_SMOOTHING).powf(frame_scale);
        let next = current + (target - current) * smoothing;
        current = if next < LEVEL_FLOOR { 0.0 } else { next };

        let decayed = target * TARGET_DECAY_PER_FRAME.powf(frame_scale);
        target = if decayed < TARGET_FLOOR { 0.0 } else { decayed };

        let base_level = if loading && !recording {
            PROCESSING_BASE_LEVEL
        } else {
            0.0
        };
        let effective = current.max(base_level);
        let advance = (WAVE_BASE_PHASE_STEP + WAVE_PHASE_GAIN * effective) * frame_scale;

        self.current.set(current);
        self.target.set(target);
        self.wave_phase
            .set((self.wave_phase.get() + advance) % std::f64::consts::TAU);
        current
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meter<'a>(
        current: &'a Cell<f64>,
        target: &'a Cell<f64>,
        phase: &'a Cell<f64>,
        pending: &'a RefCell<Vec<f32>>,
    ) -> Meter<'a> {
        Meter {
            current,
            target,
            wave_phase: phase,
            pending_levels: pending,
        }
    }

    /// An empty batch is not silence. Treating it as one drove the meter to zero
    /// between syllables, which is what a missing level looks like on screen.
    #[test]
    fn an_empty_batch_leaves_the_meter_alone() {
        let (current, target, phase, pending) = (
            Cell::new(0.5),
            Cell::new(0.5),
            Cell::new(0.0),
            RefCell::new(Vec::new()),
        );
        meter(&current, &target, &phase, &pending).tick(true, false, 1.0);
        assert!(
            target.get() > 0.4,
            "no new audio decayed the target to {}",
            target.get()
        );
        assert!(!current.get().is_nan() && !target.get().is_nan());
    }

    /// A loud batch is louder than a quiet one, and both stay in range.
    #[test]
    fn loudness_is_weighted_and_clamped() {
        let quiet = Meter::loudness(&[0.05, 0.05, 0.05]).unwrap();
        let loud = Meter::loudness(&[0.9, 0.9, 0.9]).unwrap();
        assert!(loud > quiet);
        assert!((0.0..=1.0).contains(&loud), "{loud} escaped the range");
        let spiked = Meter::loudness(&[0.0, 0.0, 1.0]).unwrap();
        assert!(spiked > (0.0 + 0.0 + 1.0) / 3.0, "peak weighting is lost");
        assert_eq!(Meter::loudness(&[]), None);
    }

    /// The frame rate must not change how fast the meter moves per second: a 30 Hz
    /// display and a 120 Hz one settle to the same place over the same time.
    #[test]
    fn the_meter_is_frame_rate_independent() {
        let run = |frames: usize, scale: f64| {
            let (c, t, p, pending) = (
                Cell::new(0.0),
                Cell::new(0.0),
                Cell::new(0.0),
                RefCell::new(Vec::new()),
            );
            for _ in 0..frames {
                *pending.borrow_mut() = vec![1.0, 1.0];
                meter(&c, &t, &p, &pending).tick(true, false, scale);
            }
            c.get()
        };
        // A second of audio at 30 Hz (2 frames' worth of scale) and at 120 Hz.
        let slow = run(30, 2.0);
        let fast = run(120, 0.5);
        assert!(
            (slow - fast).abs() < 0.02,
            "30 Hz settled at {slow}, 120 Hz at {fast}"
        );
    }

    /// Levels that arrived while the pill was idle are stale: they must not move
    /// the meter when the next take starts.
    #[test]
    fn a_batch_queued_while_idle_is_dropped() {
        let (c, t, p, pending) = (
            Cell::new(0.0),
            Cell::new(0.0),
            Cell::new(0.0),
            RefCell::new(vec![1.0, 1.0, 1.0]),
        );
        meter(&c, &t, &p, &pending).tick(false, false, 1.0);
        assert!(pending.borrow().is_empty(), "the stale batch was consumed");
        assert_eq!(t.get(), 0.0, "a stale batch moved the target");
        assert_eq!(c.get(), 0.0, "a stale batch moved the level");
    }

    /// Processing holds a visible floor, and idle releases it.
    #[test]
    fn processing_holds_a_floor_that_idle_releases() {
        let (c, t, p, pending) = (
            Cell::new(0.0),
            Cell::new(0.0),
            Cell::new(0.0),
            RefCell::new(Vec::new()),
        );
        let m = meter(&c, &t, &p, &pending);
        m.tick(false, true, 1.0);
        assert!(
            t.get() > PROCESSING_BASE_LEVEL * TARGET_DECAY_PER_FRAME - 1e-9,
            "the processing floor was not held: {}",
            t.get()
        );
        // Several idle frames decay it away entirely.
        for _ in 0..120 {
            m.tick(false, false, 1.0);
        }
        assert_eq!(t.get(), 0.0, "idle did not release the floor");
    }

    /// The phase advances, wraps, and moves faster with a louder meter.
    #[test]
    fn the_wave_phase_advances_with_the_level() {
        let (c, t, p, pending) = (
            Cell::new(0.0),
            Cell::new(0.0),
            Cell::new(0.0),
            RefCell::new(Vec::new()),
        );
        let m = meter(&c, &t, &p, &pending);
        *pending.borrow_mut() = vec![1.0; 8];
        m.tick(true, false, 1.0);
        let loud_advance = p.get();
        assert!(loud_advance > 0.0);
        assert!(loud_advance < std::f64::consts::TAU);
    }
}
