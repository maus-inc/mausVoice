//! Embedded Satoshi — the only typeface the pill uses.
//!
//! Compiled into the binary via `include_bytes!`. No system-font fallbacks.

use std::ffi::c_void;
use std::sync::OnceLock;

use cocoa::base::{id, nil};
use cocoa::foundation::NSString;
use objc::runtime::Object;
use objc::{class, msg_send, sel, sel_impl};

const SATOSHI_MEDIUM_TTF: &[u8] = include_bytes!("../fonts/Satoshi-Medium.ttf");

static REGISTERED: OnceLock<()> = OnceLock::new();

/// Register the embedded Satoshi face with Core Text for this process.
pub fn install_embedded_satoshi() {
    REGISTERED.get_or_init(|| {
        let dir = std::env::temp_dir().join("mausvoice-fonts");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("Satoshi-Medium.ttf");
        std::fs::write(&path, SATOSHI_MEDIUM_TTF)
            .unwrap_or_else(|e| panic!("failed to materialize embedded Satoshi: {e}"));

        unsafe {
            // CTFontManagerRegisterFontsForURL
            extern "C" {
                fn CFURLCreateFromFileSystemRepresentation(
                    allocator: *const c_void,
                    buffer: *const u8,
                    buf_len: isize,
                    is_directory: u8,
                ) -> *const c_void;
                fn CTFontManagerRegisterFontsForURL(
                    font_url: *const c_void,
                    scope: u32, // kCTFontManagerScopeProcess = 1
                    error: *mut *const c_void,
                ) -> u8;
                fn CFRelease(cf: *const c_void);
            }

            let path_str = path.to_string_lossy();
            let bytes = path_str.as_bytes();
            let url = CFURLCreateFromFileSystemRepresentation(
                std::ptr::null(),
                bytes.as_ptr(),
                bytes.len() as isize,
                0,
            );
            if url.is_null() {
                panic!("CFURLCreateFromFileSystemRepresentation failed for Satoshi");
            }
            let mut err: *const c_void = std::ptr::null();
            let ok = CTFontManagerRegisterFontsForURL(url, 1, &mut err);
            CFRelease(url);
            if ok == 0 {
                panic!("CTFontManagerRegisterFontsForURL failed to register embedded Satoshi");
            }
        }
    });
}

/// Return an NSFont for the embedded Satoshi face. Panics if unavailable.
pub fn satoshi_font(size: f64, bold: bool) -> id {
    install_embedded_satoshi();
    unsafe {
        // Prefer the real PostScript / full name; fall back across known tags.
        let names: &[&str] = if bold {
            // Medium is the only face shipped; request Bold and accept synthesis
            // only if the named face is missing — still from the Satoshi family.
            &[
                "Satoshi-Bold",
                "Satoshi Bold",
                "Satoshi-Medium",
                "Satoshi Medium",
                "Satoshi",
            ]
        } else {
            &[
                "Satoshi-Medium",
                "Satoshi Medium",
                "Satoshi-Regular",
                "Satoshi",
            ]
        };
        for name in names {
            let ns_name: id = NSString::alloc(nil).init_str(name);
            let font: id = msg_send![class!(NSFont), fontWithName:ns_name size:size];
            if font != nil {
                return font;
            }
        }
        panic!("embedded Satoshi is registered but NSFont cannot resolve it");
    }
}
