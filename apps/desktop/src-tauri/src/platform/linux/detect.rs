use super::launch_env::ENV_WAYLAND_DISPLAY;

pub fn is_wayland() -> bool {
    std::env::var(ENV_WAYLAND_DISPLAY).is_ok()
}
