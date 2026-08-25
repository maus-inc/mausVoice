use super::detect;

pub fn is_x11_session() -> bool {
    if detect::is_wayland() {
        return false;
    }
    match std::env::var("XDG_SESSION_TYPE") {
        Ok(value) => value.eq_ignore_ascii_case("x11"),
        Err(_) => true,
    }
}

pub fn apply_webkit_workarounds() {
    if !is_x11_session() {
        return;
    }
    if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
    if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

#[cfg(test)]
mod tests {
    use super::apply_webkit_workarounds;
    use std::env;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn clear_webkit_env() {
        env::remove_var("WEBKIT_DISABLE_COMPOSITING_MODE");
        env::remove_var("WEBKIT_DISABLE_DMABUF_RENDERER");
        env::remove_var("XDG_SESSION_TYPE");
        env::remove_var("WAYLAND_DISPLAY");
    }

    #[test]
    fn sets_both_vars_on_x11() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_webkit_env();
        env::set_var("XDG_SESSION_TYPE", "x11");
        env::remove_var("WAYLAND_DISPLAY");

        apply_webkit_workarounds();

        assert_eq!(env::var("WEBKIT_DISABLE_COMPOSITING_MODE").unwrap(), "1");
        assert_eq!(env::var("WEBKIT_DISABLE_DMABUF_RENDERER").unwrap(), "1");

        clear_webkit_env();
    }

    #[test]
    fn skips_on_wayland() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_webkit_env();
        env::remove_var("XDG_SESSION_TYPE");
        env::set_var("WAYLAND_DISPLAY", "wayland-0");

        apply_webkit_workarounds();

        assert!(env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err());
        assert!(env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err());

        clear_webkit_env();
    }

    #[test]
    fn skips_on_explicit_xdg_session_type_wayland() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_webkit_env();
        env::set_var("XDG_SESSION_TYPE", "wayland");
        env::remove_var("WAYLAND_DISPLAY");

        apply_webkit_workarounds();

        assert!(env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err());
        assert!(env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err());

        clear_webkit_env();
    }

    #[test]
    fn does_not_overwrite_existing_user_value() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_webkit_env();
        env::set_var("XDG_SESSION_TYPE", "x11");
        env::remove_var("WAYLAND_DISPLAY");
        env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "0");

        apply_webkit_workarounds();

        assert_eq!(env::var("WEBKIT_DISABLE_COMPOSITING_MODE").unwrap(), "0");
        assert_eq!(env::var("WEBKIT_DISABLE_DMABUF_RENDERER").unwrap(), "1");

        clear_webkit_env();
    }
}
