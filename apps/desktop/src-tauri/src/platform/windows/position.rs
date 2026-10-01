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
    // Windows uses standard screen coordinates:
    // - Y=0 is at the top
    // - Y increases downward
    // - Window position is the top-left corner
    //
    // Monitor values are in physical pixels, convert to logical for calculation
    let scale = monitor.scale_factor;
    let visible = Rect::visible_area_of(monitor).in_logical_points(scale);

    let target = anchor_rect(visible, anchor, window_width, window_height, margin);

    // Convert back to physical pixels
    let physical_x = (target.x * scale) as i32;
    let physical_y = (target.y * scale) as i32;

    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        physical_x, physical_y,
    )));
}

pub fn is_cursor_in_bounds(
    monitor: &MonitorAtCursor,
    anchor: OverlayAnchor,
    bounds_width: f64,
    bounds_height: f64,
    margin: f64,
) -> bool {
    // Windows: work entirely in physical coordinates to match cursor position
    let scale = monitor.scale_factor;

    // Scale the logical dimensions to physical
    let bounds = anchor_rect(
        Rect::visible_area_of(monitor),
        anchor,
        bounds_width * scale,
        bounds_height * scale,
        margin * scale,
    );

    // Cursor is already in physical coordinates
    bounds.contains(monitor.cursor_x, monitor.cursor_y)
}
