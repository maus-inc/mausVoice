//! The parts of the per-platform modules that are not per-platform.
//!
//! Each of `linux/`, `macos/` and `windows/` must keep its own implementation
//! of anything that touches X11, Wayland, Cocoa or Win32, because those calls
//! cannot be shared. What *can* be shared is everything either side of those
//! calls: the placement arithmetic, the capability values, the
//! spawn-and-fallback flow around the pill subprocess, and the rule that turns
//! two permission states into a setup status. Keeping those here is what stops
//! a fix to the rule from having to be made three times.

use crate::domain::{MonitorAtCursor, OverlayAnchor, PermissionState, PermissionStatus};
use crate::pill_process;
use crate::platform::{NativeSetupResult, NativeSetupStatus};

// ── Overlay placement geometry ──────────────────────────────────────────

/// A rectangle in whichever coordinate space the caller is positioning in:
/// logical points on macOS and Linux, physical pixels on Windows.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    /// The part of a monitor that is not covered by a menu bar, dock or other
    /// chrome. This is the area a pill is anchored within.
    pub fn visible_area_of(monitor: &MonitorAtCursor) -> Self {
        Self {
            x: monitor.visible_x,
            y: monitor.visible_y,
            width: monitor.visible_width,
            height: monitor.visible_height,
        }
    }

    /// The same rectangle measured in logical points rather than the physical
    /// pixels Windows reports monitors in. Dividing (rather than multiplying by
    /// a reciprocal) keeps the conversion exact for the `f64` values the
    /// platform hands over.
    pub fn in_logical_points(self, scale_factor: f64) -> Self {
        Self {
            x: self.x / scale_factor,
            y: self.y / scale_factor,
            width: self.width / scale_factor,
            height: self.height / scale_factor,
        }
    }

    /// Whether the point falls inside the rectangle, edges included.
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.width && y >= self.y && y <= self.y + self.height
    }
}

/// The rectangle a `width` x `height` window occupies when pinned to `anchor`
/// inside `visible`, kept `margin` points in from the edge the anchor names.
///
/// This is the whole placement rule and it does not vary by platform: the
/// platforms differ only in the coordinate space their monitor and cursor
/// values arrive in, which the caller converts before calling this.
/// The anchored rectangle for a monitor, and the same bounds used for a
/// hit test. Callers that only differ in how they read the cursor position
/// share this so the placement arithmetic is written once.
pub fn anchored_bounds(
    monitor: &MonitorAtCursor,
    anchor: OverlayAnchor,
    width: f64,
    height: f64,
    margin: f64,
) -> Rect {
    anchor_rect(Rect::visible_area_of(monitor), anchor, width, height, margin)
}

pub fn anchor_rect(
    visible: Rect,
    anchor: OverlayAnchor,
    width: f64,
    height: f64,
    margin: f64,
) -> Rect {
    match anchor {
        OverlayAnchor::BottomCenter => Rect {
            x: visible.x + (visible.width - width) / 2.0,
            y: visible.y + visible.height - height - margin,
            width,
            height,
        },
        OverlayAnchor::TopCenter => Rect {
            x: visible.x + (visible.width - width) / 2.0,
            y: visible.y + margin,
            width,
            height,
        },
        OverlayAnchor::TopRight => Rect {
            x: visible.x + visible.width - width - margin,
            y: visible.y + margin,
            width,
            height,
        },
        OverlayAnchor::TopLeft => Rect {
            x: visible.x + margin,
            y: visible.y + margin,
            width,
            height,
        },
    }
}

// ── Hotkey and capability values ────────────────────────────────────────

/// Strategy for platforms that get global hotkeys from an OS-level listener.
/// `get_hotkey_strategy` for the platforms whose hotkeys are the listener's:
/// every one except Linux on Wayland, which uses the bridge.
pub fn listener_hotkey_strategy() -> &'static str {
    LISTENER_HOTKEY_STRATEGY
}

/// Whether the platform can report which app is frontmost. Every platform this
/// ships on can, so the answer is not a per-platform question.
pub fn supports_app_detection() -> bool {
    true
}

pub const LISTENER_HOTKEY_STRATEGY: &str = "listener";

/// Strategy for Wayland, which has no global hotkey source: input is read
/// through the accessibility bridge instead.
pub const BRIDGE_HOTKEY_STRATEGY: &str = "bridge";

// ── Native setup status ─────────────────────────────────────────────────

/// Whether the user has granted one of the privacy prompts dictation needs.
pub fn permission_authorized(status: Result<PermissionStatus, String>) -> bool {
    matches!(status, Ok(status) if status.state == PermissionState::Authorized)
}

/// Whether dictation's two privacy prompts — microphone and accessibility —
/// are both granted.
///
/// Reads the current platform's `permissions` module, so the checks stay
/// per-platform (TCC on macOS, the Windows privacy settings) while the rule
/// that combines them does not.
pub fn native_setup_permissions_authorized() -> bool {
    permission_authorized(crate::platform::permissions::check_microphone_permission())
        && permission_authorized(crate::platform::permissions::check_accessibility_permission())
}

/// Setup status for a platform that gates only on those two prompts. Anything
/// beyond the prompts themselves means a restart before dictation works.
pub fn native_setup_status() -> NativeSetupStatus {
    if native_setup_permissions_authorized() {
        NativeSetupStatus::Ready
    } else {
        NativeSetupStatus::NeedsSetup
    }
}

/// The same rule for the setup *run*, where the outcome is a result rather
/// than a status: a granted prompt but a stale state still needs a restart.
pub fn native_setup_result() -> NativeSetupResult {
    if native_setup_permissions_authorized() {
        NativeSetupResult::Success
    } else {
        NativeSetupResult::RequireRestart
    }
}

// ── Pill subprocess bridge (Windows, Linux) ─────────────────────────────

/// The notifiers for platforms whose pill runs as a child process.
///
/// macOS links the pill into the app and talks to it over a channel, so its
/// `overlay` module implements its own; these two platforms only differ in
/// which binary they spawn.
pub mod notifications {
    pub use crate::pill_process::{
        notify_assistant_state, notify_audio_levels, notify_phase, notify_pill_placement,
        notify_pill_window_size, notify_request_position, notify_reset_position,
        notify_style_info, notify_visibility,
    };
}

/// The platform-specific half of starting the native pill: which binary to
/// look for, and the log lines that name it.
pub struct PillOverlay {
    /// File name of the pill binary, looked up in the bundle resources.
    pub binary_name: &'static str,
    /// Workspace package that builds the pill, for the dev-tree lookup.
    pub package_dir: &'static str,
    /// Logged when the binary cannot be found.
    pub missing_label: &'static str,
    /// Logged once the pill is running.
    pub active_label: &'static str,
}

/// Resolves the pill binary the same way in a bundle and in a dev checkout:
/// bundled resources first, then the package's own `target/debug`.
pub fn resolve_pill_binary(
    app: &tauri::AppHandle,
    overlay: &PillOverlay,
) -> Option<std::path::PathBuf> {
    pill_process::resolve_pill_binary_in_resources(app, overlay.binary_name).or_else(|| {
        pill_process::resolve_pill_binary_in_dev(overlay.package_dir, overlay.binary_name)
    })
}

/// Spawns the pill subprocess, reporting `false` so the caller can fall back to
/// the Tauri overlays. A missing binary is logged by name rather than panicking:
/// a release build that somehow ships without the sidecar should still run.
pub fn try_spawn_native_overlays(app: &tauri::AppHandle, overlay: &PillOverlay) -> bool {
    let Some(pill_path) = resolve_pill_binary(app, overlay) else {
        log::warn!("{}", overlay.missing_label);
        return false;
    };

    if pill_process::try_spawn_pill(app, &pill_path) {
        log::info!("{}", overlay.active_label);
        true
    } else {
        log::warn!("Native overlay not available, falling back to Tauri overlays");
        false
    }
}
