//! Turning a raw framebuffer into the base64 payload the frontend receives.
//!
//! The per-OS capture modules hand back pixels in whatever layout the OS
//! produces. Everything from there on is identical on every platform: decode
//! into an RGBA image, crop, resize, encode, base64. Keeping it in one place is
//! what makes the size and format rules in ground rule 11 enforceable at all,
//! since they now have exactly one implementation.

use std::io::Cursor;

use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder, RgbaImage};

use super::{clamp_rect, clamp_rect_would_change, fit_width, PhysicalRect};

/// The pixel order a raw OS framebuffer arrives in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FramePixelFormat {
    /// Four bytes per pixel, red first. macOS `CGImage` and X11 `XImage` with a
    /// 32-bit depth both produce this.
    Rgba,
    /// Four bytes per pixel, blue first. Windows DIBs are BGRA.
    Bgra,
}

/// Encoded image format.
///
/// `Png` exists for the computer-use providers, which reject a JPEG in a
/// function result. It is never the default: rule 11 fixes JPEG 1280/80 for
/// ordinary screenshots, and the provider requirement is enforced at the call
/// site that knows it is talking to a computer-use endpoint rather than by
/// making every capture pay for a PNG.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum CaptureFormat {
    Jpeg { quality: u8 },
    Png,
}

/// JPEG quality used for ordinary captures. Rule 11 fixes this at 80.
pub const DEFAULT_JPEG_QUALITY: u8 = 80;

/// Width an ordinary capture is resized to before encoding. Rule 11 fixes
/// this at 1280; a wider image costs tokens without making text more readable
/// at the resolutions these models see.
pub const DEFAULT_MAX_WIDTH: u32 = 1280;

/// Which display to capture. Desktop capture is a whole-desktop operation on
/// every platform, so the only meaningful choice is which display's coordinate
/// space the result is stated in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum CaptureDisplay {
    /// The display the pointer is on. The default, because it is the one the
    /// user is looking at.
    UnderCursor,
    /// The primary display.
    Primary,
    /// A specific display id from [`crate::platform::computer_use::displays`].
    Id(u32),
}

impl Default for CaptureDisplay {
    fn default() -> Self {
        Self::UnderCursor
    }
}

/// A capture request.
///
/// `max_width` of 0 means "do not resize", which is what a zoom region wants:
/// a zoom is only useful at its native pixel density.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    #[serde(default)]
    pub display: CaptureDisplay,
    /// Defaults to the whole chosen display.
    #[serde(default)]
    pub region: Option<PhysicalRect>,
    #[serde(default = "default_max_width")]
    pub max_width: u32,
    #[serde(default = "default_format")]
    pub format: CaptureFormat,
}

fn default_max_width() -> u32 {
    DEFAULT_MAX_WIDTH
}

fn default_format() -> CaptureFormat {
    CaptureFormat::Jpeg {
        quality: DEFAULT_JPEG_QUALITY,
    }
}

impl Default for CaptureRequest {
    fn default() -> Self {
        Self {
            display: CaptureDisplay::default(),
            region: None,
            max_width: default_max_width(),
            format: default_format(),
        }
    }
}

/// Geometry of the display a capture was taken from, in physical pixels plus
/// the desktop-space origin of that display.
///
/// `origin_x`/`origin_y` are signed because a display left of or above the
/// primary one has a negative origin in the desktop coordinate space, and the
/// conversion from a desktop coordinate to a display-local one has to know it.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DisplayGeometry {
    pub id: u32,
    pub origin_x: f64,
    pub origin_y: f64,
    pub width_px: u32,
    pub height_px: u32,
    pub scale_factor: f64,
}

impl DisplayGeometry {
    /// The whole display as a rectangle in its own coordinate space.
    pub fn bounds(&self) -> PhysicalRect {
        PhysicalRect {
            x: 0,
            y: 0,
            width: self.width_px,
            height: self.height_px,
        }
    }
}

/// A raw, unencoded framebuffer straight from the OS.
pub struct RawFrame {
    pub width: u32,
    pub height: u32,
    /// `width * height * 4` bytes in the order named by `pixel_format`.
    pub pixels: Vec<u8>,
    pub pixel_format: FramePixelFormat,
}

/// An encoded capture on its way to the frontend.
///
/// `data` is base64 because that is what crosses the IPC boundary: rule 4
/// requires JSON-serializable Rust types, and a byte array would become a
/// `Vec<u8>` in TypeScript rather than the base64 string the provider APIs
/// take.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CapturedFrame {
    pub data: String,
    pub mime_type: String,
    /// Pixel dimensions of `data` as encoded. This is what the model's
    /// coordinates are stated against, and it is NOT the display size whenever
    /// a resize happened.
    pub image_width: u32,
    pub image_height: u32,
    /// Physical pixels of the region captured, before any resize. The display
    /// area a coordinate has to land in.
    pub source_width: u32,
    pub source_height: u32,
    pub display_id: u32,
}

impl CapturedFrame {
    /// Whether the image was resized away from its capture size.
    pub fn was_resized(&self) -> bool {
        self.image_width != self.source_width || self.image_height != self.source_height
    }
}

fn decode_raw(frame: RawFrame) -> Result<RgbaImage, String> {
    let expected = (frame.width as usize)
        .checked_mul(frame.height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "Capture dimensions overflow the addressable range".to_string())?;
    if frame.pixels.len() != expected {
        return Err(format!(
            "Capture buffer holds {} bytes but {}x{} at four bytes per pixel needs {}",
            frame.pixels.len(),
            frame.width,
            frame.height,
            expected
        ));
    }
    if frame.width == 0 || frame.height == 0 {
        return Err("Capture has no pixels".to_string());
    }
    // Both orders are accepted rather than one being assumed, because a
    // capture that is silently in the wrong order is a screen full of swapped
    // red and blue with no error anywhere.
    match frame.pixel_format {
        FramePixelFormat::Rgba => RgbaImage::from_raw(frame.width, frame.height, frame.pixels)
            .ok_or_else(|| "Could not interpret the captured pixels".to_string()),
        FramePixelFormat::Bgra => RgbaImage::from_raw(
            frame.width,
            frame.height,
            frame
                .pixels
                .chunks_exact(4)
                .flat_map(|pixel| [pixel[2], pixel[1], pixel[0], pixel[3]])
                .collect(),
        )
        .ok_or_else(|| "Could not interpret the captured pixels".to_string()),
    }
}

fn encode_jpeg(image: &RgbaImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    // 1..=100 is the range the JPEG spec defines; 0 and anything above 100 is
    // silently rescaled by some encoders and rejected by others, so clamp
    // rather than pass the caller's number straight through.
    let quality = quality.clamp(1, 100);
    // JPEG has no alpha channel, so the format has to be `Rgb8` rather than
    // `Rgba8`. The encoder rejects `Rgba8` with an unsupported-color error
    // rather than ignoring the alpha, so dropping it here is the format the
    // bytes have to be in, not a preference.
    let mut rgb = Vec::with_capacity((image.width() as usize) * (image.height() as usize) * 3);
    for pixel in image.pixels() {
        let [r, g, b, _alpha] = pixel.0;
        rgb.extend_from_slice(&[r, g, b]);
    }
    JpegEncoder::new_with_quality(Cursor::new(&mut out), quality)
        .encode(&rgb, image.width(), image.height(), ExtendedColorType::Rgb8)
        .map_err(|err| format!("Could not encode the screenshot: {err}"))?;
    Ok(out)
}

fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    PngEncoder::new(Cursor::new(&mut out))
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgba8,
        )
        .map_err(|err| format!("Could not encode the screenshot: {err}"))?;
    Ok(out)
}

/// Every display the OS will let us capture, in desktop coordinate space.
///
/// One `cfg` block rather than three copies of the same match, because the
/// per-OS modules expose the same three functions and the mapping from a
/// [`CaptureDisplay`] to one of them is the only thing that differs.
#[cfg(target_os = "linux")]
mod platform {
    pub use super::super::capture_linux as backend;
}
#[cfg(target_os = "macos")]
mod platform {
    pub use super::super::capture_macos as backend;
}
#[cfg(target_os = "windows")]
mod platform {
    pub use super::super::capture_windows as backend;
}
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod platform {
    /// Mobile builds have no screen to capture, and rule 4 keeps the answer in
    /// Rust rather than having every caller ask the platform first.
    pub fn displays() -> Result<Vec<super::DisplayGeometry>, String> {
        Err("Screen capture is not available on this platform".to_string())
    }
    pub fn display_under_cursor() -> Result<super::DisplayGeometry, String> {
        displays()
    }
    pub fn primary_display() -> Result<super::DisplayGeometry, String> {
        displays()
    }
    pub fn capture(_: &super::DisplayGeometry) -> Result<super::RawFrame, String> {
        displays()
    }
    pub fn cursor_position() -> Result<Option<(u32, u32)>, String> {
        Ok(None)
    }
}

/// Where the pointer is, in desktop physical pixels with a top-left origin.
///
/// `Ok(None)` is a real answer on every platform for a different reason: the OS
/// declined to say. Mobile has no pointer, Wayland will not report one, and a
/// compositor may refuse the query.
pub fn cursor_position() -> Result<Option<(u32, u32)>, String> {
    platform::backend::cursor_position()
}

/// Every display the OS will let us capture, in desktop coordinate space.
pub fn displays() -> Result<Vec<DisplayGeometry>, String> {
    platform::backend::displays()
}

/// Geometry of the display a capture would use for `request`.
pub fn selected_display(request: &CaptureRequest) -> Result<DisplayGeometry, String> {
    match request.display {
        CaptureDisplay::Primary => platform::backend::primary_display(),
        CaptureDisplay::UnderCursor => platform::backend::display_under_cursor(),
        CaptureDisplay::Id(id) => platform::backend::displays()?
            .into_iter()
            .find(|display| display.id == id)
            .ok_or_else(|| format!("No display with id {id} is connected")),
    }
}

/// Capture using a caller-chosen display, applying the request's region,
/// width budget and format.
pub fn capture_screen(request: &CaptureRequest) -> Result<CapturedFrame, String> {
    let geometry = selected_display(request)?;
    let raw = platform::backend::capture(&geometry)?;
    finish_capture(
        raw,
        &geometry,
        request.region,
        request.max_width,
        request.format,
    )
}

/// Crop, resize, encode and base64 a raw frame in one step.
pub fn finish_capture(
    frame: RawFrame,
    geometry: &DisplayGeometry,
    requested_region: Option<PhysicalRect>,
    max_width: u32,
    format: CaptureFormat,
) -> Result<CapturedFrame, String> {
    let mut image = decode_raw(frame)?;

    let region = clamp_rect(
        requested_region.unwrap_or_else(|| geometry.bounds()),
        geometry.bounds(),
    );
    if clamp_rect_would_change(
        requested_region.unwrap_or_else(|| geometry.bounds()),
        geometry.bounds(),
    ) {
        log::warn!(
            "Capture region was clamped to the display bounds (display {} is {}x{} physical pixels)",
            geometry.id,
            geometry.width_px,
            geometry.height_px
        );
    }
    if region.width == 0 || region.height == 0 {
        return Err("Capture region is empty".to_string());
    }
    if region.x != 0 || region.y != 0 {
        image = image::imageops::crop_imm(&image, region.x, region.y, region.width, region.height)
            .to_image();
    }

    let source_width = image.width();
    let source_height = image.height();
    let (target_width, target_height) = fit_width(source_width, source_height, max_width);
    if target_width != source_width || target_height != source_height {
        image = image::imageops::resize(
            &image,
            target_width,
            target_height,
            image::imageops::FilterType::Triangle,
        );
    }

    let (bytes, mime_type) = match format {
        CaptureFormat::Jpeg { quality } => (encode_jpeg(&image, quality)?, "image/jpeg"),
        CaptureFormat::Png => (encode_png(&image)?, "image/png"),
    };

    Ok(CapturedFrame {
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime_type: mime_type.to_string(),
        image_width: target_width,
        image_height: target_height,
        source_width,
        source_height,
        display_id: geometry.id,
    })
}

/// Decode and encode a region of an existing capture, for the zoom action.
///
/// Providers that offer a zoom member take it as a rectangle of the image the
/// model was last shown, not of the physical display, so the region arrives
/// stated against `image` and has to be taken from that image before it is
/// scaled back up onto the display.
pub fn zoom_capture(frame: CapturedFrame, region: PhysicalRect) -> Result<CapturedFrame, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&frame.data)
        .map_err(|_| "Could not read back the previous screenshot".to_string())?;
    // The format is sniffed rather than assumed. The previous capture is
    // usually the JPEG an ordinary screenshot produces, and forcing PNG here
    // made every zoom fail on a real run while the PNG-only tests passed.
    let image = image::load_from_memory(&bytes)
        .map_err(|err| format!("Could not read back the previous screenshot: {err}"))?
        .to_rgba8();

    let bounds = PhysicalRect {
        x: 0,
        y: 0,
        width: image.width(),
        height: image.height(),
    };
    let clamped = clamp_rect(region, bounds);
    if clamped != region {
        log::warn!(
            "Zoom region was clamped to the previous screenshot ({}x{} pixels)",
            image.width(),
            image.height()
        );
    }
    if clamped.width == 0 || clamped.height == 0 {
        return Err("Zoom region is empty".to_string());
    }

    // Scale the clamped region from the resized capture back onto the display,
    // so the zoomed image is stated in display pixels and stays there.
    let source = PhysicalRect {
        x: 0,
        y: 0,
        width: frame.source_width,
        height: frame.source_height,
    };
    let display_region = PhysicalRect {
        x: (u64::from(clamped.x) * u64::from(source.width) / u64::from(image.width().max(1)))
            as u32,
        y: (u64::from(clamped.y) * u64::from(source.height) / u64::from(image.height().max(1)))
            as u32,
        width: ((u64::from(clamped.width) * u64::from(source.width))
            / u64::from(image.width().max(1)))
        .max(1) as u32,
        height: ((u64::from(clamped.height) * u64::from(source.height))
            / u64::from(image.height().max(1)))
        .max(1) as u32,
    };
    let display_region = clamp_rect(display_region, source);

    let cropped =
        image::imageops::crop_imm(&image, clamped.x, clamped.y, clamped.width, clamped.height)
            .to_image();
    let encoded = encode_png(&cropped)?;
    Ok(CapturedFrame {
        data: base64::engine::general_purpose::STANDARD.encode(&encoded),
        mime_type: "image/png".to_string(),
        image_width: cropped.width(),
        image_height: cropped.height(),
        source_width: display_region.width,
        source_height: display_region.height,
        display_id: frame.display_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn gradient(width: u32, height: u32, pixel_format: FramePixelFormat) -> RawFrame {
        let mut pixels = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let (r, g, b) = ((x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8);
                match pixel_format {
                    FramePixelFormat::Rgba => pixels.extend_from_slice(&[r, g, b, 255]),
                    FramePixelFormat::Bgra => pixels.extend_from_slice(&[b, g, r, 255]),
                }
            }
        }
        RawFrame {
            width,
            height,
            pixels,
            pixel_format,
        }
    }

    fn geometry() -> DisplayGeometry {
        DisplayGeometry {
            id: 7,
            origin_x: 0.0,
            origin_y: 0.0,
            width_px: 1600,
            height_px: 1000,
            scale_factor: 1.0,
        }
    }

    fn decode_frame(frame: &CapturedFrame) -> RgbaImage {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&frame.data)
            .unwrap();
        image::load_from_memory_with_format(
            &bytes,
            image::ImageFormat::from_extension(frame.mime_type.split('/').nth(1).unwrap()).unwrap(),
        )
        .unwrap()
        .to_rgba8()
    }

    #[test]
    fn captures_a_whole_display_at_the_requested_width() {
        let captured = finish_capture(
            gradient(2560, 1440, FramePixelFormat::Rgba),
            &geometry(),
            None,
            1280,
            CaptureFormat::Jpeg { quality: 80 },
        )
        .unwrap();
        assert_eq!(captured.mime_type, "image/jpeg");
        assert_eq!(captured.image_width, 1280);
        assert_eq!(captured.image_height, 720);
        assert_eq!(captured.source_width, 2560);
        assert_eq!(captured.source_height, 1440);
        assert!(captured.was_resized());
        assert_eq!(decode_frame(&captured).width(), 1280);
    }

    #[test]
    fn reports_the_image_size_separately_from_the_source_size() {
        // The whole point: a provider coordinate is stated against image_width,
        // and clamping it against source_width is off by the resize factor.
        let captured = finish_capture(
            gradient(2000, 1000, FramePixelFormat::Rgba),
            &geometry(),
            None,
            1000,
            CaptureFormat::Png,
        )
        .unwrap();
        assert_eq!(captured.image_width, 1000);
        assert_eq!(captured.source_width, 2000);
    }

    #[test]
    fn bgra_and_rgba_produce_the_same_picture() {
        // A swapped byte order is a screen of wrong colours with no error
        // anywhere, so the two orders must decode to identical pixels.
        let rgba = finish_capture(
            gradient(64, 48, FramePixelFormat::Rgba),
            &geometry(),
            None,
            0,
            CaptureFormat::Png,
        )
        .unwrap();
        let bgra = finish_capture(
            gradient(64, 48, FramePixelFormat::Bgra),
            &geometry(),
            None,
            0,
            CaptureFormat::Png,
        )
        .unwrap();
        assert_eq!(decode_frame(&rgba).as_raw(), decode_frame(&bgra).as_raw());
    }

    #[test]
    fn keeps_the_red_channel_red() {
        let captured = finish_capture(
            RawFrame {
                width: 2,
                height: 2,
                pixels: vec![
                    255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
                ],
                pixel_format: FramePixelFormat::Rgba,
            },
            &DisplayGeometry {
                width_px: 2,
                height_px: 2,
                ..geometry()
            },
            None,
            0,
            CaptureFormat::Png,
        )
        .unwrap();
        assert_eq!(
            decode_frame(&captured).get_pixel(0, 0),
            &Rgba([255, 0, 0, 255])
        );
    }

    #[test]
    fn crops_the_requested_region() {
        let mut pixels = Vec::new();
        for _ in 0..100 {
            pixels.extend_from_slice(&[1, 2, 3, 255]);
        }
        let captured = finish_capture(
            RawFrame {
                width: 10,
                height: 10,
                pixels,
                pixel_format: FramePixelFormat::Rgba,
            },
            &DisplayGeometry {
                width_px: 10,
                height_px: 10,
                ..geometry()
            },
            Some(PhysicalRect {
                x: 2,
                y: 3,
                width: 4,
                height: 5,
            }),
            0,
            CaptureFormat::Png,
        )
        .unwrap();
        assert_eq!(captured.image_width, 4);
        assert_eq!(captured.image_height, 5);
        assert_eq!(captured.source_width, 4);
    }

    #[test]
    fn clamps_a_region_that_runs_off_the_display() {
        let captured = finish_capture(
            gradient(100, 100, FramePixelFormat::Rgba),
            &DisplayGeometry {
                width_px: 100,
                height_px: 100,
                ..geometry()
            },
            Some(PhysicalRect {
                x: 80,
                y: 0,
                width: 50,
                height: 10,
            }),
            0,
            CaptureFormat::Png,
        )
        .unwrap();
        assert_eq!(captured.image_width, 20);
    }

    #[test]
    fn rejects_a_region_that_clamps_to_nothing() {
        let result = finish_capture(
            gradient(100, 100, FramePixelFormat::Rgba),
            &DisplayGeometry {
                width_px: 100,
                height_px: 100,
                ..geometry()
            },
            Some(PhysicalRect {
                x: 500,
                y: 500,
                width: 10,
                height: 10,
            }),
            0,
            CaptureFormat::Png,
        );
        assert!(result.unwrap_err().contains("empty"));
    }

    #[test]
    fn rejects_a_buffer_whose_length_disagrees_with_its_dimensions() {
        // Without this a short buffer is an out-of-bounds read rather than an
        // error, and the failure surfaces as garbage pixels or a panic. 10x10 at
        // four bytes per pixel needs 400 bytes, so a 16-byte buffer is short.
        let result = finish_capture(
            RawFrame {
                width: 10,
                height: 10,
                pixels: vec![0; 16],
                pixel_format: FramePixelFormat::Rgba,
            },
            &geometry(),
            None,
            0,
            CaptureFormat::Png,
        );
        assert!(result.unwrap_err().contains("400"));
    }

    #[test]
    fn rejects_a_zero_sized_capture() {
        let result = finish_capture(
            RawFrame {
                width: 0,
                height: 0,
                pixels: Vec::new(),
                pixel_format: FramePixelFormat::Rgba,
            },
            &geometry(),
            None,
            0,
            CaptureFormat::Png,
        );
        assert!(result.is_err());
    }

    #[test]
    fn a_zoom_of_the_whole_image_keeps_the_source_size() {
        let captured = finish_capture(
            gradient(1600, 1000, FramePixelFormat::Rgba),
            &geometry(),
            None,
            800,
            CaptureFormat::Jpeg { quality: 80 },
        )
        .unwrap();
        let whole_image = PhysicalRect {
            x: 0,
            y: 0,
            width: captured.image_width,
            height: captured.image_height,
        };
        let zoomed = zoom_capture(captured, whole_image).unwrap();
        assert_eq!(zoomed.source_width, 1600);
        assert_eq!(zoomed.source_height, 1000);
        assert_eq!(zoomed.mime_type, "image/png");
    }

    #[test]
    fn a_zoom_of_a_quarter_reports_a_quarter_of_the_source_size() {
        let captured = finish_capture(
            gradient(1600, 1000, FramePixelFormat::Rgba),
            &geometry(),
            None,
            800,
            CaptureFormat::Jpeg { quality: 80 },
        )
        .unwrap();
        let zoomed = zoom_capture(
            captured,
            PhysicalRect {
                x: 0,
                y: 0,
                width: 400,
                height: 250,
            },
        )
        .unwrap();
        assert_eq!(zoomed.source_width, 800);
        assert_eq!(zoomed.source_height, 500);
    }

    #[test]
    fn a_zoom_reports_its_own_image_size_separately() {
        let captured = finish_capture(
            gradient(1600, 1000, FramePixelFormat::Rgba),
            &geometry(),
            None,
            800,
            CaptureFormat::Jpeg { quality: 80 },
        )
        .unwrap();
        let zoomed = zoom_capture(
            captured,
            PhysicalRect {
                x: 100,
                y: 100,
                width: 400,
                height: 250,
            },
        )
        .unwrap();
        assert_eq!(zoomed.image_width, 400);
        assert_eq!(zoomed.image_height, 250);
        // And those two numbers must disagree, or the whole coordinate
        // round-trip is untested.
        assert_ne!(zoomed.image_width, zoomed.source_width);
    }

    #[test]
    fn a_zoom_that_runs_off_the_image_is_clamped_not_rejected() {
        let captured = finish_capture(
            gradient(1600, 1000, FramePixelFormat::Rgba),
            &geometry(),
            None,
            800,
            CaptureFormat::Jpeg { quality: 80 },
        )
        .unwrap();
        // The capture is 800x500 after the resize. This region straddles both
        // the right and the bottom edge and is clamped to the 100x100 corner
        // that exists. A region wholly outside the image is a different case:
        // it clamps to nothing, and saying so beats serving a blank image.
        let zoomed = zoom_capture(
            captured,
            PhysicalRect {
                x: 700,
                y: 400,
                width: 400,
                height: 400,
            },
        )
        .unwrap();
        // The image is stated in the resized capture's pixels, and the source
        // rect is that region scaled back onto the full 1600x1000 capture, so
        // the two differ by exactly the resize factor of 2. Asserting both is
        // what proves the zoom travelled back up rather than just cropping.
        assert_eq!(zoomed.image_width, 100);
        assert_eq!(zoomed.image_height, 100);
        assert_eq!(zoomed.source_width, 200);
        assert_eq!(zoomed.source_height, 200);
    }

    #[test]
    fn a_zoom_entirely_outside_the_image_is_reported_rather_than_served_blank() {
        let captured = finish_capture(
            gradient(1600, 1000, FramePixelFormat::Rgba),
            &geometry(),
            None,
            800,
            CaptureFormat::Jpeg { quality: 80 },
        )
        .unwrap();
        let result = zoom_capture(
            captured,
            PhysicalRect {
                x: 900,
                y: 700,
                width: 100,
                height: 100,
            },
        );
        assert!(result.unwrap_err().contains("empty"));
    }

    #[test]
    fn jpeg_quality_is_clamped_into_the_range_the_encoder_defines() {
        let low = finish_capture(
            gradient(16, 16, FramePixelFormat::Rgba),
            &geometry(),
            None,
            0,
            CaptureFormat::Jpeg { quality: 0 },
        )
        .unwrap();
        let high = finish_capture(
            gradient(16, 16, FramePixelFormat::Rgba),
            &geometry(),
            None,
            0,
            CaptureFormat::Jpeg { quality: 255 },
        )
        .unwrap();
        // Both must encode at all; 0 and 255 are outside 1..=100.
        assert!(!low.data.is_empty());
        assert!(!high.data.is_empty());
    }
}
