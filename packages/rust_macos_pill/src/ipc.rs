use std::cell::RefCell;
use std::io::{self, BufRead, Write};
use std::sync::mpsc::Sender;

use serde::{Deserialize, Serialize};

/// Axis-aligned screen rectangle in logical pixels. The macOS pill flips
/// AppKit's bottom-up (y-up) frames into this top-left, y-down space before
/// emitting, so the values match what Tauri expects for window placement.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

thread_local! {
    static OUT_SENDER: RefCell<Option<Sender<OutMessage>>> = const { RefCell::new(None) };
}

#[allow(dead_code)]
pub fn set_out_sender(sender: Sender<OutMessage>) {
    OUT_SENDER.with(|cell| *cell.borrow_mut() = Some(sender));
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    Hidden,
    WhileActive,
    Persistent,
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
    Levels { levels: Vec<f32> },
    StyleInfo { count: u32, name: String },
    Visibility { visibility: Visibility },
    WindowSize { size: String },
    Toast {
        message: String,
        toast_type: Option<String>,
        duration: Option<f64>,
        action: Option<String>,
        action_label: Option<String>,
    },
    DismissToast,
    Fireworks { message: String },
    Flame { message: String },
    FlashBlue,
    BroadcastTranscript { text: String },
    AssistantState {
        active: bool,
        input_mode: String,
        compact: bool,
        conversation_id: Option<String>,
        user_prompt: Option<String>,
        messages: Vec<PillMessage>,
        streaming: Option<PillStreaming>,
        permissions: Vec<PillPermission>,
    },
    /// Clears the saved position; `strategy` picks which monitor the pill
    /// re-homes onto ("current" = the monitor it lives on, "cursor" = the
    /// monitor under the pointer).
    ResetPosition {
        #[serde(default)]
        strategy: ResetStrategy,
    },
    Quit,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutMessage {
    Ready,
    Hover { hovered: bool },
    Click,
    StyleSwitch { direction: String },
    AgentTalk,
    AssistantClose,
    EnableTypeMode,
    TypedMessage { text: String },
    OpenConversation { conversation_id: String },
    ResolvePermission {
        permission_id: String,
        status: String,
        always_allow: bool,
    },
    CancelDictation,
    PauseDictation,
    ResumeDictation,
    ToastAction { action: String },
    PositionChanged {
        has_saved_position: bool,
        rect: Option<Rect>,
        monitor: Option<Rect>,
    },
}

pub fn send(msg: &OutMessage) {
    let sent_via_channel = OUT_SENDER.with(|cell| {
        cell.borrow()
            .as_ref()
            .map(|s| s.send(msg.clone()).is_ok())
            .unwrap_or(false)
    });
    if !sent_via_channel {
        let mut stdout = io::stdout().lock();
        let _ = serde_json::to_writer(&mut stdout, msg);
        let _ = stdout.write_all(b"\n");
        let _ = stdout.flush();
    }
}

pub fn start_stdin_reader(sender: Sender<InMessage>) {
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let reader = stdin.lock();
        for line in reader.lines() {
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
