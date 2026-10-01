use super::detect;

/// Session-type variable consulted when `WAYLAND_DISPLAY` is unset.
pub const ENV_XDG_SESSION_TYPE: &str = "XDG_SESSION_TYPE";
/// Set when the session runs under Wayland; takes precedence over
/// `XDG_SESSION_TYPE`.
pub const ENV_WAYLAND_DISPLAY: &str = "WAYLAND_DISPLAY";
/// Set to `1` on X11 to force WebKitGTK off its accelerated compositor.
pub const ENV_WEBKIT_DISABLE_COMPOSITING_MODE: &str = "WEBKIT_DISABLE_COMPOSITING_MODE";
/// Set to `1` on X11 to avoid the DMABUF renderer path that blanks the
/// window on some drivers (#274).
pub const ENV_WEBKIT_DISABLE_DMABUF_RENDERER: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

/// True when the session looks like X11 rather than Wayland. Defaults to
/// true when nothing conclusive is set, matching WebKitGTK behaviour.
///
/// Only a value that names Wayland turns this off. A display server that
/// logs in over a bare TTY and then starts X leaves `XDG_SESSION_TYPE` at
/// `tty` (or `mir`, or anything else the launcher invented), and reading an
/// unrecognised value as "not X11" skipped the workarounds on exactly the
/// sessions #274 was reported from, leaving the window blank.
pub fn is_x11_session() -> bool {
    if detect::is_wayland() {
        return false;
    }
    match std::env::var(ENV_XDG_SESSION_TYPE) {
        Ok(value) => !value.eq_ignore_ascii_case("wayland"),
        Err(_) => true,
    }
}

/// Sets the WebKitGTK workarounds on X11 unless the user already provided
/// their own value, then returns. No-op on Wayland.
pub fn apply_webkit_workarounds() {
    if !is_x11_session() {
        return;
    }
    if std::env::var(ENV_WEBKIT_DISABLE_COMPOSITING_MODE).is_err() {
        std::env::set_var(ENV_WEBKIT_DISABLE_COMPOSITING_MODE, "1");
    }
    if std::env::var(ENV_WEBKIT_DISABLE_DMABUF_RENDERER).is_err() {
        std::env::set_var(ENV_WEBKIT_DISABLE_DMABUF_RENDERER, "1");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_webkit_workarounds, ENV_WEBKIT_DISABLE_COMPOSITING_MODE,
        ENV_WEBKIT_DISABLE_DMABUF_RENDERER, ENV_XDG_SESSION_TYPE,
    };
    use std::env;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn clear_webkit_env() {
        env::remove_var(ENV_WEBKIT_DISABLE_COMPOSITING_MODE);
        env::remove_var(ENV_WEBKIT_DISABLE_DMABUF_RENDERER);
        env::remove_var(ENV_XDG_SESSION_TYPE);
        env::remove_var(super::ENV_WAYLAND_DISPLAY);
    }

    #[test]
    fn sets_both_vars_on_x11() {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        clear_webkit_env();
        env::set_var(ENV_XDG_SESSION_TYPE, "x11");
        env::remove_var(super::ENV_WAYLAND_DISPLAY);

        apply_webkit_workarounds();

        assert_eq!(env::var(ENV_WEBKIT_DISABLE_COMPOSITING_MODE).unwrap(), "1");
        assert_eq!(env::var(ENV_WEBKIT_DISABLE_DMABUF_RENDERER).unwrap(), "1");

        clear_webkit_env();
    }

    #[test]
    fn skips_on_wayland() {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        clear_webkit_env();
        env::remove_var(ENV_XDG_SESSION_TYPE);
        env::set_var(super::ENV_WAYLAND_DISPLAY, "wayland-0");

        apply_webkit_workarounds();

        assert!(env::var(ENV_WEBKIT_DISABLE_COMPOSITING_MODE).is_err());
        assert!(env::var(ENV_WEBKIT_DISABLE_DMABUF_RENDERER).is_err());

        clear_webkit_env();
    }

    #[test]
    fn skips_on_explicit_xdg_session_type_wayland() {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        clear_webkit_env();
        env::set_var(ENV_XDG_SESSION_TYPE, "wayland");
        env::remove_var(super::ENV_WAYLAND_DISPLAY);

        apply_webkit_workarounds();

        assert!(env::var(ENV_WEBKIT_DISABLE_COMPOSITING_MODE).is_err());
        assert!(env::var(ENV_WEBKIT_DISABLE_DMABUF_RENDERER).is_err());

        clear_webkit_env();
    }

    /// A session that logs in over a TTY and starts X afterwards reports
    /// `XDG_SESSION_TYPE=tty` with no `WAYLAND_DISPLAY`. Nothing in that
    /// names Wayland, so the session is X11 and the #274 workarounds apply.
    /// Reading any value other than a literal `x11` as "not X11" skipped
    /// them, which is what left the window blank.
    #[test]
    fn applies_on_an_unrecognized_session_type_with_no_wayland_display() {
        for session_type in ["tty", "mir", "x11", "XORG"] {
            let _guard = ENV_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            clear_webkit_env();
            env::set_var(ENV_XDG_SESSION_TYPE, session_type);
            env::remove_var(super::ENV_WAYLAND_DISPLAY);

            apply_webkit_workarounds();

            assert_eq!(
                env::var(ENV_WEBKIT_DISABLE_COMPOSITING_MODE).unwrap(),
                "1",
                "XDG_SESSION_TYPE={session_type} names no Wayland session"
            );
            assert_eq!(
                env::var(ENV_WEBKIT_DISABLE_DMABUF_RENDERER).unwrap(),
                "1",
                "XDG_SESSION_TYPE={session_type} names no Wayland session"
            );

            clear_webkit_env();
        }
    }

    #[test]
    fn does_not_overwrite_existing_user_value() {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        clear_webkit_env();
        env::set_var(ENV_XDG_SESSION_TYPE, "x11");
        env::remove_var(super::ENV_WAYLAND_DISPLAY);
        env::set_var(ENV_WEBKIT_DISABLE_COMPOSITING_MODE, "0");

        apply_webkit_workarounds();

        assert_eq!(env::var(ENV_WEBKIT_DISABLE_COMPOSITING_MODE).unwrap(), "0");
        assert_eq!(env::var(ENV_WEBKIT_DISABLE_DMABUF_RENDERER).unwrap(), "1");

        clear_webkit_env();
    }
}
