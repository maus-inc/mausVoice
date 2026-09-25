//! Edge resistance and monitor-seam geometry shared by the native pill renderers.
//!
//! A true desktop edge eases the pill toward a small resting gap. A seam that
//! touches another monitor disables that resistance; native adapters place
//! the crossing clamp at the pill center so monitor handoff stays continuous.

/// Band depth as a fraction of the work-area dimension on that axis.
pub const EDGE_BAND_FRACTION: f64 = 0.05;
/// Resting gap from each work-area edge, in logical pixels.
pub const EDGE_REST_GAP: f64 = 12.0;
/// Velocity scale controlling compression, in px/s. Increasing speed toward an edge
/// reduces the pull down to EDGE_MIN_BLEND; it never turns the edge pull off.
pub const EDGE_FLING_SPEED: f64 = 2500.0;
/// Slowest ease blend. Even the fastest fling keeps this much pull toward
/// the resting line, so the band always resists at least a little.
pub const EDGE_MIN_BLEND: f64 = 0.25;
const MONITOR_SEAM_TOLERANCE: f64 = 1.0;

/// Work-area size in the platform's drag space. The band is a fraction of
/// these; non-finite or non-positive dimensions disable the ease and leave
/// the existing hard clamp in charge.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EdgeWork {
    pub width: f64,
    pub height: f64,
    pub edges: EdgeMask,
}

impl EdgeWork {
    pub fn active(&self) -> bool {
        self.width.is_finite() && self.height.is_finite() && self.width > 0.0 && self.height > 0.0
    }

    pub const fn all(width: f64, height: f64) -> Self {
        Self { width, height, edges: EdgeMask::ALL }
    }
}

/// Which sides of the current monitor are exposed desktop edges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EdgeMask {
    pub left: bool,
    pub right: bool,
    pub top: bool,
    pub bottom: bool,
}

impl EdgeMask {
    pub const ALL: Self = Self { left: true, right: true, top: true, bottom: true };
}

/// A monitor rectangle in the platform's absolute drag-coordinate space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MonitorRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl MonitorRect {
    pub fn right(self) -> f64 { self.x + self.width }
    pub fn bottom(self) -> f64 { self.y + self.height }

    fn valid(self) -> bool {
        self.x.is_finite() && self.y.is_finite()
            && self.width.is_finite() && self.height.is_finite()
            && self.width > 0.0 && self.height > 0.0
            && self.right().is_finite() && self.bottom().is_finite()
    }
}

/// Per-frame drag area. Shared sides use the full monitor edge and disable
/// edge resistance; adapters shift those bounds to the pill-center crossing
/// plane. Exposed sides retain their work-area edge.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DragRegion {
    pub bounds: MonitorRect,
    pub edge_mask: EdgeMask,
}

/// Resolve which sides of a monitor connect to another monitor at the current
/// pointer coordinate. This handles partial monitor overlap: a seam is open
/// only where a neighboring display actually touches it.
pub fn drag_region(
    monitor: MonitorRect,
    work_area: MonitorRect,
    neighbors: &[MonitorRect],
    pointer: (f64, f64),
) -> DragRegion {
    let exposed = EdgeMask {
        left: !has_neighbor(monitor, neighbors, pointer, Side::Left),
        right: !has_neighbor(monitor, neighbors, pointer, Side::Right),
        top: !has_neighbor(monitor, neighbors, pointer, Side::Top),
        bottom: !has_neighbor(monitor, neighbors, pointer, Side::Bottom),
    };
    if !monitor.valid() || !work_area.valid() {
        return DragRegion { bounds: work_area, edge_mask: EdgeMask::ALL };
    }

    let left = if exposed.left { work_area.x } else { monitor.x };
    let right = if exposed.right { work_area.right() } else { monitor.right() };
    let top = if exposed.top { work_area.y } else { monitor.y };
    let bottom = if exposed.bottom { work_area.bottom() } else { monitor.bottom() };
    DragRegion {
        bounds: MonitorRect {
            x: left,
            y: top,
            width: (right - left).max(0.0),
            height: (bottom - top).max(0.0),
        },
        edge_mask: exposed,
    }
}

#[derive(Clone, Copy)]
enum Side {
    Left,
    Right,
    Top,
    Bottom,
}

fn has_neighbor(
    monitor: MonitorRect,
    neighbors: &[MonitorRect],
    pointer: (f64, f64),
    side: Side,
) -> bool {
    if !monitor.valid() || !pointer.0.is_finite() || !pointer.1.is_finite() {
        return false;
    }
    neighbors.iter().copied().filter(|neighbor| neighbor.valid()).any(|neighbor| {
        match side {
            Side::Left => touches(neighbor.right(), monitor.x)
                && overlaps_at(pointer.1, monitor.y, monitor.bottom(), neighbor.y, neighbor.bottom()),
            Side::Right => touches(neighbor.x, monitor.right())
                && overlaps_at(pointer.1, monitor.y, monitor.bottom(), neighbor.y, neighbor.bottom()),
            Side::Top => touches(neighbor.bottom(), monitor.y)
                && overlaps_at(pointer.0, monitor.x, monitor.right(), neighbor.x, neighbor.right()),
            Side::Bottom => touches(neighbor.y, monitor.bottom())
                && overlaps_at(pointer.0, monitor.x, monitor.right(), neighbor.x, neighbor.right()),
        }
    })
}

fn touches(a: f64, b: f64) -> bool {
    (a - b).abs() <= MONITOR_SEAM_TOLERANCE
}

fn overlaps_at(point: f64, a0: f64, a1: f64, b0: f64, b1: f64) -> bool {
    point >= a0.max(b0) && point < a1.min(b1)
}

/// Ease one axis toward its resting line. `pos` is the clamped window
/// origin, `vel` its velocity (positive away from `min`), `min`/`max` the
/// drag bounds, and `dim` the work-area size on this axis. Returns a position
/// inside `[min, max]`.
pub fn ease_axis(pos: f64, vel: f64, min: f64, max: f64, dim: f64) -> f64 {
    ease_axis_with_edges(pos, vel, min, max, dim, true, true)
}

fn ease_axis_with_edges(
    pos: f64,
    vel: f64,
    min: f64,
    max: f64,
    dim: f64,
    ease_min: bool,
    ease_max: bool,
) -> f64 {
    if !pos.is_finite() || !vel.is_finite() || !min.is_finite() || !max.is_finite() {
        return pos;
    }
    let span = (max - min).max(0.0);
    let band = dim * EDGE_BAND_FRACTION;
    if !band.is_finite() || band <= EDGE_REST_GAP || band * 2.0 >= span {
        return pos;
    }
    let from_min = pos - min;
    let from_max = max - pos;
    let eased = match (ease_min, ease_max) {
        (true, true) if from_min < from_max => ease_side(pos, vel, min, band, -1.0),
        (true, true) => ease_side(pos, vel, max, band, 1.0),
        (true, false) => ease_side(pos, vel, min, band, -1.0),
        (false, true) => ease_side(pos, vel, max, band, 1.0),
        (false, false) => pos,
    };
    eased.clamp(min, min + span)
}

/// Ease against one edge. `edge` is the bounds value on that side, `dir` is
/// -1 for the minimum edge and +1 for the maximum edge.
fn ease_side(pos: f64, vel: f64, edge: f64, band: f64, dir: f64) -> f64 {
    let e = (edge - pos) * dir;
    if e < 0.0 || e >= band { return pos; }
    let rise = band - EDGE_REST_GAP;
    let transition = band.min(3.0 * rise);
    let start = band - transition;
    let s = ((e - start) / transition).clamp(0.0, 1.0);
    let rest = EDGE_REST_GAP
        + (3.0 * rise - transition) * s * s
        + (transition - 2.0 * rise) * s * s * s;
    let toward_edge = (vel * dir).max(0.0);
    let blend = if toward_edge.is_finite() {
        (1.0 - toward_edge / EDGE_FLING_SPEED).clamp(EDGE_MIN_BLEND, 1.0)
    } else { 1.0 };
    edge - dir * (e + (rest - e) * blend)
}

/// Ease a clamped window origin against the enabled work-area edges.
pub fn ease_point(
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
    bounds: (f64, f64, f64, f64),
    work: Option<EdgeWork>,
) -> (f64, f64) {
    let Some(work) = work.filter(|w| w.active()) else { return (x, y); };
    let (min_x, min_y, max_x, max_y) = bounds;
    (
        ease_axis_with_edges(x, vx, min_x, max_x, work.width, work.edges.left, work.edges.right),
        ease_axis_with_edges(y, vy, min_y, max_y, work.height, work.edges.top, work.edges.bottom),
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
    fn disabled_edge_remains_direct_while_the_opposite_edge_still_resists() {
        let x = ease_axis_with_edges(1.0, 0.0, 0.0, MAX, DIM, false, true);
        assert_eq!(x, 1.0);
        let right = ease_axis_with_edges(MAX - 1.0, 0.0, 0.0, MAX, DIM, false, true);
        assert_eq!(right, MAX - EDGE_REST_GAP);
    }

    #[test]
    fn drag_region_opens_a_vertical_monitor_seam() {
        let top = MonitorRect { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0 };
        let bottom = MonitorRect { x: 0.0, y: 1080.0, width: 1920.0, height: 1080.0 };
        let work = MonitorRect { x: 0.0, y: 0.0, width: 1920.0, height: 1040.0 };
        let region = drag_region(top, work, &[bottom], (900.0, 1039.0));
        assert_eq!(region.bounds.bottom(), 1080.0);
        assert!(!region.edge_mask.bottom);
        assert!(region.edge_mask.top);
        let point = ease_point(
            900.0,
            1075.0,
            0.0,
            0.0,
            (region.bounds.x, region.bounds.y, region.bounds.right(), region.bounds.bottom()),
            Some(EdgeWork { width: 1920.0, height: 1040.0, edges: region.edge_mask }),
        );
        assert_eq!(point.1, 1075.0);
    }

    #[test]
    fn partial_monitor_seam_opens_only_where_the_neighbor_exists() {
        let current = MonitorRect { x: 0.0, y: 0.0, width: 1200.0, height: 1000.0 };
        let neighbor = MonitorRect { x: 1200.0, y: 200.0, width: 1000.0, height: 600.0 };
        let work = current;
        let connected = drag_region(current, work, &[neighbor], (1190.0, 500.0));
        let exposed = drag_region(current, work, &[neighbor], (1190.0, 900.0));
        assert!(!connected.edge_mask.right);
        assert!(exposed.edge_mask.right);
        assert_eq!(connected.bounds.right(), current.right());
    }

    #[test]
    fn edge_region_uses_work_area_on_exposed_sides() {
        let monitor = MonitorRect { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0 };
        let work = MonitorRect { x: 0.0, y: 40.0, width: 1920.0, height: 1040.0 };
        let region = drag_region(monitor, work, &[], (900.0, 100.0));
        assert_eq!(region.bounds, work);
        assert_eq!(region.edge_mask, EdgeMask::ALL);
    }

    #[test]
    fn both_inner_edge_bands_preserve_the_resting_gap() {
        let left = ease_axis(MIN + 1.0, 0.0, MIN, MAX, DIM);
        let right = ease_axis(MAX - 1.0, 0.0, MIN, MAX, DIM);
        assert!(left >= MIN + EDGE_REST_GAP);
        assert!(right <= MAX - EDGE_REST_GAP);
        assert!((left + right - MIN - MAX).abs() < 1e-9);
        assert_eq!(ease_side(MIN - 1.0, 0.0, MIN, BAND, -1.0), MIN - 1.0);
        assert_eq!(ease_side(MAX + 1.0, 0.0, MAX, BAND, 1.0), MAX + 1.0);
    }

    #[test]
    fn ease_is_monotone_across_the_band() {
        let mut last = f64::NEG_INFINITY;
        for step in 0..=200 {
            let pos = MIN + BAND * step as f64 / 200.0;
            let eased = ease_axis(pos, 0.0, MIN, MAX, DIM);
            assert!(eased >= last, "ease reversed at {pos}");
            assert!(eased >= MIN && eased <= MIN + BAND, "ease left the band at {pos}");
            last = eased;
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
    fn both_edges_interpolate_between_raw_position_and_full_rest_pull() {
        for (position, direction) in [(MIN + 4.0, -1.0), (MAX - 4.0, 1.0)] {
            let full = ease_axis(position, 0.0, MIN, MAX, DIM);
            for speed in [0.0, 1000.0, EDGE_FLING_SPEED, 5000.0] {
                let blend = (1.0 - speed / EDGE_FLING_SPEED).clamp(EDGE_MIN_BLEND, 1.0);
                let expected = position + (full - position) * blend;
                let actual = ease_axis(position, direction * speed, MIN, MAX, DIM);
                assert!((actual - expected).abs() < 1e-9);
            }
            assert_eq!(ease_axis(position, -direction * 5000.0, MIN, MAX, DIM), full);
        }
    }

    #[test]
    fn band_boundary_joins_raw_tracking_with_unit_slope() {
        let epsilon = 0.0001;
        for dim in [260.0, 300.0, 1920.0] {
            let band = dim * EDGE_BAND_FRACTION;
            for velocity in [-3000.0, 0.0, 3000.0] {
                let left = (ease_axis(band, velocity, 0.0, dim, dim)
                    - ease_axis(band - epsilon, velocity, 0.0, dim, dim)) / epsilon;
                let right = (ease_axis(dim - band + epsilon, velocity, 0.0, dim, dim)
                    - ease_axis(dim - band, velocity, 0.0, dim, dim)) / epsilon;
                assert!((left - 1.0).abs() < 0.001, "left slope {left}, dimension {dim}");
                assert!((right - 1.0).abs() < 0.001, "right slope {right}, dimension {dim}");
            }
        }
    }

    #[test]
    fn narrow_bands_stay_monotone_and_keep_the_resting_gap() {
        for dim in [241.0, 260.0, 300.0, 359.0] {
            let band = dim * EDGE_BAND_FRACTION;
            let mut previous = EDGE_REST_GAP;
            for i in 0..=1000 {
                let result = ease_axis(band * i as f64 / 1000.0, 0.0, 0.0, dim, dim);
                assert!(result >= previous - 1e-9);
                assert!(result >= EDGE_REST_GAP - 1e-9 && result <= band + 1e-9);
                previous = result;
            }
        }
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
        let (x, y) = ease_point(
            0.0,
            0.0,
            0.0,
            0.0,
            (MIN, MIN, MAX, MAX),
            Some(EdgeWork::all(DIM, DIM)),
        );
        assert_eq!((x, y), (MIN + EDGE_REST_GAP, MIN + EDGE_REST_GAP));
        let (x, y) = ease_point(
            500.0,
            500.0,
            0.0,
            0.0,
            (MIN, MIN, MAX, MAX),
            Some(EdgeWork::all(DIM, DIM)),
        );
        assert_eq!((x, y), (500.0, 500.0));
    }

    #[test]
    fn point_without_work_size_is_identity() {
        assert_eq!(ease_point(4.0, 4.0, 0.0, 0.0, (MIN, MIN, MAX, MAX), None), (4.0, 4.0));
        let dead = EdgeWork::all(0.0, DIM);
        assert_eq!(ease_point(4.0, 4.0, 0.0, 0.0, (MIN, MIN, MAX, MAX), Some(dead)), (4.0, 4.0));
    }
}
