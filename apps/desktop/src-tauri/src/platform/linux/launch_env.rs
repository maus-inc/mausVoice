use super::detect;

/// Session-type variable consulted when `WAYLAND_DISPLAY` is unset.
/// Set when the session runs under Wayland; takes precedence over
/// `XDG_SESSION_TYPE`.
pub const ENV_WAYLAND_DISPLAY: &str = "WAYLAND_DISPLAY";
pub const ENV_XDG_SESSION_TYPE
/// Set to `1` on X11 to force WebKitGTK off its accelerated compositor.
pub const ENV_WEBKIT_DISABLE_COMPOSITING_MODE: &str = "WEBKIT_DISABLE_COMPOSITING_MODE";
/// Set to `1` on X11 to avoid the DMABUF renderer path that blanks the
/// window on some drivers (#274).
pub const ENV_WEBKIT_DISABLE_DMABUF_RENDERER: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

/// True when the session looks like X11 rather than Wayland. Defaults to
/// true when nothing conclusive is set, matching WebKitGTK behaviour.
pub fn is_x11_session() -> bool {
    if detect::is_wayland() {
        return false;
    }
    match std::env::var(ENV_XDG_SESSION_TYPE) {
        Ok(value) => value.eq_ignore_ascii_case("x11"),
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
        let _guard = ENV_LOCK.lock().unwrap();
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
        let _guard = ENV_LOCK.lock().unwrap();
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
        let _guard = ENV_LOCK.lock().unwrap();
        clear_webkit_env();
        env::set_var(ENV_XDG_SESSION_TYPE, "wayland");
        env::remove_var(super::ENV_WAYLAND_DISPLAY);

        apply_webkit_workarounds();

        assert!(env::var(ENV_WEBKIT_DISABLE_COMPOSITING_MODE).is_err());
        assert!(env::var(ENV_WEBKIT_DISABLE_DMABUF_RENDERER).is_err());

        clear_webkit_env();
    }

    #[test]
    fn does_not_overwrite_existing_user_value() {
        let _guard = ENV_LOCK.lock().unwrap();
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
