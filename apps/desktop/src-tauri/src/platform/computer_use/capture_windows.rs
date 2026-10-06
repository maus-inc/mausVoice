//! Windows screen capture through GDI.
//!
//! `BitBlt` out of the desktop device context into a top-down 32-bit DIB. GDI
//! rather than DXGI: DXGI desktop duplication needs a device that supports it
//! and gives up on some remote and hybrid-GPU setups, whereas `BitBlt` from
//! `GetDC(None)` works on every Windows desktop and is the path the
//! accessibility code in this crate already reaches for.

use std::ptr;

use windows::Win32::Foundation::{BOOL, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, EnumDisplayMonitors,
    GetDC, GetMonitorInfoW, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
    HDC, MONITORENUMPROC, MONITORINFO, MONITOR_DEFAULTTONEAREST, SRCCOPY,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, MonitorFromPoint};

use super::capture::{DisplayGeometry, FramePixelFormat, RawFrame};

/// Monitors collected during `EnumDisplayMonitors`, which is a callback API.
///
/// The callback has no return value that can carry state, so the collection
/// rides along in the `dwdata` pointer. A `Vec` that panicked here would unwind
/// across the FFI boundary, which is undefined behaviour, so the callback
/// returns FALSE on any failure instead.
struct MonitorCollector {
    geometries: Vec<DisplayGeometry>,
}

pub fn displays() -> Result<Vec<DisplayGeometry>, String> {
    let mut collector = MonitorCollector {
        geometries: Vec::new(),
    };
    unsafe {
        EnumDisplayMonitors(
            None,
            None,
            collect_monitor,
            LPARAM(&mut collector as *mut MonitorCollector as isize),
        );
    }
    if collector.geometries.is_empty() {
        return Err("Windows reported no attached displays".to_string());
    }
    Ok(collector.geometries)
}

unsafe extern "system" fn collect_monitor(
    monitor: windows::Win32::Graphics::Gdi::HMONITOR,
    _dc: HDC,
    _rect: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let collector = &mut *(data.0 as *mut MonitorCollector);
    if let Some(geometry) = geometry_for(monitor) {
        collector.geometries.push(geometry);
    }
    TRUE
}

unsafe fn geometry_for(
    monitor: windows::Win32::Graphics::Gdi::HMONITOR,
) -> Option<DisplayGeometry> {
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !GetMonitorInfoW(monitor, &mut info).as_bool() {
        return None;
    }
    let frame = info.rcMonitor;
    let mut dpi_x: u32 = 96;
    let mut dpi_y: u32 = 96;
    let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
    Some(DisplayGeometry {
        // HMONITOR is a handle, not an index, so it is not usable as a stable
        // id across calls. The virtual-desktop origin is unique per monitor in
        // practice and is what a caller would compare against, so the handle's
        // low bits go in and nothing depends on it being the same next time.
        id: monitor.0 as u32,
        origin_x: f64::from(frame.left),
        origin_y: f64::from(frame.top),
        width_px: (frame.right - frame.left).max(0) as u32,
        height_px: (frame.bottom - frame.top).max(0) as u32,
        scale_factor: f64::from(dpi_x) / 96.0,
    })
}

pub fn display_under_cursor() -> Result<DisplayGeometry, String> {
    unsafe {
        let mut cursor = windows::Win32::Foundation::POINT::default();
        if GetCursorPos(&mut cursor).is_err() {
            return primary_display();
        }
        let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
        match geometry_for(monitor) {
            Some(geometry) => Ok(geometry),
            None => primary_display(),
        }
    }
}

pub fn primary_display() -> Result<DisplayGeometry, String> {
    unsafe {
        // `None` as the window handle asks for the primary monitor.
        let monitor = MonitorFromPoint(
            windows::Win32::Foundation::POINT::default(),
            windows::Win32::Graphics::Gdi::MONITOR_DEFAULTTOPRIMARY,
        );
        geometry_for(monitor).ok_or_else(|| "Windows reported no primary display".to_string())
    }
}

/// Where the pointer is, in virtual-desktop physical pixels with a top-left
/// origin.
///
/// `GetCursorPos` already reports that exact space, so no conversion is needed:
/// the same `POINT` that `display_under_cursor` passes to `MonitorFromPoint` is
/// the answer.
pub fn cursor_position() -> Result<Option<(u32, u32)>, String> {
    unsafe {
        let mut cursor = windows::Win32::Foundation::POINT::default();
        if GetCursorPos(&mut cursor).is_err() {
            return Ok(None);
        }
        // A pointer on a display left of or above the primary one has a
        // negative virtual-desktop coordinate, which is a real position.
        if cursor.x < 0 || cursor.y < 0 {
            return Ok(Some((0, 0)));
        }
        Ok(Some((cursor.x as u32, cursor.y as u32)))
    }
}

/// Owns the GDI objects a capture creates and releases them in the reverse of
/// the order Windows requires.
///
/// Each of these is a per-process resource. A long agent run captures
/// hundreds of times, and leaking a DC or a bitmap per capture exhausts the
/// process's GDI quota after a few hundred, at which point every other part of
/// the app that draws stops working too.
struct CaptureResources {
    screen_dc: HDC,
    memory_dc: HDC,
    previous: windows::Win32::Graphics::Gdi::HGDIOBJ,
    bitmap: windows::Win32::Graphics::Gdi::HBITMAP,
    buffer: *mut core::ffi::c_void,
}

impl Drop for CaptureResources {
    fn drop(&mut self) {
        unsafe {
            if !self.previous.is_invalid() {
                SelectObject(self.memory_dc, self.previous);
            }
            if !self.bitmap.is_invalid() {
                DeleteObject(self.bitmap.into());
            }
            if !self.memory_dc.is_invalid() {
                DeleteDC(self.memory_dc);
            }
            if !self.screen_dc.is_invalid() {
                ReleaseDC(None, self.screen_dc);
            }
        }
    }
}

pub fn capture(geometry: &DisplayGeometry) -> Result<RawFrame, String> {
    let width = i32::try_from(geometry.width_px)
        .map_err(|_| "The display is too wide to capture".to_string())?;
    let height = i32::try_from(geometry.height_px)
        .map_err(|_| "The display is too tall to capture".to_string())?;
    if width <= 0 || height <= 0 {
        return Err("The display reported no usable size".to_string());
    }

    unsafe {
        // No window handle gives the whole desktop, which is what a
        // per-display capture wants to read from: the source rectangle is
        // chosen below, not the DC. `None` is the null handle.
        let screen_dc = GetDC(None);
        if screen_dc.is_invalid() {
            return Err("Windows would not hand out a screen device context".to_string());
        }
        let memory_dc = CreateCompatibleDC(Some(screen_dc));
        if memory_dc.is_invalid() {
            ReleaseDC(None, screen_dc);
            return Err("Windows would not create an offscreen device context".to_string());
        }

        // A top-down DIB (negative height) so row 0 is the top of the screen.
        // The default bottom-up layout would hand back an upside-down capture
        // that looks entirely plausible.
        let header = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0,
            ..Default::default()
        };
        let mut info = BITMAPINFO {
            bmiHeader: header,
            ..Default::default()
        };
        let mut buffer: *mut core::ffi::c_void = ptr::null_mut();
        let bitmap = CreateDIBSection(
            Some(memory_dc),
            &mut info,
            DIB_RGB_COLORS,
            &mut buffer,
            None,
            0,
        )
        .map_err(|err| format!("Windows would not create a 32-bit bitmap: {err}"))?;
        let previous = SelectObject(memory_dc, bitmap.into());
        let resources = CaptureResources {
            screen_dc,
            memory_dc,
            previous,
            bitmap,
            buffer,
        };

        let copied = BitBlt(
            resources.memory_dc,
            0,
            0,
            width,
            height,
            Some(resources.screen_dc),
            geometry.origin_x as i32,
            geometry.origin_y as i32,
            SRCCOPY,
        );
        if let Err(err) = copied {
            return Err(format!(
                "Windows could not copy the screen into an image: {err}"
            ));
        }

        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| "The display size overflows the addressable range".to_string())?;
        if resources.buffer.is_null() {
            return Err("Windows returned an image with no pixels".to_string());
        }
        let mut pixels =
            std::slice::from_raw_parts(resources.buffer as *const u8, expected).to_vec();
        // GDI's 32-bit DIB is BGRA in memory, and its high byte is not part of
        // the format: the blt does not define it and the allocation does not
        // promise to clear it. Forwarding it as alpha would let an
        // undocumented byte decide the transparency of every screenshot sent to
        // a model, so it is set opaque here instead.
        for pixel in pixels.chunks_exact_mut(4) {
            pixel[3] = 0xFF;
        }

        Ok(RawFrame {
            width: width as u32,
            height: height as u32,
            pixels,
            pixel_format: FramePixelFormat::Bgra,
        })
    }
}
