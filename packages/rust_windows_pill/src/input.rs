use crate::constants::*;
use crate::ipc::{self, OutMessage};
use crate::state::{ClickAction, PillState};

/// A23: Dispatch haptic/audio feedback to the desktop process.
pub(crate) fn send_haptic(kind: &str) {
    ipc::send(&OutMessage::HapticFeedback {
        kind: kind.to_string(),
    });
}

/// Report a review decision back to the desktop. The id travels with the
/// decision so a late click on a card that has already been replaced is
/// discarded instead of applied to the next transcript.
fn send_review_decision_with(
    review_id: &str,
    action: &str,
    text: Option<String>,
    send: impl FnOnce(&OutMessage) -> bool,
) -> bool {
    send(&OutMessage::ReviewDecision {
        review_id: review_id.to_string(),
        action: action.to_string(),
        text,
    })
}

/// [`send_review_decision_with`] over the desktop's pipe.
pub(crate) fn send_review_decision(review_id: &str, action: &str, text: Option<String>) -> bool {
    send_review_decision_with(review_id, action, text, ipc::send)
}

/// Send whatever the entry holds.
///
/// While a transcript is under review the entry holds that transcript, so
/// submitting it is the insert decision and carries any edit the user made.
/// Otherwise it is a message for the assistant. An empty entry sends nothing,
/// because there is nothing to insert or say.
///
/// Returns true when the message actually reached the desktop, so the caller
/// clears the platform text control only then. A failed write leaves the text
/// in the entry: the pipe it would be re-sent on is the one that just failed,
/// so the entry is the only remaining copy.
pub(crate) fn submit_entry(state: &PillState) -> bool {
    submit_entry_inner(
        &state.entry_text,
        state.pending_review_id().as_deref(),
        ipc::send,
    )
}

/// The body of [`submit_entry`], with the entry and the sink as parameters so
/// the decision can be tested without a `PillState` (which has no constructor)
/// or a live desktop pipe.
fn submit_entry_inner(
    entry_text: &std::cell::RefCell<String>,
    review_id: Option<&str>,
    send: impl FnOnce(&OutMessage) -> bool,
) -> bool {
    // Send the text exactly as the user left it. Spacing at either end can be
    // deliberate when the transcript lands in a document, so trimming is only
    // ever used to decide whether there is anything to send.
    let text = entry_text.borrow().clone();
    if text.trim().is_empty() {
        return false;
    }
    // The insert decision goes out through the one function that builds it, so
    // the message shape has a single owner: the desktop's action vocabulary
    // changes here and nowhere else.
    let sent = match review_id {
        Some(review_id) => send_review_decision_with(review_id, "insert", Some(text), send),
        None => send(&OutMessage::TypedMessage { text }),
    };
    // Cleared only when the desktop actually received it. This runs in the
    // entry's activate handler, so there is no retry here: a failed write
    // means the pipe is gone and nothing would consume one. That is exactly
    // why the text must stay — the one copy the user has cannot be re-sent
    // down a pipe that has just failed, so clearing it destroys it outright.
    if sent {
        *entry_text.borrow_mut() = String::new();
        true
    } else {
        false
    }
}

pub(crate) fn handle_click(state: &PillState, x: f64, y: f64) {
    crate::draw::refresh_selector_click_regions(state);
    let (ox, oy) = state.content_offset();
    let x = x - ox;
    let y = y - oy;

    let regions = state.click_regions.borrow();
    for region in regions.iter().rev() {
        if region.contains(x, y) {
            match &region.action {
                ClickAction::Pill => {
                    // A pending review owns the pill surface: the transcript
                    // must be answered (or cancelled) before a body click can
                    // start dictation or an assistant turn again.
                    if state.assistant_review.borrow().is_some() {
                        return;
                    }
                    // Loading owns the current operation; another body click
                    // must not emit feedback or start a second action.
                    if !rust_pill_shared::can_emit_interaction_feedback(
                        true,
                        state.phase.get() == crate::ipc::Phase::Loading,
                    ) {
                        return;
                    }
                    // The recording chime owns the pill-body click. The
                    // desktop side plays start/stop clips for the same event,
                    // so emitting a thock here doubled the sound.
                    if state.assistant_active.get() {
                        ipc::send(&OutMessage::AgentTalk);
                    } else {
                        ipc::send(&OutMessage::Click);
                    }
                }
                ClickAction::StyleForward => {
                    send_haptic("deep");
                    ipc::send(&OutMessage::StyleSwitch {
                        direction: "forward".to_string(),
                    });
                }
                ClickAction::StyleBackward => {
                    send_haptic("deep");
                    ipc::send(&OutMessage::StyleSwitch {
                        direction: "backward".to_string(),
                    });
                }
                ClickAction::AssistantClose => {
                    // Closing the panel while a transcript is under review is
                    // a cancel decision, not a silent dismissal: the desktop
                    // needs an answer to release the queued reviews.
                    let review_id = state
                        .assistant_review
                        .borrow()
                        .as_ref()
                        .map(|review| review.id.clone());
                    match review_id {
                        Some(review_id) => {
                            let _ = send_review_decision(&review_id, "cancel", None);
                        }
                        None => {
                            let _ = ipc::send(&OutMessage::AssistantClose);
                        }
                    }
                }
                ClickAction::ReviewInsert(id) => {
                    // The entry is the transcript, edits included, and it
                    // travels exactly as the user left it. An empty one has
                    // nothing to insert, so the card simply stays up.
                    let text = state.entry_text.borrow().clone();
                    if !text.trim().is_empty() {
                        send_review_decision(id, "insert", Some(text));
                    }
                }
                ClickAction::ReviewCopy(id) => {
                    let text = state.entry_text.borrow().clone();
                    send_review_decision(id, "copy", Some(text));
                }
                ClickAction::ReviewEdit(id) => {
                    let text = state.entry_text.borrow().clone();
                    send_review_decision(id, "edit", Some(text));
                }
                ClickAction::ReviewCancel(id) => {
                    let _ = send_review_decision(id, "cancel", None);
                }
                ClickAction::OpenInNew => {
                    let review_id = state
                        .assistant_review
                        .borrow()
                        .as_ref()
                        .map(|review| review.id.clone());
                    if let Some(review_id) = review_id {
                        // The desktop receives this exact edit and settles the
                        // review only after its caller confirms it is durable.
                        let text = state.entry_text.borrow().clone();
                        send_review_decision(&review_id, "open", Some(text));
                    } else {
                        if let Some(ref id) = *state.assistant_conversation_id.borrow() {
                            ipc::send(&OutMessage::OpenConversation {
                                conversation_id: id.clone(),
                            });
                        }
                        ipc::send(&OutMessage::AssistantClose);
                    }
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
                    if submit_entry(state) {
                        crate::pill::clear_edit_control();
                    }
                }
                ClickAction::InputField => {
                    crate::pill::focus_edit_control();
                }
                ClickAction::FlashAction => {
                    if let Some(ref action) = *state.flash_action.borrow() {
                        ipc::send(&OutMessage::ToastAction {
                            action: action.clone(),
                        });
                    }
                    rust_pill_shared::clear_flash_state(
                        &state.flash_visible,
                        &state.flash_timer,
                        &state.flash_action,
                        &state.flash_action_label,
                        &state.flash_reject_action,
                        &state.flash_reject_action_label,
                    );
                }
                ClickAction::FlashReject => {
                    if let Some(ref action) = *state.flash_reject_action.borrow() {
                        ipc::send(&OutMessage::ToastAction {
                            action: action.clone(),
                        });
                    }
                    rust_pill_shared::clear_flash_state(
                        &state.flash_visible,
                        &state.flash_timer,
                        &state.flash_action,
                        &state.flash_action_label,
                        &state.flash_reject_action,
                        &state.flash_reject_action_label,
                    );
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

    if state.owns_panel() || state.panel_open_t.get() > 0.1 {
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
    // A pending review makes the panel scrollable too. The card can sit below a
    // conversation, and its buttons have to be reachable. The compact test
    // mirrors the one the panel is drawn with.
    let has_review = state.assistant_review.borrow().is_some();
    let owns_panel = state.owns_panel();
    let is_compact = state.assistant_compact.get() && !has_review;
    if !owns_panel || is_compact {
        return;
    }

    let current = state.scroll_offset.get();
    let max_scroll = (state.content_height.get() - state.viewport_height.get()).max(0.0);
    let new_offset = (current + delta).clamp(0.0, max_scroll);
    state.scroll_offset.set(new_offset);
    state.should_stick.set(max_scroll - new_offset <= 32.0);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The entry is the user's only copy of what they typed. Clearing it after
    /// a write that never reached the desktop destroys text that cannot be
    /// recovered and cannot be re-sent, because the pipe it would be re-sent
    /// on is the one that just failed.
    /// The desktop's action vocabulary has one owner, `send_review_decision_with`,
    /// so the insert decision's wire shape is pinned here rather than left to
    /// whichever caller happens to build it. The surrounding text travels exactly
    /// as the user left it, including spacing that can be deliberate when the
    /// transcript lands in a document.
    #[test]
    fn a_review_submit_sends_an_insert_decision_carrying_the_text() {
        let entry = std::cell::RefCell::new("  spaced transcript  ".to_string());
        let sent_json = std::cell::RefCell::new(None);
        let sent = submit_entry_inner(&entry, Some("review-9"), |msg| {
            *sent_json.borrow_mut() = Some(serde_json::to_string(msg).unwrap());
            true
        });
        assert!(sent);
        assert_eq!(
            sent_json.borrow().as_deref(),
            Some(
                r#"{"type":"review_decision","review_id":"review-9","action":"insert","text":"  spaced transcript  "}"#
            )
        );
        assert!(entry.borrow().is_empty());
    }

    #[test]
    fn a_plain_submit_sends_a_typed_message() {
        let entry = std::cell::RefCell::new("hello".to_string());
        let sent_json = std::cell::RefCell::new(None);
        let sent = submit_entry_inner(&entry, None, |msg| {
            *sent_json.borrow_mut() = Some(serde_json::to_string(msg).unwrap());
            true
        });
        assert!(sent);
        assert_eq!(
            sent_json.borrow().as_deref(),
            Some(r#"{"type":"typed_message","text":"hello"}"#)
        );
    }

    #[test]
    fn a_failed_submit_keeps_the_entry_text() {
        let entry = std::cell::RefCell::new("a typed message".to_string());
        let sent = submit_entry_inner(&entry, None, |_| false);
        assert!(!sent, "a failed write is not a send");
        assert_eq!(
            entry.borrow().as_str(),
            "a typed message",
            "the entry must survive a write the desktop never received"
        );
    }

    #[test]
    fn a_failed_review_submit_keeps_the_edited_transcript() {
        let entry = std::cell::RefCell::new("an edited transcript".to_string());
        let sent = submit_entry_inner(&entry, Some("review-7"), |_| false);
        assert!(!sent);
        assert_eq!(entry.borrow().as_str(), "an edited transcript");
    }

    #[test]
    fn a_successful_submit_clears_the_entry() {
        let entry = std::cell::RefCell::new("a typed message".to_string());
        let sent = submit_entry_inner(&entry, None, |_| true);
        assert!(sent);
        assert!(entry.borrow().is_empty());
    }

    #[test]
    fn an_entry_of_only_whitespace_sends_nothing() {
        let entry = std::cell::RefCell::new("   \n ".to_string());
        let sent = submit_entry_inner(&entry, None, |_| true);
        assert!(!sent, "there is nothing to say, so nothing is sent");
        assert_eq!(
            entry.borrow().as_str(),
            "   \n ",
            "and a submit that sent nothing must not clear the entry either"
        );
    }
}
