//! Edge repulsion shared by the three pill renderers.
//!
//! Each monitor edge owns an activation band [`EDGE_BAND_FRACTION`] of the
//! work area deep. Outside the band the pill tracks 1:1; inside, a cubic ease
//! pulls it toward a [`EDGE_REST_GAP`] resting line. Matching slope at the
//! band boundary makes entry invisible, and monotonicity prevents reversal
//! or rebound. Fast flings compress the ease but remain clamped at the edge.
//!
//! The ease is a pure function of position and velocity, not an integrator,
//! so it is frame-rate independent by construction: no substeps, stall
//! clamping, or snap thresholds. Reduced motion uses the full ease without
//! speed modulation, preserving the safe gap with no moving parts.
//!
//! Easing runs on the window origin against bounds already adjusted for the
//! visible pill footprint; an origin on a bound places the pill edge at the
//! work-area edge without footprint math here. During a drag, adjacent-monitor
//! seams replace the exposed-edge bound with a center-crossing plane. Shared
//! seams also retain the full monitor span along their tangent so docks and
//! menu bars cannot block reachable crossings. Releasing ends that exception:
//! settling uses the work-area bounds and returns the pill fully on-screen.

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
/// plane. A seam also keeps the full monitor span along its tangent axis so a
/// perpendicular work-area inset cannot close a traversable crossing.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DragRegion {
    pub bounds: MonitorRect,
    pub edge_mask: EdgeMask,
}

/// Resolve which sides of a monitor connect to another monitor at the current
/// pill-center coordinate. This stateless form is useful for parked placement;
/// held drags should use [`SeamTracker`] to keep partial-overlap seams stable.
pub fn drag_region(
    monitor: MonitorRect,
    work_area: MonitorRect,
    neighbors: &[MonitorRect],
    seam_point: (f64, f64),
) -> DragRegion {
    let exposed = exposed_edges(monitor, neighbors, seam_point);
    region_for_edges(monitor, work_area, exposed)
}

fn exposed_edges(
    monitor: MonitorRect,
    neighbors: &[MonitorRect],
    seam_point: (f64, f64),
) -> EdgeMask {
    EdgeMask {
        left: !has_neighbor(monitor, neighbors, seam_point, Side::Left),
        right: !has_neighbor(monitor, neighbors, seam_point, Side::Right),
        top: !has_neighbor(monitor, neighbors, seam_point, Side::Top),
        bottom: !has_neighbor(monitor, neighbors, seam_point, Side::Bottom),
    }
}

fn region_for_edges(
    monitor: MonitorRect,
    work_area: MonitorRect,
    exposed: EdgeMask,
) -> DragRegion {
    if !monitor.valid() || !work_area.valid() {
        let bounds = if work_area.valid() {
            work_area
        } else if monitor.valid() {
            monitor
        } else {
            MonitorRect { x: 0.0, y: 0.0, width: 0.0, height: 0.0 }
        };
        return DragRegion { bounds, edge_mask: EdgeMask::ALL };
    }

    let vertical_seam = !exposed.left || !exposed.right;
    let horizontal_seam = !exposed.top || !exposed.bottom;
    // Keep the full monitor span along a seam's tangent axis. Applying a
    // perpendicular work-area inset there would close traversable portions
    // of the physical seam beneath a dock or panel.
    let left = if horizontal_seam || !exposed.left {
        monitor.x
    } else {
        work_area.x
    };
    let right = if horizontal_seam || !exposed.right {
        monitor.right()
    } else {
        work_area.right()
    };
    let top = if vertical_seam || !exposed.top {
        monitor.y
    } else {
        work_area.y
    };
    let bottom = if vertical_seam || !exposed.bottom {
        monitor.bottom()
    } else {
        work_area.bottom()
    };
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

/// Distance required back inside a partial overlap before a latched seam
/// releases. This avoids one-frame mask and clamp jumps at the overlap edge.
pub const SEAM_HYSTERESIS_PX: f64 = 112.0;

/// Per-drag partial-seam latch. Once a side opens near an overlap endpoint it
/// stays open while the center travels beyond that endpoint, then releases
/// only after the center returns by [`SEAM_HYSTERESIS_PX`]. A source-monitor
/// change, removal of the latched neighbor, or new drag resets the latch.
#[derive(Debug, Clone)]
pub struct SeamTracker {
    monitor: Option<MonitorRect>,
    neighbors: [Option<MonitorRect>; 4],
}

impl Default for SeamTracker {
    fn default() -> Self {
        Self { monitor: None, neighbors: [None; 4] }
    }
}

impl SeamTracker {
    pub fn reset(&mut self) {
        self.monitor = None;
        self.neighbors = [None; 4];
    }

    pub fn resolve(
        &mut self,
        monitor: MonitorRect,
        work_area: MonitorRect,
        neighbors: &[MonitorRect],
        seam_point: (f64, f64),
    ) -> DragRegion {
        if !monitor.valid()
            || !work_area.valid()
            || !seam_point.0.is_finite()
            || !seam_point.1.is_finite()
        {
            self.reset();
            return drag_region(monitor, work_area, neighbors, seam_point);
        }
        if self.monitor != Some(monitor) {
            self.reset();
            self.monitor = Some(monitor);
        }

        let mut exposed = exposed_edges(monitor, neighbors, seam_point);
        for (index, side) in [Side::Left, Side::Right, Side::Top, Side::Bottom]
            .into_iter()
            .enumerate()
        {
            let coordinate = match side {
                Side::Left | Side::Right => seam_point.1,
                Side::Top | Side::Bottom => seam_point.0,
            };
            if let Some(latched) = self.neighbors[index] {
                if !neighbors.contains(&latched) {
                    self.neighbors[index] = None;
                    continue;
                }
                let Some((start, end)) = neighbor_interval(monitor, latched, side) else {
                    self.neighbors[index] = None;
                    continue;
                };
                let margin = SEAM_HYSTERESIS_PX.min((end - start) * 0.25);
                if coordinate >= start + margin && coordinate <= end - margin {
                    self.neighbors[index] = None;
                } else {
                    set_side(&mut exposed, side, false);
                }
            } else if !side_is_exposed(exposed, side) {
                if let Some(neighbor) = neighbors.iter().copied().find(|neighbor| {
                    neighbor_interval(monitor, *neighbor, side)
                        .map_or(false, |(start, end)| {
                            coordinate <= start + SEAM_HYSTERESIS_PX
                                || coordinate >= end - SEAM_HYSTERESIS_PX
                        })
                }) {
                    self.neighbors[index] = Some(neighbor);
                }
            }
        }

        region_for_edges(monitor, work_area, exposed)
    }
}

fn side_is_exposed(edges: EdgeMask, side: Side) -> bool {
    match side {
        Side::Left => edges.left,
        Side::Right => edges.right,
        Side::Top => edges.top,
        Side::Bottom => edges.bottom,
    }
}

fn set_side(edges: &mut EdgeMask, side: Side, exposed: bool) {
    match side {
        Side::Left => edges.left = exposed,
        Side::Right => edges.right = exposed,
        Side::Top => edges.top = exposed,
        Side::Bottom => edges.bottom = exposed,
    }
}

fn neighbor_interval(
    monitor: MonitorRect,
    neighbor: MonitorRect,
    side: Side,
) -> Option<(f64, f64)> {
    if !monitor.valid() || !neighbor.valid() {
        return None;
    }
    let (touches_edge, start, end) = match side {
        Side::Left => (
            touches(neighbor.right(), monitor.x),
            monitor.y.max(neighbor.y),
            monitor.bottom().min(neighbor.bottom()),
        ),
        Side::Right => (
            touches(neighbor.x, monitor.right()),
            monitor.y.max(neighbor.y),
            monitor.bottom().min(neighbor.bottom()),
        ),
        Side::Top => (
            touches(neighbor.bottom(), monitor.y),
            monitor.x.max(neighbor.x),
            monitor.right().min(neighbor.right()),
        ),
        Side::Bottom => (
            touches(neighbor.y, monitor.bottom()),
            monitor.x.max(neighbor.x),
            monitor.right().min(neighbor.right()),
        ),
    };
    (touches_edge && end > start).then_some((start, end))
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
    seam_point: (f64, f64),
    side: Side,
) -> bool {
    if !monitor.valid() || !seam_point.0.is_finite() || !seam_point.1.is_finite() {
        return false;
    }
    neighbors.iter().copied().filter(|neighbor| neighbor.valid()).any(|neighbor| {
        match side {
            Side::Left => touches(neighbor.right(), monitor.x)
                && overlaps_at(
                    seam_point.1,
                    monitor.y,
                    monitor.bottom(),
                    neighbor.y,
                    neighbor.bottom(),
                ),
            Side::Right => touches(neighbor.x, monitor.right())
                && overlaps_at(
                    seam_point.1,
                    monitor.y,
                    monitor.bottom(),
                    neighbor.y,
                    neighbor.bottom(),
                ),
            Side::Top => touches(neighbor.bottom(), monitor.y)
                && overlaps_at(
                    seam_point.0,
                    monitor.x,
                    monitor.right(),
                    neighbor.x,
                    neighbor.right(),
                ),
            Side::Bottom => touches(neighbor.y, monitor.bottom())
                && overlaps_at(
                    seam_point.0,
                    monitor.x,
                    monitor.right(),
                    neighbor.x,
                    neighbor.right(),
                ),
        }
    })
}

fn touches(a: f64, b: f64) -> bool {
    (a - b).abs() <= MONITOR_SEAM_TOLERANCE
}

fn overlaps_at(point: f64, a0: f64, a1: f64, b0: f64, b1: f64) -> bool {
    let overlap_start = a0.max(b0);
    let overlap_end = a1.min(b1);
    overlap_end > overlap_start
        && point >= overlap_start - MONITOR_SEAM_TOLERANCE
        && point <= overlap_end + MONITOR_SEAM_TOLERANCE
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
    // `dir` points out of the work area, so `e` is positive inside either
    // edge band and `vel * dir` is the speed moving toward that edge.
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
        assert!(right <= MAX - EDGE_REST_GAP && right > MAX - BAND);
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
        let work = MonitorRect { width: 1180.0, ..current };
        let connected = drag_region(current, work, &[neighbor], (1190.0, 500.0));
        let near_seam = drag_region(current, work, &[neighbor], (1190.0, 800.5));
        let beyond_tolerance = drag_region(current, work, &[neighbor], (1190.0, 801.01));
        let exposed = drag_region(current, work, &[neighbor], (1190.0, 900.0));
        assert!(!connected.edge_mask.right);
        assert!(!near_seam.edge_mask.right);
        assert!(beyond_tolerance.edge_mask.right);
        assert!(exposed.edge_mask.right);
        assert_eq!(connected.bounds.right(), current.right());
        assert_eq!(exposed.bounds.right(), work.right());

        let corner_only = MonitorRect { x: 1200.0, y: 1000.0, ..neighbor };
        let corner = drag_region(current, work, &[corner_only], (1199.5, 1000.0));
        assert!(corner.edge_mask.right, "corner contact is not a traversable seam");
    }

    #[test]
    fn a_shared_vertical_seam_keeps_the_full_tangent_span_past_a_dock_inset() {
        let monitor = MonitorRect { x: 0.0, y: 0.0, width: 1200.0, height: 1000.0 };
        let work = MonitorRect { width: 1180.0, height: 900.0, ..monitor };
        let neighbor = MonitorRect { x: 1200.0, y: 0.0, width: 1000.0, height: 1000.0 };

        let region = drag_region(monitor, work, &[neighbor], (1190.0, 950.0));

        assert!(!region.edge_mask.right);
        assert!(region.edge_mask.bottom);
        assert_eq!(region.bounds.x, work.x);
        assert_eq!(region.bounds.right(), monitor.right());
        assert_eq!(region.bounds.y, monitor.y);
        assert_eq!(region.bounds.bottom(), monitor.bottom());
    }

    #[test]
    fn partial_seam_latch_prevents_mask_flips_until_the_center_reenters() {
        let monitor = MonitorRect { x: 0.0, y: 0.0, width: 1200.0, height: 1000.0 };
        let work = MonitorRect { width: 1180.0, height: 900.0, ..monitor };
        let neighbor = MonitorRect { x: 1200.0, y: 200.0, width: 1000.0, height: 600.0 };
        let mut tracker = SeamTracker::default();

        let near_end = tracker.resolve(monitor, work, &[neighbor], (1190.0, 700.0));
        assert!(!near_end.edge_mask.right);
        let outside_overlap = tracker.resolve(monitor, work, &[neighbor], (1190.0, 900.0));
        assert!(!outside_overlap.edge_mask.right);
        assert_eq!(outside_overlap.bounds.right(), monitor.right());

        // Returning by the hysteresis margin releases the latch, but the
        // naturally connected seam stays open. Leaving again re-arms it.
        let reentered = tracker.resolve(monitor, work, &[neighbor], (1190.0, 680.0));
        assert!(!reentered.edge_mask.right);
        let near_end_again = tracker.resolve(monitor, work, &[neighbor], (1190.0, 700.0));
        assert!(!near_end_again.edge_mask.right);
        let outside_again = tracker.resolve(monitor, work, &[neighbor], (1190.0, 900.0));
        assert!(!outside_again.edge_mask.right);

        let unplugged = tracker.resolve(monitor, work, &[], (1190.0, 900.0));
        assert!(unplugged.edge_mask.right);
        assert_eq!(unplugged.bounds.right(), work.right());
    }

    #[test]
    fn release_from_a_shared_seam_uses_work_area_bounds() {
        let monitor = MonitorRect { x: 0.0, y: 0.0, width: 1200.0, height: 1000.0 };
        let work = MonitorRect { width: 1180.0, height: 900.0, ..monitor };
        let neighbor = MonitorRect { x: 1200.0, y: 0.0, width: 1000.0, height: 1000.0 };

        let held = drag_region(monitor, work, &[neighbor], (1190.0, 500.0));
        let released = drag_region(monitor, work, &[], (1190.0, 500.0));

        assert!(!held.edge_mask.right);
        assert_eq!(released.edge_mask, EdgeMask::ALL);
        assert_eq!(released.bounds, work);
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
    fn invalid_drag_region_inputs_return_finite_fallback_bounds() {
        let monitor = MonitorRect { x: -100.0, y: 20.0, width: 800.0, height: 600.0 };
        let invalid_work = MonitorRect { width: f64::NAN, ..monitor };
        let fallback = drag_region(monitor, invalid_work, &[], (0.0, 0.0));
        assert_eq!(fallback.bounds, monitor);
        assert_eq!(fallback.edge_mask, EdgeMask::ALL);

        let work = MonitorRect { x: 0.0, y: 0.0, width: 640.0, height: 480.0 };
        let invalid_monitor = MonitorRect { width: 0.0, ..monitor };
        let fallback = drag_region(invalid_monitor, work, &[], (0.0, 0.0));
        assert_eq!(fallback.bounds, work);

        let fallback = drag_region(invalid_monitor, invalid_work, &[], (0.0, 0.0));
        assert_eq!(fallback.bounds.x, 0.0);
        assert_eq!(fallback.bounds.y, 0.0);
        assert_eq!(fallback.bounds.width, 0.0);
        assert_eq!(fallback.bounds.height, 0.0);
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
