//! Edge repulsion shared by the three pill renderers.
//!
//! Each monitor edge owns an activation band [`EDGE_BAND_FRACTION`] of the
//! work area deep. Outside the band the pill tracks 1:1; inside, a cubic
//! ease pulls it toward a [`EDGE_REST_GAP`] resting line. The ease joins the
//! 1:1 tracking with a matching slope at the band boundary, so crossing it
//! is invisible, and it is monotone, so the pill never reverses or rebounds.
//! Fast inward flings compress the ease (the pill travels deeper into the
//! band) but the work-area clamp still holds, so nothing ever leaves the
//! screen.
//!
//! The ease is a pure function of position and velocity, not an integrator,
//! so it is frame-rate independent by construction: no substeps, no stall
//! clamping, no snap thresholds. Reduced motion uses the full ease with no
//! speed modulation, which keeps the safe gap with no moving parts at all.
//!
//! The ease runs on the window origin against the drag bounds, which the
//! platforms already derive from the work area plus the pill footprint. A
//! window origin on the bounds edge means the pill edge touches the work
//! area edge, so easing the origin toward bounds-plus-gap eases the pill
//! toward gap exactly, with no footprint math in here.

/// Band depth as a fraction of the work-area dimension on that axis.
pub const EDGE_BAND_FRACTION: f64 = 0.05;
/// Resting gap from each work-area edge, in logical pixels.
pub const EDGE_REST_GAP: f64 = 12.0;
/// Inward speed that fully compresses the ease, in px/s. Past this the pill
/// tracks raw (still clamped); at rest it eases fully.
pub const EDGE_FLING_SPEED: f64 = 2500.0;
/// Slowest ease blend. Even the fastest fling keeps this much pull toward
/// the resting line, so the band always resists at least a little.
pub const EDGE_MIN_BLEND: f64 = 0.25;

/// Work-area size in the platform's drag space. The band is a fraction of
/// these; non-finite or non-positive dimensions disable the ease and leave
/// the existing hard clamp in charge.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EdgeWork {
    pub width: f64,
    pub height: f64,
}

impl EdgeWork {
    pub fn active(&self) -> bool {
        self.width.is_finite() && self.height.is_finite() && self.width > 0.0 && self.height > 0.0
    }
}

/// Ease one axis toward its resting line. `pos` is the clamped window
/// origin, `vel` its velocity (positive away from `min`), `min`/`max` the
/// drag bounds, `dim` the work-area size on this axis. Returns a position
/// inside `[min, max]`.
pub fn ease_axis(pos: f64, vel: f64, min: f64, max: f64, dim: f64) -> f64 {
    if !pos.is_finite() || !vel.is_finite() || !min.is_finite() || !max.is_finite() {
        return pos;
    }
    let span = (max - min).max(0.0);
    let band = dim * EDGE_BAND_FRACTION;
    if !band.is_finite() || band <= EDGE_REST_GAP || band * 2.0 >= span.max(band) {
        return pos;
    }
    let eased = if pos - min < max - pos {
        ease_side(pos, vel, min, band, -1.0)
    } else {
        ease_side(pos, vel, max, band, 1.0)
    };
    eased.clamp(min, min + span)
}

/// Ease against one edge. `edge` is the bounds value on that side, `dir` is
/// -1 for the minimum edge and +1 for the maximum edge.
fn ease_side(pos: f64, vel: f64, edge: f64, band: f64, dir: f64) -> f64 {
    let e = (pos - edge) * dir;
    if e < 0.0 || e >= band {
        return pos;
    }
    let s = e / band;
    let rest = EDGE_REST_GAP + (band - EDGE_REST_GAP) * s * s * (3.0 - 2.0 * s);
    let inward = (-vel * dir).max(0.0);
    let blend = if inward.is_finite() {
        (1.0 - inward / EDGE_FLING_SPEED).clamp(EDGE_MIN_BLEND, 1.0)
    } else {
        1.0
    };
    edge + dir * (e + (rest - e) * blend)
}

/// Ease a clamped window origin against the work area on both axes. Corners
/// ease per axis independently. A missing or dead work size returns the
/// position untouched.
pub fn ease_point(x: f64, y: f64, vx: f64, vy: f64, bounds: (f64, f64, f64, f64), work: Option<EdgeWork>) -> (f64, f64) {
    let Some(work) = work.filter(|w| w.active()) else {
        return (x, y);
    };
    let (min_x, min_y, max_x, max_y) = bounds;
    (
        ease_axis(x, vx, min_x, max_x, work.width),
        ease_axis(y, vy, min_y, max_y, work.height),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: f64 = 0.0;
    const MAX: f64 = 1920.0;
    const DIM: f64 = 1920.0;
    const BAND: f64 = DIM * EDGE_BAND_FRACTION;

    #[test]
    fn outside_the_band_tracks_raw() {
        assert_eq!(ease_axis(MIN + BAND + 50.0, 0.0, MIN, MAX, DIM), MIN + BAND + 50.0);
        assert_eq!(ease_axis(MIN + BAND, 0.0, MIN, MAX, DIM), MIN + BAND);
    }

    #[test]
    fn at_the_edge_rests_on_the_gap_line() {
        assert_eq!(ease_axis(MIN, 0.0, MIN, MAX, DIM), MIN + EDGE_REST_GAP);
    }

    #[test]
    fn ease_is_monotone_across_the_band() {
        let mut last = f64::NEG_INFINITY;
        let mut steps = 0;
        while steps <= 200 {
            let pos = MIN + BAND * steps as f64 / 200.0;
            let eased = ease_axis(pos, 0.0, MIN, MAX, DIM);
            assert!(eased >= last, "ease reversed at {pos}");
            assert!(eased >= MIN && eased <= MIN + BAND, "ease left the band at {pos}");
            last = eased;
            steps += 1;
        }
    }

    #[test]
    fn ease_is_monotone_at_fling_speed() {
        let mut last = f64::NEG_INFINITY;
        for i in 0..=100 {
            let pos = MIN + BAND * i as f64 / 100.0;
            let eased = ease_axis(pos, -5000.0, MIN, MAX, DIM);
            assert!(eased >= last, "fling ease reversed at {pos}");
            last = eased;
        }
    }

    #[test]
    fn fast_flings_compress_deeper_than_slow_drags() {
        let pos = MIN + 4.0;
        let slow = ease_axis(pos, -50.0, MIN, MAX, DIM);
        let fast = ease_axis(pos, -2400.0, MIN, MAX, DIM);
        assert!(fast < slow, "fast {fast} should compress deeper than slow {slow}");
        assert!(fast >= MIN, "fling must stay clamped");
    }

    #[test]
    fn outward_motion_eases_fully() {
        let pos = MIN + 4.0;
        assert_eq!(ease_axis(pos, 300.0, MIN, MAX, DIM), ease_axis(pos, 0.0, MIN, MAX, DIM));
    }

    #[test]
    fn right_edge_mirrors_left() {
        assert_eq!(ease_axis(MAX, 0.0, MIN, MAX, DIM), MAX - EDGE_REST_GAP);
        assert_eq!(ease_axis(MAX - BAND, 0.0, MIN, MAX, DIM), MAX - BAND);
        let pos = MAX - 4.0;
        assert!(ease_axis(pos, 2400.0, MIN, MAX, DIM) > ease_axis(pos, 50.0, MIN, MAX, DIM));
    }

    #[test]
    fn tiny_work_area_falls_back_to_hard_clamp() {
        assert_eq!(ease_axis(100.0, 0.0, 0.0, 200.0, 200.0), 100.0);
    }

    #[test]
    fn garbage_input_returns_position_untouched() {
        assert!(ease_axis(f64::NAN, 0.0, MIN, MAX, DIM).is_nan());
        assert_eq!(ease_axis(100.0, 0.0, MIN, MAX, f64::NAN), 100.0);
        assert_eq!(ease_axis(100.0, 0.0, MIN, MAX, 0.0), 100.0);
        assert_eq!(ease_axis(100.0, 0.0, MIN, MAX, -50.0), 100.0);
    }

    #[test]
    fn point_eases_corners_per_axis() {
        let (x, y) = ease_point(0.0, 0.0, 0.0, 0.0, (MIN, MIN, MAX, MAX), Some(EdgeWork { width: DIM, height: DIM }));
        assert_eq!((x, y), (MIN + EDGE_REST_GAP, MIN + EDGE_REST_GAP));
        let (x, y) = ease_point(500.0, 500.0, 0.0, 0.0, (MIN, MIN, MAX, MAX), Some(EdgeWork { width: DIM, height: DIM }));
        assert_eq!((x, y), (500.0, 500.0));
    }

    #[test]
    fn point_without_work_size_is_identity() {
        assert_eq!(ease_point(4.0, 4.0, 0.0, 0.0, (MIN, MIN, MAX, MAX), None), (4.0, 4.0));
        let dead = EdgeWork { width: 0.0, height: DIM };
        assert_eq!(ease_point(4.0, 4.0, 0.0, 0.0, (MIN, MIN, MAX, MAX), Some(dead)), (4.0, 4.0));
    }
}
