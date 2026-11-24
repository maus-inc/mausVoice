//! Wire types the desktop sends to every native pill.
//!
//! The three platforms read the same JSON stream and, before this module,
//! carried three copies of these definitions that had to be kept in lockstep
//! by hand. `PillPlacement` is Windows-only (only the Win32 pill anchors to a
//! screen edge), so it stays in that crate's own enum extension point.

use std::io::Write;

use serde::{Deserialize, Serialize};

/// Axis-aligned screen rectangle, top-left origin, y-down.
///
/// Each platform reports it in its own window-position space — physical pixels
/// on Windows and X11 Linux, points on macOS — and the pill `rect` and its
/// `monitor` are always in the same space, which is what the desktop's
/// composer anchoring relies on.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    Hidden,
    WhileActive,
    Persistent,
}

impl From<Visibility> for crate::PillVisibility {
    fn from(value: Visibility) -> Self {
        match value {
            Visibility::Hidden => Self::Hidden,
            Visibility::WhileActive => Self::WhileActive,
            Visibility::Persistent => Self::Persistent,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Recording,
    Loading,
    Paused,
}

/// Which monitor a reset-position re-homes the pill onto.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResetStrategy {
    #[default]
    Current,
    Cursor,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PillMessage {
    pub id: String,
    pub content: Option<String>,
    pub is_error: bool,
    pub is_tool_result: bool,
    pub tool_name: Option<String>,
    pub tool_description: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PillToolCall {
    #[allow(dead_code)]
    pub id: String,
    pub name: String,
    pub done: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PillStreaming {
    pub message_id: String,
    pub tool_calls: Vec<PillToolCall>,
    pub reasoning: String,
    pub is_streaming: bool,
}

/// Review-before-insert state: one finished transcript waiting for the user
/// to decide what happens to it. Reviews are queued by the desktop, so the
/// pill only ever holds the one it is currently showing.
#[derive(Debug, Clone, Deserialize)]
pub struct PillReview {
    pub id: String,
    pub text: String,
    /// Translated by the owning desktop webview. Older senders omit these,
    /// so each falls back to the English caption the pill used to hardcode.
    #[serde(default)]
    pub edit_label: Option<String>,
    #[serde(default)]
    pub insert_label: Option<String>,
    #[serde(default)]
    pub copy_label: Option<String>,
    #[serde(default)]
    pub cancel_label: Option<String>,
    /// The "Edit below, then press Enter to insert" hint above the row.
    #[serde(default)]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PillPermission {
    pub id: String,
    pub tool_name: String,
    pub description: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InMessage {
    Phase {
        phase: Phase,
        /// Monotonic sequence number from the host; messages older than the
        /// last applied phase are ignored so a rapid loading -> idle burst
        /// can never leave the pill on a stale phase.
        #[serde(default)]
        seq: u64,
    },
    Levels {
        levels: Vec<f32>,
    },
    StyleInfo {
        count: u32,
        name: String,
    },
    Visibility {
        visibility: Visibility,
    },
    WindowSize {
        size: String,
    },
    Toast {
        message: String,
        toast_type: Option<String>,
        duration: Option<f64>,
        action: Option<String>,
        action_label: Option<String>,
        #[serde(default)]
        reject_action: Option<String>,
        #[serde(default)]
        reject_action_label: Option<String>,
    },
    DismissToast,
    Fireworks {
        message: String,
    },
    Flame {
        message: String,
    },
    FlashBlue,
    /// Replay the long-press outline at the pill's current position. Visual
    /// only: no pointer, drag or long-press state is touched.
    Locate,
    BroadcastTranscript {
        text: String,
    },
    StageText {
        text: Option<String>,
    },
    AssistantState {
        active: bool,
        input_mode: String,
        compact: bool,
        conversation_id: Option<String>,
        user_prompt: Option<String>,
        messages: Vec<PillMessage>,
        streaming: Option<PillStreaming>,
        permissions: Vec<PillPermission>,
        /// Transcript awaiting a review decision, if any.
        ///
        /// Boxed: a review carries five localized captions, which makes this
        /// variant much larger than its neighbours. Boxing keeps the enum at
        /// the size of its largest other field, and a review arrives once per
        /// sync rather than once per frame.
        #[serde(default)]
        review: Option<Box<PillReview>>,
    },
    /// Clears the saved position; `strategy` picks which monitor the pill
    /// re-homes onto ("current" = the monitor it lives on, "cursor" = the
    /// monitor under the pointer).
    ResetPosition {
        #[serde(default)]
        strategy: ResetStrategy,
    },
    /// Screen edge the pill anchors to. Only the Win32 pill acts on it; the
    /// desktop sends it to every platform, so the others accept and ignore it
    /// rather than logging it as an unparseable message.
    PillPlacement {
        placement: String,
    },
    /// Ask the pill to re-publish its current geometry.
    ///
    /// The pill only emits `PositionChanged` when the user moves it, so a
    /// freshly started session has no geometry on the desktop side and
    /// windows anchored to the pill (the review composer) fall back to the
    /// OS-centred placement. The desktop asks for the geometry once the
    /// listener is live instead of waiting for the first drag.
    RequestPosition,
    Quit,
}

/// Messages the pill sends back to the desktop.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutMessage {
    Ready,
    Hover {
        hovered: bool,
    },
    Click,
    StyleSwitch {
        direction: String,
    },
    AgentTalk,
    AssistantClose,
    EnableTypeMode,
    TypedMessage {
        text: String,
    },
    OpenConversation {
        conversation_id: String,
    },
    ResolvePermission {
        permission_id: String,
        status: String,
        always_allow: bool,
    },
    CancelDictation,
    PauseDictation,
    ResumeDictation,
    ToastAction {
        action: String,
    },
    /// The user's decision on the transcript under review.
    /// `action` is one of "insert", "copy", "cancel", "open", "edit" -- the
    /// variants of the desktop's `PillReviewAction`.
    ///
    /// `text` carries what the entry holds for Insert, Copy, and Open. Open
    /// lets the desktop preserve the edited text before it settles the
    /// review; Cancel leaves it out.
    ReviewDecision {
        review_id: String,
        action: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    PositionChanged {
        has_saved_position: bool,
        rect: Option<Rect>,
        monitor: Option<Rect>,
    },
    /// Haptic/audio feedback request for the desktop process.
    /// `kind` values: "press", "deep", "release".
    HapticFeedback {
        kind: String,
    },
}

/// Writes one message to the desktop as a single JSON line on stdout.
///
/// Returns whether the bytes were actually handed to the pipe: a write to a
/// closed pipe is how the pill learns the desktop went away.
pub fn write_message(msg: &OutMessage) -> bool {
    let mut stdout = std::io::stdout().lock();
    if serde_json::to_writer(&mut stdout, msg).is_err() {
        return false;
    }
    if stdout.write_all(b"\n").is_err() {
        return false;
    }
    stdout.flush().is_ok()
}

/// Reads newline-delimited JSON from stdin on a background thread, handing
/// each decoded message to `sender` and a final [`InMessage::Quit`] when the
/// stream ends or the receiver goes away.
pub fn start_stdin_reader(sender: std::sync::mpsc::Sender<InMessage>) {
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let reader = stdin.lock();
        for line in std::io::BufRead::lines(reader) {
            let Ok(line) = line else { break };
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<InMessage>(&line) {
                Ok(msg) => {
                    if sender.send(msg).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    eprintln!("[pill] bad message: {e}");
                }
            }
        }
        let _ = sender.send(InMessage::Quit);
    });
}

#[cfg(test)]
mod review_localization_tests {
    use super::PillReview;

    #[test]
    fn review_edit_label_accepts_legacy_and_localized_payloads() {
        let legacy: PillReview = serde_json::from_str(r#"{"id":"r1","text":"draft"}"#).unwrap();
        assert!(legacy.edit_label.is_none());
        let localized: PillReview =
            serde_json::from_str(r#"{"id":"r1","text":"draft","edit_label":"Bearbeiten"}"#)
                .unwrap();
        assert_eq!(localized.edit_label.as_deref(), Some("Bearbeiten"));
        assert_eq!(localized.text, "draft");
    }

    /// Every caption the pill draws for a review has to arrive from the desktop
    /// locale. A sender that omits one must still parse, so the draw site can
    /// fall back rather than the pill refusing the whole review.
    #[test]
    fn review_captions_default_to_none_and_accept_every_locale() {
        let legacy: PillReview = serde_json::from_str(r#"{"id":"r1","text":"draft"}"#).unwrap();
        assert!(legacy.insert_label.is_none());
        assert!(legacy.copy_label.is_none());
        assert!(legacy.cancel_label.is_none());
        assert!(legacy.hint.is_none());

        let localized: PillReview = serde_json::from_str(
            r#"{
                "id":"r1",
                "text":"draft",
                "edit_label":"Bearbeiten",
                "insert_label":"Einfuegen",
                "copy_label":"Kopieren",
                "cancel_label":"Abbrechen",
                "hint":"Unten bearbeiten, dann Enter druecken"
            }"#,
        )
        .unwrap();
        assert_eq!(localized.edit_label.as_deref(), Some("Bearbeiten"));
        assert_eq!(localized.insert_label.as_deref(), Some("Einfuegen"));
        assert_eq!(localized.copy_label.as_deref(), Some("Kopieren"));
        assert_eq!(localized.cancel_label.as_deref(), Some("Abbrechen"));
        assert_eq!(
            localized.hint.as_deref(),
            Some("Unten bearbeiten, dann Enter druecken"),
        );
    }

    /// The review variant is boxed so a five-caption review does not inflate the
    /// whole message enum. This pins the wire shape, because a boxed field
    /// still deserializes from the same flat JSON object.
    #[test]
    fn the_boxed_review_variant_still_reads_a_flat_json_object() {
        #[derive(serde::Deserialize)]
        struct Wrapper {
            review: Option<Box<PillReview>>,
        }
        let parsed: Wrapper = serde_json::from_str(
            r#"{"review":{"id":"r1","text":"draft","insert_label":"Einfuegen"}}"#,
        )
        .unwrap();
        let review = parsed.review.expect("review should be present");
        assert_eq!(review.id, "r1");
        assert_eq!(review.insert_label.as_deref(), Some("Einfuegen"));
    }
}
