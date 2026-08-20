use std::io::{BufRead, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

use crate::domain::{OverlayPhase, PillWindowSize};

pub struct PillProcess {
    _child: Child,
    stdin: Mutex<ChildStdin>,
}

/// Monotonic sequence number for phase messages. A rapid loading -> idle
/// sequence must never leave the pill rendering a stale phase, and a
/// duplicate/late write must not regress the rendered phase.
static PHASE_SEQ: AtomicU64 = AtomicU64::new(0);

impl PillProcess {
    /// Writes one newline-terminated message to the pill's stdin.
    ///
    /// On write failure (broken pipe, pill exited), retries once immediately
    /// and then surfaces the error to the caller instead of only logging it.
    pub fn send(&self, msg: &str) -> Result<(), String> {
        let attempt = |label: &str| -> Result<(), String> {
            let mut stdin = self
                .stdin
                .lock()
                .map_err(|err| format!("failed to lock pill stdin: {err}"))?;
            stdin
                .write_all(msg.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush())
                .map_err(|err| format!("{label}: {err}"))
        };

        if let Err(first) = attempt("failed to write to pill process") {
            let second = attempt("retry failed to write to pill process");
            let error = match second {
                Ok(()) => {
                    log::warn!(
                        "Pill stdin write succeeded on retry (first attempt failed: {first})"
                    );
                    return Ok(());
                }
                Err(second) => format!("{first}; {second}"),
            };
            log::error!("Pill stdin write failed: {error}");
            return Err(error);
        }

        Ok(())
    }
}

pub fn try_spawn_pill(app: &tauri::AppHandle, pill_path: &std::path::Path) -> bool {
    let spawn_time = Instant::now();
    log::info!("Spawning pill overlay from: {}", pill_path.display());

    let mut command = Command::new(pill_path);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            log::warn!("Failed to spawn pill overlay: {err}");
            return false;
        }
    };

    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            log::warn!("Pill overlay process has no stdin");
            return false;
        }
    };

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            log::warn!("Pill overlay process has no stdout");
            return false;
        }
    };

    let reader = match wait_for_ready(stdout, &mut child) {
        Some(reader) => reader,
        None => {
            let _ = child.kill();
            return false;
        }
    };

    let process = std::sync::Arc::new(PillProcess {
        _child: child,
        stdin: Mutex::new(stdin),
    });

    app.manage(process);

    start_stdout_reader(app.clone(), reader);

    log::info!(
        "Native pill overlay is active (initialized in {:.1}s)",
        spawn_time.elapsed().as_secs_f64()
    );
    true
}

pub fn notify_phase(app: &tauri::AppHandle, phase: &OverlayPhase) {
    if let Some(pill) = app.try_state::<std::sync::Arc<PillProcess>>() {
        let phase_str = match phase {
            OverlayPhase::Idle => "idle",
            OverlayPhase::Recording => "recording",
            OverlayPhase::Loading => "loading",
            OverlayPhase::Paused => "paused",
        };
        let seq = PHASE_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
        let msg = format!(r#"{{"type":"phase","phase":"{phase_str}","seq":{seq}}}"#);
        if let Err(err) = pill.send(&msg) {
            log::error!("Failed to notify pill of phase {phase_str}: {err}");
        }
    }
}

pub fn notify_audio_levels(app: &tauri::AppHandle, levels: &[f32]) {
    if let Some(pill) = app.try_state::<std::sync::Arc<PillProcess>>() {
        if let Ok(json) =
            serde_json::to_string(&serde_json::json!({"type": "levels", "levels": levels}))
        {
            if let Err(err) = pill.send(&json) {
                log::error!("Failed to notify pill of audio levels: {err}");
            }
        }
    }
}

pub fn notify_visibility(app: &tauri::AppHandle, visibility: &str) {
    if let Some(pill) = app.try_state::<std::sync::Arc<PillProcess>>() {
        let msg = format!(r#"{{"type":"visibility","visibility":"{visibility}"}}"#);
        if let Err(err) = pill.send(&msg) {
            log::error!("Failed to notify pill of visibility: {err}");
        }
    }
}

pub fn notify_style_info(app: &tauri::AppHandle, count: u32, name: &str) {
    if let Some(pill) = app.try_state::<std::sync::Arc<PillProcess>>() {
        if let Ok(json) = serde_json::to_string(&serde_json::json!({
            "type": "style_info",
            "count": count,
            "name": name,
        })) {
            if let Err(err) = pill.send(&json) {
                log::error!("Failed to notify pill of style info: {err}");
            }
        }
    }
}

pub fn notify_pill_window_size(app: &tauri::AppHandle, size: &PillWindowSize) {
    if let Some(pill) = app.try_state::<std::sync::Arc<PillProcess>>() {
        let size_str = match size {
            PillWindowSize::Dictation => "dictation",
            PillWindowSize::AssistantCompact => "assistant_compact",
            PillWindowSize::AssistantExpanded => "assistant_expanded",
            PillWindowSize::AssistantTyping => "assistant_typing",
        };
        let msg = format!(r#"{{"type":"window_size","size":"{size_str}"}}"#);
        if let Err(err) = pill.send(&msg) {
            log::error!("Failed to notify pill of window size: {err}");
        }
    }
}

pub fn notify_assistant_state(app: &tauri::AppHandle, payload: &str) {
    if let Some(pill) = app.try_state::<std::sync::Arc<PillProcess>>() {
        if let Err(err) = pill.send(payload) {
            log::error!("Failed to notify pill of assistant state: {err}");
        }
    }
}

pub fn notify_reset_position(app: &tauri::AppHandle, strategy: &str) -> Result<(), String> {
    match app.try_state::<std::sync::Arc<PillProcess>>() {
        Some(pill) => {
            let msg = format!(r#"{{"type":"reset_position","strategy":"{strategy}"}}"#);
            pill.send(&msg)
                .map_err(|err| format!("failed to reset pill position: {err}"))
        }
        None => Err("Reset position requested with no managed pill process".to_string()),
    }
}

pub fn resolve_pill_binary_in_resources(
    app: &tauri::AppHandle,
    binary_name: &str,
) -> Option<std::path::PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let path = resource_dir.join("resources").join(binary_name);
        if path.exists() {
            return Some(path);
        }
    }
    None
}

pub fn resolve_pill_binary_in_dev(
    package_dir_name: &str,
    binary_name: &str,
) -> Option<std::path::PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent();
    while let Some(d) = dir {
        let dev_path = d
            .join("packages")
            .join(package_dir_name)
            .join("target/debug")
            .join(binary_name);
        if dev_path.exists() {
            return Some(dev_path);
        }
        dir = d.parent();
    }
    None
}

fn wait_for_ready(
    stdout: ChildStdout,
    child: &mut Child,
) -> Option<std::io::BufReader<ChildStdout>> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(None);
                    return;
                }
                Ok(_) => {
                    if line.contains("\"ready\"") {
                        let _ = tx.send(Some(reader));
                        return;
                    }
                }
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(result) => return result,
            Err(RecvTimeoutError::Disconnected) => {
                log::warn!("Pill overlay reader thread died");
                return None;
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Ok(Some(status)) = child.try_wait() {
                    log::warn!("Pill overlay exited before ready (status: {status})");
                    return None;
                }
                if Instant::now() >= deadline {
                    log::warn!("Pill overlay did not report ready (timed out after 30s)");
                    return None;
                }
            }
        }
    }
}

fn start_stdout_reader(app: tauri::AppHandle, reader: std::io::BufReader<ChildStdout>) {
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if line.contains("\"click\"") {
                        let _ = app.emit_to("main", "on-click-dictate", ());
                    } else if line.contains("\"agent_talk\"") {
                        let _ = app.emit_to("main", "on-click-agent-talk", ());
                    } else if line.contains("\"assistant_close\"") {
                        let _ = app.emit_to("main", "assistant-mode-close", ());
                    } else if line.contains("\"enable_type_mode\"") {
                        let _ = app.emit_to("main", "assistant-enable-type-mode", ());
                    } else if line.contains("\"cancel_dictation\"") {
                        let _ = app.emit_to("main", "cancel-dictation", ());
                    } else if line.contains("\"pause_dictation\"") {
                        let _ = app.emit_to("main", "pause-dictation", ());
                    } else if line.contains("\"resume_dictation\"") {
                        let _ = app.emit_to("main", "resume-dictation", ());
                    } else if line.contains("\"typed_message\"") {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                            if let Some(text) = val.get("text").and_then(|v| v.as_str()) {
                                let payload = serde_json::json!({ "text": text });
                                let _ = app.emit_to("main", "assistant-typed-message", payload);
                            }
                        }
                    } else if line.contains("\"open_conversation\"") {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                            if let Some(id) = val.get("conversation_id").and_then(|v| v.as_str()) {
                                let payload = serde_json::json!({ "conversationId": id });
                                let _ = app.emit_to("main", "open-pill-conversation", payload);
                            }
                        }
                        let _ = app.emit_to("main", "assistant-mode-close", ());
                    } else if line.contains("\"resolve_permission\"") {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                            let permission_id = val
                                .get("permission_id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let status = val
                                .get("status")
                                .and_then(|v| v.as_str())
                                .unwrap_or("denied");
                            let always_allow = val
                                .get("always_allow")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            let payload = serde_json::json!({
                                "permissionId": permission_id,
                                "status": status,
                                "alwaysAllow": always_allow,
                            });
                            let _ = app.emit_to("main", "overlay-resolve-permission", payload);
                        }
                    } else if line.contains("\"style_switch\"") {
                        // Cheap pre-filter so we only attempt JSON parsing (and
                        // can only emit a parse warning) for lines that actually
                        // claim to be a style switch, not every misc stdout line.
                        if let Some(direction) = parse_style_switch_direction(&line) {
                            emit_pill_style_switch(&app, direction);
                        }
                    } else if line.contains("\"toast_action\"") {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                            if let Some(action) = val.get("action").and_then(|v| v.as_str()) {
                                let payload = serde_json::json!({ "action": action });
                                let _ = app.emit_to("main", "toast-action", payload);
                            }
                        }
                    } else if line.contains("\"haptic_feedback\"") {
                        // A23: Thock haptics - play audio feedback for pill gestures.
                        if let Ok(val) =
                            serde_json::from_str::<serde_json::Value>(&line)
                        {
                            if let Some(kind) =
                                val.get("kind").and_then(|v| v.as_str())
                            {
                                crate::system::audio_feedback::play_thock(kind);
                            }
                        }
                    } else if line.contains("\"position_changed\"") {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                            let has_saved = val
                                .get("has_saved_position")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            // Forward any real pill + monitor geometry the sidecar
                            // emits (when present) so the composer can anchor next
                            // to the actual pill instead of falling back to OS
                            // placement. Absent fields serialize to null and the
                            // TypeScript consumer treats them as "unknown".
                            let rect = val.get("rect").cloned().filter(|v| v.is_object());
                            let monitor = val
                                .get("monitor")
                                .cloned()
                                .filter(|v| v.is_object());
                            let payload = serde_json::json!({
                                "hasSavedPosition": has_saved,
                                "rect": rect,
                                "monitor": monitor,
                            });
                            let _ = app.emit_to("main", "pill-position-changed", payload);
                        }
                    }
                }
            }
        }
        log::info!("Pill overlay process stdout closed");
    });
}

/// Direction of a pill style switch. A closed enum lets the emit path match
/// exhaustively instead of defensively warning on a value the parser already
/// guarantees is valid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PillStyleSwitchDirection {
    Forward,
    Backward,
}

impl PillStyleSwitchDirection {
    /// Case-insensitive parse from the direction string the pills emit.
    pub fn parse(direction: &str) -> Option<Self> {
        if direction.eq_ignore_ascii_case("forward") {
            Some(Self::Forward)
        } else if direction.eq_ignore_ascii_case("backward") {
            Some(Self::Backward)
        } else {
            None
        }
    }
}

/// Parsed `style_switch` direction from a pill stdout line.
///
/// Accepts the serde-tagged JSON the pills emit
/// (`{"type":"style_switch","direction":"forward"}`) and is case-insensitive
/// on `direction` so a casing drift cannot silently drop the click.
pub(crate) fn parse_style_switch_direction(line: &str) -> Option<PillStyleSwitchDirection> {
    let trimmed = line.trim();
    let value: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(error) => {
            // Distinguish unparseable lines from valid-but-unsupported payloads:
            // a JSON parse failure here is genuinely malformed pill output and
            // warrants its own warning rather than a silent `None`.
            log::warn!("Ignoring unparseable pill line {trimmed:?}: {error}");
            return None;
        }
    };
    if value.get("type").and_then(|v| v.as_str()) != Some("style_switch") {
        return None;
    }
    let Some(raw_direction) = value.get("direction").and_then(|v| v.as_str()) else {
        log::warn!("Ignoring pill style-switch line missing direction: {trimmed}");
        return None;
    };
    match PillStyleSwitchDirection::parse(raw_direction) {
        Some(direction) => Some(direction),
        None => {
            log::warn!(
                "Ignoring unknown pill style-switch direction from line: {trimmed}"
            );
            None
        }
    }
}

/// Tauri event names the pill bridge emits for a chevron click. These must
/// stay in sync with the `useTauriListen` event strings in
/// `DictationSideEffects.tsx` (currently the hard-coded `"tone-switch-forward"`
/// / `"tone-switch-backward"` listeners), which are the webview's counterpart.
pub const PILL_STYLE_SWITCH_FORWARD_EVENT: &str = "tone-switch-forward";
pub const PILL_STYLE_SWITCH_BACKWARD_EVENT: &str = "tone-switch-backward";

/// Emit the pill chevron click to the desktop webview.
///
/// Prefer the main window (dictation is owned there) but fall back to a
/// broadcast so a hidden/relabeled window cannot swallow the switch.
pub fn emit_pill_style_switch(app: &tauri::AppHandle, direction: PillStyleSwitchDirection) {
    let event = match direction {
        PillStyleSwitchDirection::Forward => PILL_STYLE_SWITCH_FORWARD_EVENT,
        PillStyleSwitchDirection::Backward => PILL_STYLE_SWITCH_BACKWARD_EVENT,
    };
    log::debug!("Pill style switch: {direction:?}");
    if let Err(err) = app.emit_to("main", event, ()) {
        log::warn!("Failed to emit {event} to main: {err}; broadcasting");
        if let Err(err) = app.emit(event, ()) {
            log::error!("Failed to broadcast {event}: {err}");
        }
    }
}

#[cfg(test)]
mod style_switch_parse_tests {
    use super::{parse_style_switch_direction, PillStyleSwitchDirection};

    #[test]
    fn parses_canonical_pill_line() {
        assert_eq!(
            parse_style_switch_direction(
                r#"{"type":"style_switch","direction":"forward"}"#
            ),
            Some(PillStyleSwitchDirection::Forward)
        );
        assert_eq!(
            parse_style_switch_direction(
                r#"{"type":"style_switch","direction":"backward"}"#
            ),
            Some(PillStyleSwitchDirection::Backward)
        );
    }

    #[test]
    fn accepts_trailing_newline_and_mixed_case() {
        assert_eq!(
            parse_style_switch_direction(
                "{\"type\":\"style_switch\",\"direction\":\"Forward\"}\n"
            ),
            Some(PillStyleSwitchDirection::Forward)
        );
        assert_eq!(
            parse_style_switch_direction(
                "{\"type\":\"style_switch\",\"direction\":\"BACKWARD\"}\r\n"
            ),
            Some(PillStyleSwitchDirection::Backward)
        );
    }

    #[test]
    fn rejects_malformed_or_unrelated_lines() {
        assert_eq!(
            parse_style_switch_direction(r#"{"type":"click"}"#),
            None
        );
        assert_eq!(
            parse_style_switch_direction(r#"{"type":"style_switch","direction":"sideways"}"#),
            None
        );
        assert_eq!(parse_style_switch_direction("not json"), None);
        assert_eq!(
            parse_style_switch_direction(r#"{"type":"style_info","name":"forward"}"#),
            None
        );
    }
}
