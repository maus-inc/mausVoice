use crate::domain::{MonitorAtCursor, OverlayAnchor};
use crate::platform::common::{anchor_rect, Rect};
use tauri::WebviewWindow;

pub fn set_overlay_position(
    window: &WebviewWindow,
    monitor: &MonitorAtCursor,
    anchor: OverlayAnchor,
    window_width: f64,
    window_height: f64,
    margin: f64,
) {
    // macOS monitor.rs already converts visible_y to standard coordinates:
    // visible_y = top inset (e.g., menu bar height)
    // visible_height = usable height
    //
    // For macOS, we use LogicalPosition with coordinates relative to the
    // monitor's frame, and Tauri handles the platform-specific conversion.
    let target = anchor_rect(
        Rect::visible_area_of(monitor),
        anchor,
        window_width,
        window_height,
        margin,
    );

    // macOS uses LogicalPosition - Tauri handles the coordinate conversion
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
    let bounds = anchor_rect(
        Rect::visible_area_of(monitor),
        anchor,
        bounds_width,
        bounds_height,
        margin,
    );

    // macOS cursor coordinates are in Cocoa system (Y=0 at bottom)
    // Convert to standard coordinates (Y=0 at top) to match bounds position
    let cursor_x = monitor.cursor_x;
    let cursor_y = monitor.height - monitor.cursor_y;

    bounds.contains(cursor_x, cursor_y)
}
