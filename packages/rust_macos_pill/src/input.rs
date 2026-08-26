use crate::ipc::{self, OutMessage, Phase};

use crate::constants::*;
use crate::draw::{over_side_control, pill_position};
use crate::gfx;
use crate::state::{ClickAction, PillState};

fn has_flash_action_at(state: &PillState, x: f64, y: f64) -> bool {
    if state.flash_action.borrow().is_none() || state.flash_t.get() < 0.5 {
        return false;
    }
    // Check against the actual click regions registered by the draw code,
    // since the flash can be wider than the draw area (it extends into the
    // content-offset margins). The FlashAction region has exact coordinates.
    let regions = state.click_regions.borrow();
    regions.iter().any(|r| {
        matches!(
            r.action,
            ClickAction::FlashAction | ClickAction::FlashReject
        ) && r.contains(x, y)
    })
}

pub(crate) fn handle_click(state: &PillState, x: f64, y: f64) {
    let s = state.ui_scale;
    let (ox, oy) = state.content_offset();
    let x = x / s - ox;
    let y = y / s - oy;

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
                    ipc::send(&OutMessage::StyleSwitch {
                        direction: "forward".to_string(),
                    });
                }
                ClickAction::StyleBackward => {
                    ipc::send(&OutMessage::StyleSwitch {
                        direction: "backward".to_string(),
                    });
                }
                ClickAction::AssistantClose => {
                    ipc::send(&OutMessage::AssistantClose);
                }
                ClickAction::OpenInNew => {
                    if let Some(ref id) = *state.assistant_conversation_id.borrow() {
                        ipc::send(&OutMessage::OpenConversation {
                            conversation_id: id.clone(),
                        });
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
                        permission_id: id.clone(),
                        status: "allowed".to_string(),
                        always_allow: false,
                    });
                }
                ClickAction::PermissionDeny(id) => {
                    ipc::send(&OutMessage::ResolvePermission {
                        permission_id: id.clone(),
                        status: "denied".to_string(),
                        always_allow: false,
                    });
                }
                ClickAction::PermissionAlwaysAllow(id) => {
                    ipc::send(&OutMessage::ResolvePermission {
                        permission_id: id.clone(),
                        status: "allowed".to_string(),
                        always_allow: true,
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
                        ipc::send(&OutMessage::ToastAction {
                            action: action.clone(),
                        });
                    }
                    state.flash_visible.set(false);
                    state.flash_timer.set(0.0);
                    *state.flash_action.borrow_mut() = None;
                    *state.flash_action_label.borrow_mut() = None;
                    *state.flash_reject_action.borrow_mut() = None;
                    *state.flash_reject_action_label.borrow_mut() = None;
                }
                ClickAction::FlashReject => {
                    if let Some(ref action) = *state.flash_reject_action.borrow() {
                        ipc::send(&OutMessage::ToastAction {
                            action: action.clone(),
                        });
                    }
                    state.flash_visible.set(false);
                    state.flash_timer.set(0.0);
                    *state.flash_action.borrow_mut() = None;
                    *state.flash_action_label.borrow_mut() = None;
                    *state.flash_reject_action.borrow_mut() = None;
                    *state.flash_reject_action_label.borrow_mut() = None;
                }
            }
            return;
        }
    }
}

pub(crate) fn handle_scroll(state: &PillState, delta_y: f64) {
    if !state.assistant_active.get() || state.assistant_compact.get() {
        return;
    }

    let current = state.scroll_offset.get();
    let max_scroll = (state.content_height.get() - state.viewport_height.get()).max(0.0);
    let new_offset = (current - delta_y).clamp(0.0, max_scroll);
    state.scroll_offset.set(new_offset);
    state.should_stick.set(max_scroll - new_offset <= 32.0);
}

/// Returns true if the given point is on the pill body itself
/// (not on a button or interactive element). Used for long-press detection.
pub(crate) fn is_on_pill_at(state: &PillState, x: f64, y: f64) -> bool {
    let s = state.ui_scale;
    let (ox, oy) = state.content_offset();
    let x = x / s - ox;
    let y = y / s - oy;
    let dw = state.draw_width.get();
    let dh = state.draw_height.get();

    if state.assistant_active.get() || state.panel_open_t.get() > 0.1 {
        return false;
    }

    let pill_area_top = dh - PILL_AREA_HEIGHT;
    let expand_t = state.expand_t.get();
    let pill_w = gfx::lerp(MIN_PILL_WIDTH, EXPANDED_PILL_WIDTH, expand_t);
    let hit_x = (dw - pill_w) / 2.0;

    if x >= hit_x && x <= hit_x + pill_w && y >= pill_area_top && y <= dh {
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

const HOVER_ENTRY_PAD_X: f64 = 8.0;
const HOVER_ENTRY_PAD_Y: f64 = 8.0;
const HOVER_EXIT_PAD_X: f64 = 24.0;
const HOVER_EXIT_PAD_Y: f64 = 28.0;

pub(crate) fn is_in_hover_zone(state: &PillState, x: f64, y: f64) -> bool {
    let s = state.ui_scale;
    let (ox, oy) = state.content_offset();
    let x = x / s - ox;
    let y = y / s - oy;
    let dw = state.draw_width.get();
    let dh = state.draw_height.get();

    if state.assistant_active.get() || state.panel_open_t.get() > 0.1 {
        return x >= 0.0 && x <= dw && y >= 0.0 && y <= dh;
    }

    let currently_hovered = state.hovered.get();
    let (pad_x, pad_y) = if currently_hovered {
        (HOVER_EXIT_PAD_X, HOVER_EXIT_PAD_Y)
    } else {
        (HOVER_ENTRY_PAD_X, HOVER_ENTRY_PAD_Y)
    };

    let (pill_x, pill_y, pill_w, pill_h) = pill_position(state, dw, dh);
    if x >= pill_x - pad_x
        && x <= pill_x + pill_w + pad_x
        && y >= pill_y - pad_y
        && y <= pill_y + pill_h + pad_y
    {
        return true;
    }

    if currently_hovered {
        if state.tooltip_t.get() > 0.1 {
            let tooltip_w = state.tooltip_width.get();
            let tooltip_x = (dw - tooltip_w) / 2.0;
            let pill_area_top = dh - PILL_AREA_HEIGHT;
            let tooltip_y = pill_area_top - TOOLTIP_GAP - TOOLTIP_HEIGHT;
            if x >= tooltip_x
                && x <= tooltip_x + tooltip_w
                && y >= tooltip_y
                && y <= tooltip_y + TOOLTIP_HEIGHT
            {
                return true;
            }
        }

        if state.phase.get() != Phase::Idle
            && over_side_control(x, y, pill_x, pill_y, pill_w, pill_h)
        {
            return true;
        }
    }

    false
}

pub(crate) fn is_interactive_at(state: &PillState, x: f64, y: f64) -> bool {
    let s = state.ui_scale;
    let (ox, oy) = state.content_offset();
    let x = x / s - ox;
    let y = y / s - oy;
    let dw = state.draw_width.get();
    let dh = state.draw_height.get();

    if state.assistant_active.get() || state.panel_open_t.get() > 0.1 {
        return x >= 0.0 && x <= dw && y >= 0.0 && y <= dh;
    }

    // Check pill area
    let expand_t = state.expand_t.get();
    let pill_w = gfx::lerp(MIN_PILL_WIDTH, EXPANDED_PILL_WIDTH, expand_t);
    let pill_area_top = dh - PILL_AREA_HEIGHT;

    // Expanded pill hit area
    let hit_x = (dw - pill_w) / 2.0;
    if x >= hit_x && x <= hit_x + pill_w && y >= pill_area_top && y <= dh {
        return true;
    }

    // Tooltip area
    if state.tooltip_t.get() > 0.1 {
        let tooltip_w = state.tooltip_width.get();
        let tooltip_x = (dw - tooltip_w) / 2.0;
        let tooltip_y = pill_area_top - TOOLTIP_GAP - TOOLTIP_HEIGHT;
        if x >= tooltip_x
            && x <= tooltip_x + tooltip_w
            && y >= tooltip_y
            && y <= tooltip_y + TOOLTIP_HEIGHT
        {
            return true;
        }
    }

    // Cancel button
    if state.phase.get() != Phase::Idle && state.hovered.get() {
        let (pill_x, pill_y, pw, ph) = pill_position(state, dw, dh);
        if over_side_control(x, y, pill_x, pill_y, pw, ph) {
            return true;
        }
    }

    // Flash message with action button
    if has_flash_action_at(state, x, y) {
        return true;
    }

    false
}
