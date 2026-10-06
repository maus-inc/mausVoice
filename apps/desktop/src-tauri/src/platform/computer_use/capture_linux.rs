//! X11 screen capture.
//!
//! Wayland is deliberately absent. Rule 15 forbids attempting Wayland capture
//! in Phases 1 to 3, and there is no non-portal fallback here: the only way to
//! read a Wayland surface is a portal the user has to approve per capture, so
//! an implementation that silently ignored that would be a privacy bug rather
//! than a missing feature.

use x11::xlib::{
    XCloseDisplay, XDefaultRootWindow, XDefaultScreen, XDestroyImage, XDisplayHeight,
    XDisplayWidth, XGetImage, XOpenDisplay, XQueryPointer, ZPixmap,
};

use super::capture::{DisplayGeometry, FramePixelFormat, RawFrame};

/// Where the pointer is, in desktop pixels.
///
/// `XQueryPointer` against the root window is the direct answer; deriving it
/// from the monitor under the cursor instead would need a second query and
/// would be wrong on a multi-screen X server.
pub fn cursor_position() -> Result<Option<(u32, u32)>, String> {
    if super::super::linux::detect::is_wayland() {
        return Ok(None);
    }
    let display = unsafe { XOpenDisplay(std::ptr::null()) };
    if display.is_null() {
        return Err("Could not connect to the X display".to_string());
    }
    let guard = DisplayGuard { display };
    let root = unsafe { XDefaultRootWindow(guard.display) };
    let mut root_return: u64 = 0;
    let mut child_return: u64 = 0;
    let mut root_x: i32 = 0;
    let mut root_y: i32 = 0;
    let mut win_x: i32 = 0;
    let mut win_y: i32 = 0;
    let mut mask: u32 = 0;
    let ok = unsafe {
        XQueryPointer(
            guard.display,
            root,
            &mut root_return,
            &mut child_return,
            &mut root_x,
            &mut root_y,
            &mut win_x,
            &mut win_y,
            &mut mask,
        )
    } != 0;
    if !ok {
        return Ok(None);
    }
    // A pointer dragged off the left or top edge reports a negative root
    // coordinate, which is a real position rather than an error, so it is
    // clamped to the origin instead of wrapped into four billion.
    Ok(Some((root_x.max(0) as u32, root_y.max(0) as u32)))
}

pub fn displays() -> Result<Vec<DisplayGeometry>, String> {
    // Refuse here for the same reason `capture` does. Under XWayland the
    // connection below succeeds, so without this guard the app would be handed
    // a display list describing a screen it can never capture from.
    if super::super::linux::detect::is_wayland() {
        return Err(
            "Screen capture needs an X11 session. On Wayland, computer use is not available."
                .to_string(),
        );
    }

    let display = unsafe { XOpenDisplay(std::ptr::null()) };
    if display.is_null() {
        return Err("Could not connect to the X display".to_string());
    }
    let screen = unsafe { XDefaultScreen(display) };
    let width = unsafe { XDisplayWidth(display, screen) };
    let height = unsafe { XDisplayHeight(display, screen) };
    unsafe { XCloseDisplay(display) };
    if width <= 0 || height <= 0 {
        return Err("The X display reported no usable size".to_string());
    }
    Ok(vec![DisplayGeometry {
        // X11 screen 0. A multi-screen X server would want a RandR walk; the
        // single-screen case is what every desktop this runs on presents, and
        // a wrong id here is a wrong coordinate space rather than a crash.
        id: screen as u32,
        origin_x: 0.0,
        origin_y: 0.0,
        width_px: width as u32,
        height_px: height as u32,
        scale_factor: 1.0,
    }])
}

pub fn display_under_cursor() -> Result<DisplayGeometry, String> {
    displays()?
        .into_iter()
        .next()
        .ok_or_else(|| "No X display is available".to_string())
}

pub fn primary_display() -> Result<DisplayGeometry, String> {
    display_under_cursor()
}

/// Read the whole screen, or a rectangle of it, off the X server.
///
/// `XGetImage` is the non-shared-memory path. It copies through the X protocol
/// rather than mapping a shared segment, which costs a round trip per capture
/// but needs no MIT-SHM extension and no per-process segment setup, both of
/// which are a common source of capture bugs under compositors.
pub fn capture(geometry: &DisplayGeometry) -> Result<RawFrame, String> {
    if super::super::linux::detect::is_wayland() {
        return Err(
            "Screen capture needs an X11 session. On Wayland, computer use is not available."
                .to_string(),
        );
    }

    let display = unsafe { XOpenDisplay(std::ptr::null()) };
    if display.is_null() {
        return Err("Could not connect to the X display".to_string());
    }
    // Every early return from here on closes the display and frees the image.
    // Leaking either per capture exhausts server resources over a long run.
    let guard = DisplayGuard { display };

    let root = unsafe { XDefaultRootWindow(guard.display) };
    let screen = unsafe { XDefaultScreen(guard.display) };
    let screen_width = unsafe { XDisplayWidth(guard.display, screen) }.max(0) as u32;
    let screen_height = unsafe { XDisplayHeight(guard.display, screen) }.max(0) as u32;

    let width = geometry.width_px.min(screen_width);
    let height = geometry.height_px.min(screen_height);
    if width == 0 || height == 0 {
        return Err("The X display reported no usable size".to_string());
    }

    let image = unsafe {
        XGetImage(
            guard.display,
            root,
            0,
            0,
            // `XGetImage` takes its width and height as `c_uint`; `u32` is the same type
            // on every platform this builds for, so the cast is free and the
            // argument types are named rather than inferred.
            width as std::os::raw::c_uint,
            height as std::os::raw::c_uint,
            // AllPlanes: which planes to read. The X server offers 32 bits per
            // pixel and there is nothing to mask off.
            u64::MAX,
            ZPixmap,
        )
    };
    if image.is_null() {
        return Err("The X server refused to return the screen contents".to_string());
    }
    let image_guard = ImageGuard { image };

    let info = unsafe { &*image_guard.image };
    if info.bits_per_pixel != 32 {
        return Err(format!(
            "Screen capture needs 32 bits per pixel; the X server offered {}",
            info.bits_per_pixel
        ));
    }
    let stride = info.bytes_per_line;
    if stride <= 0 {
        return Err("The X server returned an image with no row stride".to_string());
    }
    let row_bytes = (width as usize) * 4;
    let stride = stride as usize;
    let height = height as usize;

    let mut pixels = Vec::with_capacity(row_bytes * height);
    let data = info.data as *const u8;
    for row in 0..height {
        let start = row * stride;
        // Read exactly one row of pixels rather than a whole stride: the
        // padding X inserts between rows is not part of the image, and
        // including it shifts every row after the first.
        let slice = unsafe { std::slice::from_raw_parts(data.add(start), row_bytes) };
        pixels.extend_from_slice(slice);
    }

    Ok(RawFrame {
        width,
        height: height as u32,
        pixels,
        pixel_format: FramePixelFormat::Rgba,
    })
}

struct DisplayGuard {
    display: *mut x11::xlib::Display,
}

impl Drop for DisplayGuard {
    fn drop(&mut self) {
        if !self.display.is_null() {
            unsafe { XCloseDisplay(self.display) };
        }
    }
}

struct ImageGuard {
    image: *mut x11::xlib::XImage,
}

impl Drop for ImageGuard {
    fn drop(&mut self) {
        if !self.image.is_null() {
            unsafe { XDestroyImage(self.image) };
        }
    }
}
