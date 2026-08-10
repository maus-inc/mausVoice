use gtk::cairo;
use gtk::gdk;

use crate::ipc::{self, OutMessage, Phase};

use crate::constants::*;
use crate::draw::{
    cancel_button_origin, over_side_control, pause_button_origin, pill_position, tooltip_origin,
};
use crate::state::{ClickAction, PillState};

pub(crate) fn is_over_pill_area(state: &PillState, x: f64, y: f64) -> bool {
    let (ox, oy) = state.content_offset();
    let x = x - ox;
    let y = y - oy;
    let dw = state.draw_width.get();
    let dh = state.draw_height.get();

    if state.assistant_active.get() || state.panel_open_t.get() > 0.1 {
        return x >= 0.0 && x <= dw && y >= 0.0 && y <= dh;
    }

    // Pill area (with padding)
    let pad = if state.hovered.get() { 24.0 } else { 8.0 };
    let (px, py, pw, ph) = pill_position(state, dw, dh);
    if x >= px - pad && x <= px + pw + pad && y >= py - pad && y <= py + ph + pad {
        return true;
    }

    // Tooltip: same helper the draw code uses, so the hit box always covers
    // the painted tooltip (including after a Wayland drag).
    if state.tooltip_t.get() > 0.1 {
        let tooltip_w = state.tooltip_width.get();
        let (tooltip_x, tooltip_y) = tooltip_origin(px, py, pw, tooltip_w);
        if x >= tooltip_x && x <= tooltip_x + tooltip_w
            && y >= tooltip_y && y <= tooltip_y + TOOLTIP_HEIGHT
        {
            return true;
        }
    }

    // Pause / cancel side controls (live pill geometry, matching draw code)
    if state.phase.get() != Phase::Idle && over_side_control(x, y, px, py, pw, ph) {
        return true;
    }

    false
}

pub(crate) fn is_on_pill_at(state: &PillState, x: f64, y: f64) -> bool {
    let (ox, oy) = state.content_offset();
    let x = x - ox;
    let y = y - oy;
    let dw = state.draw_width.get();
    let dh = state.draw_height.get();

    if state.assistant_active.get() || state.panel_open_t.get() > 0.1 {
        return false;
    }

    let (px, py, pw, ph) = pill_position(state, dw, dh);
    if x >= px && x <= px + pw && y >= py && y <= py + ph {
        let regions = state.click_regions.borrow();
        for region in regions.iter().rev() {
            if matches!(region.action, ClickAction::Pill) {
                continue;
            }
            if region.contains(x, y) {
                return false;
            }
        }
        return true;
    }

    false
}

pub(crate) fn handle_click(state: &PillState, x: f64, y: f64) {
    let (ox, oy) = state.content_offset();
    let x = x - ox;
    let y = y - oy;

    let regions = state.click_regions.borrow();
    for region in regions.iter().rev() {
        if region.contains(x, y) {
            match &region.action {
                ClickAction::Pill => {
                    if state.assistant_active.get() {
                        ipc::send(&OutMessage::AgentTalk);
                    } else {
                        ipc::send(&OutMessage::Click);
                    }
                }
                ClickAction::StyleForward => {
                    ipc::send(&OutMessage::StyleSwitch { direction: "forward".to_string() });
                }
                ClickAction::StyleBackward => {
                    ipc::send(&OutMessage::StyleSwitch { direction: "backward".to_string() });
                }
                ClickAction::AssistantClose => {
                    ipc::send(&OutMessage::AssistantClose);
                }
                ClickAction::OpenInNew => {
                    if let Some(ref id) = *state.assistant_conversation_id.borrow() {
                        ipc::send(&OutMessage::OpenConversation { conversation_id: id.clone() });
                    }
                    ipc::send(&OutMessage::AssistantClose);
                }
                ClickAction::KeyboardButton => {
                    ipc::send(&OutMessage::EnableTypeMode);
                }
                ClickAction::CancelDictation => {
                    ipc::send(&OutMessage::CancelDictation);
                }
                ClickAction::PauseDictation => {
                    ipc::send(&OutMessage::PauseDictation);
                }
                ClickAction::ResumeDictation => {
                    ipc::send(&OutMessage::ResumeDictation);
                }
                ClickAction::PermissionAllow(id) => {
                    ipc::send(&OutMessage::ResolvePermission {
                        permission_id: id.clone(), status: "allowed".to_string(), always_allow: false,
                    });
                }
                ClickAction::PermissionDeny(id) => {
                    ipc::send(&OutMessage::ResolvePermission {
                        permission_id: id.clone(), status: "denied".to_string(), always_allow: false,
                    });
                }
                ClickAction::PermissionAlwaysAllow(id) => {
                    ipc::send(&OutMessage::ResolvePermission {
                        permission_id: id.clone(), status: "allowed".to_string(), always_allow: true,
                    });
                }
                ClickAction::SendButton => {
                    let text = state.entry_text.borrow().trim().to_string();
                    if !text.is_empty() {
                        ipc::send(&OutMessage::TypedMessage { text });
                        *state.entry_text.borrow_mut() = String::new();
                    }
                }
                ClickAction::FlashAction => {
                    if let Some(ref action) = *state.flash_action.borrow() {
                        ipc::send(&OutMessage::ToastAction { action: action.clone() });
                    }
                    state.flash_visible.set(false);
                    state.flash_timer.set(0.0);
                    *state.flash_action.borrow_mut() = None;
                    *state.flash_action_label.borrow_mut() = None;
                }
            }
            return;
        }
    }
}

pub(crate) fn handle_scroll(state: &PillState, event: &gdk::EventScroll) {
    if !state.assistant_active.get() || state.assistant_compact.get() {
        return;
    }

    let dy = match event.direction() {
        gdk::ScrollDirection::Up => -30.0,
        gdk::ScrollDirection::Down => 30.0,
        gdk::ScrollDirection::Smooth => {
            let (_, dy) = event.delta();
            dy * 30.0
        }
        _ => 0.0,
    };

    let current = state.scroll_offset.get();
    let max_scroll = (state.content_height.get() - state.viewport_height.get()).max(0.0);
    let new_offset = (current + dy).clamp(0.0, max_scroll);
    state.scroll_offset.set(new_offset);
    state.should_stick.set(max_scroll - new_offset <= 32.0);
}

/// Pure region math: build the input region from live pill geometry plus
/// the optional tooltip, with no `gdk::Window` and no `PillState`, so tests
/// can drive it with a non-zero drag offset and assert the moved pill and
/// both side controls stay clickable.
#[allow(clippy::too_many_arguments)]
fn build_input_region(
    ox: f64, oy: f64,
    pill_x: f64, pill_y: f64, pill_w: f64, pill_h: f64,
    tooltip_t: f64, tooltip_w: f64,
    include_side_controls: bool,
) -> cairo::Region {
    let pill_rect = cairo::RectangleInt::new(
        (ox + pill_x) as i32,
        (oy + pill_y) as i32,
        pill_w.ceil() as i32,
        pill_h.ceil() as i32,
    );

    let mut region = if tooltip_t > 0.1 && tooltip_w > 0.0 {
        // Same helper the draw code uses, so the region always covers the
        // painted tooltip. Centring on the pill rather than the window also
        // keeps them aligned horizontally once a drag moves the pill.
        let (tooltip_rx, tooltip_ry) = tooltip_origin(pill_x, pill_y, pill_w, tooltip_w);
        let tooltip_rect = cairo::RectangleInt::new(
            (ox + tooltip_rx).floor() as i32,
            (oy + tooltip_ry).floor() as i32,
            tooltip_w.ceil() as i32,
            TOOLTIP_HEIGHT.ceil() as i32,
        );
        let r = cairo::Region::create_rectangle(&pill_rect);
        let _ = r.union_rectangle(&tooltip_rect);
        r
    } else {
        cairo::Region::create_rectangle(&pill_rect)
    };

    if include_side_controls {
        union_side_controls(&mut region, ox, oy, pill_x, pill_y, pill_w, pill_h);
    }
    region
}

/// Build the input region from live pill geometry plus the optional tooltip.
#[allow(clippy::too_many_arguments)]
fn input_region(
    state: &PillState,
    ox: f64, oy: f64,
    pill_x: f64, pill_y: f64, pill_w: f64, pill_h: f64,
) -> cairo::Region {
    let region = build_input_region(
        ox, oy,
        pill_x, pill_y, pill_w, pill_h,
        state.tooltip_t.get(), state.tooltip_width.get(),
        state.phase.get() != Phase::Idle,
    );
    union_flash_action(&region, state, ox, oy);
    region
}

pub(crate) fn set_expanded_input_region(gdk_window: &gdk::Window, state: &PillState) {
    let dw = state.draw_width.get();
    let dh = state.draw_height.get();
    let (ox, oy) = state.content_offset();

    if state.assistant_active.get() {
        let rect = cairo::RectangleInt::new(
            ox as i32, oy as i32,
            dw.ceil() as i32, dh.ceil() as i32,
        );
        let region = cairo::Region::create_rectangle(&rect);
        gdk_window.input_shape_combine_region(&region, 0, 0);
    } else {
        // Use the SAME live geometry as the draw layer (pill_position
        // applies drag_draw_offset_* on non-X11 backends), so the input
        // region follows the pill after a Wayland/LayerShell drag. The
        // static EXPANDED_* rectangle used to leave the moved pill unable
        // to receive hover/click once dropped elsewhere.
        let (pill_x, pill_y, pill_w, pill_h) = pill_position(state, dw, dh);
        let region = input_region(state, ox, oy, pill_x, pill_y, pill_w, pill_h);
        gdk_window.input_shape_combine_region(&region, 0, 0);
    }
}

fn union_flash_action(
    region: &cairo::Region,
    state: &PillState,
    ox: f64, oy: f64,
) {
    if state.flash_action.borrow().is_none() || state.flash_t.get() < 0.5 {
        return;
    }
    // Use the click regions registered by draw code for exact coordinates
    let regions = state.click_regions.borrow();
    for r in regions.iter() {
        if matches!(r.action, ClickAction::FlashAction) {
            let rect = cairo::RectangleInt::new(
                (ox + r.x) as i32,
                (oy + r.y) as i32,
                r.w.ceil() as i32,
                r.h.ceil() as i32,
            );
            let _ = region.union_rectangle(&rect);
        }
    }
}

fn union_side_controls(
    region: &mut cairo::Region,
    ox: f64, oy: f64,
    pill_x: f64, pill_y: f64, pill_w: f64, pill_h: f64,
) {
    // Both side controls use the same shared origins as the draw code, so
    // hit-testing can never drift away from where the controls are painted.
    // Callers pass the live pill_position() result so the controls follow
    // the pill after a Wayland/LayerShell drag.
    let (pause_x, pause_y) = pause_button_origin(pill_x, pill_y, pill_h);
    let (cancel_x, cancel_y) = cancel_button_origin(pill_x, pill_y, pill_w, pill_h);
    let size = CANCEL_BUTTON_SIZE.ceil() as i32;
    for (bx, by) in [(pause_x, pause_y), (cancel_x, cancel_y)] {
        let btn_rect = cairo::RectangleInt::new(
            (ox + bx) as i32,
            (oy + by) as i32,
            size,
            size,
        );
        let _ = region.union_rectangle(&btn_rect);
    }
}

pub(crate) fn update_input_region(gdk_window: &gdk::Window, state: &PillState) {
    let hovered = state.hovered.get();
    let is_active = state.phase.get() != Phase::Idle;
    let is_assistant = state.assistant_active.get();

    if is_assistant || hovered || is_active {
        set_expanded_input_region(gdk_window, state);
    } else {
        let dw = state.draw_width.get();
        let dh = state.draw_height.get();
        let (ox, oy) = state.content_offset();
        let (pill_x, pill_y, pill_w, pill_h) = pill_position(state, dw, dh);
        let pill_rx = (ox + pill_x) as i32;
        let pill_ry = (oy + pill_y) as i32;
        let rect = cairo::RectangleInt::new(
            pill_rx, pill_ry,
            pill_w.ceil() as i32,
            pill_h.ceil() as i32,
        );
        let region = cairo::Region::create_rectangle(&rect);
        union_flash_action(&region, state, ox, oy);
        gdk_window.input_shape_combine_region(&region, 0, 0);
    }
}

#[cfg(test)]
mod input_region_tests {
    use super::*;

    /// After a non-X11 drag the pill is drawn at base position + offset.
    /// The input region must include the moved pill body and both side
    /// controls at that shifted geometry.
    #[test]
    fn shifted_pill_keeps_body_and_controls_clickable() {
        let (ox, oy) = (0.0f64, 0.0f64);
        // Base pill geometry (what pill_position returns before offset)
        let (base_x, base_y, base_w, base_h) = (240.0f64, 100.0f64, 120.0f64, 32.0f64);
        // Simulate a Wayland drag: non-zero drag_draw_offset_* shifted draw
        // position. pill_position() adds these on non-X11 backends.
        let offset_x = 80.0f64;
        let offset_y = 40.0f64;
        let pill_x = base_x + offset_x;
        let pill_y = base_y + offset_y;
        let pill_w = base_w;
        let pill_h = base_h;

        // Active phase -> side controls are part of the input region.
        let region = build_input_region(
            ox, oy,
            pill_x, pill_y, pill_w, pill_h,
            0.0, 0.0,   // no tooltip
            true,       // include side controls
        );

        // Moved pill body centre must be inside the region.
        let pill_cx = (ox + pill_x + pill_w / 2.0) as i32;
        let pill_cy = (oy + pill_y + pill_h / 2.0) as i32;
        assert!(
            region.contains_point(pill_cx, pill_cy),
            "moved pill centre ({pill_cx},{pill_cy}) missing from input region"
        );

        // Both side controls (pause left, cancel right) must stay clickable.
        let (pause_x, pause_y) = pause_button_origin(pill_x, pill_y, pill_h);
        let (cancel_x, cancel_y) = cancel_button_origin(pill_x, pill_y, pill_w, pill_h);
        let size = CANCEL_BUTTON_SIZE;
        for (cx, cy, label) in [
            (pause_x + size / 2.0, pause_y + size / 2.0, "pause"),
            (cancel_x + size / 2.0, cancel_y + size / 2.0, "cancel"),
        ] {
            assert!(
                region.contains_point((ox + cx) as i32, (oy + cy) as i32),
                "{label} control centre missing from shifted input region"
            );
        }
    }

    /// The visible tooltip must sit inside the input region, at rest and
    /// after a drag. These previously disagreed: the draw code anchored the
    /// tooltip to a fixed `pill_area_top` while the region followed the live
    /// `pill_y`, so the style selector could be painted outside its own input
    /// shape and stop receiving clicks.
    #[test]
    fn tooltip_stays_inside_region_when_pill_moves() {
        let (ox, oy) = (0.0f64, 0.0f64);
        let (base_x, base_y, pill_w, pill_h) = (240.0f64, 100.0f64, 120.0f64, 32.0f64);
        let tooltip_w = 160.0f64;

        for (offset_x, offset_y) in [(0.0, 0.0), (80.0, 40.0), (-60.0, -30.0)] {
            let pill_x = base_x + offset_x;
            let pill_y = base_y + offset_y;

            let region = build_input_region(
                ox, oy,
                pill_x, pill_y, pill_w, pill_h,
                1.0, tooltip_w,  // tooltip fully shown
                false,
            );

            // Every corner and the centre of the painted tooltip must be
            // covered, so the whole selector is clickable.
            let (tx, ty) = tooltip_origin(pill_x, pill_y, pill_w, tooltip_w);
            let probes = [
                (tx + 1.0, ty + 1.0, "top-left"),
                (tx + tooltip_w - 1.0, ty + 1.0, "top-right"),
                (tx + tooltip_w / 2.0, ty + TOOLTIP_HEIGHT / 2.0, "centre"),
                (tx + 1.0, ty + TOOLTIP_HEIGHT - 1.0, "bottom-left"),
                (tx + tooltip_w - 1.0, ty + TOOLTIP_HEIGHT - 1.0, "bottom-right"),
            ];
            for (px, py, label) in probes {
                assert!(
                    region.contains_point((ox + px) as i32, (oy + py) as i32),
                    "tooltip {label} missing from region at offset ({offset_x},{offset_y})"
                );
            }
        }
    }

    /// The tooltip is centred on the pill and sits directly above it.
    #[test]
    fn tooltip_origin_tracks_the_pill() {
        let (x0, y0) = tooltip_origin(240.0, 100.0, 120.0, 160.0);
        // Centred: pill centre 300 - half tooltip 80 = 220.
        assert_eq!(x0, 220.0);
        assert_eq!(y0, 100.0 - TOOLTIP_GAP - TOOLTIP_HEIGHT);

        // A drag shifts the tooltip by exactly the same delta as the pill.
        let (x1, y1) = tooltip_origin(240.0 + 80.0, 100.0 + 40.0, 120.0, 160.0);
        assert_eq!(x1 - x0, 80.0);
        assert_eq!(y1 - y0, 40.0);
    }

    /// Without an offset the region still covers the pill body.
    #[test]
    fn unshifted_pill_body_is_in_region() {
        let (ox, oy) = (0.0f64, 0.0f64);
        let region = build_input_region(
            ox, oy,
            240.0, 100.0, 120.0, 32.0,
            0.0, 0.0,
            false,
        );
        assert!(region.contains_point(300, 116), "pill centre should be inside");
    }
}
