use gtk::cairo;
use gtk::gdk;

use crate::ipc::{self, OutMessage, Phase};

use crate::constants::*;
use crate::draw::{cancel_button_origin, over_side_control, pause_button_origin, pill_position};
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

    let pill_area_top = dh - PILL_AREA_HEIGHT;

    // Pill area (with padding)
    let pad = if state.hovered.get() { 24.0 } else { 8.0 };
    let (px, py, pw, ph) = pill_position(state, dw, dh);
    if x >= px - pad && x <= px + pw + pad && y >= py - pad && y <= py + ph + pad {
        return true;
    }

    // Tooltip
    if state.tooltip_t.get() > 0.1 {
        let tooltip_w = state.tooltip_width.get();
        let tooltip_x = (dw - tooltip_w) / 2.0;
        let tooltip_y = pill_area_top - TOOLTIP_GAP - TOOLTIP_HEIGHT;
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
        let pill_w = EXPANDED_PILL_WIDTH;
        let pill_h = EXPANDED_PILL_HEIGHT;
        let pill_rx = (ox + (dw - pill_w) / 2.0) as i32;
        let pill_area_top = dh - PILL_AREA_HEIGHT;
        let pill_ry = (oy + pill_area_top) as i32;

        let tooltip_t = state.tooltip_t.get();
        let tooltip_w = state.tooltip_width.get();

        if tooltip_t > 0.1 && tooltip_w > 0.0 {
            let tooltip_top = (oy + pill_area_top - TOOLTIP_GAP - TOOLTIP_HEIGHT) as i32;
            let region_w = tooltip_w.ceil().max(pill_w).ceil() as i32;
            let region_rx = (ox + (dw - region_w as f64) / 2.0) as i32;
            let region_h = pill_ry + pill_h.ceil() as i32 + ((PILL_AREA_HEIGHT - EXPANDED_PILL_HEIGHT) / 2.0).ceil() as i32 - tooltip_top;
            let rect = cairo::RectangleInt::new(region_rx, tooltip_top, region_w, region_h);
            let region = cairo::Region::create_rectangle(&rect);
            if state.phase.get() != Phase::Idle {
                union_side_controls(&region, state, ox, oy, dw, dh);
            }
            union_flash_action(&region, state, ox, oy);
            gdk_window.input_shape_combine_region(&region, 0, 0);
        } else {
            let rect = cairo::RectangleInt::new(
                pill_rx, pill_ry,
                pill_w.ceil() as i32,
                PILL_AREA_HEIGHT.ceil() as i32,
            );
            let region = cairo::Region::create_rectangle(&rect);
            if state.phase.get() != Phase::Idle {
                union_side_controls(&region, state, ox, oy, dw, dh);
            }
            union_flash_action(&region, state, ox, oy);
            gdk_window.input_shape_combine_region(&region, 0, 0);
        }
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
    region: &cairo::Region,
    state: &PillState,
    ox: f64, oy: f64, dw: f64, dh: f64,
) {
    // Both side controls use the same shared origins as the draw code, so
    // hit-testing can never drift away from where the controls are painted.
    let (pill_x, pill_y, pill_w, pill_h) = pill_position(state, dw, dh);
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
