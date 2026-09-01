use crate::platform::keyboard::{
    debug_keys_enabled, key_raw_code, key_to_label, run_listen_loop, send_control,
    send_event_to_tcp, setup_listener_process, update_grab_hotkey_state, ControlState,
    GrabDecision, GrabHotkeyState, KeyboardEventPayload, WireEventKind,
};
use rdev::{Event, EventType};
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::BufWriter;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

extern "C" {
    fn CGEventSourceKeyState(state_id: i32, key: u16) -> bool;
}

const FUNCTION_LABEL: &str = "Function";
/// `kVK_Function` — the Fn key's virtual keycode, used to poll its physical state. This is the
/// same API the stale-key sweep relies on, which is proven reliable for Fn on real hardware
/// (unlike `CGEventSourceFlagsState`, whose secondary-Fn bit is not reported in the source state).
const FUNCTION_KEYCODE: u32 = 63;
/// How often the Fn watchdog polls the key state.
const FN_POLL_INTERVAL: Duration = Duration::from_millis(40);
/// Require the key to read released for this many consecutive polls before synthesizing a
/// release, so a single transient mis-read can never cancel an in-progress hold.
const FN_RELEASE_CONFIRMATIONS: u8 = 2;
/// Require Fn to read *physically pressed while the grab never reported it* for this many
/// consecutive polls before concluding the event tap is dead. A live tap sets `fn_held` within
/// one poll (<40ms) of a press, so this threshold (~120ms) cannot false-positive on a real press.
const TAP_DEAD_CONFIRMATIONS: u8 = 3;

fn is_key_physically_pressed(key_code: u32) -> bool {
    unsafe { CGEventSourceKeyState(1, key_code as u16) }
}

/// Single background watchdog for the Fn key, comparing the tap-independent physical key state
/// (`CGEventSourceKeyState`) against what the grab tap actually delivered (`fn_held`):
///
/// 1. **Missed release** — we believe Fn is held but it reads physically released. rdev does not
///    reliably deliver `KeyRelease(Function)` on macOS, so emit a prompt synthetic release once
///    confirmed. (Idempotent with the stale-key sweep.) Without this, hold-to-talk never stops.
/// 2. **Dead tap** — Fn reads physically pressed but the grab never reported the press. macOS
///    silently disables an event tap (`kCGEventTapDisabledByTimeout`) without dropping the child
///    or the connection, and rdev does not re-enable it — so Fn (and all hotkeys) go dead while
///    everything *looks* healthy. When the tap-independent key state shows a press the tap missed,
///    the tap is dead: exit so the parent respawns the child with a fresh tap (self-healing the
///    ~30-min degradation). The current press is lost; the next one works.
fn spawn_fn_watchdog(writer: Arc<Mutex<BufWriter<TcpStream>>>, fn_held: Arc<AtomicBool>) {
    thread::spawn(move || {
        // Let the grab tap finish installing before arming dead-tap detection, so a user holding
        // Fn at launch can't be mistaken for a dead tap (and cause a respawn loop).
        thread::sleep(Duration::from_millis(800));
        let mut released_polls: u8 = 0;
        let mut missed_press_polls: u8 = 0;
        loop {
            thread::sleep(FN_POLL_INTERVAL);
            let physically_pressed = is_key_physically_pressed(FUNCTION_KEYCODE);
            let believed_held = fn_held.load(Ordering::SeqCst);

            if believed_held && !physically_pressed {
                // Missed release.
                missed_press_polls = 0;
                released_polls = released_polls.saturating_add(1);
                if released_polls >= FN_RELEASE_CONFIRMATIONS {
                    released_polls = 0;
                    fn_held.store(false, Ordering::SeqCst);
                    if debug_keys_enabled() {
                        eprintln!("[keys] Fn read released; emitting synthetic Function release");
                    }
                    send_event_to_tcp(
                        &writer,
                        &KeyboardEventPayload {
                            kind: WireEventKind::Release,
                            key_label: FUNCTION_LABEL.to_string(),
                            raw_code: None,
                            scan_code: 0,
                        },
                    );
                }
            } else if !believed_held && physically_pressed {
                // Possible dead tap: a physical Fn press the grab never delivered.
                released_polls = 0;
                missed_press_polls = missed_press_polls.saturating_add(1);
                if missed_press_polls >= TAP_DEAD_CONFIRMATIONS {
                    eprintln!(
                        "Keyboard listener: event tap appears disabled (Fn pressed but not \
                         delivered); exiting so the parent respawns with a fresh tap"
                    );
                    std::process::exit(0);
                }
            } else {
                // Consistent (held & pressed, or idle & released): tap is delivering.
                released_polls = 0;
                missed_press_polls = 0;
            }
        }
    });
}

fn scan_code(event: &Event) -> u32 {
    event.platform_code
}

pub fn run_listener_process() -> Result<(), String> {
    let ctx = setup_listener_process()?;

    // Tracks whether we currently believe the Fn key is held. The watcher uses it to emit a
    // prompt release when the physical Fn flag clears (rdev's own Fn release is unreliable).
    let fn_held = Arc::new(AtomicBool::new(false));
    spawn_fn_watchdog(ctx.writer.clone(), fn_held.clone());

    struct GrabState {
        hotkeys: GrabHotkeyState,
        pressed_platform_codes: HashMap<String, u32>,
    }

    let grab_result = rdev::grab({
        let writer = ctx.writer.clone();
        let combos = ctx.combos.clone();
        let fn_held = fn_held.clone();
        let state = RefCell::new(GrabState {
            hotkeys: GrabHotkeyState::default(),
            pressed_platform_codes: HashMap::new(),
        });
        move |event| -> Option<Event> {
            let (key, is_press) = match event.event_type {
                EventType::KeyPress(key) => (key, true),
                EventType::KeyRelease(key) => (key, false),
                _ => return Some(event),
            };

            {
                let mut s = state.borrow_mut();
                let stale: Vec<(String, u32)> = s
                    .pressed_platform_codes
                    .iter()
                    .filter(|(_, &code)| !is_key_physically_pressed(code))
                    .map(|(label, &code)| (label.clone(), code))
                    .collect();

                for (stale_label, _) in &stale {
                    s.hotkeys.pressed_keys.remove(stale_label);
                    s.pressed_platform_codes.remove(stale_label);
                    s.hotkeys.suppressed_keys.remove(stale_label);

                    if debug_keys_enabled() {
                        eprintln!("[keys] Sweeping stale key: {stale_label}");
                    }

                    let release_payload = KeyboardEventPayload {
                        kind: WireEventKind::Release,
                        key_label: stale_label.clone(),
                        raw_code: None,
                        scan_code: 0,
                    };
                    send_event_to_tcp(&writer, &release_payload);
                }

                if !stale.is_empty() && s.hotkeys.pressed_keys.is_empty() {
                    s.hotkeys.combo_active = false;
                }
            }

            let label = key_to_label(key);
            if label == FUNCTION_LABEL {
                // Track Fn so the flag watcher knows when a release is owed. rdev delivers the
                // Fn press reliably; the watcher backstops the (often missing) release.
                fn_held.store(is_press, Ordering::SeqCst);
            }
            let payload = KeyboardEventPayload {
                kind: if is_press {
                    WireEventKind::Press
                } else {
                    WireEventKind::Release
                },
                key_label: label.clone(),
                raw_code: key_raw_code(key),
                scan_code: event.platform_code,
            };
            send_event_to_tcp(&writer, &payload);

            let mut s = state.borrow_mut();
            if is_press {
                s.pressed_platform_codes
                    .insert(label.clone(), event.platform_code);
            } else {
                s.pressed_platform_codes.remove(&label);
            }

            let current_combos = combos.lock().map(|g| g.clone()).unwrap_or_default();
            if update_grab_hotkey_state(&mut s.hotkeys, &label, is_press, &current_combos)
                == GrabDecision::Suppress
            {
                None
            } else {
                Some(event)
            }
        }
    });

    match grab_result {
        Ok(()) => return Ok(()),
        Err(grab_err) => {
            eprintln!("rdev::grab() failed ({grab_err:?}), falling back to rdev::listen()");
            send_control(&ctx.writer, ControlState::GrabFailed);
        }
    }

    send_control(&ctx.writer, ControlState::ListenFallback);
    run_listen_loop(ctx.writer, scan_code)
}
