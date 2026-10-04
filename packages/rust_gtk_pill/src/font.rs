//! Embedded Satoshi — the only typeface the pill uses.

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::sync::OnceLock;

// Fontconfig FFI.
//
// `FcConfigAppFontAddFile` takes a NULLABLE config: NULL means "the current config", which
// fontconfig creates on demand and which is the one Pango and Cairo actually resolve fonts
// through. Nothing here owns a config, so there is nothing to free.
extern "C" {
    fn FcConfigAppFontAddFile(config: *mut std::ffi::c_void, file: *const std::ffi::c_char) -> i32;
}

const SATOSHI_MEDIUM_TTF: &[u8] = include_bytes!("../fonts/Satoshi-Medium.ttf");

static FONT_PATH: OnceLock<std::path::PathBuf> = OnceLock::new();

/// Materialize and register Satoshi with fontconfig for this process.
pub fn install_embedded_satoshi() {
    FONT_PATH.get_or_init(|| {
        let dir = std::env::temp_dir().join("mausvoice-fonts");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("Satoshi-Medium.ttf");
        std::fs::write(&path, SATOSHI_MEDIUM_TTF)
            .unwrap_or_else(|e| panic!("failed to materialize embedded Satoshi: {e}"));

        // FcConfigAppFontAddFile via fontconfig through cairo/pango path:
        // set FONTCONFIG_FILE or use FcConfigAppFontAddFile via dlopen-free approach:
        // write a tiny fonts.conf that only includes our file and point FONTCONFIG_PATH.
        let conf = dir.join("fonts.conf");
        let conf_body = format!(
            r#"<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>{dir}</dir>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
</fontconfig>
"#,
            dir = dir.display()
        );
        let _ = std::fs::write(&conf, conf_body);
        // Prefer prepending our dir via FONTCONFIG_PATH so "Satoshi" resolves first.
        // Do not remove system config entirely (cairo may need defaults), but our
        // face is still the only one we select by family name.
        let prev = std::env::var_os("FONTCONFIG_PATH");
        let mut paths = vec![dir.display().to_string()];
        if let Some(p) = prev {
            paths.push(p.to_string_lossy().into_owned());
        }
        // SAFETY: font setup runs on the GTK thread before workers start.
        // `set_var` is unsafe since 1.87; older rustc still treats it as safe.
        #[allow(unused_unsafe)]
        unsafe {
            std::env::set_var("FONTCONFIG_PATH", paths.join(":"));
        }

        // Register Satoshi with fontconfig itself, AFTER FONTCONFIG_PATH is set.
        //
        // This used to call `FcInitLoadConfigAndFonts()` and register against the config it
        // returned. That call creates a NEW config and returns it; it does not install it as
        // the current one. So the app font was added to a config no renderer ever read, and
        // the registration had no effect — Satoshi resolved only because of the
        // `FONTCONFIG_PATH` set immediately below it. The returned config was also never freed
        // (the old comment claimed fontconfig owned it; the caller does), and building it
        // meant scanning every system font at startup for nothing.
        //
        // NULL means "the current config", and doing this after FONTCONFIG_PATH means the
        // config fontconfig creates on demand already has our directory prepended. Runs once,
        // before GTK initializes Pango's font database.
        let bytes = path.as_os_str().as_bytes();
        if bytes.contains(&0) {
            rust_pill_shared::log_font_error("Satoshi path contains interior null bytes — cannot build C string");
        } else {
            match CString::new(bytes) {
                Ok(c_path) => {
                    let ok = unsafe {
                        FcConfigAppFontAddFile(std::ptr::null_mut(), c_path.as_ptr())
                    };
                    if ok == 0 {
                        rust_pill_shared::log_font_error("FcConfigAppFontAddFile returned false for Satoshi (may fall back to system font)");
                    }
                }
                Err(_) => {
                    rust_pill_shared::log_font_error("CString::new failed for Satoshi path — encoding issue");
                }
            }
        }
        path
    });
}
