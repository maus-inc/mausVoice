pub fn configure_display_backend() {
    if std::env::var("GDK_BACKEND").is_ok() {
        return;
    }
    if std::env::var("WAYLAND_DISPLAY").is_ok() {
        // SAFETY: called once at process startup before other threads exist.
        // `set_var` is unsafe since 1.87; older rustc still treats this as safe.
        #[allow(unused_unsafe)]
        unsafe {
            std::env::set_var("GDK_BACKEND", "wayland");
        }
    }
}
