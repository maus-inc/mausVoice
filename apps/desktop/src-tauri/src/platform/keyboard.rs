use crate::domain::{
    KeyboardListenerHealthPayload, KeysHeldPayload, EVT_KEYBOARD_LISTENER_HEALTH, EVT_KEYS_HELD,
};
use rdev::{Event, EventType, Key as RdevKey};
use std::collections::HashSet;
use std::env;
use std::io::{BufRead, BufReader, BufWriter, ErrorKind, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter, EventTarget};

use serde::{Deserialize, Serialize};
use strum::IntoEnumIterator;

#[cfg(target_os = "macos")]
pub use super::macos::keyboard::run_listener_process;
#[cfg(target_os = "windows")]
pub use super::windows::keyboard::run_listener_process;

type PressedKeys = Arc<Mutex<HashSet<String>>>;

struct KeyEventEmitter {
    app: AppHandle,
    pressed_keys: PressedKeys,
}
impl KeyEventEmitter {
    fn new(app: &AppHandle) -> Self {
        Self {
            app: app.clone(),
            pressed_keys: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    fn handle_event(&self, event: &Event) {
        if debug_keys_enabled() {
            log::debug!("event: {:?}", event.event_type);
        }

        match event.event_type {
            EventType::KeyPress(key) => {
                self.update_pressed_keys(key, true);
            }
            EventType::KeyRelease(key) => {
                self.update_pressed_keys(key, false);
            }
            _ => {}
        }
    }

    fn update_pressed_keys(&self, key: RdevKey, is_pressed: bool) {
        let key_label = key_to_label(key);
        let mut guard = self
            .pressed_keys
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let changed = if is_pressed {
            guard.insert(key_label.clone())
        } else {
            guard.remove(&key_label)
        };

        if changed {
            let mut snapshot: Vec<String> = guard.iter().cloned().collect();
            snapshot.sort_unstable();
            drop(guard);
            self.emit(keys_payload(snapshot));
        }
    }

    fn reset(&self) {
        let mut guard = self
            .pressed_keys
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.clear();
        drop(guard);
        self.emit(keys_payload(Vec::new()));
    }

    fn emit(&self, payload: KeysHeldPayload) {
        if let Err(err) = self.app.emit_to(EventTarget::any(), EVT_KEYS_HELD, payload) {
            log::error!("Failed to emit keys-held event: {err}");
        }
    }
}

struct ListenerHandle {
    join_handle: JoinHandle<()>,
    running: Arc<AtomicBool>,
    emitter: Arc<KeyEventEmitter>,
}

fn listener_state() -> &'static Mutex<Option<ListenerHandle>> {
    static STATE: OnceLock<Mutex<Option<ListenerHandle>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

/// Observed health of the keyboard listener, grounded in the child's actual grab/listen
/// outcome rather than in OS permission state. Lives in its own static, independent of
/// `listener_state()` (which is `take()`n on stop), so it survives `Stopped`/`Failed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HealthState {
    Starting,
    /// Child is up and speaking the protocol; grab outcome not yet known.
    Connected,
    /// Grab path confirmed alive (no failure within the grace window).
    HealthyGrab,
    /// Child reported `rdev::grab()` failed; fallback not yet started.
    GrabFailed,
    /// Child entered `rdev::listen()` fallback; not yet confirmed alive.
    FallbackStarting,
    /// Fallback confirmed alive (survived the grace window without disconnect).
    DegradedListenFallback,
    Failed,
    Stopped,
}

impl HealthState {
    /// Stable snake-case identifier sent to the frontend.
    fn as_str(self) -> &'static str {
        match self {
            HealthState::Starting => "starting",
            HealthState::Connected => "connected",
            HealthState::HealthyGrab => "healthy_grab",
            HealthState::GrabFailed => "grab_failed",
            HealthState::FallbackStarting => "fallback_starting",
            HealthState::DegradedListenFallback => "degraded_listen_fallback",
            HealthState::Failed => "failed",
            HealthState::Stopped => "stopped",
        }
    }
}

/// Grace window after `Connected` with no `grab_failed` and no disconnect, after which the
/// grab path is inferred healthy. rdev gives no "tap installed" callback, so absence of
/// failure within this window is the strongest positive signal available.
const HEALTHY_GRAB_GRACE: Duration = Duration::from_millis(750);

/// After this many consecutive failed attempts, stop fast-retrying: mark `Failed` and switch
/// to a slow-poll auto-recovery loop. The listener thread stays alive throughout (AC-1).
const FAILURE_CAP: u32 = 5;
/// Backoff after the first failure; doubles each consecutive failure up to `BACKOFF_CEILING`.
const BACKOFF_BASE: Duration = Duration::from_millis(500);
const BACKOFF_CEILING: Duration = Duration::from_secs(5);
/// Retry interval once the failure cap is reached — the Rust-owned auto-recovery poll, so a
/// listener that comes back (e.g. Accessibility re-granted) self-heals without an app restart.
const SLOW_RETRY_INTERVAL: Duration = Duration::from_secs(30);
/// How long to wait for a freshly spawned child to connect before treating it as a failure.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

fn health_state() -> &'static Mutex<HealthState> {
    static STATE: OnceLock<Mutex<HealthState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HealthState::Stopped))
}

/// App handle used to emit health-transition events to the frontend. Stored on
/// `start_key_listener` so `set_health` can emit from any thread (listener loop or grace timer).
fn listener_app() -> &'static Mutex<Option<AppHandle>> {
    static APP: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();
    APP.get_or_init(|| Mutex::new(None))
}

fn emit_health(state: HealthState) {
    let guard = listener_app()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(app) = guard.as_ref() {
        let payload = KeyboardListenerHealthPayload {
            state: state.as_str().to_string(),
        };
        if let Err(err) = app.emit(EVT_KEYBOARD_LISTENER_HEALTH, payload) {
            log::error!("Failed to emit keyboard listener health: {err}");
        }
    }
}

/// Monotonic id for the current child connection. A grace timer captures the generation it
/// was armed for and promotes only if it still matches, so a stale timer cannot promote a
/// later connection.
fn connection_generation() -> &'static AtomicU64 {
    static GENERATION: OnceLock<AtomicU64> = OnceLock::new();
    GENERATION.get_or_init(|| AtomicU64::new(0))
}

fn set_health(state: HealthState) {
    let changed = {
        let mut guard = health_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *guard != state {
            log::info!("Keyboard listener health: {:?} -> {state:?}", *guard);
            *guard = state;
            true
        } else {
            false
        }
    };
    if changed {
        emit_health(state);
    }
}

fn get_health() -> HealthState {
    *health_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Current listener health as a snake-case string, for the `get_key_listener_health` command.
pub fn current_listener_health() -> String {
    get_health().as_str().to_string()
}

/// Per-connection facts recorded by `pump_stream` while the connection is open. Used to
/// classify the connection's outcome at EOF from timing, independent of the live health
/// state (which a racing grace timer may have promoted just before EOF was processed).
#[derive(Debug, Default)]
struct ConnectionOutcome {
    connected_at: Option<Instant>,
    grab_failed: bool,
    fallback_at: Option<Instant>,
}

impl ConnectionOutcome {
    /// Whether this connection actually *survived* the relevant grace window before dropping —
    /// judged from the recorded timestamps, not from whatever the live grace timer happened to
    /// set. This closes the timer-vs-EOF race: a child that exits before proving a path alive
    /// is never mistaken for a transient disconnect, even if its grace timer fired first.
    fn proved_alive(&self) -> bool {
        connection_proved_alive(
            self.connected_at.map(|at| at.elapsed()),
            self.grab_failed,
            self.fallback_at.map(|at| at.elapsed()),
        )
    }
}

fn connection_proved_alive(
    connected_elapsed: Option<Duration>,
    grab_failed: bool,
    fallback_elapsed: Option<Duration>,
) -> bool {
    // Fallback supersedes the grab outcome: if the child entered listen() fallback, the
    // connection is alive only if the fallback itself survived its grace window.
    if let Some(elapsed) = fallback_elapsed {
        return elapsed >= HEALTHY_GRAB_GRACE;
    }
    // Grab path: connected, never reported a grab failure, and survived the grace window.
    if let Some(elapsed) = connected_elapsed {
        return !grab_failed && elapsed >= HEALTHY_GRAB_GRACE;
    }
    false
}

/// Whether a fired grace timer should promote `from` → its target: only if it is still the
/// same connection and the listener has not since moved off `from` (e.g. via `grab_failed`
/// or `listen_fallback`).
fn should_promote(generation_matches: bool, current: HealthState, from: HealthState) -> bool {
    generation_matches && current == from
}

/// Whether the consecutive-failure count has reached the point where we stop fast-retrying.
fn failure_capped(consecutive_failures: u32) -> bool {
    consecutive_failures >= FAILURE_CAP
}

/// Delay before the next attempt: exponential backoff pre-cap (`BACKOFF_BASE` doubling up to
/// `BACKOFF_CEILING`), then the fixed slow-retry interval once capped.
fn retry_backoff(consecutive_failures: u32) -> Duration {
    if failure_capped(consecutive_failures) {
        return SLOW_RETRY_INTERVAL;
    }
    let shift = consecutive_failures.saturating_sub(1).min(16);
    let ms = (BACKOFF_BASE.as_millis() as u64).saturating_mul(1u64 << shift);
    Duration::from_millis(ms).min(BACKOFF_CEILING)
}

fn handle_control_message(state: ControlState, generation: u64) {
    match state {
        ControlState::Connected => {
            set_health(HealthState::Connected);
            arm_grace_promotion(generation, HealthState::Connected, HealthState::HealthyGrab);
        }
        ControlState::GrabFailed => {
            // Unconditional downgrade: covers a grab that failed after being promoted to
            // HealthyGrab. `listen_fallback` may override this upward if fallback starts.
            set_health(HealthState::GrabFailed);
        }
        ControlState::ListenFallback => {
            set_health(HealthState::FallbackStarting);
            arm_grace_promotion(
                generation,
                HealthState::FallbackStarting,
                HealthState::DegradedListenFallback,
            );
        }
    }
}

fn arm_grace_promotion(generation: u64, from: HealthState, to: HealthState) {
    thread::spawn(move || {
        thread::sleep(HEALTHY_GRAB_GRACE);
        let generation_matches = connection_generation().load(Ordering::SeqCst) == generation;
        let promoted = {
            let mut guard = health_state()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if should_promote(generation_matches, *guard, from) {
                log::info!("Keyboard listener health: {from:?} -> {to:?}");
                *guard = to;
                true
            } else {
                false
            }
        };
        if promoted {
            emit_health(to);
        }
    });
}

fn keys_payload(keys: Vec<String>) -> KeysHeldPayload {
    KeysHeldPayload { keys }
}

fn combo_store() -> &'static Mutex<Vec<Vec<String>>> {
    static STORE: OnceLock<Mutex<Vec<Vec<String>>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Vec::new()))
}

fn child_stdin_store() -> &'static Mutex<Option<ChildStdin>> {
    static STORE: OnceLock<Mutex<Option<ChildStdin>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(None))
}

pub fn sync_combos(combos: Vec<Vec<String>>) {
    {
        let mut guard = combo_store()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = combos.clone();
    }

    if let Ok(mut guard) = child_stdin_store().lock() {
        if let Some(stdin) = guard.as_mut() {
            if let Ok(json) = serde_json::to_string(&combos) {
                if let Err(err) = writeln!(stdin, "{json}") {
                    log::error!("Failed to write combos to child stdin: {err}");
                }
                let _ = stdin.flush();
            }
        }
    }
}

pub fn reset_pressed_keys() {
    let state = listener_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if let Some(handle) = state.as_ref() {
        handle.emitter.reset();
    }
}

/// Serializes the whole stop/start sequence. Without this, two overlapping `start_key_listener`
/// calls could each see "nothing to stop", both spawn, and the later store would orphan the
/// first thread + child. Held across the entire stop→spawn→store operation.
fn lifecycle_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn start_key_listener(app: &AppHandle) -> Result<(), String> {
    let _lifecycle = lifecycle_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    stop_listener_locked();

    {
        let mut app_guard = listener_app()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *app_guard = Some(app.clone());
    }

    let mut state = listener_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    log::info!("Starting keyboard listener");
    let emitter = Arc::new(KeyEventEmitter::new(app));
    let (join_handle, running) = start_external_listener(emitter.clone())?;
    *state = Some(ListenerHandle {
        join_handle,
        running,
        emitter,
    });

    Ok(())
}

pub fn stop_key_listener() -> Result<(), String> {
    let _lifecycle = lifecycle_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    stop_listener_locked();
    Ok(())
}

/// Tear down the current listener. Caller must hold `lifecycle_lock`.
fn stop_listener_locked() {
    let handle = {
        let mut state = listener_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.take()
    };

    if let Some(handle) = handle {
        handle.running.store(false, Ordering::SeqCst);
        stop_listener_child();
        if let Err(err) = handle.join_handle.join() {
            log::error!("Keyboard listener thread join failed: {err:?}");
        }
        handle.emitter.reset();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) enum WireEventKind {
    Press,
    Release,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct KeyboardEventPayload {
    pub kind: WireEventKind,
    pub key_label: String,
    pub raw_code: Option<u32>,
    #[serde(default)]
    pub scan_code: u32,
}

/// Control message the child sends to the parent over the same TCP stream as key events,
/// describing the outcome of installing its event tap. Used to drive listener health.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ControlState {
    /// Child is up and speaking the wire protocol (emitted from shared setup).
    Connected,
    /// `rdev::grab()` returned an error; the child is about to fall back to `listen()`.
    GrabFailed,
    /// Child is running via `rdev::listen()` (degraded: no key suppression).
    ListenFallback,
}

/// Tagged wire protocol over the loopback TCP stream. Both ends are the same binary, so
/// there is no backward-compatibility constraint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum WireMessage {
    Key(KeyboardEventPayload),
    Control { state: ControlState },
}

pub(crate) fn debug_keys_enabled() -> bool {
    static DEBUG: OnceLock<bool> = OnceLock::new();
    *DEBUG.get_or_init(|| matches!(env::var("VOQUILL_DEBUG_KEYS"), Ok(value) if value == "1"))
}

fn child_store() -> &'static Mutex<Option<Child>> {
    static CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
    CHILD.get_or_init(|| Mutex::new(None))
}

fn start_external_listener(
    emitter: Arc<KeyEventEmitter>,
) -> Result<(JoinHandle<()>, Arc<AtomicBool>), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|err| format!("failed to bind keyboard listener socket: {err}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|err| format!("failed to configure keyboard listener socket: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("failed to read listener address: {err}"))?
        .port();

    let running = Arc::new(AtomicBool::new(true));
    let thread_running = running.clone();
    let thread_emitter = emitter.clone();

    let handle = thread::spawn(move || {
        run_listener_thread(listener, port, thread_running, thread_emitter);
    });

    Ok((handle, running))
}

enum ConnectResult {
    Connected(TcpStream),
    /// The child did not connect within `CONNECT_TIMEOUT`, or it exited before connecting.
    TimedOut,
    /// The listener was asked to stop while waiting.
    Stopped,
}

/// Wait for the freshly spawned child to connect, bounded by `timeout`. Returns early if the
/// child exits before connecting (avoids waiting the full timeout on a child that crashed) or
/// if the listener is stopping.
fn wait_for_connection(
    listener: &TcpListener,
    running: &AtomicBool,
    timeout: Duration,
) -> ConnectResult {
    let deadline = Instant::now() + timeout;
    while running.load(Ordering::SeqCst) {
        if Instant::now() >= deadline {
            return ConnectResult::TimedOut;
        }
        match listener.accept() {
            Ok((stream, _addr)) => return ConnectResult::Connected(stream),
            Err(err) if err.kind() == ErrorKind::WouldBlock => {
                if listener_child_exited() {
                    return ConnectResult::TimedOut;
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(err) => {
                log::error!("Keyboard listener accept error: {err}");
                return ConnectResult::TimedOut;
            }
        }
    }
    ConnectResult::Stopped
}

fn listener_child_exited() -> bool {
    let mut guard = child_store()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match guard.as_mut() {
        Some(child) => !matches!(child.try_wait(), Ok(None)),
        None => true,
    }
}

/// Sleep for `duration`, but wake promptly if the listener is asked to stop, so a long
/// slow-retry backoff never delays shutdown.
fn interruptible_sleep(duration: Duration, running: &AtomicBool) {
    let deadline = Instant::now() + duration;
    while running.load(Ordering::SeqCst) {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        thread::sleep((deadline - now).min(Duration::from_millis(100)));
    }
}

/// Mark `Failed` once consecutive failures reach the cap, so a persistently broken listener
/// settles on a single terminal state instead of flapping through intermediate states.
fn register_failure(consecutive_failures: u32) {
    if failure_capped(consecutive_failures) {
        set_health(HealthState::Failed);
        log::warn!(
            "Keyboard listener failed {consecutive_failures} consecutive attempts; slow-retrying"
        );
    }
}

fn run_listener_thread(
    listener: TcpListener,
    port: u16,
    running: Arc<AtomicBool>,
    emitter: Arc<KeyEventEmitter>,
) {
    set_health(HealthState::Starting);
    let mut consecutive_failures: u32 = 0;

    while running.load(Ordering::SeqCst) {
        if let Err(err) = ensure_listener_child(port) {
            log::error!("Keyboard listener child error: {err}");
            consecutive_failures = consecutive_failures.saturating_add(1);
            register_failure(consecutive_failures);
            interruptible_sleep(retry_backoff(consecutive_failures), &running);
            continue;
        }

        match wait_for_connection(&listener, &running, CONNECT_TIMEOUT) {
            ConnectResult::Connected(stream) => {
                let generation = connection_generation().fetch_add(1, Ordering::SeqCst) + 1;

                let outcome = pump_stream(stream, emitter.clone(), generation);
                emitter.reset();

                // Invalidate any grace timer still pending for this connection, then reap the
                // now-disconnected child so the next iteration always respawns fresh.
                connection_generation().fetch_add(1, Ordering::SeqCst);
                stop_listener_child();

                if !running.load(Ordering::SeqCst) {
                    break;
                }

                if outcome.proved_alive() {
                    consecutive_failures = 0;
                } else {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    register_failure(consecutive_failures);
                    interruptible_sleep(retry_backoff(consecutive_failures), &running);
                }
            }
            ConnectResult::TimedOut => {
                log::warn!("Keyboard listener child did not connect within {CONNECT_TIMEOUT:?}");
                stop_listener_child();
                consecutive_failures = consecutive_failures.saturating_add(1);
                register_failure(consecutive_failures);
                interruptible_sleep(retry_backoff(consecutive_failures), &running);
            }
            ConnectResult::Stopped => break,
        }
    }

    set_health(HealthState::Stopped);
    stop_listener_child();
}

fn spawn_listener_child(port: u16) -> Result<Child, String> {
    let exe = std::env::current_exe()
        .map_err(|err| format!("failed to resolve current executable: {err}"))?;

    let mut command = Command::new(exe);
    command
        .env("VOQUILL_KEYBOARD_LISTENER", "1")
        .env("VOQUILL_KEYBOARD_PORT", port.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
        .spawn()
        .map_err(|err| format!("failed to spawn keyboard listener process: {err}"))
}

fn ensure_listener_child(port: u16) -> Result<(), String> {
    let should_spawn = {
        let mut guard = child_store()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(Some(_status)) => {
                    *guard = None;
                    true
                }
                Ok(None) => {
                    return Ok(());
                }
                Err(err) => {
                    log::warn!("Keyboard listener child wait failed: {err}");
                    *guard = None;
                    true
                }
            }
        } else {
            true
        }
    };

    if !should_spawn {
        return Ok(());
    }

    let mut child = spawn_listener_child(port)?;

    let stdin = child.stdin.take();
    {
        let mut stdin_guard = child_stdin_store()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *stdin_guard = stdin;
    }

    {
        let combos = combo_store()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if !combos.is_empty() {
            if let Ok(mut guard) = child_stdin_store().lock() {
                if let Some(stdin) = guard.as_mut() {
                    if let Ok(json) = serde_json::to_string(&combos) {
                        if let Err(err) = writeln!(stdin, "{json}") {
                            log::error!("Failed to send initial combos to child: {err}");
                        }
                        let _ = stdin.flush();
                    }
                }
            }
        }
    }

    let mut guard = child_store()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Some(child);
    Ok(())
}

fn stop_listener_child() {
    {
        let mut stdin_guard = child_stdin_store()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *stdin_guard = None;
    }

    let mut guard = child_store()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(mut child) = guard.take() {
        // The child may have already self-exited after we dropped its stdin above.
        // Only signal it if it is still running, and treat a kill race as benign.
        if !matches!(child.try_wait(), Ok(Some(_))) {
            if let Err(err) = child.kill() {
                log::debug!("Keyboard listener child kill skipped: {err}");
            }
        }
        if let Err(err) = child.wait() {
            log::error!("Failed to wait for keyboard listener child: {err}");
        }
    }
}

fn pump_stream(
    stream: TcpStream,
    emitter: Arc<KeyEventEmitter>,
    generation: u64,
) -> ConnectionOutcome {
    let mut outcome = ConnectionOutcome::default();

    if let Err(err) = stream.set_nodelay(true) {
        log::error!("failed to configure keyboard stream: {err}");
        return outcome;
    }
    if let Err(err) = stream.set_nonblocking(false) {
        log::error!("failed to set blocking mode for keyboard stream: {err}");
        return outcome;
    }

    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(err) => {
                log::error!("Keyboard listener stream error: {err}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        match serde_json::from_str::<WireMessage>(&line) {
            Ok(WireMessage::Key(payload)) => {
                #[cfg(target_os = "windows")]
                if payload.scan_code == 0 {
                    if debug_keys_enabled() {
                        log::debug!(
                            "Ignoring injected event (scan_code=0): {:?} {}",
                            payload.kind,
                            payload.key_label
                        );
                    }
                    continue;
                }

                if let Some(event) = event_from_payload(payload) {
                    emitter.handle_event(&event);
                }
            }
            Ok(WireMessage::Control { state }) => {
                match state {
                    ControlState::Connected => outcome.connected_at = Some(Instant::now()),
                    ControlState::GrabFailed => outcome.grab_failed = true,
                    ControlState::ListenFallback => outcome.fallback_at = Some(Instant::now()),
                }
                handle_control_message(state, generation);
            }
            Err(err) => log::warn!("Malformed keyboard wire message: {err}: {line}"),
        }
    }

    outcome
}

fn event_from_payload(payload: KeyboardEventPayload) -> Option<Event> {
    let key = key_from_payload(&payload.key_label, payload.raw_code)?;

    let event_type = match payload.kind {
        WireEventKind::Press => EventType::KeyPress(key),
        WireEventKind::Release => EventType::KeyRelease(key),
    };

    Some(Event {
        time: SystemTime::now(),
        unicode: None,
        event_type,
        platform_code: 0,
        position_code: 0,
        usb_hid: 0,
        #[cfg(target_os = "windows")]
        extra_data: 0,
        #[cfg(target_os = "macos")]
        extra_data: 0,
    })
}

fn key_from_payload(label: &str, raw_code: Option<u32>) -> Option<RdevKey> {
    if let Some(code) = raw_code.or_else(|| parse_unknown_label(label)) {
        return Some(RdevKey::Unknown(code));
    }

    for key in RdevKey::iter() {
        match key {
            RdevKey::Unknown(_) | RdevKey::RawKey(_) => continue,
            _ => {
                if format!("{key:?}") == label {
                    return Some(key);
                }
            }
        }
    }

    None
}

fn parse_unknown_label(label: &str) -> Option<u32> {
    let trimmed = label.strip_prefix("Unknown(")?.strip_suffix(')')?;
    trimmed.parse().ok()
}

pub(crate) fn key_to_label(key: RdevKey) -> String {
    match key {
        RdevKey::Unknown(code) => format!("Unknown({code})"),
        _ => format!("{key:?}"),
    }
}

pub(crate) fn key_raw_code(key: RdevKey) -> Option<u32> {
    match key {
        RdevKey::Unknown(code) => Some(code),
        _ => None,
    }
}

fn write_wire_message(writer: &Mutex<BufWriter<TcpStream>>, message: &WireMessage) {
    if let Ok(json) = serde_json::to_string(message) {
        if let Ok(mut guard) = writer.lock() {
            if let Err(err) = writeln!(guard, "{json}") {
                eprintln!("Keyboard listener write error: {err}");
                std::process::exit(1);
            }
            if let Err(err) = guard.flush() {
                eprintln!("Keyboard listener flush error: {err}");
                std::process::exit(1);
            }
        }
    }
}

pub(crate) fn send_event_to_tcp(
    writer: &Mutex<BufWriter<TcpStream>>,
    payload: &KeyboardEventPayload,
) {
    write_wire_message(writer, &WireMessage::Key(payload.clone()));
}

pub(crate) fn send_control(writer: &Mutex<BufWriter<TcpStream>>, state: ControlState) {
    write_wire_message(writer, &WireMessage::Control { state });
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn matches_any_combo(pressed: &HashSet<String>, combos: &[Vec<String>]) -> bool {
    let pressed_normalized: HashSet<String> =
        pressed.iter().map(|key| key.to_ascii_lowercase()).collect();

    for combo in combos {
        if combo.is_empty() {
            continue;
        }

        let combo_normalized: HashSet<String> =
            combo.iter().map(|key| key.to_ascii_lowercase()).collect();

        if combo_normalized.is_empty() {
            continue;
        }

        if pressed_normalized == combo_normalized {
            return true;
        }
    }
    false
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn is_modifier_like_key_label(key_label: &str) -> bool {
    let normalized = key_label.to_ascii_lowercase();
    normalized.starts_with("meta")
        || normalized.starts_with("control")
        || normalized.starts_with("shift")
        || normalized.starts_with("alt")
        || normalized.starts_with("option")
        || normalized.starts_with("function")
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn matches_modifier_only_combo(pressed: &HashSet<String>, combos: &[Vec<String>]) -> bool {
    let pressed_normalized: HashSet<String> =
        pressed.iter().map(|key| key.to_ascii_lowercase()).collect();

    for combo in combos {
        if combo.is_empty() || !combo.iter().all(|key| is_modifier_like_key_label(key)) {
            continue;
        }

        let combo_normalized: HashSet<String> =
            combo.iter().map(|key| key.to_ascii_lowercase()).collect();

        if combo_normalized.is_empty() {
            continue;
        }

        if pressed_normalized == combo_normalized {
            return true;
        }
    }

    false
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[derive(Debug, Default)]
pub(crate) struct GrabHotkeyState {
    pub pressed_keys: HashSet<String>,
    pub suppressed_keys: HashSet<String>,
    pub combo_active: bool,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GrabDecision {
    PassThrough,
    Suppress,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn update_grab_hotkey_state(
    state: &mut GrabHotkeyState,
    key_label: &str,
    is_press: bool,
    combos: &[Vec<String>],
) -> GrabDecision {
    if is_press {
        state.pressed_keys.insert(key_label.to_string());
        let has_match = matches_any_combo(&state.pressed_keys, combos);
        let has_modifier_only_match = matches_modifier_only_combo(&state.pressed_keys, combos);

        if !state.combo_active && has_match {
            state.combo_active = true;
            if has_modifier_only_match {
                return GrabDecision::PassThrough;
            }
            state.suppressed_keys.insert(key_label.to_string());
            return GrabDecision::Suppress;
        }

        if state.combo_active {
            if state.suppressed_keys.is_empty() {
                if has_match && !has_modifier_only_match {
                    state.suppressed_keys.insert(key_label.to_string());
                    return GrabDecision::Suppress;
                }
                return GrabDecision::PassThrough;
            }
            state.suppressed_keys.insert(key_label.to_string());
            return GrabDecision::Suppress;
        }

        return GrabDecision::PassThrough;
    }

    state.pressed_keys.remove(key_label);
    if state.pressed_keys.is_empty() {
        state.combo_active = false;
    }

    if state.suppressed_keys.remove(key_label) {
        GrabDecision::Suppress
    } else {
        GrabDecision::PassThrough
    }
}

pub(crate) struct ListenerContext {
    pub writer: Arc<Mutex<BufWriter<TcpStream>>>,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub combos: Arc<Mutex<Vec<Vec<String>>>>,
}

pub(crate) fn setup_listener_process() -> Result<ListenerContext, String> {
    let port = env::var("VOQUILL_KEYBOARD_PORT")
        .map_err(|_| "VOQUILL_KEYBOARD_PORT env var missing".to_string())?
        .parse::<u16>()
        .map_err(|err| format!("invalid VOQUILL_KEYBOARD_PORT: {err}"))?;

    let stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|err| format!("keyboard listener failed to connect: {err}"))?;
    stream
        .set_nodelay(true)
        .map_err(|err| format!("failed to configure listener socket: {err}"))?;

    let writer = Arc::new(Mutex::new(BufWriter::new(stream)));

    // Announce that the child is up and speaking the wire protocol. Emitted here in shared
    // setup so macOS and Windows both report Connected identically (AC-2).
    send_control(&writer, ControlState::Connected);

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let combos: Arc<Mutex<Vec<Vec<String>>>> = Arc::new(Mutex::new(Vec::new()));

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let combos_for_stdin = combos.clone();
        thread::spawn(move || {
            let stdin = std::io::stdin();
            let reader = BufReader::new(stdin.lock());
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<Vec<Vec<String>>>(&line) {
                    Ok(new_combos) => {
                        if let Ok(mut guard) = combos_for_stdin.lock() {
                            *guard = new_combos;
                        }
                    }
                    Err(err) => {
                        eprintln!("Keyboard child: malformed combo update: {err}");
                    }
                }
            }
            // Parent closed stdin (EOF) or the pipe errored: the parent is gone.
            // Exit immediately rather than letting the rdev loop linger until its
            // next failed socket write.
            eprintln!("Keyboard listener: parent stdin closed, exiting");
            std::process::exit(0);
        });
    }

    Ok(ListenerContext {
        writer,
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        combos,
    })
}

pub(crate) fn run_listen_loop(
    writer: Arc<Mutex<BufWriter<TcpStream>>>,
    scan_code_fn: fn(&Event) -> u32,
) -> Result<(), String> {
    rdev::listen(move |event| {
        let payload = match event.event_type {
            EventType::KeyPress(key) => Some(KeyboardEventPayload {
                kind: WireEventKind::Press,
                key_label: key_to_label(key),
                raw_code: key_raw_code(key),
                scan_code: scan_code_fn(&event),
            }),
            EventType::KeyRelease(key) => Some(KeyboardEventPayload {
                kind: WireEventKind::Release,
                key_label: key_to_label(key),
                raw_code: key_raw_code(key),
                scan_code: scan_code_fn(&event),
            }),
            _ => None,
        };

        if let Some(payload) = payload {
            send_event_to_tcp(&writer, &payload);
        }
    })
    .map_err(|err| format!("keyboard listener error: {err:?}"))
}

#[cfg(all(test, any(target_os = "macos", target_os = "windows")))]
mod tests {
    use super::{
        connection_proved_alive, failure_capped, matches_any_combo, retry_backoff,
        should_promote, update_grab_hotkey_state, ControlState, GrabDecision, GrabHotkeyState,
        HealthState, KeyboardEventPayload, WireEventKind, WireMessage, BACKOFF_CEILING,
        FAILURE_CAP, HEALTHY_GRAB_GRACE, SLOW_RETRY_INTERVAL,
    };
    use std::collections::HashSet;
    use std::time::Duration;

    fn set(keys: &[&str]) -> HashSet<String> {
        keys.iter().map(|key| key.to_string()).collect()
    }

    #[test]
    fn matches_with_exact_key_set() {
        let pressed = set(&["MetaLeft"]);
        let combos = vec![vec!["MetaLeft".to_string()]];
        assert!(matches_any_combo(&pressed, &combos));
    }

    #[test]
    fn does_not_match_when_extra_keys_are_pressed() {
        let pressed = set(&["MetaLeft", "KeyZ"]);
        let combos = vec![vec!["MetaLeft".to_string()]];
        assert!(!matches_any_combo(&pressed, &combos));
    }

    #[test]
    fn matches_case_insensitively() {
        let pressed = set(&["metaleft", "keyz"]);
        let combos = vec![vec!["MetaLeft".to_string(), "KeyZ".to_string()]];
        assert!(matches_any_combo(&pressed, &combos));
    }

    #[test]
    fn only_suppresses_release_for_keys_suppressed_on_press() {
        let combos = vec![vec!["ControlLeft".to_string(), "MetaLeft".to_string()]];
        let mut state = GrabHotkeyState::default();

        assert_eq!(
            update_grab_hotkey_state(&mut state, "ControlLeft", true, &combos),
            GrabDecision::PassThrough
        );
        assert_eq!(
            update_grab_hotkey_state(&mut state, "MetaLeft", true, &combos),
            GrabDecision::PassThrough
        );
        assert_eq!(
            update_grab_hotkey_state(&mut state, "MetaLeft", false, &combos),
            GrabDecision::PassThrough
        );
        assert_eq!(
            update_grab_hotkey_state(&mut state, "ControlLeft", false, &combos),
            GrabDecision::PassThrough
        );
    }

    #[test]
    fn suppresses_press_and_release_for_single_key_combo() {
        let combos = vec![vec!["Escape".to_string()]];
        let mut state = GrabHotkeyState::default();

        assert_eq!(
            update_grab_hotkey_state(&mut state, "Escape", true, &combos),
            GrabDecision::Suppress
        );
        assert_eq!(
            update_grab_hotkey_state(&mut state, "Escape", false, &combos),
            GrabDecision::Suppress
        );
    }

    #[test]
    fn modifier_only_combo_is_not_suppressed_regardless_of_key_order() {
        let combos = vec![vec!["ControlLeft".to_string(), "MetaLeft".to_string()]];

        let mut control_then_meta = GrabHotkeyState::default();
        assert_eq!(
            update_grab_hotkey_state(&mut control_then_meta, "ControlLeft", true, &combos),
            GrabDecision::PassThrough
        );
        assert_eq!(
            update_grab_hotkey_state(&mut control_then_meta, "MetaLeft", true, &combos),
            GrabDecision::PassThrough
        );
        assert_eq!(
            update_grab_hotkey_state(&mut control_then_meta, "MetaLeft", false, &combos),
            GrabDecision::PassThrough
        );
        assert_eq!(
            update_grab_hotkey_state(&mut control_then_meta, "ControlLeft", false, &combos),
            GrabDecision::PassThrough
        );

        let mut meta_then_control = GrabHotkeyState::default();
        assert_eq!(
            update_grab_hotkey_state(&mut meta_then_control, "MetaLeft", true, &combos),
            GrabDecision::PassThrough
        );
        assert_eq!(
            update_grab_hotkey_state(&mut meta_then_control, "ControlLeft", true, &combos),
            GrabDecision::PassThrough
        );
        assert_eq!(
            update_grab_hotkey_state(&mut meta_then_control, "ControlLeft", false, &combos),
            GrabDecision::PassThrough
        );
        assert_eq!(
            update_grab_hotkey_state(&mut meta_then_control, "MetaLeft", false, &combos),
            GrabDecision::PassThrough
        );
    }

    #[test]
    fn escalates_from_modifier_only_combo_to_non_modifier_combo() {
        let combos = vec![
            vec!["Function".to_string()],
            vec!["Function".to_string(), "KeyZ".to_string()],
        ];
        let mut state = GrabHotkeyState::default();

        assert_eq!(
            update_grab_hotkey_state(&mut state, "Function", true, &combos),
            GrabDecision::PassThrough
        );
        assert_eq!(
            update_grab_hotkey_state(&mut state, "KeyZ", true, &combos),
            GrabDecision::Suppress
        );
        assert_eq!(
            update_grab_hotkey_state(&mut state, "KeyZ", false, &combos),
            GrabDecision::Suppress
        );
        assert_eq!(
            update_grab_hotkey_state(&mut state, "Function", false, &combos),
            GrabDecision::PassThrough
        );
    }

    fn sample_key_payload() -> KeyboardEventPayload {
        KeyboardEventPayload {
            kind: WireEventKind::Press,
            key_label: "KeyZ".to_string(),
            raw_code: None,
            scan_code: 44,
        }
    }

    #[test]
    fn key_wire_message_is_tagged_and_round_trips() {
        let message = WireMessage::Key(sample_key_payload());
        let json = serde_json::to_string(&message).unwrap();
        assert!(json.contains("\"type\":\"key\""));

        match serde_json::from_str::<WireMessage>(&json).unwrap() {
            WireMessage::Key(payload) => {
                assert_eq!(payload.key_label, "KeyZ");
                assert_eq!(payload.scan_code, 44);
            }
            other => panic!("expected Key, got {other:?}"),
        }
    }

    #[test]
    fn control_wire_message_is_tagged_and_round_trips() {
        let json = serde_json::to_string(&WireMessage::Control {
            state: ControlState::Connected,
        })
        .unwrap();
        assert_eq!(json, "{\"type\":\"control\",\"state\":\"connected\"}");

        match serde_json::from_str::<WireMessage>(&json).unwrap() {
            WireMessage::Control { state } => assert_eq!(state, ControlState::Connected),
            other => panic!("expected Control, got {other:?}"),
        }
    }

    #[test]
    fn unknown_wire_message_type_is_rejected() {
        assert!(serde_json::from_str::<WireMessage>("{\"type\":\"bogus\"}").is_err());
    }

    #[test]
    fn connection_is_alive_only_after_surviving_the_grace_window() {
        let under = HEALTHY_GRAB_GRACE / 2;
        let over = HEALTHY_GRAB_GRACE * 2;

        // Never connected -> failed attempt.
        assert!(!connection_proved_alive(None, false, None));
        // Grab path: connected long enough, no grab failure -> alive.
        assert!(connection_proved_alive(Some(over), false, None));
        // Grab path: EOF before grace (the timer-vs-EOF race case) -> not alive.
        assert!(!connection_proved_alive(Some(under), false, None));
        // Grab reported failed and no fallback -> not alive even if connected long.
        assert!(!connection_proved_alive(Some(over), true, None));
        // Fallback supersedes grab: survived its own grace -> alive.
        assert!(connection_proved_alive(Some(over), true, Some(over)));
        // Fallback entered but EOF before fallback grace -> not alive.
        assert!(!connection_proved_alive(Some(over), true, Some(under)));
    }

    #[test]
    fn grace_promotes_only_when_generation_and_from_state_match() {
        // grab grace: Connected -> HealthyGrab
        assert!(should_promote(
            true,
            HealthState::Connected,
            HealthState::Connected
        ));
        // stale generation must not promote
        assert!(!should_promote(
            false,
            HealthState::Connected,
            HealthState::Connected
        ));
        // moved off `from` (e.g. grab_failed arrived) must not promote
        assert!(!should_promote(
            true,
            HealthState::GrabFailed,
            HealthState::Connected
        ));
        // fallback grace: FallbackStarting -> DegradedListenFallback
        assert!(should_promote(
            true,
            HealthState::FallbackStarting,
            HealthState::FallbackStarting
        ));
        // a connection that already dropped (Failed) must not promote fallback
        assert!(!should_promote(
            true,
            HealthState::Failed,
            HealthState::FallbackStarting
        ));
    }

    #[test]
    fn failure_cap_triggers_at_threshold() {
        assert!(!failure_capped(0));
        assert!(!failure_capped(FAILURE_CAP - 1));
        assert!(failure_capped(FAILURE_CAP));
        assert!(failure_capped(FAILURE_CAP + 10));
    }

    #[test]
    fn backoff_grows_exponentially_then_slow_retries_when_capped() {
        // Exponential growth pre-cap (shift saturates at 0 for the first failure).
        assert_eq!(retry_backoff(0), Duration::from_millis(500));
        assert_eq!(retry_backoff(1), Duration::from_millis(500));
        assert_eq!(retry_backoff(2), Duration::from_millis(1000));
        assert_eq!(retry_backoff(3), Duration::from_millis(2000));
        assert_eq!(retry_backoff(4), Duration::from_millis(4000));
        // Never exceeds the ceiling before the cap kicks in.
        assert!(retry_backoff(FAILURE_CAP - 1) <= BACKOFF_CEILING);
        // Once capped, switch to the slow-retry auto-recovery interval.
        assert_eq!(retry_backoff(FAILURE_CAP), SLOW_RETRY_INTERVAL);
        assert_eq!(retry_backoff(FAILURE_CAP + 5), SLOW_RETRY_INTERVAL);
    }
}
