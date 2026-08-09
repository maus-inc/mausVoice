//! Embedded Satoshi — the only typeface the pill uses.

use std::sync::OnceLock;

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
        // SAFETY: single-threaded at startup before GTK font use.
        unsafe {
            std::env::set_var("FONTCONFIG_PATH", paths.join(":"));
        }
        path
    });
}

pub const FAMILY: &str = "Satoshi";
