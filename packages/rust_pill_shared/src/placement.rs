//! Ordered-pair model for the pill and the style selector.
//!
//! The selector sits above the pill by default and moves below it when the
//! headroom above the pill drops under the selector height plus
//! [`PLACEMENT_GAP`]. Switching back needs [`PLACEMENT_HYSTERESIS`] extra
//! pixels, so hovering near the boundary never flaps the selector up and
//! down. The side change animates through the shared [`spring_01`] curve as
//! a 0..1 blend, and platforms derive the painted origin and the hit region
//! from that blend every frame, so clicks always land where the pixels are.
//!
//! Platforms own the headroom measurement (pill top minus work-area top in
//! their logical pixels) and feed it in; this module owns the decision, the
//! blend, and the origin math, so all three pills place the selector alike
//! and stay testable without a display. Selection state is untouched: only
//! geometry moves, never the style fields.
//!
//! [`spring_01`]: crate::spring::spring_01

use std::cell::Cell;

use crate::spring::spring_01;

/// Resting gap between the pill edge and the selector, in logical pixels.
pub const PLACEMENT_GAP: f64 = 12.0;
/// Extra headroom needed before the selector moves back above, in logical
/// pixels. Stops rapid order changes near the boundary.
pub const PLACEMENT_HYSTERESIS: f64 = 20.0;

/// Extra headroom between the below slot and the window bottom, in logical
/// pixels. Keeps antialiased edges inside the window.
pub const BELOW_SLOT_MARGIN: f64 = 4.0;

/// Which side of the pill the selector sits on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectorSide {
    Above,
    Below,
}

/// One frame of input to [`SelectorPlacement::advance`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlacementFrame {
    /// Pill top minus work-area top in the platform's logical pixels.
    pub space_above: f64,
    /// Selector height in the platform's logical pixels.
    pub tooltip_h: f64,
    /// Spring stiffness for the side-change blend. Platforms pass the same
    /// stiffness their fade transitions use.
    pub stiffness: f64,
    /// Seconds since the previous frame. Clamped internally.
    pub dt: f64,
    /// True when the OS asks for reduced motion. The side snaps instead of
    /// blending; placement itself is unaffected.
    pub reduced_motion: bool,
}

/// One frame of output from [`SelectorPlacement::advance`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlacementOutput {
    pub side: SelectorSide,
    /// 0.0 is fully above, 1.0 fully below. Feed it to [`tooltip_origin`].
    pub blend: f64,
}

/// Shared selector-placement state machine. See the module docs for the
/// feeding contract.
#[derive(Debug, Clone)]
pub struct SelectorPlacement {
    side: SelectorSide,
    blend: Cell<f64>,
    blend_vel: Cell<f64>,
}

impl Default for SelectorPlacement {
    fn default() -> Self {
        Self::new()
    }
}

impl SelectorPlacement {
    pub fn new() -> Self {
        Self {
            side: SelectorSide::Above,
            blend: Cell::new(0.0),
            blend_vel: Cell::new(0.0),
        }
    }

    pub fn side(&self) -> SelectorSide {
        self.side
    }

    pub fn blend(&self) -> f64 {
        self.blend.get()
    }

    /// Current blend velocity. The redraw gate reads it to keep painting
    /// while a side change is still animating.
    pub fn blend_velocity(&self) -> f64 {
        self.blend_vel.get()
    }

    /// Drop back to above with no animation. Used when the platform re-homes
    /// the pill (reset-position command) or otherwise moves the window
    /// itself.
    pub fn reset(&mut self) {
        self.side = SelectorSide::Above;
        self.blend.set(0.0);
        self.blend_vel.set(0.0);
    }

    /// Decide the side from this frame's headroom and ease the blend toward
    /// it. Reduced motion snaps the blend instead of easing it.
    pub fn advance(&mut self, frame: &PlacementFrame) -> PlacementOutput {
        self.side = decide_side(self.side, frame.space_above, frame.tooltip_h);
        let target = match self.side {
            SelectorSide::Above => 0.0,
            SelectorSide::Below => 1.0,
        };
        if frame.reduced_motion {
            self.blend.set(target);
            self.blend_vel.set(0.0);
        } else {
            spring_01(&self.blend, &self.blend_vel, target, frame.stiffness, frame.dt);
        }
        PlacementOutput {
            side: self.side,
            blend: self.blend.get(),
        }
    }
}

/// Pick the selector side from the headroom above the pill.
///
/// Above wins by default and flips below once the space drops under the
/// selector height plus [`PLACEMENT_GAP`]. Coming back needs that plus
/// [`PLACEMENT_HYSTERESIS`], so one pixel of jitter at the line cannot flap
/// the order. Garbage in (non-finite or negative height) keeps the current
/// side instead of jumping.
pub fn decide_side(current: SelectorSide, space_above: f64, tooltip_h: f64) -> SelectorSide {
    if !space_above.is_finite() || !tooltip_h.is_finite() || tooltip_h < 0.0 {
        return current;
    }
    let needed = tooltip_h + PLACEMENT_GAP;
    match current {
        SelectorSide::Above => {
            if space_above < needed {
                SelectorSide::Below
            } else {
                SelectorSide::Above
            }
        }
        SelectorSide::Below => {
            if space_above >= needed + PLACEMENT_HYSTERESIS {
                SelectorSide::Above
            } else {
                SelectorSide::Below
            }
        }
    }
}

/// Extra window rows a platform keeps below the pill so the below slot fits
/// inside the window. Platforms add this to their window height once at
/// creation (not per flip) and leave content math untouched, so the pill
/// never moves and the blend animates inside room that is already there.
pub fn below_slot_extra(tooltip_h: f64) -> f64 {
    PLACEMENT_GAP + tooltip_h.max(0.0) + BELOW_SLOT_MARGIN
}

/// Selector origin for a blend value: horizontally centred on the pill,
/// vertically interpolated between the above slot and the below slot.
/// Platforms paint at this origin and build their hit region from it on the
/// same frame, so the clickable box tracks the animation exactly.
#[allow(clippy::too_many_arguments)]
pub fn tooltip_origin(
    pill_x: f64,
    pill_y: f64,
    pill_w: f64,
    pill_h: f64,
    tooltip_w: f64,
    tooltip_h: f64,
    gap: f64,
    blend: f64,
) -> (f64, f64) {
    let x = pill_x + (pill_w - tooltip_w) / 2.0;
    let above_y = pill_y - gap - tooltip_h;
    let below_y = pill_y + pill_h + gap;
    let t = if blend.is_finite() {
        blend.clamp(0.0, 1.0)
    } else {
        0.0
    };
    (x, above_y + (below_y - above_y) * t)
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: f64 = 32.0;
    const NEEDED: f64 = H + PLACEMENT_GAP;

    fn frame(space_above: f64, dt: f64) -> PlacementFrame {
        PlacementFrame {
            space_above,
            tooltip_h: H,
            stiffness: 170.0,
            dt,
            reduced_motion: false,
        }
    }

    #[test]
    fn above_is_the_default_side() {
        let placement = SelectorPlacement::new();
        assert_eq!(placement.side(), SelectorSide::Above);
        let out = SelectorPlacement::new().advance(&frame(500.0, 1.0 / 60.0));
        assert_eq!(out.side, SelectorSide::Above);
        assert_eq!(out.blend, 0.0);
    }

    #[test]
    fn exact_fit_stays_above() {
        assert_eq!(decide_side(SelectorSide::Above, NEEDED, H), SelectorSide::Above);
    }

    #[test]
    fn one_pixel_short_flips_below() {
        assert_eq!(
            decide_side(SelectorSide::Above, NEEDED - 1.0, H),
            SelectorSide::Below
        );
    }

    #[test]
    fn hysteresis_holds_below_near_the_line() {
        assert_eq!(
            decide_side(SelectorSide::Below, NEEDED + PLACEMENT_HYSTERESIS - 1.0, H),
            SelectorSide::Below
        );
        assert_eq!(
            decide_side(SelectorSide::Below, NEEDED + PLACEMENT_HYSTERESIS, H),
            SelectorSide::Above
        );
    }

    #[test]
    fn repeated_threshold_crossings_end_on_the_right_side() {
        let mut side = SelectorSide::Above;
        for space in [NEEDED - 2.0, NEEDED + 1.0, NEEDED - 0.5, NEEDED + 100.0] {
            side = decide_side(side, space, H);
        }
        assert_eq!(side, SelectorSide::Above);
        let mut side = SelectorSide::Above;
        for _ in 0..50 {
            side = decide_side(side, NEEDED - 0.5, H);
            side = decide_side(side, NEEDED + 1.0, H);
        }
        assert_eq!(side, SelectorSide::Below);
    }

    #[test]
    fn negative_headroom_goes_below() {
        assert_eq!(decide_side(SelectorSide::Above, -40.0, H), SelectorSide::Below);
    }

    #[test]
    fn zero_height_selector_needs_only_the_gap() {
        assert_eq!(decide_side(SelectorSide::Above, PLACEMENT_GAP, 0.0), SelectorSide::Above);
        assert_eq!(
            decide_side(SelectorSide::Above, PLACEMENT_GAP - 1.0, 0.0),
            SelectorSide::Below
        );
    }

    #[test]
    fn garbage_input_keeps_the_current_side() {
        assert_eq!(
            decide_side(SelectorSide::Above, f64::NAN, H),
            SelectorSide::Above
        );
        assert_eq!(
            decide_side(SelectorSide::Below, f64::INFINITY, H),
            SelectorSide::Below
        );
        assert_eq!(
            decide_side(SelectorSide::Above, 500.0, f64::NAN),
            SelectorSide::Above
        );
        assert_eq!(decide_side(SelectorSide::Below, 500.0, -1.0), SelectorSide::Below);
    }

    #[test]
    fn reduced_motion_snaps_to_below_in_one_frame() {
        let mut placement = SelectorPlacement::new();
        let out = placement.advance(&PlacementFrame {
            reduced_motion: true,
            ..frame(0.0, 1.0 / 60.0)
        });
        assert_eq!(out.side, SelectorSide::Below);
        assert_eq!(out.blend, 1.0);
    }

    #[test]
    fn blend_eases_to_below_without_overshoot() {
        let mut placement = SelectorPlacement::new();
        let mut last = 0.0;
        for _ in 0..600 {
            let out = placement.advance(&frame(0.0, 1.0 / 60.0));
            assert!(out.blend >= last, "blend moved backwards");
            assert!(out.blend <= 1.0, "blend overshot below");
            last = out.blend;
            if out.blend == 1.0 {
                break;
            }
        }
        assert_eq!(placement.advance(&frame(0.0, 1.0 / 60.0)).blend, 1.0);
    }

    #[test]
    fn origin_centres_above_and_below() {
        let (x, y) = tooltip_origin(240.0, 100.0, 120.0, 32.0, 160.0, H, 6.0, 0.0);
        assert_eq!(x, 220.0);
        assert_eq!(y, 100.0 - 6.0 - H);
        let (x, y) = tooltip_origin(240.0, 100.0, 120.0, 32.0, 160.0, H, 6.0, 1.0);
        assert_eq!(x, 220.0);
        assert_eq!(y, 100.0 + 32.0 + 6.0);
    }

    #[test]
    fn origin_mid_blend_sits_halfway() {
        let (_, top) = tooltip_origin(0.0, 100.0, 120.0, 32.0, 160.0, H, 6.0, 0.0);
        let (_, bottom) = tooltip_origin(0.0, 100.0, 120.0, 32.0, 160.0, H, 6.0, 1.0);
        let (_, mid) = tooltip_origin(0.0, 100.0, 120.0, 32.0, 160.0, H, 6.0, 0.5);
        assert_eq!(mid, (top + bottom) / 2.0);
    }

    #[test]
    fn origin_clamps_wild_blend_values() {
        let (_, top) = tooltip_origin(0.0, 100.0, 120.0, 32.0, 160.0, H, 6.0, 0.0);
        let (_, bottom) = tooltip_origin(0.0, 100.0, 120.0, 32.0, 160.0, H, 6.0, 1.0);
        assert_eq!(tooltip_origin(0.0, 100.0, 120.0, 32.0, 160.0, H, 6.0, -3.0).1, top);
        assert_eq!(tooltip_origin(0.0, 100.0, 120.0, 32.0, 160.0, H, 6.0, 9.0).1, bottom);
        assert_eq!(tooltip_origin(0.0, 100.0, 120.0, 32.0, 160.0, H, 6.0, f64::NAN).1, top);
    }

    #[test]
    fn below_slot_extra_covers_gap_height_and_margin() {
        assert_eq!(below_slot_extra(32.0), 12.0 + 32.0 + 4.0);
        assert_eq!(below_slot_extra(24.0), 12.0 + 24.0 + 4.0);
        assert_eq!(below_slot_extra(-5.0), 12.0 + 0.0 + 4.0);
    }

    #[test]
    fn reset_returns_to_above() {
        let mut placement = SelectorPlacement::new();
        placement.advance(&frame(0.0, 1.0 / 60.0));
        assert_eq!(placement.side(), SelectorSide::Below);
        placement.reset();
        assert_eq!(placement.side(), SelectorSide::Above);
        let out = placement.advance(&frame(500.0, 1.0 / 60.0));
        assert_eq!((out.side, out.blend), (SelectorSide::Above, 0.0));
    }
}
