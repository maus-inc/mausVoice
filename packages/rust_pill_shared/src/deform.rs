//! Monitor-crossing deformation shared by the three pill renderers.
//!
//! When the pill crosses onto another monitor it receives a short, speed-scaled
//! spring impulse along the boundary normal. It compresses and expands smoothly,
//! then settles without bounce. The effect is paint only: hit regions, saved
//! positions, and selection state never see it.
//!
//! The platform owns monitor identity and passes the full bounds of the monitor
//! containing the pill CENTER (never the transparent host window, which can
//! straddle a boundary while the pill itself has not crossed). A change of
//! origin with the pill moving at gesture speed triggers; drifts,
//! teleports (re-homes, hot-plug moves), and unknown monitors do not.
//!
//! All per-monitor caches resolve every frame from the live monitor, so no
//! stale physical/logical mapping survives a crossing: coordinates are
//! rebased by construction, and DPI differences ride along with the
//! platform's own per-frame scale. Reduced motion skips the deformation and
//! emits a short border pulse the platforms map onto their flash affordance.

use std::cell::Cell;

use crate::spring::spring_01;

/// Peak squeeze along the boundary normal at a full-speed crossing.
pub const CROSS_SQUEEZE: f64 = 0.14;
/// Peak stretch on the perpendicular axis at a full-speed crossing.
pub const CROSS_STRETCH: f64 = 0.08;
/// Slowest crossing that still deforms, in px/s. Below this the move is a
/// drift, not a crossing.
pub const CROSS_MIN_SPEED: f64 = 50.0;
/// Crossing speed that reaches full deformation, in px/s.
pub const CROSS_FULL_SPEED: f64 = 2400.0;
/// Response shaping makes ordinary deliberate drags visible before the
/// high-speed cap, while keeping slow monitor-to-monitor movement restrained.
pub const CROSS_RESPONSE_EXPONENT: f64 = 0.65;
// The 120 Hz semi-implicit spring steps peak below the continuous response.
const CROSS_IMPULSE_GAIN: f64 = 1.25;
/// Faster than this is a teleport (re-home, hot-plug shuffle), not a
/// gesture crossing, and never deforms.
pub const CROSS_MAX_SPEED: f64 = 8000.0;
/// Border pulse length for reduced motion, in seconds.
pub const CROSS_PULSE_TIME: f64 = 0.25;

/// Boundary normal axis, inferred from monitor edge overlap, not origin deltas.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrossingAxis {
    X,
    Y,
}

/// One frame of input to [`CrossingDeform::advance`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CrossingFrame {
    /// Origin of the monitor containing the pill center, in the platform's
    /// drag space. Non-finite means unknown: no trigger, no reseed.
    pub monitor_x: f64,
    pub monitor_y: f64,
    pub monitor_width: f64,
    pub monitor_height: f64,
    /// Pill center in the same space. Drives the crossing-speed estimate.
    pub pill_cx: f64,
    pub pill_cy: f64,
    /// Frame time in seconds on the platform's monotonic clock.
    pub now: f64,
    /// Seconds since the previous frame. Clamped internally.
    pub dt: f64,
    /// Spring stiffness for the return. Platforms pass the stiffness their
    /// other transitions use.
    pub stiffness: f64,
    /// True when the OS asks for reduced motion. No deformation; the border
    /// pulse still fires.
    pub reduced_motion: bool,
}

/// One frame of output from [`CrossingDeform::advance`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DeformOutput {
    /// Paint scale around the pill center. (1, 1) at rest and always under
    /// reduced motion.
    pub scale_x: f64,
    pub scale_y: f64,
    /// True while the spring is still returning.
    pub active: bool,
    /// Border pulse 1..0 after a trigger, for the reduced-motion emphasis.
    /// Platforms ignore it in full motion.
    pub pulse: f64,
    /// True on the single frame a crossing triggers. Platforms arm their
    /// reduced-motion flash on it.
    pub triggered: bool,
}

/// Shared crossing-deformation state machine. See the module docs for the
/// feeding contract.
#[derive(Debug, Clone)]
pub struct CrossingDeform {
    seeded: bool,
    mon_x: f64,
    mon_y: f64,
    mon_width: f64,
    mon_height: f64,
    last_cx: f64,
    last_cy: f64,
    last_t: f64,
    squeeze_x: Cell<f64>,
    squeeze_x_vel: Cell<f64>,
    squeeze_y: Cell<f64>,
    squeeze_y_vel: Cell<f64>,
    pulse: Cell<f64>,
}

/// A side-by-side pair overlaps vertically; a stacked pair overlaps
/// horizontally. Corner-only, overlapping/mirrored, or diagonal layouts have
/// no unambiguous shared normal, so suppress the cosmetic trigger there.
fn boundary_axis(
    from: (f64, f64, f64, f64),
    to: (f64, f64, f64, f64),
) -> Option<CrossingAxis> {
    let (fx, fy, fw, fh) = from;
    let (tx, ty, tw, th) = to;
    let overlap_x = (fx + fw).min(tx + tw) - fx.max(tx);
    let overlap_y = (fy + fh).min(ty + th) - fy.max(ty);
    if overlap_y > 0.0 && overlap_x <= 0.0 {
        Some(CrossingAxis::X)
    } else if overlap_x > 0.0 && overlap_y <= 0.0 {
        Some(CrossingAxis::Y)
    } else {
        None
    }
}

impl Default for CrossingDeform {
    fn default() -> Self {
        Self::new()
    }
}

impl CrossingDeform {
    pub fn new() -> Self {
        Self {
            seeded: false,
            mon_x: 0.0,
            mon_y: 0.0,
            mon_width: 0.0,
            mon_height: 0.0,
            last_cx: 0.0,
            last_cy: 0.0,
            last_t: 0.0,
            squeeze_x: Cell::new(0.0),
            squeeze_x_vel: Cell::new(0.0),
            squeeze_y: Cell::new(0.0),
            squeeze_y_vel: Cell::new(0.0),
            pulse: Cell::new(0.0),
        }
    }

    /// True while the return spring is still moving. The redraw gate reads
    /// it to keep painting until the pill is round again.
    pub fn animating(&self) -> bool {
        self.squeeze_x.get() != 0.0 || self.squeeze_x_vel.get() != 0.0
            || self.squeeze_y.get() != 0.0 || self.squeeze_y_vel.get() != 0.0
    }

    /// Forget the monitor. Used when the platform re-homes the pill itself.
    pub fn reset(&mut self) {
        self.seeded = false;
        self.squeeze_x.set(0.0);
        self.squeeze_x_vel.set(0.0);
        self.squeeze_y.set(0.0);
        self.squeeze_y_vel.set(0.0);
        self.pulse.set(0.0);
    }

    /// Feed one frame and return the paint scale for it.
    pub fn advance(&mut self, frame: &CrossingFrame) -> DeformOutput {
        let dt = if frame.dt.is_finite() {
            frame.dt.clamp(0.0, 0.05)
        } else {
            0.0
        };
        let stiffness = if frame.stiffness.is_finite() {
            frame.stiffness.clamp(1.0, 1000.0)
        } else {
            170.0
        };
        self.pulse.set((self.pulse.get() - dt / CROSS_PULSE_TIME).max(0.0));

        let known = frame.monitor_x.is_finite()
            && frame.monitor_y.is_finite()
            && frame.monitor_width.is_finite() && frame.monitor_width > 0.0
            && frame.monitor_height.is_finite() && frame.monitor_height > 0.0
            && (frame.monitor_x + frame.monitor_width).is_finite()
            && (frame.monitor_y + frame.monitor_height).is_finite()
            && frame.pill_cx.is_finite()
            && frame.pill_cy.is_finite()
            && frame.now.is_finite();
        if !known {
            self.advance_return(frame, dt, stiffness);
            return self.output(false);
        }

        if !self.seeded {
            self.seed(frame);
            return self.output(false);
        }

        let mut triggered = false;
        if frame.monitor_x != self.mon_x || frame.monitor_y != self.mon_y {
            let span = (frame.now - self.last_t).max(f64::MIN_POSITIVE);
            let dx = frame.pill_cx - self.last_cx;
            let dy = frame.pill_cy - self.last_cy;
            let speed = (dx * dx + dy * dy).sqrt() / span;
            let normal = boundary_axis(
                (self.mon_x, self.mon_y, self.mon_width, self.mon_height),
                (frame.monitor_x, frame.monitor_y, frame.monitor_width, frame.monitor_height),
            );
            if let Some(axis) = normal.filter(|_| (CROSS_MIN_SPEED..=CROSS_MAX_SPEED).contains(&speed)) {
                if !frame.reduced_motion {
                    let speed_progress = ((speed - CROSS_MIN_SPEED)
                        / (CROSS_FULL_SPEED - CROSS_MIN_SPEED)).clamp(0.0, 1.0);
                    let peak = speed_progress.powf(CROSS_RESPONSE_EXPONENT);
                    let impulse = peak
                        * stiffness.sqrt()
                        * std::f64::consts::E
                        * CROSS_IMPULSE_GAIN;
                    let velocity = match axis {
                        CrossingAxis::X => &self.squeeze_x_vel,
                        CrossingAxis::Y => &self.squeeze_y_vel,
                    };
                    let launch_cap = stiffness.sqrt() * std::f64::consts::E * CROSS_IMPULSE_GAIN;
                    velocity.set((velocity.get().max(0.0) + impulse).min(launch_cap));
                }
                self.pulse.set(1.0);
                triggered = true;
            }
        }
        // Refresh dimensions even when a monitor resizes without moving.
        self.seed(frame);

        self.advance_return(frame, dt, stiffness);
        self.output(triggered)
    }

    fn advance_return(&self, frame: &CrossingFrame, dt: f64, stiffness: f64) {
        if frame.reduced_motion {
            self.squeeze_x.set(0.0);
            self.squeeze_x_vel.set(0.0);
            self.squeeze_y.set(0.0);
            self.squeeze_y_vel.set(0.0);
        } else {
            spring_01(&self.squeeze_x, &self.squeeze_x_vel, 0.0, stiffness, dt);
            spring_01(&self.squeeze_y, &self.squeeze_y_vel, 0.0, stiffness, dt);
        }
    }

    fn seed(&mut self, frame: &CrossingFrame) {
        self.seeded = true;
        self.mon_x = frame.monitor_x;
        self.mon_y = frame.monitor_y;
        self.mon_width = frame.monitor_width;
        self.mon_height = frame.monitor_height;
        self.last_cx = frame.pill_cx;
        self.last_cy = frame.pill_cy;
        self.last_t = frame.now;
    }

    /// Current paint scale around the pill center. (1, 1) at rest.
    pub fn scales(&self) -> (f64, f64) {
        let x = self.squeeze_x.get();
        let y = self.squeeze_y.get();
        (
            1.0 - CROSS_SQUEEZE * x + CROSS_STRETCH * y,
            1.0 - CROSS_SQUEEZE * y + CROSS_STRETCH * x,
        )
    }

    fn output(&self, triggered: bool) -> DeformOutput {
        let (scale_x, scale_y) = self.scales();
        DeformOutput {
            scale_x,
            scale_y,
            active: self.animating(),
            pulse: self.pulse.get(),
            triggered,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(mon_x: f64, mon_y: f64, cx: f64, now: f64) -> CrossingFrame {
        frame_at(mon_x, mon_y, cx, 500.0, now)
    }

    fn frame_at(mon_x: f64, mon_y: f64, cx: f64, cy: f64, now: f64) -> CrossingFrame {
        CrossingFrame {
            monitor_x: mon_x,
            monitor_y: mon_y,
            monitor_width: 1920.0,
            monitor_height: 1080.0,
            pill_cx: cx,
            pill_cy: cy,
            now,
            dt: 1.0 / 60.0,
            stiffness: 170.0,
            reduced_motion: false,
        }
    }

    #[test]
    fn first_frame_seeds_without_deforming() {
        let mut deform = CrossingDeform::new();
        let out = deform.advance(&frame(0.0, 0.0, 100.0, 0.0));
        assert_eq!((out.scale_x, out.scale_y), (1.0, 1.0));
        assert!(!out.active && !out.triggered);
    }

    #[test]
    fn same_monitor_drift_never_triggers() {
        let mut deform = CrossingDeform::new();
        for i in 0..120 {
            let out = deform.advance(&frame(0.0, 0.0, 100.0 + i as f64 * 10.0, i as f64 / 60.0));
            assert!(!out.triggered, "drift triggered on frame {i}");
            assert_eq!((out.scale_x, out.scale_y), (1.0, 1.0));
        }
    }

    #[test]
    fn fast_crossing_squeezes_along_the_normal() {
        let mut deform = CrossingDeform::new();
        deform.advance(&frame(0.0, 0.0, 1900.0, 0.0));
        // 100 px in one frame is a 6000 px/s fling: full squeeze on x.
        let out = deform.advance(&frame(1920.0, 0.0, 2000.0, 1.0 / 60.0));
        assert!(out.triggered);
        assert!(out.scale_x < 1.0 && out.scale_x >= 1.0 - CROSS_SQUEEZE);
        assert!(out.scale_y > 1.0 && out.scale_y <= 1.0 + CROSS_STRETCH);
    }

    #[test]
    fn vertical_crossing_squeezes_y() {
        let mut deform = CrossingDeform::new();
        deform.advance(&frame_at(0.0, 0.0, 100.0, 1060.0, 0.0));
        let out = deform.advance(&frame_at(0.0, 1080.0, 120.0, 1100.0, 1.0 / 60.0));
        assert!(out.triggered);
        assert!(out.scale_y < 1.0);
        assert!(out.scale_x > 1.0);
    }

    #[test]
    fn slow_drift_across_reports_no_deform() {
        let mut deform = CrossingDeform::new();
        deform.advance(&frame(0.0, 0.0, 1919.0, 0.0));
        // New monitor but barely moving: reseed, no trigger.
        let out = deform.advance(&frame(1920.0, 0.0, 1920.0, 1.0));
        assert!(!out.triggered);
        assert_eq!((out.scale_x, out.scale_y), (1.0, 1.0));
        // And it does not retrigger on the next frame either.
        let out = deform.advance(&frame(1920.0, 0.0, 1921.0, 1.0 + 1.0 / 60.0));
        assert!(!out.triggered);
    }

    #[test]
    fn teleport_reseeds_without_deforming() {
        let mut deform = CrossingDeform::new();
        deform.advance(&frame(0.0, 0.0, 1919.0, 0.0));
        let out = deform.advance(&frame(1920.0, 0.0, 2100.0, 1.0 / 60.0));
        assert!(!out.triggered);
        assert_eq!((out.scale_x, out.scale_y), (1.0, 1.0));
    }

    #[test]
    fn ordinary_crossings_are_visible_and_faster_crossings_peak_more() {
        fn peak_squeeze(speed: f64) -> f64 {
            let mut deform = CrossingDeform::new();
            deform.advance(&frame(0.0, 0.0, 1919.0, 0.0));
            let center = 1919.0 + speed / 60.0;
            let first = deform.advance(&frame(1920.0, 0.0, center, 1.0 / 60.0));
            assert!(first.triggered);
            assert!(first.scale_x > 1.0 - CROSS_SQUEEZE, "the impulse should build instead of snapping");
            let mut peak = 1.0 - first.scale_x;
            for i in 2..=24 {
                let output = deform.advance(&frame(1920.0, 0.0, center, i as f64 / 60.0));
                peak = peak.max(1.0 - output.scale_x);
            }
            peak
        }
        let slow = peak_squeeze(500.0);
        let ordinary = peak_squeeze(1000.0);
        let full = peak_squeeze(CROSS_FULL_SPEED);
        let over = peak_squeeze(7000.0);
        assert!(slow > 0.03, "a deliberate crossing should be visible: {slow}");
        assert!(ordinary > slow && full > ordinary, "faster crossings should deform more: {slow} {ordinary} {full}");
        assert!(
            (full - CROSS_SQUEEZE).abs() < 0.01,
            "full squeeze should reach the design cap, got {full}"
        );
        assert!(
            (over - full).abs() < 1e-12,
            "crossings past full speed should clamp at {full}, got {over}"
        );
    }

    #[test]
    fn successive_crossing_axes_keep_both_springs_continuous() {
        let mut deform = CrossingDeform::new();
        deform.advance(&frame_at(0.0, 0.0, 1919.0, 1060.0, 0.0));
        let across = deform.advance(&frame_at(1920.0, 0.0, 1950.0, 1060.0, 1.0 / 60.0));
        assert!(across.triggered);
        let expected_x = std::cell::Cell::new(deform.squeeze_x.get());
        let expected_x_velocity = std::cell::Cell::new(deform.squeeze_x_vel.get());
        spring_01(
            &expected_x,
            &expected_x_velocity,
            0.0,
            170.0,
            1.0 / 60.0,
        );
        let vertical = frame_at(1920.0, 1080.0, 1950.0, 1100.0, 2.0 / 60.0);
        let output = deform.advance(&vertical);
        assert!(output.triggered);
        assert!((deform.squeeze_x.get() - expected_x.get()).abs() < 1e-12);
        assert!(deform.squeeze_y.get() > 0.0);
        assert!((1.0 - CROSS_SQUEEZE..=1.0 + CROSS_STRETCH).contains(&output.scale_x));
        assert!((1.0 - CROSS_SQUEEZE..=1.0 + CROSS_STRETCH).contains(&output.scale_y));
    }

    #[test]
    fn backtrack_retriggers_on_the_new_normal() {
        let mut deform = CrossingDeform::new();
        deform.advance(&frame(0.0, 0.0, 1900.0, 0.0));
        let out = deform.advance(&frame(1920.0, 0.0, 2000.0, 1.0 / 60.0));
        assert!(out.triggered && out.scale_x < 1.0);
        // Jump back just as fast: triggers again (reseeded above, so this is
        // a genuine second crossing, not a repeat).
        let out = deform.advance(&frame(0.0, 0.0, 1900.0, 2.0 / 60.0));
        assert!(out.triggered);
        assert!(out.scale_x < 1.0);
    }

    #[test]
    fn spring_returns_to_round() {
        let mut deform = CrossingDeform::new();
        deform.advance(&frame(0.0, 0.0, 1900.0, 0.0));
        deform.advance(&frame(1920.0, 0.0, 2000.0, 1.0 / 60.0));
        let mut done = false;
        for i in 0..600 {
            let out = deform.advance(&frame(1920.0, 0.0, 2000.0, (2 + i) as f64 / 60.0));
            assert!(!out.triggered);
            if !out.active {
                done = true;
                break;
            }
        }
        assert!(done, "deform never settled");
        let out = deform.advance(&frame(1920.0, 0.0, 2000.0, 11.0));
        assert_eq!((out.scale_x, out.scale_y), (1.0, 1.0));
    }

    #[test]
    fn invalid_stiffness_matches_its_sanitized_value_during_return() {
        for (stiffness, sanitized) in [
            (0.0, 1.0),
            (-10.0, 1.0),
            (f64::NAN, 170.0),
            (f64::INFINITY, 170.0),
            (f64::NEG_INFINITY, 170.0),
            (f64::MAX, 1000.0),
        ] {
            let mut deform = CrossingDeform::new();
            let mut reference = CrossingDeform::new();
            let seed = frame(0.0, 0.0, 1900.0, 0.0);
            deform.advance(&seed);
            reference.advance(&seed);

            let mut crossing = frame(1920.0, 0.0, 2000.0, 1.0 / 60.0);
            let mut expected = crossing;
            crossing.stiffness = stiffness;
            expected.stiffness = sanitized;

            for i in 1..=240 {
                let now = i as f64 / 60.0;
                crossing.now = now;
                expected.now = now;
                let actual = deform.advance(&crossing);
                let expected_output = reference.advance(&expected);
                assert_eq!(actual.triggered, expected_output.triggered);
                assert_eq!(actual.active, expected_output.active);
                assert_eq!(actual.pulse, expected_output.pulse);
                assert_eq!(actual.scale_x, expected_output.scale_x);
                assert_eq!(actual.scale_y, expected_output.scale_y);
                assert!(actual.scale_x.is_finite() && actual.scale_y.is_finite());
            }
        }
    }

    #[test]
    fn reduced_motion_pulses_without_deforming() {
        let mut deform = CrossingDeform::new();
        deform.advance(&frame(0.0, 0.0, 1900.0, 0.0));
        let mut f = frame(1920.0, 0.0, 2000.0, 1.0 / 60.0);
        f.reduced_motion = true;
        let out = deform.advance(&f);
        assert!(out.triggered);
        assert_eq!((out.scale_x, out.scale_y), (1.0, 1.0));
        assert!(!out.active);
        assert_eq!(out.pulse, 1.0);
        // The pulse decays away on its own.
        let mut last = 1.0;
        for i in 1..30 {
            let out = deform.advance(&CrossingFrame { now: (1 + i) as f64 / 60.0, ..f });
            assert!(out.pulse <= last);
            last = out.pulse;
        }
        assert_eq!(last, 0.0);
    }

    #[test]
    fn unknown_monitor_never_triggers_or_reseeds() {
        let mut deform = CrossingDeform::new();
        for i in 0..10 {
            let out = deform.advance(&frame(f64::NAN, 0.0, 100.0, i as f64 / 60.0));
            assert!(!out.triggered);
        }
        // A later finite frame seeds cleanly instead of treating the NaN run
        // as a crossing.
        let out = deform.advance(&frame(0.0, 0.0, 100.0, 1.0));
        assert!(!out.triggered);
    }

    #[test]
    fn unknown_monitor_keeps_returning_to_rest_and_honors_reduced_motion() {
        for reduced_motion in [false, true] {
            let mut deform = CrossingDeform::new();
            deform.advance(&frame(0.0, 0.0, 1900.0, 0.0));
            let crossing = deform.advance(&frame(1920.0, 0.0, 2000.0, 1.0 / 60.0));
            assert!(crossing.triggered && crossing.active);
            let mut unknown = frame(f64::NAN, f64::NAN, 200.0, 2.0 / 60.0);
            unknown.reduced_motion = reduced_motion;
            let first = deform.advance(&unknown);
            assert!(!first.triggered);
            if reduced_motion {
                assert_eq!((first.scale_x, first.scale_y), (1.0, 1.0));
                assert!(!first.active);
            } else {
                assert!(first.scale_x > crossing.scale_x);
            }
            for _ in 0..240 {
                unknown.now += unknown.dt;
                assert!(!deform.advance(&unknown).triggered);
            }
            assert_eq!(deform.scales(), (1.0, 1.0));
            assert!(!deform.animating());
        }
    }

    #[test]
    fn diagonal_crossing_picks_the_dominant_axis() {
        let mut deform = CrossingDeform::new();
        deform.advance(&frame_at(0.0, 0.0, 100.0, 1060.0, 0.0));
        // Monitor moved mostly up, a little right: vertical normal.
        let out = deform.advance(&frame_at(100.0, 1080.0, 200.0, 1100.0, 1.0 / 60.0));
        assert!(out.triggered);
        assert!(out.scale_y < 1.0 && out.scale_x > 1.0);
    }

    #[test]
    fn vertically_offset_side_by_side_monitors_keep_a_horizontal_normal() {
        for (next_x, old_x, new_x, width) in [
            (800.0, 790.0, 810.0, 1200.0),
            (-400.0, 10.0, -10.0, 400.0),
        ] {
            let mut deform = CrossingDeform::new();
            let mut before = frame(0.0, 0.0, old_x, 0.0);
            before.monitor_width = 800.0;
            before.monitor_height = 1800.0;
            before.pill_cy = 1300.0;
            deform.advance(&before);
            let mut after = frame(next_x, 1200.0, new_x, 1.0 / 60.0);
            after.monitor_width = width;
            after.pill_cy = 1300.0;
            let output = deform.advance(&after);
            assert!(output.triggered);
            assert!(output.scale_x < 1.0 && output.scale_y > 1.0);
        }
    }

    #[test]
    fn horizontally_offset_stacked_monitors_keep_a_vertical_normal() {
        for (next_y, old_y, new_y) in [(600.0, 590.0, 610.0), (-800.0, 10.0, -10.0)] {
            let mut deform = CrossingDeform::new();
            let mut before = frame(0.0, 0.0, 2000.0, 0.0);
            before.monitor_width = 2400.0;
            before.monitor_height = 600.0;
            before.pill_cy = old_y;
            deform.advance(&before);
            let mut after = frame(1800.0, next_y, 2000.0, 1.0 / 60.0);
            after.monitor_width = 1080.0;
            after.monitor_height = 800.0;
            after.pill_cy = new_y;
            let output = deform.advance(&after);
            assert!(output.triggered);
            assert!(output.scale_y < 1.0 && output.scale_x > 1.0);
        }
    }

    #[test]
    fn ambiguous_monitor_pairs_do_not_guess_a_crossing_normal() {
        for (x, y) in [(1920.0, 1080.0), (2000.0, 1200.0), (100.0, 100.0)] {
            let mut deform = CrossingDeform::new();
            deform.advance(&frame(0.0, 0.0, 100.0, 0.0));
            let output = deform.advance(&frame(x, y, 120.0, 1.0 / 60.0));
            assert!(!output.triggered);
            assert_eq!((output.scale_x, output.scale_y), (1.0, 1.0));
        }
    }

    #[test]
    fn invalid_monitor_dimensions_do_not_reseed() {
        for invalid in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let mut deform = CrossingDeform::new();
            let mut unknown = frame(1920.0, 0.0, 100.0, 0.0);
            unknown.monitor_width = invalid;
            assert!(!deform.advance(&unknown).triggered);
            assert!(!deform.seeded);
            unknown.monitor_width = 1920.0;
            unknown.monitor_height = invalid;
            assert!(!deform.advance(&unknown).triggered);
            assert!(!deform.seeded);
        }
    }

}
