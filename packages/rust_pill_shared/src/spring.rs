//! Critically damped spring integrator shared by the three pill renderers.
//!
//! Every transition on the pill (expand, tooltip, panel, buttons, flash,
//! window size) runs through one of the two step functions here, so the same
//! stiffness draws the same curve on every platform at every frame rate. The
//! spring is critically damped (damping ratio 1). From rest it approaches its
//! target without overshoot; callers supplying launch velocity must bound
//! that trajectory separately.
//!
//! Long frames integrate in substeps of at most [`SUBSTEP`], which keeps the
//! curve nearly frame-rate independent: one long frame lands within a
//! fraction of a percent of the same time split across short frames, and
//! splits that divide the substep evenly agree bit for bit. Stall-sized
//! steps clamp to [`MAX_DT`] first, so a sleep or display change cannot
//! teleport a transition.

use std::cell::Cell;

/// Largest frame step the integrator takes. A sleep, stall, or display change
/// can hand a huge `dt` to one frame; clamping keeps the spring from jumping
/// on it.
const MAX_DT: f64 = 0.05;
/// Spring integration step. Long frames split into substeps of at most this
/// size so the curve barely depends on frame rate.
const SUBSTEP: f64 = 1.0 / 120.0;
/// A 0..1 transition snaps to its target once within this distance with a
/// slow enough velocity, instead of easing asymptotically forever.
const SNAP_01_POS: f64 = 0.002;
const SNAP_01_VEL: f64 = 0.5;
/// A pixel transition snaps once within half a pixel with less than half a
/// pixel of motion left in the frame.
const SNAP_PX_POS: f64 = 0.5;
const SNAP_PX_STEP: f64 = 0.5;

/// Sanitizes a caller-supplied frame step: non-finite becomes zero (hold
/// position), the rest clamps to [`MAX_DT`].
fn clamp_dt(dt: f64) -> f64 {
    if dt.is_finite() {
        dt.clamp(0.0, MAX_DT)
    } else {
        0.0
    }
}

/// One spring step in pure form: `(value, velocity)` after `dt` seconds
/// toward `target` with the given stiffness. Substepped and dt-clamped; the
/// [`Cell`]-based step functions below wrap this with rest detection,
/// snapping, and (for [`spring_01`]) range clamping.
pub fn spring_integrate(
    value: f64,
    velocity: f64,
    target: f64,
    stiffness: f64,
    dt: f64,
) -> (f64, f64) {
    let dt = clamp_dt(dt);
    if dt == 0.0 || !target.is_finite() {
        return (value, velocity);
    }
    // A corrupted position has no usable trajectory. Recover to the known
    // target; an invalid velocity alone can restart smoothly from rest.
    if !value.is_finite() {
        return (target, 0.0);
    }
    let velocity = if velocity.is_finite() { velocity } else { 0.0 };
    let stiffness = if stiffness.is_finite() {
        stiffness.max(f64::MIN_POSITIVE)
    } else {
        f64::MIN_POSITIVE
    };
    let steps = ((dt / SUBSTEP).ceil() as usize).max(1);
    let h = dt / steps as f64;
    let damping = 2.0 * stiffness.sqrt();
    let (mut v, mut vel) = (value, velocity);
    for _ in 0..steps {
        vel += (stiffness * (target - v) - damping * vel) * h;
        v += vel * h;
    }
    (v, vel)
}

/// Advances a 0..1 transition (expand, tooltip, panel, buttons, flash) one
/// frame. Springs at rest are skipped; near-target springs snap
/// exactly; overshoot past the range clamps and kills the velocity so the
/// transition stops dead at the edge instead of pressing past it. A
/// non-finite target leaves the state untouched: nothing can converge to it.
pub fn spring_01(value: &Cell<f64>, velocity: &Cell<f64>, target: f64, stiffness: f64, dt: f64) {
    let step_dt = clamp_dt(dt);
    if !target.is_finite() || step_dt == 0.0 {
        return;
    }
    let target = target.clamp(0.0, 1.0);
    let v = value.get();
    let vel = velocity.get();
    if v == target && vel == 0.0 {
        return;
    }
    let (new_v, new_vel) = spring_integrate(v, vel, target, stiffness, step_dt);
    if (new_v - target).abs() < SNAP_01_POS && new_vel.abs() < SNAP_01_VEL {
        value.set(target);
        velocity.set(0.0);
    } else {
        value.set(new_v.clamp(0.0, 1.0));
        velocity.set(if !(0.0..=1.0).contains(&new_v) {
            0.0
        } else {
            new_vel
        });
    }
}

/// Advances a pixel transition (window width/height) one frame. Unclamped, so
/// the window can pass through any size on its way; snaps once within half a
/// pixel of the target with less than half a pixel of motion left.
pub fn spring_px(value: &Cell<f64>, velocity: &Cell<f64>, target: f64, stiffness: f64, dt: f64) {
    let step_dt = clamp_dt(dt);
    if !target.is_finite() || step_dt == 0.0 {
        return;
    }
    let v = value.get();
    let vel = velocity.get();
    if v == target && vel == 0.0 {
        return;
    }
    let (new_v, new_vel) = spring_integrate(v, vel, target, stiffness, step_dt);
    if (new_v - target).abs() < SNAP_PX_POS && (new_vel * step_dt).abs() < SNAP_PX_STEP {
        value.set(target);
        velocity.set(0.0);
    } else {
        value.set(new_v);
        velocity.set(new_vel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STIFFNESS: f64 = 200.0;

    #[test]
    fn non_positive_or_unknown_time_never_snaps_near_target_state() {
        for dt in [0.0, -0.01, f64::NAN, f64::INFINITY] {
            let value = Cell::new(0.999);
            let velocity = Cell::new(0.1);
            spring_01(&value, &velocity, 1.0, STIFFNESS, dt);
            assert_eq!((value.get(), velocity.get()), (0.999, 0.1));
            value.set(39.9);
            velocity.set(1000.0);
            spring_px(&value, &velocity, 40.0, STIFFNESS, dt);
            assert_eq!((value.get(), velocity.get()), (39.9, 1000.0));
        }
    }

    #[test]
    fn invalid_state_recovers_with_a_valid_target_and_positive_time() {
        for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(
                spring_integrate(invalid, 1.0, 0.8, STIFFNESS, SUBSTEP),
                (0.8, 0.0)
            );
            let (v, vel) = spring_integrate(0.4, invalid, 0.8, STIFFNESS, SUBSTEP);
            assert!(v.is_finite() && vel.is_finite());
            assert!(v > 0.4 && v < 0.8);
            for step in [spring_01, spring_px] {
                let value = Cell::new(invalid);
                let velocity = Cell::new(invalid);
                step(&value, &velocity, 0.8, STIFFNESS, SUBSTEP);
                assert_eq!((value.get(), velocity.get()), (0.8, 0.0));
            }
        }
    }

    #[test]
    fn pure_integrator_holds_for_invalid_targets_and_zero_time() {
        assert_eq!(
            spring_integrate(0.4, 1.5, f64::NAN, STIFFNESS, SUBSTEP),
            (0.4, 1.5)
        );
        // Avoid infinity * zero turning an invalid position into a new NaN.
        let (v, vel) = spring_integrate(f64::INFINITY, 1.5, 1.0, STIFFNESS, 0.0);
        assert_eq!((v, vel), (f64::INFINITY, 1.5));
    }

    #[test]
    fn normalized_spring_clamps_finite_targets_before_rest_detection() {
        for target in [-2.0_f64, 2.0] {
            let value = Cell::new(target);
            let velocity = Cell::new(0.0);
            spring_01(&value, &velocity, target, STIFFNESS, SUBSTEP);
            assert!((0.0..=1.0).contains(&value.get()));
            assert_eq!(velocity.get(), 0.0);
        }
    }

    /// Runs the pure integrator from rest in 60 Hz frames until it settles or
    /// the frame budget runs out. Returns every value sampled.
    fn run_to_settle(target: f64, max_frames: usize) -> Vec<f64> {
        let (mut v, mut vel) = (0.0, 0.0);
        let mut out = Vec::with_capacity(max_frames);
        for _ in 0..max_frames {
            (v, vel) = spring_integrate(v, vel, target, STIFFNESS, 1.0 / 60.0);
            out.push(v);
            if (v - target).abs() < SNAP_01_POS && vel.abs() < SNAP_01_VEL {
                break;
            }
        }
        out
    }

    #[test]
    fn converges_to_the_target_from_rest() {
        let path = run_to_settle(1.0, 600);
        assert!(path.len() < 600, "spring did not settle within ten seconds");
        let last = *path.last().unwrap();
        assert!((last - 1.0).abs() < SNAP_01_POS);
    }

    #[test]
    fn critically_damped_approach_never_reverses() {
        // From rest, each frame must move nearer the target than the last:
        // no overshoot, no visible oscillation.
        let path = run_to_settle(1.0, 600);
        let mut prev = 0.0;
        for (i, v) in path.iter().enumerate() {
            assert!(
                *v + 1e-9 >= prev,
                "frame {i}: spring moved away from its target"
            );
            assert!(*v <= 1.0 + 1e-9, "frame {i}: spring overshot its target");
            prev = *v;
        }
    }

    #[test]
    fn one_long_frame_matches_two_short_ones_exactly() {
        // 1/30 s is four 1/120 s substeps; two 1/60 s frames are two plus two
        // of the same substeps, so the results must agree bit for bit.
        let (v_long, vel_long) = spring_integrate(0.2, 3.0, 1.0, STIFFNESS, 1.0 / 30.0);
        let (v_mid, vel_mid) = spring_integrate(0.2, 3.0, 1.0, STIFFNESS, 1.0 / 60.0);
        let (v_short, vel_short) = spring_integrate(v_mid, vel_mid, 1.0, STIFFNESS, 1.0 / 60.0);
        assert_eq!((v_long, vel_long), (v_short, vel_short));
    }

    #[test]
    fn stall_sized_step_clamps_to_max_dt() {
        let stalled = spring_integrate(0.2, 3.0, 1.0, STIFFNESS, 5.0);
        let clamped = spring_integrate(0.2, 3.0, 1.0, STIFFNESS, MAX_DT);
        assert_eq!(stalled, clamped);
    }

    #[test]
    fn spring_01_snaps_exactly_and_stays_put() {
        let value = Cell::new(0.0);
        let velocity = Cell::new(0.0);
        for _ in 0..600 {
            spring_01(&value, &velocity, 1.0, STIFFNESS, 1.0 / 60.0);
        }
        assert_eq!((value.get(), velocity.get()), (1.0, 0.0));
        // At rest, a zero-time step touches neither state cell.
        spring_01(&value, &velocity, 1.0, STIFFNESS, f64::NAN);
        assert_eq!((value.get(), velocity.get()), (1.0, 0.0));
    }

    #[test]
    fn spring_01_clamps_overshoot_and_kills_velocity() {
        // Arriving hot at the top edge stops dead instead of pressing past it.
        let value = Cell::new(0.999);
        let velocity = Cell::new(10.0);
        spring_01(&value, &velocity, 1.0, STIFFNESS, 1.0 / 60.0);
        assert_eq!(value.get(), 1.0);
        assert_eq!(velocity.get(), 0.0);
    }

    #[test]
    fn spring_px_converges_unclamped_and_snaps() {
        let value = Cell::new(600.0);
        let velocity = Cell::new(0.0);
        for _ in 0..600 {
            spring_px(&value, &velocity, 800.0, STIFFNESS, 1.0 / 60.0);
        }
        assert_eq!((value.get(), velocity.get()), (800.0, 0.0));
    }

    #[test]
    fn non_finite_target_leaves_state_untouched() {
        let value = Cell::new(0.4);
        let velocity = Cell::new(1.5);
        spring_01(&value, &velocity, f64::NAN, STIFFNESS, 1.0 / 60.0);
        assert_eq!((value.get(), velocity.get()), (0.4, 1.5));
        spring_px(&value, &velocity, f64::INFINITY, STIFFNESS, 1.0 / 60.0);
        assert_eq!((value.get(), velocity.get()), (0.4, 1.5));
    }

    #[test]
    fn zero_dt_holds_position() {
        let (v, vel) = spring_integrate(0.2, 3.0, 1.0, STIFFNESS, 0.0);
        assert_eq!((v, vel), (0.2, 3.0));
    }
}
