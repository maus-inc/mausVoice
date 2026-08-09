//! Embedded Satoshi — the only typeface the pill uses.
//!
//! Compiled into the binary via `include_bytes!`. No system-font fallbacks.

use std::path::PathBuf;
use std::sync::OnceLock;

use windows::core::*;
use windows::Win32::Graphics::DirectWrite::*;
use windows::Win32::Graphics::Gdi::*;

const SATOSHI_MEDIUM_TTF: &[u8] = include_bytes!("../fonts/Satoshi-Medium.ttf");

static FONT_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Write the embedded TTF into a private temp path and register it with GDI so
/// DirectWrite resolves the family name `"Satoshi"` inside this process only.
pub fn install_embedded_satoshi() {
    FONT_PATH.get_or_init(|| {
        let dir = std::env::temp_dir().join("mausvoice-fonts");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("Satoshi-Medium.ttf");
        std::fs::write(&path, SATOSHI_MEDIUM_TTF)
            .unwrap_or_else(|e| panic!("failed to materialize embedded Satoshi: {e}"));

        let wide: Vec<u16> = path
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            let added = AddFontResourceExW(
                PCWSTR(wide.as_ptr()),
                FR_PRIVATE,
                None,
            );
            if added == 0 {
                panic!("failed to register embedded Satoshi with GDI");
            }
        }
        path
    });
}

/// Always-Satoshi text format. Panics if the embedded face cannot be used.
pub fn create_text_format(
    factory: &IDWriteFactory,
    size: f32,
    bold: bool,
    italic: bool,
) -> IDWriteTextFormat {
    install_embedded_satoshi();
    let weight = if bold {
        DWRITE_FONT_WEIGHT_BOLD
    } else {
        DWRITE_FONT_WEIGHT(500) // Medium
    };
    let style = if italic {
        DWRITE_FONT_STYLE_ITALIC
    } else {
        DWRITE_FONT_STYLE_NORMAL
    };
    unsafe {
        factory
            .CreateTextFormat(
                w!("Satoshi"),
                None,
                weight,
                style,
                DWRITE_FONT_STRETCH_NORMAL,
                size,
                w!("en-us"),
            )
            .unwrap_or_else(|e| panic!("embedded Satoshi unavailable to DirectWrite: {e}"))
    }
}
