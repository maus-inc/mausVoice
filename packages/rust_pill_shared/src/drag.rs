//! Native drag-motion controller shared by the three pill renderers.
//!
//! Every platform feeds the same inputs once per frame: the newest pointer
//! position, the elapsed time, and the allowed range for the window top-left
//! computed from the monitor work area. The controller answers with the window
//! position for that frame.
//!
//! While the drag is held the window tracks the pointer 1:1 with no spring in
//! the path, so the pill can never trail the cursor. Spring motion applies
//! only to the release settle: a short velocity-aware glide that runs on the
//! frame clock and is cancelled the moment a new drag begins. Platforms own
//! the work-area bounds, applying the output position, and persisting the drop
//! point; this module owns samples, release velocity, and settle physics, so
//! all three pills feel identical and stay testable without a display.

use crate::edge::{ease_point, EdgeWork};

/// One pointer observation. `time` is seconds on a monotonic clock; platforms
/// pass their own frame clock (it only ever compares samples with each other).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PointerSample {
    pub x: f64,
    pub y: f64,
    pub time: f64,
}

/// Allowed range for the window top-left, computed by the platform from the
/// monitor work area and the pill's visible footprint.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DragBounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl DragBounds {
    /// Clamp a window origin into range. Inverted bounds (a footprint larger
    /// than the work area) collapse to the minimum edge instead of pushing the
    /// window off screen.
    pub fn clamp_point(&self, x: f64, y: f64) -> (f64, f64) {
        let max_x = self.max_x.max(self.min_x);
        let max_y = self.max_y.max(self.min_y);
        (x.clamp(self.min_x, max_x), y.clamp(self.min_y, max_y))
    }
}

/// What the controller is doing. Platforms still own the gesture flags; the
/// phase mirrors them (`Held` while the drag is armed) plus the settle that
/// runs after release.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DragPhase {
    Idle,
    Held,
    Settling,
}

/// One frame of input to [`DragController::advance`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DragFrame {
    /// Newest known pointer position in the platform's drag space.
    pub pointer_x: f64,
    pub pointer_y: f64,
    /// Frame time in seconds on the platform's monotonic clock.
    pub now: f64,
    /// Seconds since the previous frame. Clamped internally, so callers pass
    /// the raw measurement.
    pub dt: f64,
    /// Allowed window range for this frame.
    pub bounds: DragBounds,
    /// True while the platform's drag is still armed.
    pub held: bool,
    /// True when the OS asks for reduced motion. The settle snaps instead of
    /// gliding; held tracking is unaffected (direct tracking is not animation).
    pub reduced_motion: bool,
    /// Work-area size for edge repulsion, if the platform knows it. `None`
    /// (or a dead size) keeps the existing hard clamp. See
    /// [`crate::edge::ease_point`].
    pub edge_work: Option<EdgeWork>,
}

/// One frame of output from [`DragController::advance`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DragOutput {
    /// Window top-left for this frame, already clamped to the frame bounds.
    pub x: f64,
    pub y: f64,
    /// Release velocity in px/s while held (live estimate), settle velocity
    /// while settling, zero once idle.
    pub velocity_x: f64,
    pub velocity_y: f64,
    pub phase: DragPhase,
    /// True on the frame a settle completes. Platforms persist the drop point
    /// when they see the Held -> Settling -> settled transition finish.
    pub settled: bool,
}

/// How many pointer samples the controller keeps for velocity estimation.
/// Eight samples at 60 Hz cover ~130 ms, just over [`VELOCITY_WINDOW`].
const SAMPLE_RING: usize = 8;
/// Release velocity measures the newest sample against the oldest sample
/// inside this window, so a pause before release reads ~zero instead of the
/// average speed of the whole drag.
const VELOCITY_WINDOW: f64 = 0.12;
/// Largest frame step the controller integrates. A sleep, stall, or display
/// change can hand a huge `dt` to one frame; clamping keeps the spring (and
/// the velocity estimate) from exploding on it.
const MAX_DT: f64 = 0.05;
/// Spring integration step. Long frames split into substeps of at most this
/// size so the settle curve is frame-rate independent.
const SUBSTEP: f64 = 1.0 / 120.0;
/// Release speeds above this are clock-jump outliers (two samples with nearly
/// identical timestamps), never a real hand. 20,000 px/s crosses a 4K screen
/// in a fifth of a second.
const MAX_RELEASE_SPEED: f64 = 20_000.0;
/// The settle glides along the release velocity for this long before the
/// spring takes over the target: `target = release + velocity * GLIDE`.
const SETTLE_GLIDE_TIME: f64 = 0.09;
/// Longest allowed glide in pixels, so a fast fling cannot throw the pill
/// across the monitor.
const SETTLE_MAX_GLIDE: f64 = 160.0;
/// Settle spring stiffness. Critically damped (damping ratio 1), so the settle
/// approaches its target without ever overshooting it.
const SETTLE_STIFFNESS: f64 = 220.0;
/// The settle snaps to its target once within this distance with a slow
/// enough velocity, instead of easing asymptotically forever.
const SETTLE_SNAP_PX: f64 = 0.5;
const SETTLE_SNAP_SPEED: f64 = 90.0;
/// Releases slower than this settle in place: the glide would only turn
/// sensor jitter into visible drift.
const SETTLE_MIN_FLING_SPEED: f64 = 30.0;
/// Safety cap: a settle always finishes inside this time even if the snap
/// thresholds never trip (they always do for a damped spring; this is the net).
const SETTLE_MAX_TIME: f64 = 0.6;

/// Shared native drag-motion controller. See the module docs for the split of
/// duties between this controller and the platforms.
#[derive(Debug, Clone)]
pub struct DragController {
    phase: DragPhase,
    samples: [PointerSample; SAMPLE_RING],
    sample_len: usize,
    grab_dx: f64,
    grab_dy: f64,
    window_x: f64,
    window_y: f64,
    release_vx: f64,
    release_vy: f64,
    settle_x: f64,
    settle_y: f64,
    settle_vx: f64,
    settle_vy: f64,
    settle_target: Option<(f64, f64)>,
    settle_elapsed: f64,
}

impl Default for DragController {
    fn default() -> Self {
        Self::new()
    }
}

impl DragController {
    pub fn new() -> Self {
        Self {
            phase: DragPhase::Idle,
            samples: [PointerSample {
                x: 0.0,
                y: 0.0,
                time: 0.0,
            }; SAMPLE_RING],
            sample_len: 0,
            grab_dx: 0.0,
            grab_dy: 0.0,
            window_x: 0.0,
            window_y: 0.0,
            release_vx: 0.0,
            release_vy: 0.0,
            settle_x: 0.0,
            settle_y: 0.0,
            settle_vx: 0.0,
            settle_vy: 0.0,
            settle_target: None,
            settle_elapsed: 0.0,
        }
    }

    pub fn phase(&self) -> DragPhase {
        self.phase
    }

    pub fn is_settling(&self) -> bool {
        self.phase == DragPhase::Settling
    }

    /// Release velocity latched by the last [`DragController::end_drag`], in
    /// px/s. Zero unless a settle is running.
    pub fn release_velocity(&self) -> (f64, f64) {
        if self.phase == DragPhase::Settling {
            (self.release_vx, self.release_vy)
        } else {
            (0.0, 0.0)
        }
    }

    /// Drop all state back to idle. Used when the platform re-homes the pill
    /// (reset-position command) or otherwise moves the window itself.
    pub fn reset(&mut self) {
        self.phase = DragPhase::Idle;
        self.sample_len = 0;
        self.release_vx = 0.0;
        self.release_vy = 0.0;
        self.settle_target = None;
        self.settle_elapsed = 0.0;
    }

    /// Arm a drag. The grab offset is the pointer position minus the window
    /// origin at the arm moment; holding it fixed keeps the grabbed point
    /// under the cursor. Arming mid-settle cancels the settle immediately, so
    /// a new drag never fights the previous release.
    pub fn begin_drag(
        &mut self,
        grab_dx: f64,
        grab_dy: f64,
        window_x: f64,
        window_y: f64,
        _now: f64,
    ) {
        self.phase = DragPhase::Held;
        self.grab_dx = grab_dx;
        self.grab_dy = grab_dy;
        self.window_x = window_x;
        self.window_y = window_y;
        self.sample_len = 0;
        self.release_vx = 0.0;
        self.release_vy = 0.0;
        self.settle_target = None;
        self.settle_elapsed = 0.0;
    }

    /// Record a pointer observation between frames (a motion event). Samples
    /// coalesce: only the newest position is ever used for tracking, and the
    /// ring keeps just enough history for the release-velocity estimate.
    /// Non-finite coordinates are ignored, never latched.
    pub fn push_sample(&mut self, x: f64, y: f64, now: f64) {
        if !x.is_finite() || !y.is_finite() || !now.is_finite() {
            return;
        }
        let now = if self.sample_len > 0 {
            now.max(self.samples[self.sample_len - 1].time)
        } else {
            now
        };
        let sample = PointerSample { x, y, time: now };
        if self.sample_len < SAMPLE_RING {
            self.samples[self.sample_len] = sample;
            self.sample_len += 1;
        } else {
            self.samples.copy_within(1.., 0);
            self.samples[SAMPLE_RING - 1] = sample;
        }
    }

    /// End the drag and start the release settle. The settle target derives
    /// from the release velocity on the first settling frame (bounds are only
    /// known per frame); until then the phase alone tells the platform a
    /// settle is running. Safe to call when no drag is held.
    pub fn end_drag(&mut self, now: f64) {
        if self.phase != DragPhase::Held {
            return;
        }
        let (vx, vy) = self.estimate_velocity(now);
        self.release_vx = vx;
        self.release_vy = vy;
        self.settle_x = self.window_x;
        self.settle_y = self.window_y;
        self.settle_vx = vx;
        self.settle_vy = vy;
        self.settle_target = None;
        self.settle_elapsed = 0.0;
        self.phase = DragPhase::Settling;
    }

    /// Advance one frame and return the window position for it.
    ///
    /// The frame sample joins the ring (coalescing with any between-frame
    /// pushes: newest wins for position). A `held` flag that flips false
    /// without an explicit [`DragController::end_drag`] still releases cleanly,
    /// so the missed-release backstops that clear the platform flag cannot
    /// strand the controller mid-drag.
    pub fn advance(&mut self, frame: &DragFrame) -> DragOutput {
        let dt = if frame.dt.is_finite() {
            frame.dt.clamp(0.0, MAX_DT)
        } else {
            0.0
        };
        self.push_sample(frame.pointer_x, frame.pointer_y, frame.now);

        match self.phase {
            DragPhase::Idle => {
                if frame.held {
                    // A platform that feeds held frames without arming first
                    // still tracks; the grab offset stays whatever was latched
                    // (zero until the first begin_drag).
                    self.phase = DragPhase::Held;
                    return self.track_held(frame);
                }
                DragOutput {
                    x: self.window_x,
                    y: self.window_y,
                    velocity_x: 0.0,
                    velocity_y: 0.0,
                    phase: DragPhase::Idle,
                    settled: true,
                }
            }
            DragPhase::Held => {
                if frame.held {
                    self.track_held(frame)
                } else {
                    self.end_drag(frame.now);
                    self.track_settle(frame, dt)
                }
            }
            DragPhase::Settling => {
                if frame.held {
                    // Held frames for a new press arrived without begin_drag
                    // (which would already have set Held): the latched grab
                    // belongs to the previous drag, so re-latch it to hold the
                    // current position instead of jumping, then track 1:1.
                    self.grab_dx = frame.pointer_x - self.window_x;
                    self.grab_dy = frame.pointer_y - self.window_y;
                    self.phase = DragPhase::Held;
                    self.settle_target = None;
                    self.track_held(frame)
                } else {
                    self.track_settle(frame, dt)
                }
            }
        }
    }

    /// Direct 1:1 tracking: newest pointer minus the fixed grab offset,
    /// clamped to the frame bounds. No spring, no lag. A non-finite pointer
    /// holds the last position instead of poisoning the window origin.
    fn track_held(&mut self, frame: &DragFrame) -> DragOutput {
        let (vx, vy) = self.estimate_velocity(frame.now);
        // Reduced motion keeps the gap with the full ease: zero velocity
        // reads as no fling, so the blend stays at one.
        let (evx, evy) = if frame.reduced_motion { (0.0, 0.0) } else { (vx, vy) };
        let (x, y) = if frame.pointer_x.is_finite() && frame.pointer_y.is_finite() {
            let (cx, cy) = frame.bounds.clamp_point(
                frame.pointer_x - self.grab_dx,
                frame.pointer_y - self.grab_dy,
            );
            // Edge repulsion eases the clamped origin toward the resting gap
            // inside the activation band; outside it this is identity.
            let bounds = frame.bounds;
            ease_point(
                cx,
                cy,
                evx,
                evy,
                (bounds.min_x, bounds.min_y, bounds.max_x, bounds.max_y),
                frame.edge_work,
            )
        } else {
            (self.window_x, self.window_y)
        };
        self.window_x = x;
        self.window_y = y;
        DragOutput {
            x,
            y,
            velocity_x: vx,
            velocity_y: vy,
            phase: DragPhase::Held,
            settled: false,
        }
    }

    /// One frame of the release settle: a critically damped spring toward the
    /// glide target, integrated in substeps. The spring starts exactly at the
    /// release point with the release velocity, so the first settle frame
    /// continues the motion instead of jumping.
    fn track_settle(&mut self, frame: &DragFrame, dt: f64) -> DragOutput {
        let speed = (self.release_vx * self.release_vx + self.release_vy * self.release_vy).sqrt();
        let (tx, ty) = match self.settle_target {
            Some((tx, ty)) => frame.bounds.clamp_point(tx, ty),
            None => {
                let target = if frame.reduced_motion || speed < SETTLE_MIN_FLING_SPEED {
                    (self.settle_x, self.settle_y)
                } else {
                    let mut gx = self.release_vx * SETTLE_GLIDE_TIME;
                    let mut gy = self.release_vy * SETTLE_GLIDE_TIME;
                    let glide =
                        (gx * gx + gy * gy).sqrt().max(f64::MIN_POSITIVE);
                    if glide > SETTLE_MAX_GLIDE {
                        let k = SETTLE_MAX_GLIDE / glide;
                        gx *= k;
                        gy *= k;
                    }
                    (self.settle_x + gx, self.settle_y + gy)
                };
                let clamped = frame.bounds.clamp_point(target.0, target.1);
                self.settle_target = Some(clamped);
                clamped
            }
        };

        if frame.reduced_motion {
            // The snap still lands on the resting gap, not just inside the
            // work area.
            let bounds = frame.bounds;
            let (ex, ey) = ease_point(
                tx,
                ty,
                0.0,
                0.0,
                (bounds.min_x, bounds.min_y, bounds.max_x, bounds.max_y),
                frame.edge_work,
            );
            self.window_x = ex;
            self.window_y = ey;
            self.phase = DragPhase::Idle;
            self.settle_target = None;
            return DragOutput {
                x: ex,
                y: ey,
                velocity_x: 0.0,
                velocity_y: 0.0,
                phase: DragPhase::Idle,
                settled: true,
            };
        }

        let steps = ((dt / SUBSTEP).ceil() as usize).max(1);
        let h = dt / steps as f64;
        let damping = 2.0 * SETTLE_STIFFNESS.sqrt();
        let (mut x, mut y, mut vx, mut vy) =
            (self.settle_x, self.settle_y, self.settle_vx, self.settle_vy);
        for _ in 0..steps {
            vx += (SETTLE_STIFFNESS * (tx - x) - damping * vx) * h;
            vy += (SETTLE_STIFFNESS * (ty - y) - damping * vy) * h;
            x += vx * h;
            y += vy * h;
        }
        // Edge repulsion eases the settle toward the resting gap inside the
        // activation band; the bounds clamp after it still holds the screen.
        // A clamped axis stops dead instead of pressing into the edge.
        let bounds = frame.bounds;
        let (ex, ey) = ease_point(
            x,
            y,
            vx,
            vy,
            (bounds.min_x, bounds.min_y, bounds.max_x, bounds.max_y),
            frame.edge_work,
        );
        let (cx, cy) = frame.bounds.clamp_point(ex, ey);
        if cx != ex {
            vx = 0.0;
        }
        if cy != ey {
            vy = 0.0;
        }
        self.settle_elapsed += dt;

        let close = (cx - tx).abs() < SETTLE_SNAP_PX && (cy - ty).abs() < SETTLE_SNAP_PX;
        let slow = (vx * vx + vy * vy).sqrt() < SETTLE_SNAP_SPEED;
        if (close && slow) || self.settle_elapsed >= SETTLE_MAX_TIME {
            self.window_x = tx;
            self.window_y = ty;
            self.phase = DragPhase::Idle;
            self.settle_target = None;
            return DragOutput {
                x: tx,
                y: ty,
                velocity_x: 0.0,
                velocity_y: 0.0,
                phase: DragPhase::Idle,
                settled: true,
            };
        }

        self.settle_x = cx;
        self.settle_y = cy;
        self.settle_vx = vx;
        self.settle_vy = vy;
        self.window_x = cx;
        self.window_y = cy;
        DragOutput {
            x: cx,
            y: cy,
            velocity_x: vx,
            velocity_y: vy,
            phase: DragPhase::Settling,
            settled: false,
        }
    }

    /// Release-velocity estimate from the sample ring: newest sample against
    /// the oldest sample inside [`VELOCITY_WINDOW`]. Returns zero with fewer
    /// than two usable samples or a non-positive span.
    fn estimate_velocity(&self, now: f64) -> (f64, f64) {
        if self.sample_len < 2 {
            return (0.0, 0.0);
        }
        let newest = self.samples[self.sample_len - 1];
        let mut oldest = newest;
        for sample in self.samples[..self.sample_len].iter().rev().skip(1) {
            if newest.time - sample.time > VELOCITY_WINDOW {
                break;
            }
            oldest = *sample;
        }
        let span = (newest.time - oldest.time).max(f64::MIN_POSITIVE);
        if newest.time - oldest.time <= 0.0 || !now.is_finite() {
            return (0.0, 0.0);
        }
        let mut vx = (newest.x - oldest.x) / span;
        let mut vy = (newest.y - oldest.y) / span;
        let speed = (vx * vx + vy * vy).sqrt();
        if speed > MAX_RELEASE_SPEED {
            let k = MAX_RELEASE_SPEED / speed;
            vx *= k;
            vy *= k;
        }
        (vx, vy)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME_DT: f64 = 1.0 / 60.0;

    fn wide_bounds() -> DragBounds {
        DragBounds {
            min_x: -10_000.0,
            min_y: -10_000.0,
            max_x: 10_000.0,
            max_y: 10_000.0,
        }
    }

    fn held_frame(pointer_x: f64, pointer_y: f64, now: f64) -> DragFrame {
        DragFrame {
            pointer_x,
            pointer_y,
            now,
            dt: FRAME_DT,
            bounds: wide_bounds(),
            held: true,
            reduced_motion: false,
            edge_work: None,
        }
    }

    fn free_frame(now: f64, dt: f64) -> DragFrame {
        DragFrame {
            pointer_x: 0.0,
            pointer_y: 0.0,
            now,
            dt,
            bounds: wide_bounds(),
            held: false,
            reduced_motion: false,
            edge_work: None,
        }
    }

    #[test]
    fn held_tracking_eases_inside_the_edge_band() {
        use crate::edge::EdgeWork;
        let mut drag = DragController::new();
        drag.begin_drag(0.0, 0.0, 0.0, 0.0, 0.0);
        let out = drag.advance(&DragFrame {
            pointer_x: 2.0,
            pointer_y: 500.0,
            now: 0.05,
            dt: FRAME_DT,
            bounds: DragBounds { min_x: 0.0, min_y: 0.0, max_x: 1920.0, max_y: 1080.0 },
            held: true,
            reduced_motion: false,
            edge_work: Some(EdgeWork { width: 1920.0, height: 1080.0 }),
        });
        assert!(out.x > 2.0 && out.x <= 12.5, "edge should ease, got {}", out.x);
        assert_eq!(out.y, 500.0);
    }

    #[test]
    fn held_tracking_has_zero_lag_by_construction() {
        // Two seconds of synthetic 60 Hz motion: every frame output must equal
        // the newest sample minus the grab offset, exactly.
        let mut drag = DragController::new();
        drag.begin_drag(20.0, 10.0, 0.0, 0.0, 0.0);
        for i in 0..120 {
            let now = i as f64 * FRAME_DT;
            let px = 300.0 + i as f64 * 7.0;
            let py = 200.0 + (i as f64 * 0.4).sin() * 50.0;
            let out = drag.advance(&held_frame(px, py, now));
            assert_eq!(out.phase, DragPhase::Held);
            assert!(!out.settled);
            assert!(
                (out.x - (px - 20.0)).abs() < 1e-9,
                "frame {i}: window lags the pointer"
            );
            assert!(
                (out.y - (py - 10.0)).abs() < 1e-9,
                "frame {i}: window lags the pointer"
            );
        }
    }

    #[test]
    fn held_tracking_clamps_to_the_work_area() {
        let mut drag = DragController::new();
        drag.begin_drag(0.0, 0.0, 0.0, 0.0, 0.0);
        let mut frame = held_frame(5000.0, -5000.0, 0.0);
        frame.bounds = DragBounds {
            min_x: 0.0,
            min_y: 0.0,
            max_x: 100.0,
            max_y: 100.0,
        };
        let out = drag.advance(&frame);
        assert_eq!((out.x, out.y), (100.0, 0.0));
    }

    #[test]
    fn inverted_bounds_collapse_to_the_minimum_edge() {
        // A footprint larger than the work area inverts the range; the clamp
        // must resolve to the minimum instead of leaving the area.
        let bounds = DragBounds {
            min_x: 40.0,
            min_y: 40.0,
            max_x: 10.0,
            max_y: 10.0,
        };
        assert_eq!(bounds.clamp_point(0.0, 999.0), (40.0, 40.0));
    }

    #[test]
    fn stationary_release_settles_within_two_pixels_on_the_first_frame() {
        // The common drop: the pointer rested before release, so the first
        // settle frame must not visibly jump from the last tracked position.
        let mut drag = DragController::new();
        drag.begin_drag(20.0, 10.0, 280.0, 190.0, 0.0);
        let mut last = (280.0, 190.0);
        for i in 0..30 {
            let out = drag.advance(&held_frame(300.0, 200.0, i as f64 * FRAME_DT));
            last = (out.x, out.y);
        }
        drag.end_drag(30.0 * FRAME_DT);
        let out = drag.advance(&free_frame(31.0 * FRAME_DT, FRAME_DT));
        let jump = ((out.x - last.0).powi(2) + (out.y - last.1).powi(2)).sqrt();
        assert!(jump <= 2.0, "drop jump of {jump}px exceeds 2px");
    }

    #[test]
    fn slow_release_stays_within_two_pixels_on_the_first_frame() {
        // A gentle drop at 2 px/frame keeps the first settle frame inside the
        // same 2 px budget: the spring starts at the release point, so the
        // only first-frame motion is the velocity it already had.
        let mut drag = DragController::new();
        drag.begin_drag(0.0, 0.0, 0.0, 0.0, 0.0);
        let mut last = (0.0, 0.0);
        for i in 0..30 {
            let out = drag.advance(&held_frame(i as f64 * 2.0, 0.0, i as f64 * FRAME_DT));
            last = (out.x, out.y);
        }
        drag.end_drag(30.0 * FRAME_DT);
        let out = drag.advance(&free_frame(31.0 * FRAME_DT, FRAME_DT));
        let jump = ((out.x - last.0).powi(2) + (out.y - last.1).powi(2)).sqrt();
        assert!(jump <= 2.5, "drop jump of {jump}px exceeds the budget");
    }

    #[test]
    fn fling_release_stays_continuous_and_settles_without_oscillation() {
        // A fast fling keeps moving after release, but the path must be
        // continuous (no teleport on the release frame) and the distance to
        // the target must shrink monotonically: a critically damped spring
        // never overshoots, so there is no visible oscillation.
        let mut drag = DragController::new();
        drag.begin_drag(0.0, 0.0, 0.0, 0.0, 0.0);
        let mut last = (0.0, 0.0);
        for i in 0..30 {
            let out = drag.advance(&held_frame(i as f64 * 30.0, 0.0, i as f64 * FRAME_DT));
            last = (out.x, out.y);
        }
        let release_at = 30.0 * FRAME_DT;
        drag.end_drag(release_at);
        let (vx, _) = drag.release_velocity();
        assert!(vx > 1000.0, "expected a fast release, got {vx}px/s");

        let mut prev = last;
        let mut prev_dist = f64::INFINITY;
        let mut frames = 0;
        let mut done = false;
        for i in 1..=60 {
            let out = drag.advance(&free_frame(release_at + i as f64 * FRAME_DT, FRAME_DT));
            frames = i;
            // Continuity: no single frame teleports further than the release
            // velocity could carry it (plus the spring's first pull).
            let step = ((out.x - prev.0).powi(2) + (out.y - prev.1).powi(2)).sqrt();
            assert!(
                step <= vx * FRAME_DT + 2.0,
                "frame {i}: teleport of {step}px after release"
            );
            prev = (out.x, out.y);
            if out.phase == DragPhase::Idle {
                done = true;
                assert!(out.settled);
                break;
            }
            // Monotonic approach once the spring dominates: skip the first few
            // frames where release momentum still carries the window outward.
            if i > 4 {
                if let Some((tx, ty)) = drag.settle_target {
                    let dist = ((out.x - tx).powi(2) + (out.y - ty).powi(2)).sqrt();
                    assert!(
                        dist <= prev_dist + 1e-9,
                        "frame {i}: settle moved away from its target"
                    );
                    prev_dist = dist;
                }
            }
        }
        assert!(done, "settle did not finish within 60 frames");
        assert!(
            frames as f64 * FRAME_DT < SETTLE_MAX_TIME,
            "settle took too long"
        );
        // The glide is capped: even a violent fling travels at most
        // SETTLE_MAX_GLIDE past the release point.
        assert!(
            (prev.0 - last.0).abs() <= SETTLE_MAX_GLIDE + 1.0,
            "glide ran past its cap"
        );
    }

    #[test]
    fn new_drag_cancels_a_running_settle_immediately() {
        let mut drag = DragController::new();
        drag.begin_drag(0.0, 0.0, 0.0, 0.0, 0.0);
        for i in 0..10 {
            drag.advance(&held_frame(i as f64 * 20.0, 0.0, i as f64 * FRAME_DT));
        }
        drag.end_drag(10.0 * FRAME_DT);
        let mid = drag.advance(&free_frame(11.0 * FRAME_DT, FRAME_DT));
        assert_eq!(mid.phase, DragPhase::Settling);

        // Re-arm mid-settle: the very next frame tracks the pointer directly.
        drag.begin_drag(5.0, 5.0, mid.x, mid.y, 12.0 * FRAME_DT);
        let out = drag.advance(&held_frame(900.0, 400.0, 12.0 * FRAME_DT));
        assert_eq!(out.phase, DragPhase::Held);
        assert_eq!((out.x, out.y), (895.0, 395.0));
    }

    #[test]
    fn held_frames_during_settle_hold_position_without_a_jump() {
        // Held frames for a new press that arrive without begin_drag must not
        // teleport: the controller re-latches the grab so tracking continues
        // from the current position.
        let mut drag = DragController::new();
        drag.begin_drag(0.0, 0.0, 0.0, 0.0, 0.0);
        for i in 0..10 {
            drag.advance(&held_frame(i as f64 * 20.0, 0.0, i as f64 * FRAME_DT));
        }
        drag.end_drag(10.0 * FRAME_DT);
        let mid = drag.advance(&free_frame(11.0 * FRAME_DT, FRAME_DT));
        assert_eq!(mid.phase, DragPhase::Settling);
        let out = drag.advance(&held_frame(900.0, 400.0, 12.0 * FRAME_DT));
        assert_eq!(out.phase, DragPhase::Held);
        assert!(
            (out.x - mid.x).abs() < 1e-9 && (out.y - mid.y).abs() < 1e-9,
            "re-grab teleported from {mid:?} to ({}, {})",
            out.x,
            out.y
        );
        let next = drag.advance(&held_frame(910.0, 420.0, 13.0 * FRAME_DT));
        assert!((next.x - out.x - 10.0).abs() < 1e-9);
        assert!((next.y - out.y - 20.0).abs() < 1e-9);
    }

    #[test]
    fn reduced_motion_snaps_instead_of_gliding() {
        let mut drag = DragController::new();
        drag.begin_drag(0.0, 0.0, 0.0, 0.0, 0.0);
        for i in 0..10 {
            drag.advance(&held_frame(i as f64 * 30.0, 0.0, i as f64 * FRAME_DT));
        }
        let release_pos = 9.0 * 30.0;
        drag.end_drag(10.0 * FRAME_DT);
        let mut frame = free_frame(11.0 * FRAME_DT, FRAME_DT);
        frame.reduced_motion = true;
        let out = drag.advance(&frame);
        assert!(out.settled);
        assert_eq!(out.phase, DragPhase::Idle);
        assert!(
            (out.x - release_pos).abs() < 1e-9,
            "reduced motion must park exactly at the drop point"
        );
    }

    #[test]
    fn release_without_held_frames_finishes_at_the_drop_point() {
        // A drag armed and released with no motion in between still runs one
        // settle and reports settled, so the platform persists exactly once.
        let mut drag = DragController::new();
        drag.begin_drag(10.0, 10.0, 100.0, 100.0, 0.0);
        drag.end_drag(0.01);
        let mut settled = false;
        for i in 1..=10 {
            let out = drag.advance(&free_frame(i as f64 * FRAME_DT, FRAME_DT));
            if out.settled {
                settled = true;
                assert_eq!((out.x, out.y), (100.0, 100.0));
                break;
            }
        }
        assert!(settled, "empty settle never reported done");
    }

    #[test]
    fn missed_release_flag_still_ends_the_drag() {
        // The platform backstops feed held=false when the button is physically
        // up even if no release event arrived; the controller must release
        // instead of tracking forever.
        let mut drag = DragController::new();
        drag.begin_drag(0.0, 0.0, 0.0, 0.0, 0.0);
        for i in 0..10 {
            drag.advance(&held_frame(100.0, 100.0, i as f64 * FRAME_DT));
        }
        let out = drag.advance(&free_frame(11.0 * FRAME_DT, FRAME_DT));
        assert!(
            out.phase == DragPhase::Settling || out.settled,
            "controller stayed held after the flag dropped"
        );
    }

    #[test]
    fn settle_survives_a_sleep_sized_frame() {
        // A 5-second stall (sleep, display change) clamps to MAX_DT: the
        // settle takes one bounded step instead of exploding or teleporting.
        let mut drag = DragController::new();
        drag.begin_drag(0.0, 0.0, 0.0, 0.0, 0.0);
        for i in 0..10 {
            drag.advance(&held_frame(i as f64 * 10.0, 0.0, i as f64 * FRAME_DT));
        }
        drag.end_drag(10.0 * FRAME_DT);
        let out = drag.advance(&free_frame(11.0 * FRAME_DT, 5.0));
        assert!(out.x.is_finite() && out.y.is_finite());
        assert!((out.x - 90.0).abs() < SETTLE_MAX_GLIDE + 50.0);
    }

    #[test]
    fn non_finite_input_never_poison_the_controller() {
        let mut drag = DragController::new();
        drag.begin_drag(0.0, 0.0, 50.0, 50.0, 0.0);
        drag.push_sample(f64::NAN, 0.0, 0.01);
        drag.push_sample(0.0, f64::INFINITY, 0.02);
        let out = drag.advance(&held_frame(100.0, 100.0, 0.03));
        assert_eq!((out.x, out.y), (100.0, 100.0));
        let out = drag.advance(&DragFrame {
            pointer_x: f64::NAN,
            pointer_y: 0.0,
            now: 0.04,
            dt: FRAME_DT,
            bounds: wide_bounds(),
            held: true,
            reduced_motion: false,
            edge_work: None,
        });
        assert!(out.x.is_finite() && out.y.is_finite());
    }

    #[test]
    fn long_frames_integrate_in_substeps_like_short_ones() {
        // One 33 ms frame and two 16.5 ms frames must land in the same place:
        // substep integration keeps the settle curve frame-rate independent.
        fn run(frames: &[f64]) -> (f64, f64) {
            let mut drag = DragController::new();
            drag.begin_drag(0.0, 0.0, 0.0, 0.0, 0.0);
            for i in 0..8 {
                drag.advance(&held_frame(i as f64 * 25.0, 0.0, i as f64 * FRAME_DT));
            }
            drag.end_drag(8.0 * FRAME_DT);
            let mut now = 8.0 * FRAME_DT;
            let mut pos = (0.0, 0.0);
            for dt in frames {
                now += dt;
                let out = drag.advance(&DragFrame {
                    pointer_x: 0.0,
                    pointer_y: 0.0,
                    now,
                    dt: *dt,
                    bounds: wide_bounds(),
                    held: false,
                    reduced_motion: false,
                    edge_work: None,
                });
                pos = (out.x, out.y);
            }
            pos
        }
        let one_long = run(&[1.0 / 30.0]);
        let two_short = run(&[1.0 / 60.0, 1.0 / 60.0]);
        assert!(
            (one_long.0 - two_short.0).abs() < 1.0,
            "frame-rate dependent settle: {one_long:?} vs {two_short:?}"
        );
    }

    #[test]
    fn reset_returns_to_idle_without_a_settled_frame() {
        let mut drag = DragController::new();
        drag.begin_drag(0.0, 0.0, 0.0, 0.0, 0.0);
        drag.advance(&held_frame(100.0, 100.0, 0.01));
        drag.end_drag(0.02);
        assert!(drag.is_settling());
        drag.reset();
        assert_eq!(drag.phase(), DragPhase::Idle);
        assert!(!drag.is_settling());
        assert_eq!(drag.release_velocity(), (0.0, 0.0));
    }

    #[test]
    fn advance_is_cheap_enough_for_the_frame_clock() {
        // Headless proxy for the 55-updates-per-second bar: 10,000 advances
        // (over two minutes of 60 Hz frames) must finish in well under a
        // second. The bound is generous on purpose; it only catches
        // pathological slowdowns, never flakes on a loaded machine.
        let mut drag = DragController::new();
        drag.begin_drag(10.0, 10.0, 0.0, 0.0, 0.0);
        let start = std::time::Instant::now();
        for i in 0..10_000 {
            let now = i as f64 * FRAME_DT;
            drag.advance(&held_frame(now * 500.0, now * 100.0, now));
        }
        assert!(
            start.elapsed().as_secs_f64() < 1.0,
            "advance too slow for per-frame use"
        );
    }

    #[test]
    fn subframe_flick_completes_a_settle_from_the_tracked_position() {
        // Press and release inside one frame interval: no tick ever armed
        // the controller, so the platform arms from the press point, runs
        // the missed held frame, and ends. The release must settle from the
        // tracked delta (newest minus press), not no-op and strand the
        // motion, and released frames must run to a persisted settle.
        let mut drag = DragController::new();
        drag.push_sample(102.0, 202.0, 0.004);
        drag.push_sample(118.0, 214.0, 0.009);
        assert_eq!(drag.phase(), DragPhase::Idle);
        drag.begin_drag(100.0, 200.0, 0.0, 0.0, 0.010);
        drag.push_sample(118.0, 214.0, 0.010);
        let tracked = drag.advance(&DragFrame {
            pointer_x: 118.0,
            pointer_y: 214.0,
            now: 0.010,
            dt: 0.0,
            bounds: wide_bounds(),
            held: true,
            reduced_motion: false,
        });
        assert_eq!(tracked.phase, DragPhase::Held);
        assert_eq!((tracked.x, tracked.y), (18.0, 14.0));
        drag.end_drag(0.010);
        assert!(drag.is_settling());
        let mut now = 0.010;
        let mut done = None;
        for _ in 0..600 {
            now += FRAME_DT;
            let out = drag.advance(&free_frame(now, FRAME_DT));
            if out.settled {
                done = Some(out);
                break;
            }
        }
        let done = done.expect("settle must terminate");
        assert_eq!((done.x, done.y), (18.0, 14.0));
    }
}
