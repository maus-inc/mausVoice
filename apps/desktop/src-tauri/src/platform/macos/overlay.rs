use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;

use tauri::{Emitter, Manager};

use crate::domain::{OverlayPhase, PillWindowSize};
use rust_macos_pill::ipc::{InMessage, OutMessage, Phase, ResetStrategy, Visibility};

/// Monotonic sequence number for phase messages (mirrors `pill_process.rs`);
/// lets the pill ignore stale/duplicate phase writes.
static PHASE_SEQ: AtomicU64 = AtomicU64::new(0);

struct MacosPill {
    /// `None` once the pill's channel has closed. Tauri's manager cannot forget
    /// a managed state, so the sender is the only thing that says the pill is
    /// still there; see `retire`.
    sender: Mutex<Option<mpsc::Sender<InMessage>>>,
    /// Set by the first message that could not be handed over. Audio levels
    /// are sent on every frame, so a pill that has gone away would otherwise
    /// write a warning sixty times a second.
    delivery_failed: AtomicBool,
}

impl MacosPill {
    /// Hand a message to the pill thread.
    ///
    /// Both failures are real: a poisoned lock means another thread panicked
    /// while holding the sender, and a closed channel means the pill is gone.
    /// Either way the message was not delivered, so the caller is told.
    ///
    /// A closed channel is also the only trustworthy end-of-pill signal the
    /// desktop side has, so it is where the pill is retired — see
    /// [`MacosPill::retire`] for why the out channel cannot be that signal.
    fn send(&self, msg: InMessage) -> Result<(), String> {
        // The lock is released before the failure is handled: `retire` takes
        // the same one and `std::sync::Mutex` is not reentrant.
        let delivered = {
            let sender = self
                .sender
                .lock()
                .map_err(|_| "macOS pill channel is poisoned".to_string())?;
            let sender = sender
                .as_ref()
                .ok_or_else(|| "macOS pill is no longer running".to_string())?;
            sender.send(msg).is_ok()
        };
        if !delivered {
            self.retire();
            return Err("macOS pill is no longer receiving messages".to_string());
        }

        Ok(())
    }

    /// Send a message whose sender has nothing to do about a failure. The
    /// message is still lost, so the first one is reported and the rest are
    /// left at debug level.
    fn send_or_log(&self, msg: InMessage) {
        if let Err(err) = self.send(msg) {
            if self.delivery_failed.fetch_or(true, Ordering::Relaxed) {
                log::debug!("Native pill message not delivered: {err}");
            } else {
                log::warn!("Native pill message not delivered: {err}");
            }
        }
    }

    /// Report the pill as gone and take the sender out.
    ///
    /// The pill's own receiver is `in_rx`, handed to `app::run_embedded` on the
    /// main thread, and it is dropped when the pill's run loop dies. That
    /// disconnect is the end of the pill, and [`MacosPill::send`] retires here
    /// because it is the only observer of it that can fire while the app runs.
    ///
    /// The reader thread in `start_out_reader` cannot be: it waits on `out_rx`,
    /// whose only `Sender` was handed to `ipc::set_out_sender`, which stores it
    /// in a `thread_local!` on the main thread (`try_create_native_overlays`
    /// calls `rust_macos_pill::start` there). That sender is dropped when the
    /// main thread exits, so `out_rx.recv()` never returns during the app's
    /// life. Hooking retirement to it — which is what this used to do — left the
    /// hook unreachable and the managed state holding a sender that could never
    /// be cleared.
    ///
    /// The managed state outlives the pill, and leaving the sender installed
    /// meant every later update failed one message at a time while the frontend
    /// went on treating the native pill as available: the position commands
    /// kept reporting a pill they could not reach, and the other notifiers
    /// looked as delivered when nothing was. Clearing the sender is what makes
    /// one state answer both questions. The warning flag goes with it, because
    /// the failure is reported here — a later update that finds no sender is
    /// expected and stays at debug.
    fn retire(&self) {
        if let Ok(mut sender) = self.sender.lock() {
            sender.take();
        }
        self.delivery_failed.store(true, Ordering::Relaxed);
    }
}

pub fn try_create_native_overlays(app: &tauri::AppHandle) -> bool {
    let (in_tx, in_rx) = mpsc::channel::<InMessage>();
    let (out_tx, out_rx) = mpsc::channel::<OutMessage>();

    // Start the pill on the main thread (Tauri setup runs on main thread)
    rust_macos_pill::start(out_tx, in_rx);

    let pill = std::sync::Arc::new(MacosPill {
        sender: Mutex::new(Some(in_tx)),
        delivery_failed: AtomicBool::new(false),
    });
    app.manage(pill);

    start_out_reader(app.clone(), out_rx);

    log::info!("Using native macOS pill overlay (embedded)");
    true
}

pub fn notify_phase(app: &tauri::AppHandle, phase: &OverlayPhase) {
    if let Some(pill) = app.try_state::<std::sync::Arc<MacosPill>>() {
        let phase = match phase {
            OverlayPhase::Idle => Phase::Idle,
            OverlayPhase::Recording => Phase::Recording,
            OverlayPhase::Loading => Phase::Loading,
            OverlayPhase::Paused => Phase::Paused,
        };
        let seq = PHASE_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
        pill.send_or_log(InMessage::Phase { phase, seq });
    }
}

pub fn notify_audio_levels(app: &tauri::AppHandle, levels: &[f32]) {
    if let Some(pill) = app.try_state::<std::sync::Arc<MacosPill>>() {
        pill.send_or_log(InMessage::Levels {
            levels: levels.to_vec(),
        });
    }
}

pub fn notify_visibility(app: &tauri::AppHandle, visibility: &str) {
    if let Some(pill) = app.try_state::<std::sync::Arc<MacosPill>>() {
        let visibility = match visibility {
            "hidden" => Visibility::Hidden,
            "persistent" => Visibility::Persistent,
            _ => Visibility::WhileActive,
        };
        pill.send_or_log(InMessage::Visibility { visibility });
    }
}

pub fn notify_pill_placement(_app: &tauri::AppHandle, placement: &str) {
    // The macOS pill (rust_macos_pill) is the embedded in-process pill and
    // currently only supports a bottom-anchored layout, so the user's
    // `pillPlacement` preference is recorded by the host but not pushed to
    // the native pill yet. The overlay.rs surface stays consistent across
    // platforms so the host code does not need to special-case macOS.
    log::debug!("Pill placement preference received: {placement}");
}

/// Logs style info instead of forwarding it: the macOS pill is rendered by
/// SwiftUI in-process and reads style state from the app store directly.
pub fn notify_style_info(app: &tauri::AppHandle, count: u32, name: &str) {
    if let Some(pill) = app.try_state::<std::sync::Arc<MacosPill>>() {
        pill.send_or_log(InMessage::StyleInfo {
            count,
            name: name.to_string(),
        });
    }
}

pub fn notify_pill_window_size(app: &tauri::AppHandle, size: &PillWindowSize) {
    if let Some(pill) = app.try_state::<std::sync::Arc<MacosPill>>() {
        let size_str = match size {
            PillWindowSize::Dictation => "dictation",
            PillWindowSize::AssistantCompact => "assistant_compact",
            PillWindowSize::AssistantExpanded => "assistant_expanded",
            PillWindowSize::AssistantTyping => "assistant_typing",
        };
        pill.send_or_log(InMessage::WindowSize {
            size: size_str.to_string(),
        });
    }
}

pub fn notify_assistant_state(app: &tauri::AppHandle, payload: &str) {
    if let Some(pill) = app.try_state::<std::sync::Arc<MacosPill>>() {
        match serde_json::from_str::<InMessage>(payload) {
            Ok(msg) => pill.send_or_log(msg),
            // The payload is built by the desktop side, so a parse failure is a
            // bug in that builder. Saying so beats a pill that quietly stops
            // following the assistant.
            Err(err) => log::warn!("Ignoring malformed assistant state: {err}"),
        }
    }
}

pub fn notify_request_position(app: &tauri::AppHandle) -> Result<(), String> {
    match app.try_state::<std::sync::Arc<MacosPill>>() {
        Some(pill) => pill.send(InMessage::RequestPosition),
        None => Err("Pill position requested with no managed macOS pill".to_string()),
    }
}

pub fn notify_reset_position(app: &tauri::AppHandle, strategy: &str) -> Result<(), String> {
    let strategy = if strategy == "cursor" {
        ResetStrategy::Cursor
    } else {
        ResetStrategy::Current
    };
    match app.try_state::<std::sync::Arc<MacosPill>>() {
        Some(pill) => pill.send(InMessage::ResetPosition { strategy }),
        None => Err("Reset position requested with no managed macOS pill".to_string()),
    }
}

fn start_out_reader(app: tauri::AppHandle, rx: mpsc::Receiver<OutMessage>) {
    std::thread::spawn(move || {
        while let Ok(msg) = rx.recv() {
            match msg {
                OutMessage::Ready => {
                    log::info!("Native macOS pill ready");
                }
                OutMessage::Click => {
                    let _ = app.emit_to("main", "on-click-dictate", ());
                }
                OutMessage::AgentTalk => {
                    let _ = app.emit_to("main", "on-click-agent-talk", ());
                }
                OutMessage::AssistantClose => {
                    let _ = app.emit_to("main", "assistant-mode-close", ());
                }
                OutMessage::EnableTypeMode => {
                    let _ = app.emit_to("main", "assistant-enable-type-mode", ());
                }
                OutMessage::CancelDictation => {
                    let _ = app.emit_to("main", "cancel-dictation", ());
                }
                OutMessage::PauseDictation => {
                    let _ = app.emit_to("main", "pause-dictation", ());
                }
                OutMessage::ResumeDictation => {
                    let _ = app.emit_to("main", "resume-dictation", ());
                }
                OutMessage::TypedMessage { text } => {
                    let payload = serde_json::json!({ "text": text });
                    let _ = app.emit_to("main", "assistant-typed-message", payload);
                }
                OutMessage::OpenConversation { conversation_id } => {
                    let payload = serde_json::json!({ "conversationId": conversation_id });
                    let _ = app.emit_to("main", "open-pill-conversation", payload);
                    let _ = app.emit_to("main", "assistant-mode-close", ());
                }
                OutMessage::ResolvePermission {
                    permission_id,
                    status,
                    always_allow,
                } => {
                    let payload = serde_json::json!({
                        "permissionId": permission_id,
                        "status": status,
                        "alwaysAllow": always_allow,
                    });
                    let _ = app.emit_to("main", "overlay-resolve-permission", payload);
                }
                OutMessage::ReviewDecision {
                    review_id,
                    action,
                    text,
                } => {
                    // Validate before forwarding, for the same reason the
                    // subprocess bridge does: an action the desktop cannot read
                    // must not be turned into a guess that discards the
                    // transcript.
                    match crate::pill_process::PillReviewAction::parse(&action) {
                        Some(action) if !review_id.is_empty() => {
                            let payload = serde_json::json!({
                                "reviewId": review_id,
                                "action": action.as_str(),
                                "text": text,
                            });
                            if let Err(err) = app.emit_to("main", "pill-review-decision", payload) {
                                log::error!("Failed to deliver a pill review decision: {err}");
                            }
                        }
                        _ => {
                            log::warn!("Ignoring an unreadable review decision from the macOS pill")
                        }
                    }
                }
                OutMessage::StyleSwitch { direction } => {
                    match crate::pill_process::PillStyleSwitchDirection::parse(&direction) {
                        Some(direction) => {
                            crate::pill_process::emit_pill_style_switch(&app, direction);
                        }
                        None => {
                            log::warn!("Ignoring unknown pill style-switch direction: {direction}");
                        }
                    }
                }
                OutMessage::ToastAction { action } => {
                    let payload = serde_json::json!({ "action": action });
                    let _ = app.emit_to("main", "toast-action", payload);
                }
                OutMessage::HapticFeedback { kind } => {
                    crate::system::audio_feedback::play_thock(&kind);
                }
                OutMessage::Hover { .. } => {}
                OutMessage::PositionChanged {
                    has_saved_position,
                    rect,
                    monitor,
                } => {
                    let rect_json = rect.map(|r| {
                        serde_json::json!({ "x": r.x, "y": r.y, "width": r.width, "height": r.height })
                    });
                    let monitor_json = monitor.map(|m| {
                        serde_json::json!({ "x": m.x, "y": m.y, "width": m.width, "height": m.height })
                    });
                    let payload = serde_json::json!({
                        "hasSavedPosition": has_saved_position,
                        "rect": rect_json,
                        "monitor": monitor_json,
                    });
                    let _ = app.emit_to("main", "pill-position-changed", payload);
                }
            }
        }
        // The out channel closing is not the pill ending: its only `Sender` lives
        // in a `thread_local!` on the main thread, so this loop normally only
        // unwinds while the app is shutting down. The pill's own lifetime is
        // observed in `MacosPill::send`, off the in-channel disconnect. Keep
        // this as the teardown log it actually is, rather than a second and
        // unreachable retirement hook.
        log::info!("Native macOS pill out channel closed");
    });
}
