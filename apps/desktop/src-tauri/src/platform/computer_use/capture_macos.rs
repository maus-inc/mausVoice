//! macOS screen capture through CoreGraphics.
//!
//! `CGDisplayCreateImage` is the only capture path that does not need screen
//! recording permission for the calling process, and it returns the whole
//! display rather than a composited window list. The image it hands back is
//! `CGImage`, whose backing bytes are in whatever layout its colour space
//! implies, so it is drawn into a bitmap context we own instead of being read
//! directly. That gives one known byte order for every display.

use core_graphics::base::{kCGBitmapByteOrder32Big, kCGImageAlphaNoneSkipLast};
use core_graphics::color_space::CGColorSpace;
use core_graphics::context::CGContext;
use core_graphics::display::CGDisplay;
use core_graphics::geometry::{CGPoint, CGRect, CGSize};

use super::capture::{DisplayGeometry, FramePixelFormat, RawFrame};

/// Bitmap description for a 32-bit buffer holding RGBX.
///
/// `kCGBitmapByteOrder32Big` puts the first-named component in the most
/// significant byte, and `kCGImageAlphaNoneSkipLast` means the components come
/// first with the unused byte last. Apple's own documentation, transcribed in
/// `core-graphics` `image.rs`, describes that combination as R, B, G, X, so the
/// bytes in memory are R, G, B, X. Declared here because `core-graphics` 0.24
/// exports the alpha constant and the byte-order flag separately, and labelling
/// the buffer as blue-first instead swaps red and blue in every screenshot with
/// no error anywhere.
const BITMAP_INFO: u32 = kCGBitmapByteOrder32Big | kCGImageAlphaNoneSkipLast;

pub fn displays() -> Result<Vec<DisplayGeometry>, String> {
    let ids = CGDisplay::active_displays()
        .map_err(|err| format!("macOS would not list the attached displays: {err:?}"))?;
    let geometries: Vec<DisplayGeometry> = ids.iter().map(|id| geometry_for(*id)).collect();
    if geometries.is_empty() {
        return Err("macOS reported no attached displays".to_string());
    }
    Ok(geometries)
}

/// macOS display bounds are in points with the origin at the top-left of the
/// primary display, and the backing store is in physical pixels. Both numbers
/// are needed: the origin for the desktop-coordinate conversion, the pixel
/// count for the capture.
fn geometry_for(id: core_graphics::sys::CGDirectDisplayID) -> DisplayGeometry {
    let display = CGDisplay::new(id);
    let bounds = display.bounds();
    let width_px = display.pixels_wide().max(1) as u32;
    let height_px = display.pixels_high().max(1) as u32;
    // Derived rather than read from NSScreen: the backing scale factor IS the
    // ratio of the two, and taking the ratio means one source of truth for both
    // numbers instead of two that can disagree.
    let scale_factor = if bounds.size.width > 0.0 {
        f64::from(width_px) / bounds.size.width
    } else {
        1.0
    };
    DisplayGeometry {
        id,
        origin_x: f64::from(bounds.origin.x),
        origin_y: f64::from(bounds.origin.y),
        width_px,
        height_px,
        scale_factor,
    }
}

pub fn display_under_cursor() -> Result<DisplayGeometry, String> {
    let monitor = crate::platform::monitor::get_monitor_at_cursor()
        .ok_or_else(|| "macOS would not report the display under the pointer".to_string())?;
    // NSScreen has no display id, so the match is on the monitor's pixel
    // geometry. A miss here would capture the wrong screen entirely, so the
    // fallback is the primary display rather than an arbitrary one.
    displays()?
        .into_iter()
        .find(|display| {
            (f64::from(display.width_px) - monitor.width * monitor.scale_factor).abs() < 1.0
                && (f64::from(display.height_px) - monitor.height * monitor.scale_factor).abs()
                    < 1.0
        })
        .map(Ok)
        .unwrap_or_else(|| primary_display())
}

pub fn primary_display() -> Result<DisplayGeometry, String> {
    let main = CGDisplay::main();
    Ok(geometry_for(main.id))
}

/// Where the pointer is, in desktop physical pixels with a top-left origin.
///
/// AppKit and Quartz disagree about both the origin and the unit, and this is
/// the one place that has to reconcile them:
///
/// * AppKit's `mouseLocation` is in points with the origin at the BOTTOM-LEFT
///   of the primary display and y growing upward.
/// * Quartz, which is the space the rest of this module works in, is in points
///   with the origin at the TOP-LEFT of the primary display and y growing down.
/// * `rdev` on macOS posts a raw `CGPoint`, so a value handed to it must
///   already be in that top-left space, which is what this returns.
///
/// Mirroring y against the primary display's point height is what makes a
/// display ABOVE the primary land at a negative Quartz y, which is correct.
pub fn cursor_position() -> Result<Option<(u32, u32)>, String> {
    use cocoa::appkit::NSEvent;
    use cocoa::base::nil;

    let location = NSEvent::mouseLocation(nil);
    if !location.x.is_finite() || !location.y.is_finite() {
        return Ok(None);
    }

    let primary = primary_display()?;
    let primary_points = primary.width_px as f64 / primary.scale_factor;
    let quartz_x_points = location.x;
    let quartz_y_points = primary_points - location.y;

    // The scale factor belongs to whichever display the point landed on, so the
    // per-display lookup is what makes a mixed-DPI desktop correct rather than
    // uniformly scaled by the primary's factor.
    let scale = displays()?
        .into_iter()
        .find(|display| {
            let origin_x = display.origin_x;
            let origin_y = display.origin_y;
            let width_points = f64::from(display.width_px) / display.scale_factor;
            let height_points = f64::from(display.height_px) / display.scale_factor;
            quartz_x_points >= origin_x
                && quartz_x_points < origin_x + width_points
                && quartz_y_points >= origin_y
                && quartz_y_points < origin_y + height_points
        })
        .map(|display| display.scale_factor)
        .unwrap_or(primary.scale_factor);

    let x = (quartz_x_points * scale).round().max(0.0);
    let y = (quartz_y_points * scale).round().max(0.0);
    if x > u32::MAX as f64 || y > u32::MAX as f64 {
        return Ok(None);
    }
    Ok(Some((x as u32, y as u32)))
}

/// Copy a display's backing store into a known RGBA byte order.
pub fn capture(geometry: &DisplayGeometry) -> Result<RawFrame, String> {
    let display = CGDisplay::new(geometry.id);
    let image = display
        .image()
        .ok_or_else(|| "macOS refused to return the display contents. Screen recording permission may be missing.".to_string())?;

    let width = image.width() as u32;
    let height = image.height() as u32;
    if width == 0 || height == 0 {
        return Err("The captured display had no pixels".to_string());
    }
    let color_space = CGColorSpace::create_device_rgb();
    let bytes_per_row = width as usize * 4;
    let mut context = CGContext::create_bitmap_context(
        None,
        width as usize,
        height as usize,
        8,
        bytes_per_row,
        &color_space,
        BITMAP_INFO,
    );
    context.draw_image(
        CGRect::new(
            &CGPoint::new(0.0, 0.0),
            &CGSize::new(width as f64, height as f64),
        ),
        &image,
    );
    context.flush();
    let pixels = context.data().to_vec();
    drop(image);

    Ok(RawFrame {
        width,
        height,
        pixels,
        pixel_format: FramePixelFormat::Rgba,
    })
}
