//! The parts of screen capture and input synthesis that are not per-platform.
//!
//! Three OS APIs can produce a framebuffer and three can move a pointer, but
//! the questions asked of a capture are the same everywhere: which display,
//! which rectangle, how wide may the encoded image be, and which format does
//! the caller need. Deciding those here keeps the per-OS files down to the one
//! call they each own, and puts the arithmetic that has to be exactly right
//! (DPI scaling, rectangle clamping, aspect-preserving resize) under
//! `#[cfg(test)]` on every platform instead of behind a real display.

pub mod input;

mod capture;

// `pub` because `capture` re-exports whichever one applies as its
// `platform::backend`, and Rust will not re-export anything narrower. The
// module itself is only reachable through `capture`, because its `capture`
// module is private and the re-export lives inside that.
#[cfg(target_os = "linux")]
pub mod capture_linux;
#[cfg(target_os = "macos")]
pub mod capture_macos;
#[cfg(target_os = "windows")]
pub mod capture_windows;

pub use capture::{
    capture_screen, displays, finish_capture, selected_display, zoom_capture, CaptureDisplay,
    CaptureFormat, CaptureRequest, CapturedFrame, DisplayGeometry, FramePixelFormat, RawFrame,
    DEFAULT_JPEG_QUALITY, DEFAULT_MAX_WIDTH,
};

/// A rectangle in physical pixels, measured from the top-left of the desktop.
///
/// Coordinates are `u32` rather than `f64` on purpose: a rectangle is a set of
/// whole pixels, and rounding a fractional rectangle outward silently enlarges
/// it, which for a click target means clicking a neighbouring control.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl PhysicalRect {
    /// The right and bottom edges as exclusive coordinates.
    pub fn right(&self) -> u64 {
        u64::from(self.x) + u64::from(self.width)
    }

    pub fn bottom(&self) -> u64 {
        u64::from(self.y) + u64::from(self.height)
    }
}

/// Clamp `rect` so it lies inside `bounds`, shrinking from the bottom-right.
///
/// A capture that runs past the edge of a display is a bug in the caller's
/// arithmetic, not something to paper over: clamping keeps a slightly-off
/// request usable, and the accompanying log line says the request was clamped
/// so the cause is still visible. Growing is never correct, because there are
/// no pixels to grow into.
pub fn clamp_rect(rect: PhysicalRect, bounds: PhysicalRect) -> PhysicalRect {
    let max_width = (u64::from(bounds.width)).saturating_sub(u64::from(rect.x));
    let max_height = (u64::from(bounds.height)).saturating_sub(u64::from(rect.y));
    PhysicalRect {
        x: rect.x,
        y: rect.y,
        width: rect.width.min(max_width as u32),
        height: rect.height.min(max_height as u32),
    }
}

/// Whether clamping `rect` against `bounds` would change it.
///
/// Used to report a clamped request rather than silently serving a smaller
/// image than the caller asked for.
pub fn clamp_rect_would_change(rect: PhysicalRect, bounds: PhysicalRect) -> bool {
    clamp_rect(rect, bounds) != rect
}

/// The pixel dimensions an image of `source` should be resized to so that it
/// is at most `max_width` wide while keeping its aspect ratio.
///
/// Only ever shrinks. A capture that is already narrower than the budget is
/// left alone: enlarging it invents pixels, and a model told to click at a
/// coordinate in a blurred-up image clicks the wrong thing just as surely as
/// one told to click in a shrunken one. A `max_width` of 0 disables resizing.
pub fn fit_width(source_width: u32, source_height: u32, max_width: u32) -> (u32, u32) {
    if max_width == 0 || source_width <= max_width || source_width == 0 || source_height == 0 {
        return (source_width, source_height);
    }
    let height =
        ((u64::from(source_height) * u64::from(max_width)) / u64::from(source_width)).max(1);
    (max_width, height as u32)
}

/// Map a point stated against a resized image back onto the full-size capture.
///
/// The providers state coordinates against whatever image they were shown, so
/// after a resize every incoming coordinate has to travel back up before it
/// reaches the OS. This is the arithmetic that is easy to get wrong in the
/// last pixel: `source_width` is the *resized* width and `source_width_full`
/// is the capture it came from.
pub fn unscale_coordinate(value: u32, source_width: u32, source_width_full: u32) -> u32 {
    if source_width == 0 || source_width == source_width_full {
        return value;
    }
    let scaled = (u64::from(value) * u64::from(source_width_full)) / u64::from(source_width);
    scaled.min(u64::from(source_width_full) - 1) as u32
}

/// Clamp a point stated in a display's own physical pixels to that display.
///
/// A capture is stated in the pixels of the display it came from, so the
/// coordinates a model answers with are display-local. This is where a point
/// that has fallen off the display, because the model scaled it slightly wrong
/// or because a stale screenshot described a display that has since been
/// unplugged, becomes a point that is at least on the display.
pub fn clamp_to_display(display_x: u32, display_y: u32, geometry: &DisplayGeometry) -> (u32, u32) {
    let max_x = geometry.width_px.saturating_sub(1);
    let max_y = geometry.height_px.saturating_sub(1);
    (display_x.min(max_x), display_y.min(max_y))
}

/// Map a point from desktop physical pixels onto the display a capture came
/// from.
///
/// `geometry.origin_*` is where the display sits in the desktop coordinate
/// space, so a monitor to the left of the primary one has a negative origin.
/// Subtracting the origin is what turns a desktop-wide coordinate into a
/// display-local one; adding instead is the bug that puts every click a monitor
/// to the left of where it belongs, and it is silent.
pub fn to_display_local(desktop_x: u32, desktop_y: u32, geometry: &DisplayGeometry) -> (u32, u32) {
    let local_x = f64::from(desktop_x) - geometry.origin_x;
    let local_y = f64::from(desktop_y) - geometry.origin_y;
    if local_x < 0.0 || local_y < 0.0 {
        return (0, 0);
    }
    clamp_to_display(local_x.round() as u32, local_y.round() as u32, geometry)
}

/// Map a point stated in a display's own physical pixels to desktop pixels.
///
/// The opposite direction to [`to_display_local`], and deliberately a different
/// function rather than a reuse of it. Subtracting a negative origin and then
/// adding it back looks like a no-op but is not: the intermediate value is
/// clamped to the display, so a caller that passed desktop coordinates through
/// this one had them clamped as if they were local ones. On a display to the
/// left of the primary, that turns every point into the far corner.
///
/// Returns signed coordinates because a display left of or above the primary
/// one genuinely sits at a negative desktop offset. Clamping those to zero
/// would put the click on the wrong monitor, which is the silent failure rule 8
/// is about; whether the platform can act on them is the caller's business.
pub fn to_desktop(display_x: u32, display_y: u32, geometry: &DisplayGeometry) -> (i64, i64) {
    let (local_x, local_y) = clamp_to_display(display_x, display_y, geometry);
    (
        (geometry.origin_x + f64::from(local_x)).round() as i64,
        (geometry.origin_y + f64::from(local_y)).round() as i64,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: u32, y: u32, width: u32, height: u32) -> PhysicalRect {
        PhysicalRect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn clamp_leaves_an_interior_rect_alone() {
        let bounds = rect(0, 0, 1920, 1080);
        let inner = rect(100, 100, 200, 200);
        assert_eq!(clamp_rect(inner, bounds), inner);
        assert!(!clamp_rect_would_change(inner, bounds));
    }

    #[test]
    fn clamp_shrinks_a_rect_that_overruns_the_right_edge() {
        let bounds = rect(0, 0, 1920, 1080);
        let clamped = clamp_rect(rect(1800, 0, 400, 100), bounds);
        assert_eq!(clamped, rect(1800, 0, 120, 100));
        assert!(clamp_rect_would_change(rect(1800, 0, 400, 100), bounds));
    }

    #[test]
    fn clamp_shrinks_a_rect_that_overruns_both_edges() {
        let bounds = rect(0, 0, 800, 600);
        assert_eq!(
            clamp_rect(rect(700, 500, 400, 400), bounds),
            rect(700, 500, 100, 100)
        );
    }

    #[test]
    fn clamp_does_not_panic_when_the_origin_is_past_the_edge() {
        // u64 subtraction, not u32: 0u32.wrapping_sub(x) is silent garbage.
        let bounds = rect(0, 0, 100, 100);
        assert_eq!(
            clamp_rect(rect(500, 500, 10, 10), bounds),
            rect(500, 500, 0, 0)
        );
    }

    #[test]
    fn fit_width_only_ever_shrinks() {
        assert_eq!(fit_width(800, 600, 1280), (800, 600));
        assert_eq!(fit_width(1280, 800, 1280), (1280, 800));
        assert_eq!(fit_width(0, 0, 1280), (0, 0));
    }

    #[test]
    fn fit_width_of_zero_disables_resizing() {
        assert_eq!(fit_width(3840, 2160, 0), (3840, 2160));
    }

    #[test]
    fn fit_width_preserves_aspect_ratio() {
        let (width, height) = fit_width(2560, 1440, 1280);
        assert_eq!((width, height), (1280, 720));
    }

    #[test]
    fn fit_width_never_rounds_height_down_to_zero() {
        // A 1000x1 capture fitted to 1px wide would round to 0 and produce an
        // image with no rows at all.
        let (width, height) = fit_width(1000, 1, 1);
        assert_eq!(width, 1);
        assert_eq!(height, 1);
    }

    #[test]
    fn unscale_is_identity_when_no_resize_happened() {
        assert_eq!(unscale_coordinate(640, 1280, 1280), 640);
    }

    #[test]
    fn unscale_maps_back_onto_the_full_capture() {
        // 640 of a 1280-wide image is half of a 2560-wide capture.
        assert_eq!(unscale_coordinate(640, 1280, 2560), 1280);
    }

    #[test]
    fn unscale_never_lands_one_past_the_last_pixel() {
        assert_eq!(unscale_coordinate(1280, 1280, 2560), 2559);
    }

    #[test]
    fn unscale_of_a_zero_width_source_is_the_input() {
        assert_eq!(unscale_coordinate(7, 0, 2560), 7);
    }

    #[test]
    fn to_display_local_subtracts_a_positive_origin() {
        let geometry = DisplayGeometry {
            id: 1,
            origin_x: 1920.0,
            origin_y: 0.0,
            width_px: 1280,
            height_px: 1024,
            scale_factor: 1.0,
        };
        assert_eq!(to_display_local(2000, 300, &geometry), (80, 300));
    }

    #[test]
    fn to_display_local_subtracts_a_negative_origin() {
        // A monitor left of the primary one has a negative desktop origin, so
        // this display occupies desktop x in [-1280, 0). Desktop x 0 is
        // therefore its exclusive right edge, and the last pixel it can name is
        // 1279. Returning 1280 would be a coordinate one past the display.
        let geometry = DisplayGeometry {
            id: 1,
            origin_x: -1280.0,
            origin_y: 0.0,
            width_px: 1280,
            height_px: 1024,
            scale_factor: 1.0,
        };
        assert_eq!(to_display_local(0, 0, &geometry), (1279, 0));
    }

    #[test]
    fn to_display_local_clamps_a_point_off_the_display_to_the_origin() {
        let geometry = DisplayGeometry {
            id: 1,
            origin_x: 1920.0,
            origin_y: 0.0,
            width_px: 1280,
            height_px: 1024,
            scale_factor: 1.0,
        };
        assert_eq!(to_display_local(1000, 10, &geometry), (0, 0));
    }

    #[test]
    fn to_display_local_clamps_the_last_row_and_column() {
        let geometry = DisplayGeometry {
            id: 1,
            origin_x: 0.0,
            origin_y: 0.0,
            width_px: 1920,
            height_px: 1080,
            scale_factor: 1.0,
        };
        assert_eq!(to_display_local(9999, 9999, &geometry), (1919, 1079));
    }
}
