//! Monitor-crossing deformation shared by the three pill renderers.
//!
//! When the pill crosses onto another monitor it squeezes briefly along the
//! boundary normal (down to 92%) and stretches across it (up to 104%),
//! scaled by the crossing speed, then springs back. The effect is paint
//! only: hit regions, saved positions, and selection state never see it.
//!
//! The platform owns monitor identity and passes the origin of the monitor
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

/// Peak squeeze along the boundary normal: the pill draws at 92%.
pub const CROSS_SQUEEZE: f64 = 0.08;
/// Peak stretch on the perpendicular axis: the pill draws at 104%.
pub const CROSS_STRETCH: f64 = 0.04;
/// Slowest crossing that still deforms, in px/s. Below this the move is a
/// drift, not a crossing.
pub const CROSS_MIN_SPEED: f64 = 50.0;
/// Crossing speed that deforms fully, in px/s. Past this the magnitude
/// clamps instead of growing.
pub const CROSS_FULL_SPEED: f64 = 3000.0;
/// Faster than this is a teleport (re-home, hot-plug shuffle), not a
/// gesture crossing, and never deforms.
pub const CROSS_MAX_SPEED: f64 = 8000.0;
/// Border pulse length for reduced motion, in seconds.
pub const CROSS_PULSE_TIME: f64 = 0.25;

/// Boundary normal axis: the dominant axis of the monitor-origin delta.
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
    last_cx: f64,
    last_cy: f64,
    last_t: f64,
    axis: CrossingAxis,
    energy: Cell<f64>,
    energy_vel: Cell<f64>,
    pulse: Cell<f64>,
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
            last_cx: 0.0,
            last_cy: 0.0,
            last_t: 0.0,
            axis: CrossingAxis::X,
            energy: Cell::new(0.0),
            energy_vel: Cell::new(0.0),
            pulse: Cell::new(0.0),
        }
    }

    /// True while the return spring is still moving. The redraw gate reads
    /// it to keep painting until the pill is round again.
    pub fn animating(&self) -> bool {
        self.energy.get() != 0.0 || self.energy_vel.get() != 0.0
    }

    /// Forget the monitor. Used when the platform re-homes the pill itself.
    pub fn reset(&mut self) {
        self.seeded = false;
        self.energy.set(0.0);
        self.energy_vel.set(0.0);
        self.pulse.set(0.0);
    }

    /// Feed one frame and return the paint scale for it.
    pub fn advance(&mut self, frame: &CrossingFrame) -> DeformOutput {
        let dt = if frame.dt.is_finite() {
            frame.dt.clamp(0.0, 0.05)
        } else {
            0.0
        };
        self.pulse.set((self.pulse.get() - dt / CROSS_PULSE_TIME).max(0.0));

        let known = frame.monitor_x.is_finite()
            && frame.monitor_y.is_finite()
            && frame.pill_cx.is_finite()
            && frame.pill_cy.is_finite()
            && frame.now.is_finite();
        if !known {
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
            if speed >= CROSS_MIN_SPEED && speed <= CROSS_MAX_SPEED {
                self.axis = if (frame.monitor_x - self.mon_x).abs() >= (frame.monitor_y - self.mon_y).abs() {
                    CrossingAxis::X
                } else {
                    CrossingAxis::Y
                };
                if !frame.reduced_motion {
                    let magnitude = ((speed - CROSS_MIN_SPEED) / (CROSS_FULL_SPEED - CROSS_MIN_SPEED)).clamp(0.0, 1.0);
                    self.energy.set(magnitude);
                    self.energy_vel.set(0.0);
                }
                self.pulse.set(1.0);
                triggered = true;
            }
            self.mon_x = frame.monitor_x;
            self.mon_y = frame.monitor_y;
            self.last_cx = frame.pill_cx;
            self.last_cy = frame.pill_cy;
            self.last_t = frame.now;
        } else {
            self.last_cx = frame.pill_cx;
            self.last_cy = frame.pill_cy;
            self.last_t = frame.now;
        }

        if !frame.reduced_motion {
            spring_01(&self.energy, &self.energy_vel, 0.0, frame.stiffness, dt);
        } else {
            self.energy.set(0.0);
            self.energy_vel.set(0.0);
        }
        self.output(triggered)
    }

    fn seed(&mut self, frame: &CrossingFrame) {
        self.seeded = true;
        self.mon_x = frame.monitor_x;
        self.mon_y = frame.monitor_y;
        self.last_cx = frame.pill_cx;
        self.last_cy = frame.pill_cy;
        self.last_t = frame.now;
    }

    /// Current paint scale around the pill center. (1, 1) at rest.
    pub fn scales(&self) -> (f64, f64) {
        let e = self.energy.get();
        match self.axis {
            CrossingAxis::X => (1.0 - CROSS_SQUEEZE * e, 1.0 + CROSS_STRETCH * e),
            CrossingAxis::Y => (1.0 + CROSS_STRETCH * e, 1.0 - CROSS_SQUEEZE * e),
        }
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
        CrossingFrame {
            monitor_x: mon_x,
            monitor_y: mon_y,
            pill_cx: cx,
            pill_cy: 500.0,
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
        deform.advance(&frame(0.0, 0.0, 100.0, 0.0));
        // 100 px in one frame is a 6000 px/s fling: full squeeze on x.
        let out = deform.advance(&frame(1920.0, 0.0, 200.0, 1.0 / 60.0));
        assert!(out.triggered);
        assert!(out.scale_x < 1.0 && out.scale_x >= 1.0 - CROSS_SQUEEZE);
        assert!(out.scale_y > 1.0 && out.scale_y <= 1.0 + CROSS_STRETCH);
    }

    #[test]
    fn vertical_crossing_squeezes_y() {
        let mut deform = CrossingDeform::new();
        deform.advance(&frame(0.0, 0.0, 100.0, 0.0));
        let out = deform.advance(&frame(0.0, 1080.0, 120.0, 1.0 / 60.0));
        assert!(out.triggered);
        assert!(out.scale_y < 1.0);
        assert!(out.scale_x > 1.0);
    }

    #[test]
    fn slow_drift_across_reports_no_deform() {
        let mut deform = CrossingDeform::new();
        deform.advance(&frame(0.0, 0.0, 100.0, 0.0));
        // New monitor but barely moving: reseed, no trigger.
        let out = deform.advance(&frame(1920.0, 0.0, 101.0, 1.0));
        assert!(!out.triggered);
        assert_eq!((out.scale_x, out.scale_y), (1.0, 1.0));
        // And it does not retrigger on the next frame either.
        let out = deform.advance(&frame(1920.0, 0.0, 102.0, 1.0 + 1.0 / 60.0));
        assert!(!out.triggered);
    }

    #[test]
    fn teleport_reseeds_without_deforming() {
        let mut deform = CrossingDeform::new();
        deform.advance(&frame(0.0, 0.0, 100.0, 0.0));
        let out = deform.advance(&frame(1920.0, 0.0, 1500.0, 1.0 / 60.0));
        assert!(!out.triggered);
        assert_eq!((out.scale_x, out.scale_y), (1.0, 1.0));
    }

    #[test]
    fn magnitude_grows_with_speed_then_clamps() {
        fn energy_at(speed: f64) -> f64 {
            let mut deform = CrossingDeform::new();
            deform.advance(&frame(0.0, 0.0, 0.0, 0.0));
            // One frame at `speed` px/s: dx = speed / 60.
            let out = deform.advance(&frame(1920.0, 0.0, speed / 60.0, 1.0 / 60.0));
            assert!(out.triggered);
            out.scale_x
        }
        let slow = energy_at(500.0);
        let mid = energy_at(1500.0);
        let full = energy_at(3000.0);
        let over = energy_at(7000.0);
        assert!(slow > mid && mid > full, "faster must squeeze more: {slow} {mid} {full}");
        assert_eq!(full, over, "past full speed the magnitude clamps");
        assert!((full - (1.0 - CROSS_SQUEEZE)).abs() < 0.005, "full squeeze should bottom out, got {full}");
    }

    #[test]
    fn backtrack_retriggers_on_the_new_normal() {
        let mut deform = CrossingDeform::new();
        deform.advance(&frame(0.0, 0.0, 100.0, 0.0));
        let out = deform.advance(&frame(1920.0, 0.0, 200.0, 1.0 / 60.0));
        assert!(out.triggered && out.scale_x < 1.0);
        // Jump back just as fast: triggers again (reseeded above, so this is
        // a genuine second crossing, not a repeat).
        let out = deform.advance(&frame(0.0, 0.0, 100.0, 2.0 / 60.0));
        assert!(out.triggered);
        assert!(out.scale_x < 1.0);
    }

    #[test]
    fn spring_returns_to_round() {
        let mut deform = CrossingDeform::new();
        deform.advance(&frame(0.0, 0.0, 100.0, 0.0));
        deform.advance(&frame(1920.0, 0.0, 200.0, 1.0 / 60.0));
        let mut done = false;
        for i in 0..600 {
            let out = deform.advance(&frame(1920.0, 0.0, 200.0, (2 + i) as f64 / 60.0));
            assert!(!out.triggered);
            if !out.active {
                done = true;
                break;
            }
        }
        assert!(done, "deform never settled");
        let out = deform.advance(&frame(1920.0, 0.0, 200.0, 11.0));
        assert_eq!((out.scale_x, out.scale_y), (1.0, 1.0));
    }

    #[test]
    fn reduced_motion_pulses_without_deforming() {
        let mut deform = CrossingDeform::new();
        deform.advance(&frame(0.0, 0.0, 100.0, 0.0));
        let mut f = frame(1920.0, 0.0, 200.0, 1.0 / 60.0);
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
    fn diagonal_crossing_picks_the_dominant_axis() {
        let mut deform = CrossingDeform::new();
        deform.advance(&frame(0.0, 0.0, 100.0, 0.0));
        // Monitor moved mostly up, a little right: vertical normal.
        let out = deform.advance(&frame(100.0, 1080.0, 200.0, 1.0 / 60.0));
        assert!(out.triggered);
        assert!(out.scale_y < 1.0 && out.scale_x > 1.0);
    }
}
