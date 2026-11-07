use crate::domain::{MonitorAtCursor, OverlayAnchor};
use crate::platform::common::anchored_bounds;
use tauri::WebviewWindow;

pub fn set_overlay_position(
    window: &WebviewWindow,
    monitor: &MonitorAtCursor,
    anchor: OverlayAnchor,
    window_width: f64,
    window_height: f64,
    margin: f64,
) {
    // GDK returns coordinates in logical (application) pixels already,
    // so we use them directly without dividing by scale
    let target = anchored_bounds(monitor, anchor, window_width, window_height, margin);

    let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
        target.x, target.y,
    )));
}

pub fn is_cursor_in_bounds(
    monitor: &MonitorAtCursor,
    anchor: OverlayAnchor,
    bounds_width: f64,
    bounds_height: f64,
    margin: f64,
) -> bool {
    let bounds = anchored_bounds(monitor, anchor, bounds_width, bounds_height, margin);

    // GDK cursor coordinates are also in logical pixels
    bounds.contains(monitor.cursor_x, monitor.cursor_y)
}
