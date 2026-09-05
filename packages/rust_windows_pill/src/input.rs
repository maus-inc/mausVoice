use crate::ipc::{self, OutMessage};
use crate::state::{ClickAction, PillState};
use crate::constants::*;

/// A23: Dispatch haptic/audio feedback to the desktop process.
pub(crate) fn send_haptic(kind: &str) {
    ipc::send(&OutMessage::HapticFeedback {
        kind: kind.to_string(),
    });
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
                    // Loading owns the current operation; another body click
                    // must not emit feedback or start a second action.
                    if !rust_pill_shared::can_emit_interaction_feedback(
                        true,
                        state.phase.get() == crate::ipc::Phase::Loading,
                    ) {
                        return;
                    }
                    send_haptic("press");
                    if state.assistant_active.get() {
                        ipc::send(&OutMessage::AgentTalk);
                    } else {
                        ipc::send(&OutMessage::Click);
                    }
                }
                ClickAction::StyleForward => {
                    send_haptic("deep");
                    ipc::send(&OutMessage::StyleSwitch { direction: "forward".to_string() });
                }
                ClickAction::StyleBackward => {
                    send_haptic("deep");
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
                    send_haptic("deep");
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
                        crate::pill::clear_edit_control();
                    }
                }
                ClickAction::InputField => {
                    crate::pill::focus_edit_control();
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

/// Returns true if the given point is on the pill body itself
/// (not on a button or interactive element). Used for long-press detection.
pub(crate) fn is_on_pill_at(state: &PillState, x: f64, y: f64) -> bool {
    let (ox, oy) = state.content_offset();
    let x = x - ox;
    let y = y - oy;
    let dw = state.draw_width.get();
    let dh = state.draw_height.get();

    if state.assistant_active.get() || state.panel_open_t.get() > 0.1 {
        return false;
    }

    let pill_area_top = dh - PILL_AREA_HEIGHT;
    let expand_t = state.expand_t.get();
    let pill_w = crate::gfx::lerp(MIN_PILL_WIDTH, EXPANDED_PILL_WIDTH, expand_t);
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

pub(crate) fn handle_scroll(state: &PillState, delta: f64) {
    if !state.assistant_active.get() || state.assistant_compact.get() {
        return;
    }

    let current = state.scroll_offset.get();
    let max_scroll = (state.content_height.get() - state.viewport_height.get()).max(0.0);
    let new_offset = (current + delta).clamp(0.0, max_scroll);
    state.scroll_offset.set(new_offset);
    state.should_stick.set(max_scroll - new_offset <= 32.0);
}
