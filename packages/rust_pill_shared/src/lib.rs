//! Geometry helpers shared by the per-platform pill renderers
//! (rust_gtk_pill, rust_macos_pill, rust_windows_pill).
//!
//! The long-press progress ring draws a partial outline around a rounded
//! rectangle. Keeping the perimeter math in one crate guarantees every
//! platform traces the *same* path for the same input rectangle, so the
//! ring lines up pixel-for-pixel across Linux, macOS and Windows.

use std::f64::consts::FRAC_PI_2;

/// Build the perimeter of an axis-aligned rounded rectangle as an ordered
/// list of `(x, y)` points. The path traces clockwise starting from the
/// left end of the top edge, goes through four quarter-circle corners,
/// and closes back at the start point.
///
/// `arc_steps` controls how many line segments each corner arc is split
/// into; it is chosen automatically from `radius` when callers pass
/// [`RoundedRectArcSteps::Auto`], mirroring the heuristic the three pills
/// previously duplicated locally.
pub fn rounded_rectangle_perimeter(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    radius: f64,
    arc_steps: RoundedRectArcSteps,
) -> Vec<(f64, f64)> {
    // A zero or negative radius collapses to a plain rectangle; cap the
    // radius at half the shortest side so the arcs never overlap.
    let r = radius.max(0.0).min(w.min(h) * 0.5);
    let steps = match arc_steps {
        RoundedRectArcSteps::Auto => ((r * 0.75).ceil() as usize).clamp(6, 24),
        RoundedRectArcSteps::Exact(n) => n.max(1),
    };

    let mut path: Vec<(f64, f64)> = Vec::with_capacity(steps * 4 + 5);

    let corner = |cx: f64, cy: f64, from: f64, path: &mut Vec<(f64, f64)>| {
        for i in 1..=steps {
            let angle = from + (i as f64 / steps as f64) * FRAC_PI_2;
            path.push((cx + angle.cos() * r, cy + angle.sin() * r));
        }
    };

    // Top edge, left -> right (start point doubles as the progress origin).
    // Always emit both endpoints; consumers already tolerate zero-length segments.
    path.push((x + r, y));
    path.push((x + w - r, y));
    // Top-right corner (-90deg -> 0deg), then the right edge.
    corner(x + w - r, y + r, -FRAC_PI_2, &mut path);
    path.push((x + w, y + h - r));
    // Bottom-right corner (0deg -> 90deg), then the bottom edge, right -> left.
    corner(x + w - r, y + h - r, 0.0, &mut path);
    path.push((x + r, y + h));
    // Bottom-left corner (90deg -> 180deg), then the left edge.
    corner(x + r, y + h - r, FRAC_PI_2, &mut path);
    path.push((x, y + r));
    // Top-left corner (180deg -> 270deg) - closes back at the start point.
    corner(x + r, y + r, std::f64::consts::PI, &mut path);

    path
}

/// Cumulative linear distances along a polygon produced by
/// [`rounded_rectangle_perimeter`], starting at `0.0` for the first vertex.
///
/// Returns `(distances, total_len)` where `distances[i]` is the distance
/// from the first vertex to the `i`-th vertex travelling along the path,
/// and `total_len` is the total perimeter length.
pub fn path_distances(path: &[(f64, f64)]) -> (Vec<f64>, f64) {
    let mut distances = Vec::with_capacity(path.len());
    distances.push(0.0);
    for i in 1..path.len() {
        let dx = path[i].0 - path[i - 1].0;
        let dy = path[i].1 - path[i - 1].1;
        distances.push(distances[i - 1] + (dx * dx + dy * dy).sqrt());
    }
    let total = distances.last().copied().unwrap_or(0.0);
    (distances, total)
}

/// How many line segments to use for each corner arc.
#[derive(Debug, Clone, Copy)]
pub enum RoundedRectArcSteps {
    /// Pick a step count from the radius (higher radius -> smoother arcs),
    /// clamped to 6..=24.
    Auto,
    /// Use exactly `n` segments per corner.
    Exact(usize),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn perimeter_closes_back_to_start() {
        let pts = rounded_rectangle_perimeter(10.0, 20.0, 120.0, 32.0, 16.0, RoundedRectArcSteps::Auto);
        assert!(pts.len() > 8);
        let first = pts[0];
        let last = *pts.last().unwrap();
        // The final arc segment lands at the start point (within floating error).
        assert!((last.0 - first.0).abs() < 1e-6);
        assert!((last.1 - first.1).abs() < 1e-6);
    }

    #[test]
    fn zero_radius_produces_a_rectangle() {
        let pts = rounded_rectangle_perimeter(0.0, 0.0, 100.0, 50.0, 0.0, RoundedRectArcSteps::Exact(1));
        // With r=0 the "arcs" collapse to the corners: 4 edge endpoints +
        // 4 one-step corners + the closing start point = 9.
        assert_eq!(pts.len(), 9);
        let (_, total) = path_distances(&pts);
        assert!((total - 300.0).abs() < 1e-6);
    }

    #[test]
    fn auto_steps_follow_radius() {
        let small = rounded_rectangle_perimeter(0.0, 0.0, 100.0, 32.0, 8.0, RoundedRectArcSteps::Auto);
        let big = rounded_rectangle_perimeter(0.0, 0.0, 400.0, 200.0, 100.0, RoundedRectArcSteps::Auto);
        // Bigger radius -> more steps; the minimum is 6.
        assert!(big.len() > small.len());
        assert!(small.len() >= 6 * 4 + 5);
    }
}
