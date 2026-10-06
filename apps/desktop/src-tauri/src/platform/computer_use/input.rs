//! Input synthesis, in the one layer both the OS backends and the frontend's
//! action vocabulary agree on.
//!
//! Everything here takes PHYSICAL pixels. That is rule 8, and it is the whole
//! reason this file exists: a click aimed at the wrong pixel produces no error
//! anywhere, so the conversion between the logical points a human reasons
//! about and the physical pixels the OS wants happens once, here, and is
//! logged rather than guessed at by each caller.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Which mouse button an action refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

impl MouseButton {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "left" => Ok(Self::Left),
            "right" => Ok(Self::Right),
            "middle" => Ok(Self::Middle),
            other => Err(format!("Unknown mouse button '{other}'")),
        }
    }
}

/// The direction a scroll or two-axis scroll moves the content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

impl ScrollDirection {
    /// Signs for rdev's `Wheel { delta_x, delta_y }`, which is positive for up
    /// and right.
    ///
    /// rdev's own documentation notes that Linux only honours the SIGN of
    /// `delta_y` for a simulated wheel event, not its magnitude, so a pixel
    /// amount on Linux becomes one wheel click per sign unit. That is an OS
    /// limitation rather than a bug here, and it is logged so a caller that
    /// asked for 600 pixels and got three clicks is not left guessing.
    pub fn wheel_deltas(self, amount: i64) -> (i64, i64) {
        match self {
            Self::Up => (0, amount),
            Self::Down => (0, -amount),
            Self::Left => (-amount, 0),
            Self::Right => (amount, 0),
        }
    }
}

/// One key in a chord, named the way the providers name it.
///
/// Providers disagree on spelling: Anthropic's `key` member takes `text`
/// like `"ctrl+c"`, Gemini's `press_key` takes `key` like `"CTRL+C"`. The
/// frontend normalizes both to this one vocabulary before it gets here, so the
/// only spellings this has to understand are the normalized ones plus the
/// handful of names the platforms use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyChord(Vec<rdev::Key>);

impl KeyChord {
    /// Parse a `+`-separated chord, e.g. `ctrl+shift+t`.
    ///
    /// Parsed eagerly and rejected wholesale: pressing `ctrl` and then failing
    /// on `shft` would leave a modifier stuck down for whatever the user does
    /// next, which on a desktop is a genuinely bad state to be in.
    pub fn parse(chord: &str) -> Result<Self, String> {
        Self::from_parts(chord.split('+').map(str::trim), chord)
    }

    /// Parse a chord the caller already split into keys.
    ///
    /// The providers hand over key lists rather than one string: Gemini's
    /// `hotkey` takes `keys`, and an Anthropic click takes separate modifiers.
    /// Accepting that shape keeps the boundary free of a join that this side
    /// would immediately split again.
    pub fn from_parts<I, S>(parts: I, spelling: &str) -> Result<Self, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut keys = Vec::new();
        for part in parts {
            let part = part.as_ref().trim();
            let key = parse_key(part)
                .ok_or_else(|| format!("Unknown key '{part}' in chord '{spelling}'"))?;
            keys.push(key);
        }
        if keys.is_empty() {
            return Err("Key chord is empty".to_string());
        }
        Ok(Self(keys))
    }

    pub fn keys(&self) -> &[rdev::Key] {
        &self.0
    }
}

/// Normalize a key name to the lowercase, space-free form both platforms use.
///
/// Underscores and spaces always go, because `PAGE_UP`, `page up` and `pageup`
/// are all one key. A dash is only removed from a name longer than one
/// character: `page-up` is `pageup`, but a bare `-` is the minus key and
/// deleting it would leave an empty name that parses as nothing at all.
fn canonical_key_name(raw: &str) -> String {
    let lowered = raw.trim().to_ascii_lowercase();
    if lowered.chars().count() > 1 {
        return lowered.replace([' ', '_', '-'], "");
    }
    lowered
}

/// The modifier keys, by every spelling the providers, humans and the three
/// platforms use for them.
///
/// Each maps to the LEFT variant deliberately. Left and right are reported
/// separately by the OS, so a chord has to name one, and the left one is the
/// one the providers' documents are written against.
fn modifier_key(name: &str) -> Option<rdev::Key> {
    use rdev::Key as K;
    match name {
        "ctrl" | "control" | "ctl" => Some(K::ControlLeft),
        "cmd" | "command" | "meta" | "super" | "win" | "windows" => Some(K::MetaLeft),
        "alt" | "option" | "opt" => Some(K::Alt),
        "altgr" => Some(K::AltGr),
        "shift" => Some(K::ShiftLeft),
        _ => None,
    }
}

fn parse_key(raw: &str) -> Option<rdev::Key> {
    let name = canonical_key_name(raw);
    // Modifiers first: they are the only names both providers spell several
    // ways, and they must not fall through to the letter arm.
    if let Some(key) = modifier_key(&name) {
        return Some(key);
    }
    if let Some(key) = number_or_function_key(&name) {
        return Some(key);
    }
    // The numeric keypad is a different set of keys from the top row and the
    // OS reports them separately, so `kp1` cannot fall through to the digit arm.
    if let Some(digit) = name.strip_prefix("kp") {
        let mut chars = digit.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            if c.is_ascii_digit() {
                return Some(keypad_number_key(c));
            }
        }
    }
    // Before the single-character arm, because every name here is longer than
    // one character except the punctuation, and the single-character arm would
    // otherwise accept `~` as a literal tilde when the user meant grave.
    if let Some(key) = named_key(&name) {
        return Some(key);
    }
    // A single character is a literal: a letter or a digit, and the punctuation
    // both providers send when the user typed it into a prompt. A longer name
    // that reached here is genuinely unknown rather than a literal, so it is
    // rejected instead of being truncated to its first character.
    let mut chars = name.chars();
    let c = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    punctuation_key(c).or_else(|| match c {
        'a'..='z' => Some(letter_key(c)),
        '0'..='9' => Some(number_key(c)),
        _ => None,
    })
}

/// `F1` through `F24`, the range the OS reports.
fn number_or_function_key(name: &str) -> Option<rdev::Key> {
    use rdev::Key as K;
    let function = match name {
        "f1" => K::F1,
        "f2" => K::F2,
        "f3" => K::F3,
        "f4" => K::F4,
        "f5" => K::F5,
        "f6" => K::F6,
        "f7" => K::F7,
        "f8" => K::F8,
        "f9" => K::F9,
        "f10" => K::F10,
        "f11" => K::F11,
        "f12" => K::F12,
        "f13" => K::F13,
        "f14" => K::F14,
        "f15" => K::F15,
        "f16" => K::F16,
        "f17" => K::F17,
        "f18" => K::F18,
        "f19" => K::F19,
        "f20" => K::F20,
        "f21" => K::F21,
        "f22" => K::F22,
        "f23" => K::F23,
        "f24" => K::F24,
        _ => return None,
    };
    Some(function)
}

/// The named navigation and editing keys, by every spelling.
fn named_key(name: &str) -> Option<rdev::Key> {
    use rdev::Key as K;
    let key = match name {
        "esc" | "escape" => K::Escape,
        "enter" | "return" => K::Return,
        "space" | "spacebar" => K::Space,
        "tab" => K::Tab,
        "backspace" => K::Backspace,
        "capslock" => K::CapsLock,
        "delete" | "del" => K::Delete,
        "insert" | "ins" => K::Insert,
        "home" => K::Home,
        "end" => K::End,
        "pageup" | "pgup" => K::PageUp,
        "pagedown" | "pgdn" => K::PageDown,
        "up" | "uparrow" => K::UpArrow,
        "down" | "downarrow" => K::DownArrow,
        "left" | "leftarrow" => K::LeftArrow,
        "right" | "rightarrow" => K::RightArrow,
        "printscreen" | "prtsc" | "print" => K::PrintScreen,
        "scrolllock" => K::ScrollLock,
        "numlock" => K::NumLock,
        "pause" | "break" => K::Pause,
        // rdev has no `Menu`; the context-menu key is spelled `Apps`, and it is
        // the key both Windows and X11 send for that menu.
        "menu" | "contextmenu" | "apps" => K::Apps,
        "cancel" => K::Cancel,
        "clear" => K::Clear,
        "backquote" | "backtick" | "`" | "~" => K::BackQuote,
        "minus" | "-" | "_" => K::Minus,
        "equal" | "equals" | "=" | "+" => K::Equal,
        "leftbracket" | "[" | "{" => K::LeftBracket,
        "rightbracket" | "]" | "}" => K::RightBracket,
        "backslash" | "\\" | "|" => K::BackSlash,
        "semicolon" | ";" | ":" => K::SemiColon,
        "quote" | "'" | "\"" => K::Quote,
        "comma" | "," | "<" => K::Comma,
        "period" | "dot" | "." | ">" => K::Dot,
        "slash" | "/" | "?" => K::Slash,
        "asterisk" | "star" | "*" => K::KpMultiply,
        _ => return None,
    };
    Some(key)
}

fn punctuation_key(c: char) -> Option<rdev::Key> {
    named_key(&c.to_string())
}

/// Map a letter to the physical key that produces it on a US layout.
///
/// Deliberately positional, not layout-aware: a chord named `ctrl+c` has to
/// mean the same thing whatever the user's layout is, which is what the
/// providers' documents assume. A layout-aware mapping would put `ctrl+c` under
/// a different physical key for a user whose `A` key produces `Q`, and the
/// provider would have no way to know that.
fn letter_key(c: char) -> rdev::Key {
    use rdev::Key as K;
    match c {
        'a' => K::KeyA,
        'b' => K::KeyB,
        'c' => K::KeyC,
        'd' => K::KeyD,
        'e' => K::KeyE,
        'f' => K::KeyF,
        'g' => K::KeyG,
        'h' => K::KeyH,
        'i' => K::KeyI,
        'j' => K::KeyJ,
        'k' => K::KeyK,
        'l' => K::KeyL,
        'm' => K::KeyM,
        'n' => K::KeyN,
        'o' => K::KeyO,
        'p' => K::KeyP,
        'q' => K::KeyQ,
        'r' => K::KeyR,
        's' => K::KeyS,
        't' => K::KeyT,
        'u' => K::KeyU,
        'v' => K::KeyV,
        'w' => K::KeyW,
        'x' => K::KeyX,
        'y' => K::KeyY,
        'z' => K::KeyZ,
        _ => K::KeyA,
    }
}

/// The top-row digit for a character, NOT the numeric keypad.
///
/// The numeric keypad digits, which are different keys from the top row with
/// different keycodes, and which the OS reports separately.
fn keypad_number_key(c: char) -> rdev::Key {
    use rdev::Key as K;
    match c {
        '0' => K::Kp0,
        '1' => K::Kp1,
        '2' => K::Kp2,
        '3' => K::Kp3,
        '4' => K::Kp4,
        '5' => K::Kp5,
        '6' => K::Kp6,
        '7' => K::Kp7,
        '8' => K::Kp8,
        '9' => K::Kp9,
        _ => K::Kp0,
    }
}

/// `Kp1` and `1` are different keys with different keycodes, and a chord
/// naming `1` means the top row.
fn number_key(c: char) -> rdev::Key {
    use rdev::Key as K;
    match c {
        '0' => K::Num0,
        '1' => K::Num1,
        '2' => K::Num2,
        '3' => K::Num3,
        '4' => K::Num4,
        '5' => K::Num5,
        '6' => K::Num6,
        '7' => K::Num7,
        '8' => K::Num8,
        '9' => K::Num9,
        _ => K::Num0,
    }
}

fn simulate(event: &rdev::EventType) -> Result<(), String> {
    rdev::simulate(event)
        .map_err(|_| "The operating system refused the simulated input event".to_string())
}

fn rdev_button(which: MouseButton) -> rdev::Button {
    match which {
        MouseButton::Left => rdev::Button::Left,
        MouseButton::Right => rdev::Button::Right,
        MouseButton::Middle => rdev::Button::Middle,
    }
}

/// Set by [`cancel_input`] so a long hold or a type can be interrupted.
///
/// Rule 9 requires the Stop button to cancel in-flight tool execution within
/// 500ms, and the input layer is where a tool blocks. A `wait` of up to 300
/// seconds is the one action that can exceed that on its own, so it polls this
/// instead of sleeping straight through.
static INPUT_CANCELLED: AtomicBool = AtomicBool::new(false);

/// Buttons and keys this process is currently holding down.
///
/// A provider can split a press and its release across two turns, and a turn
/// can end in an error or a stop. Without this record a held `shift` stays held
/// in the operating system and every later keystroke the user types becomes a
/// shortcut, with nothing in the app able to clear it.
static HELD_INPUT: Mutex<Vec<HeldInput>> = Mutex::new(Vec::new());

/// One thing currently pressed, and what kind of release it needs.
#[derive(Clone, Copy, PartialEq, Eq)]
enum HeldInput {
    Key(rdev::Key),
    Button(rdev::Button),
}

/// Note something as held, so [`release_held_input`] can let go of it later.
fn record_held(held: HeldInput) {
    let mut guard = HELD_INPUT.lock().unwrap_or_else(|e| e.into_inner());
    if !guard.contains(&held) {
        guard.push(held);
    }
}

/// Forget something that has already been released.
fn forget_held(held: HeldInput) {
    let mut guard = HELD_INPUT.lock().unwrap_or_else(|e| e.into_inner());
    guard.retain(|item| *item != held);
}

/// Let go of everything this process is holding, in reverse press order.
///
/// Release order matters for a modifier that was pressed after a key: lifting
/// the key first would retype its combination for a moment. A release that
/// fails is not retried, because a key the system refuses to release is one
/// it also refuses to report on, and blocking Stop behind it would be worse.
fn release_held_input() {
    let held = {
        let mut guard = HELD_INPUT.lock().unwrap_or_else(|e| e.into_inner());
        let held = std::mem::take(&mut *guard);
        held.into_iter().rev().collect::<Vec<_>>()
    };
    for item in held {
        let event = match item {
            HeldInput::Key(key) => rdev::EventType::KeyRelease(key),
            HeldInput::Button(button) => rdev::EventType::ButtonRelease(button),
        };
        let _ = simulate(&event);
    }
}

/// Ask any in-flight input action to stop at its next checkpoint, and let go
/// of anything this process is still holding down.
pub fn cancel_input() {
    INPUT_CANCELLED.store(true, Ordering::SeqCst);
    release_held_input();
}

/// Clear the cancel flag. Taken by the action loop so one action's cancel
/// cannot silently disarm the next one, which would leave the Stop button
/// working only once.
pub fn reset_input_cancel() {
    INPUT_CANCELLED.store(false, Ordering::SeqCst);
    // The run that owned those holds is gone, so anything still recorded
    // belongs to a caller that never got to release it.
    release_held_input();
}

fn input_cancelled() -> bool {
    INPUT_CANCELLED.load(Ordering::SeqCst)
}

/// Poll until `duration` elapses or the run is cancelled.
///
/// Returns whether the wait completed. Checked in 20ms slices so a cancelled
/// wait is noticed well inside rule 9's 500ms budget.
pub fn wait_cancellable(duration: Duration) -> Result<bool, String> {
    wait_cancellable_on(&INPUT_CANCELLED, duration)
}

/// The wait, with its cancel flag supplied.
///
/// The flag is a parameter rather than always the global one so a test can
/// exercise both outcomes without sharing one process-wide atomic with another
/// test. Two tests that both set the global flag race each other, and the loser
/// fails for a reason that has nothing to do with the code under test.
fn wait_cancellable_on(cancelled: &AtomicBool, duration: Duration) -> Result<bool, String> {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        if cancelled.load(Ordering::SeqCst) {
            return Ok(false);
        }
        std::thread::sleep(Duration::from_millis(20).min(deadline - Instant::now()));
    }
    Ok(true)
}

/// Move the pointer to a point in DESKTOP physical pixels.
///
/// Signed, because a display left of or above the primary one sits at a negative
/// desktop offset and that offset is the whole reason the conversion exists.
/// Clamping it away would put the click on the wrong monitor.
pub fn move_pointer(desktop_x: i64, desktop_y: i64) -> Result<(), String> {
    simulate(&rdev::EventType::MouseMove {
        x: desktop_x as f64,
        y: desktop_y as f64,
    })
}

/// Move the pointer to a point on a specific display, given in that display's
/// own physical pixels.
///
/// This is the conversion rule 8 exists for. A caller working from a capture
/// holds display-local coordinates; the OS wants desktop coordinates on a
/// multi-monitor desktop, and the difference is the display's origin. The
/// transformation is logged because a wrong one is silent.
pub fn move_pointer_on_display(
    display_x: u32,
    display_y: u32,
    geometry: &super::DisplayGeometry,
) -> Result<(), String> {
    let (desktop_x, desktop_y) = desktop_point(display_x, display_y, geometry);
    simulate(&rdev::EventType::MouseMove {
        x: desktop_x as f64,
        y: desktop_y as f64,
    })
}

/// A display-local physical point as a desktop physical point, logged.
///
/// The log is not noise. Rule 8 calls out that a wrong coordinate here produces
/// no error anywhere: the click lands on whatever is at the wrong pixel, and
/// the only evidence is a screenshot afterwards.
fn desktop_point(display_x: u32, display_y: u32, geometry: &super::DisplayGeometry) -> (i64, i64) {
    let (desktop_x, desktop_y) = super::to_desktop(display_x, display_y, geometry);
    log::debug!(
        "Point {display_x},{display_y} on display {} -> desktop {desktop_x},{desktop_y} (scale {})",
        geometry.id,
        geometry.scale_factor
    );
    (desktop_x, desktop_y)
}

/// Where the pointer is now, in DESKTOP physical pixels with a top-left origin.
///
/// `Ok(None)` means the platform cannot report it, which is a legitimate answer
/// rather than a failure: a caller asking must be able to say "I don't know"
/// instead of inventing a position.
///
/// Per-OS rather than built on `rdev`, because `rdev` can only learn the pointer
/// position by listening for the next mouse event, and that event never arrives
/// if the user is not moving. The coordinate spaces differ too: X11 and Windows
/// report virtual-desktop pixels, while macOS reports AppKit POINTS with a
/// bottom-left origin, so the conversion belongs beside the rest of that
/// platform's capture code rather than in this shared file.
pub fn pointer_position() -> Result<Option<(u32, u32)>, String> {
    super::capture::cursor_position()
}

/// Press and release a mouse button `clicks` times at the current position.
///
/// `modifiers` are held for the whole gesture. This is not a convenience: a
/// ctrl+click is how every file manager selects a non-adjacent item and a
/// shift+click is how a range is selected, so a click that cannot carry
/// modifiers cannot do the job an agent is being asked to do.
pub fn click(button: MouseButton, clicks: u32, modifiers: Option<&KeyChord>) -> Result<(), String> {
    if !(1..=3).contains(&clicks) {
        return Err(format!("A click must repeat 1 to 3 times, not {clicks}"));
    }
    with_held_modifiers(modifiers, || {
        for _ in 0..clicks {
            simulate(&rdev::EventType::ButtonPress(rdev_button(button)))?;
            simulate(&rdev::EventType::ButtonRelease(rdev_button(button)))?;
            if input_cancelled() {
                return Err("Input was cancelled".to_string());
            }
        }
        Ok(())
    })
}

/// Run `gesture` with `modifiers` held down, letting go whatever happens.
///
/// The release is unconditional for the same reason [`drag`]'s is: a modifier
/// left held turns every later keystroke into a shortcut, and the user is left
/// pressing Escape to work out why.
fn with_held_modifiers(
    modifiers: Option<&KeyChord>,
    gesture: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let Some(chord) = modifiers else {
        return gesture();
    };
    press_chord_down(chord)?;
    let outcome = gesture();
    let released = release_chord_up(chord);
    outcome?;
    released
}

/// Press a button without releasing it, for a drag.
pub fn press_button(button: MouseButton) -> Result<(), String> {
    let native = rdev_button(button);
    simulate(&rdev::EventType::ButtonPress(native))?;
    record_held(HeldInput::Button(native));
    Ok(())
}

/// Release a button held by [`press_button`].
pub fn release_button(button: MouseButton) -> Result<(), String> {
    let native = rdev_button(button);
    let outcome = simulate(&rdev::EventType::ButtonRelease(native));
    // Forget it only once the system says it let go, so a failed release stays
    // on the list and a later cancel retries it.
    if outcome.is_ok() {
        forget_held(HeldInput::Button(native));
    }
    outcome
}

/// Drag from one desktop point to another with a button held.
///
/// The release is unconditional on purpose. A failure between press and
/// release leaves a button held down, and the next click anywhere on the
/// desktop becomes a drag; letting go is the one thing that must happen.
pub fn drag(
    from_x: i64,
    from_y: i64,
    to_x: i64,
    to_y: i64,
    button: MouseButton,
    modifiers: Option<&KeyChord>,
) -> Result<(), String> {
    move_pointer(from_x, from_y)?;
    with_held_modifiers(modifiers, || {
        press_button(button)?;
        let outcome = move_pointer(to_x, to_y);
        let released = release_button(button);
        outcome?;
        released
    })
}

/// Drag between two points of one display, given in that display's pixels.
///
/// Both endpoints are converted with the same rule [`move_pointer_on_display`]
/// uses, rather than the command layer converting them, so there is exactly
/// one place that knows how a display-local point becomes a desktop one.
pub fn drag_on_display(
    from_x: u32,
    from_y: u32,
    to_x: u32,
    to_y: u32,
    button: MouseButton,
    modifiers: Option<&KeyChord>,
    geometry: &super::DisplayGeometry,
) -> Result<(), String> {
    let (from_x, from_y) = desktop_point(from_x, from_y, geometry);
    let (to_x, to_y) = desktop_point(to_x, to_y, geometry);
    drag(from_x, from_y, to_x, to_y, button, modifiers)
}

/// Scroll by a pixel amount. See [`ScrollDirection::wheel_deltas`] for the
/// Linux magnitude caveat.
pub fn scroll(direction: ScrollDirection, amount: i64) -> Result<(), String> {
    if amount <= 0 {
        return Err(format!("Scroll amount must be positive, not {amount}"));
    }
    let (delta_x, delta_y) = direction.wheel_deltas(amount);
    simulate(&rdev::EventType::Wheel { delta_x, delta_y })
}

/// Press a chord's keys in order and release them in reverse.
///
/// Reversed on the way up because that is what keeps a modifier from being
/// released before the key it modifies on every platform.
pub fn press_chord(chord: &KeyChord) -> Result<(), String> {
    let keys = chord.keys();
    press_keys_latched(keys)?;
    let outcome = (|| {
        for key in keys.iter().rev() {
            simulate(&rdev::EventType::KeyRelease(*key))?;
        }
        Ok(())
    })();
    if outcome.is_err() {
        // Release whatever did go down rather than leaving it latched.
        for key in keys.iter().rev() {
            let _ = simulate(&rdev::EventType::KeyRelease(*key));
        }
    }
    outcome
}

/// Press each key in turn, letting go of the ones already down if a later one
/// is refused.
///
/// Returning on the first failure would leave `ctrl` pressed when `t` is
/// refused, and every keystroke the user types afterwards would then be a
/// shortcut. The release runs whatever the outcome so the only thing a failure
/// leaves behind is the error.
fn press_keys_latched(keys: &[rdev::Key]) -> Result<(), String> {
    let mut outcome = Ok(());
    for key in keys {
        if let Err(err) = simulate(&rdev::EventType::KeyPress(*key)) {
            outcome = Err(err);
            break;
        }
        record_held(HeldInput::Key(*key));
    }
    if outcome.is_err() {
        for key in keys.iter().rev() {
            let _ = simulate(&rdev::EventType::KeyRelease(*key));
        }
        // The keys this chord pressed are no longer held, whatever the caller
        // does next. Leaving them in the list would make a later cancel
        // release a key that is already up.
        for key in keys {
            forget_held(HeldInput::Key(*key));
        }
    }
    outcome
}

/// Press a chord, holding the keys down for `hold` before releasing them.
///
/// The providers expose this as `hold_key`, and it is the only way to express
/// shift+arrow or a key-down-then-move gesture as a single action.
pub fn press_chord_held(chord: &KeyChord, hold: Duration) -> Result<(), String> {
    press_chord_down(chord)?;
    // The release runs whatever the wait reports, so a cancelled hold cannot
    // leave a modifier pressed for whatever the user does next.
    let completed = wait_cancellable(hold);
    let released = release_chord_up(chord);
    if !completed.unwrap_or(false) {
        return Err("Input was cancelled".to_string());
    }
    released
}

/// Press a chord `times` times over.
///
/// `repeat` is a count rather than a key-repeat field because that is how both
/// providers express it, and a count is also what a caller can bound: the
/// provider's own ceiling is enforced before this is reached.
pub fn press_chord_repeated(chord: &KeyChord, times: u32) -> Result<(), String> {
    if times == 0 {
        return Err("A key must repeat at least once, not zero times".to_string());
    }
    for _ in 0..times {
        press_chord(chord)?;
        if input_cancelled() {
            return Err("Input was cancelled".to_string());
        }
    }
    Ok(())
}

/// Hold a chord down without releasing it, for a later [`release_chord`] or a
/// following action that needs the modifier still pressed.
pub fn press_chord_down(chord: &KeyChord) -> Result<(), String> {
    press_keys_latched(chord.keys())
}

/// Release a chord held by [`press_chord_down`].
pub fn release_chord_up(chord: &KeyChord) -> Result<(), String> {
    let mut outcome = Ok(());
    for key in chord.keys().iter().rev() {
        match simulate(&rdev::EventType::KeyRelease(*key)) {
            Ok(()) => forget_held(HeldInput::Key(*key)),
            Err(err) => outcome = Err(err),
        }
    }
    outcome
}

/// Type text into whatever currently has focus, reusing the platform's own
/// typing path.
///
/// The providers' `type` member is a plain string, and pasting it through the
/// clipboard would overwrite whatever the user had copied. Delegating to the
/// same `type_text_into_focused_field` the paste tool uses keeps one typing
/// implementation, including its per-platform handling of newlines and
/// non-ASCII input.
pub fn type_text(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    // The live static, not a copy of its value. A snapshot here would never be
    // written again, so `cancel_input()` would set a flag the running typing
    // loop is not reading and the text would finish typing after Stop.
    crate::platform::input::type_text_into_focused_field(text, 0, &INPUT_CANCELLED)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Serialises the tests that read or write the process-global cancel flag.
    ///
    /// The flag is one atomic shared by every computer-use run, which is what
    /// makes it work and also what makes two tests that both set it race. One
    /// at a time is enough: they are asserting a flag transition, not
    /// exercising concurrency against each other.
    static GLOBAL_FLAG_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn parses_the_button_names_both_providers_use() {
        assert_eq!(MouseButton::parse("left").unwrap(), MouseButton::Left);
        assert_eq!(MouseButton::parse("RIGHT").unwrap(), MouseButton::Right);
        assert_eq!(MouseButton::parse(" middle ").unwrap(), MouseButton::Middle);
    }

    #[test]
    fn rejects_an_unknown_button() {
        assert!(MouseButton::parse("scroll").is_err());
    }

    #[test]
    fn scroll_signs_match_the_positive_is_up_and_right_convention() {
        assert_eq!(ScrollDirection::Up.wheel_deltas(300), (0, 300));
        assert_eq!(ScrollDirection::Down.wheel_deltas(300), (0, -300));
        assert_eq!(ScrollDirection::Left.wheel_deltas(300), (-300, 0));
        assert_eq!(ScrollDirection::Right.wheel_deltas(300), (300, 0));
    }

    #[test]
    fn a_chord_of_one_key_parses() {
        assert_eq!(KeyChord::parse("enter").unwrap().keys().len(), 1);
    }

    #[test]
    fn a_chord_keeps_its_order() {
        let chord = KeyChord::parse("ctrl+shift+t").unwrap();
        assert_eq!(
            chord.keys(),
            &[
                rdev::Key::ControlLeft,
                rdev::Key::ShiftLeft,
                rdev::Key::KeyT
            ]
        );
    }

    #[test]
    fn a_chord_accepts_both_providers_spellings() {
        // Anthropic writes "ctrl+c", Gemini writes "CTRL+C".
        assert_eq!(
            KeyChord::parse("ctrl+c").unwrap().keys(),
            KeyChord::parse("CTRL+C").unwrap().keys()
        );
    }

    #[test]
    fn a_pre_split_chord_parses_the_same_as_a_joined_one() {
        // The providers hand over key lists, and `parse` is kept for the callers
        // that still have one string. If these two ever drift, a click with
        // modifiers behaves differently depending on which door it came through.
        assert_eq!(
            KeyChord::from_parts(["ctrl", "shift"], "ctrl+shift")
                .unwrap()
                .keys(),
            KeyChord::parse("ctrl+shift").unwrap().keys()
        );
    }

    #[test]
    fn an_empty_key_list_is_refused_by_the_parser() {
        // `computer_use_optional_chord` maps an empty list to "no modifiers"
        // before it gets here, so reaching this error means a caller built the
        // list itself and passed something unusable.
        assert!(KeyChord::from_parts(Vec::<String>::new(), "").is_err());
    }

    #[test]
    fn a_chord_maps_every_alias_onto_one_key() {
        let expected = KeyChord::parse("ctrl").unwrap();
        for alias in ["ctrl", "control", "CTL", "Control", "ctrl"] {
            assert_eq!(
                KeyChord::parse(alias).unwrap().keys(),
                expected.keys(),
                "{alias}"
            );
        }
        for alias in ["cmd", "command", "meta", "super", "win", "Meta"] {
            assert_eq!(
                KeyChord::parse(alias).unwrap().keys(),
                KeyChord::parse("cmd").unwrap().keys(),
                "{alias}"
            );
        }
        for alias in ["alt", "option", "opt"] {
            assert_eq!(
                KeyChord::parse(alias).unwrap().keys(),
                KeyChord::parse("alt").unwrap().keys(),
                "{alias}"
            );
        }
    }

    #[test]
    fn escape_and_enter_accept_the_provider_spellings() {
        assert_eq!(
            KeyChord::parse("esc").unwrap().keys(),
            KeyChord::parse("escape").unwrap().keys()
        );
        assert_eq!(
            KeyChord::parse("enter").unwrap().keys(),
            KeyChord::parse("return").unwrap().keys()
        );
    }

    #[test]
    fn space_accepts_both_spellings() {
        assert_eq!(
            KeyChord::parse("space").unwrap().keys(),
            KeyChord::parse("Space").unwrap().keys()
        );
    }

    #[test]
    fn a_top_row_digit_is_not_the_numeric_keypad_digit() {
        assert_eq!(KeyChord::parse("1").unwrap().keys(), &[rdev::Key::Num1]);
        assert_ne!(
            KeyChord::parse("1").unwrap().keys(),
            KeyChord::parse("kp1").unwrap().keys()
        );
    }

    #[test]
    fn a_letter_maps_to_the_physical_key_for_that_letter() {
        assert_eq!(KeyChord::parse("a").unwrap().keys(), &[rdev::Key::KeyA]);
        assert_eq!(KeyChord::parse("Z").unwrap().keys(), &[rdev::Key::KeyZ]);
    }

    #[test]
    fn function_keys_parse() {
        assert_eq!(KeyChord::parse("f5").unwrap().keys(), &[rdev::Key::F5]);
        assert_eq!(KeyChord::parse("F12").unwrap().keys(), &[rdev::Key::F12]);
    }

    #[test]
    fn arrow_keys_accept_their_two_spellings() {
        assert_eq!(
            KeyChord::parse("up").unwrap().keys(),
            KeyChord::parse("upArrow").unwrap().keys()
        );
        assert_eq!(
            KeyChord::parse("left").unwrap().keys(),
            KeyChord::parse("LeftArrow").unwrap().keys()
        );
    }

    #[test]
    fn a_chord_with_an_unknown_key_is_rejected_whole() {
        // Partially applying a chord would leave the modifier it already
        // pressed stuck down.
        assert!(KeyChord::parse("ctrl+shft+t").is_err());
        assert!(KeyChord::parse("ctrl+").is_err());
        assert!(KeyChord::parse("").is_err());
    }

    #[test]
    fn canonical_key_name_strips_case_space_and_dash() {
        assert_eq!(canonical_key_name("Page Down"), "pagedown");
        assert_eq!(canonical_key_name("CTRL"), "ctrl");
        assert_eq!(canonical_key_name("caps-lock"), "capslock");
    }

    #[test]
    fn a_chord_that_cannot_repeat_at_all_is_refused() {
        assert!(press_chord_repeated(&KeyChord::parse("enter").unwrap(), 0).is_err());
    }

    #[test]
    fn a_point_on_a_display_left_of_the_primary_stays_on_that_display() {
        let geometry = super::super::DisplayGeometry {
            id: 2,
            // A 2560px display whose left edge is 2560px left of the desktop
            // origin, so its whole span is negative.
            origin_x: -2560.0,
            origin_y: -200.0,
            width_px: 2560,
            height_px: 1440,
            scale_factor: 2.0,
        };
        assert_eq!(desktop_point(0, 0, &geometry), (-2560, -200));
        // The far corner: 2559 local is 2559 - 2560 = -1 on the desktop.
        assert_eq!(desktop_point(2559, 1439, &geometry), (-1, 1239));
    }

    #[test]
    fn a_point_past_the_edge_of_its_display_clamps_to_the_last_pixel() {
        let geometry = super::super::DisplayGeometry {
            id: 1,
            origin_x: 0.0,
            origin_y: 0.0,
            width_px: 1920,
            height_px: 1080,
            scale_factor: 1.0,
        };
        assert_eq!(desktop_point(5000, 5000, &geometry), (1919, 1079));
    }

    #[test]
    fn a_fractional_origin_is_rounded_rather_than_truncated() {
        let geometry = super::super::DisplayGeometry {
            id: 1,
            origin_x: 0.5,
            origin_y: 0.0,
            width_px: 1920,
            height_px: 1080,
            scale_factor: 1.0,
        };
        assert_eq!(desktop_point(0, 0, &geometry), (1, 0));
    }

    #[test]
    fn the_two_conversions_are_not_each_others_inverse_on_a_negative_origin() {
        // This is the case the two functions exist to keep apart. Round
        // tripping a DESKTOP coordinate through the display-local conversion
        // clamps it to the display, so a desktop point on one monitor read as
        // if it were local to another silently lands in a corner. Both
        // directions are asserted together so a future merge of the two shows
        // up here rather than as a click on the wrong screen.
        let geometry = super::super::DisplayGeometry {
            id: 2,
            origin_x: -2560.0,
            origin_y: 0.0,
            width_px: 2560,
            height_px: 1440,
            scale_factor: 1.0,
        };
        // Desktop 100 is 2660 local, which is off the 2560px display, so the
        // display-local conversion clamps it to the last pixel rather than
        // keeping it.
        assert_eq!(
            super::super::to_display_local(100, 100, &geometry),
            (2559, 100)
        );
        // Local 100 is desktop -2460, and it is left alone because no clamp
        // belongs between a point and the display it is already on.
        assert_eq!(super::super::to_desktop(100, 100, &geometry), (-2460, 100));
    }

    #[test]
    fn a_cancelled_wait_returns_false_rather_than_completing() {
        let flag = AtomicBool::new(false);
        assert!(wait_cancellable_on(&flag, Duration::from_millis(30)).unwrap());
        flag.store(true, Ordering::SeqCst);
        let started = Instant::now();
        assert!(!wait_cancellable_on(&flag, Duration::from_secs(30)).unwrap());
        // Rule 9 budgets 500ms; the poll interval bounds it at one slice.
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn clearing_the_flag_arms_the_next_wait_again() {
        let flag = AtomicBool::new(true);
        assert!(!wait_cancellable_on(&flag, Duration::from_millis(1)).unwrap());
        flag.store(false, Ordering::SeqCst);
        assert!(wait_cancellable_on(&flag, Duration::from_millis(1)).unwrap());
    }

    #[test]
    fn cancelling_stops_a_wait_that_is_already_running() {
        // The two tests above check what a wait sees before and after a flag
        // change. This one checks that an in-flight wait notices, which is the
        // property rule 9 actually depends on.
        let flag = Arc::new(AtomicBool::new(false));
        let canceller = {
            let flag = Arc::clone(&flag);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(30));
                flag.store(true, Ordering::SeqCst);
            })
        };
        let started = Instant::now();
        assert!(!wait_cancellable_on(&flag, Duration::from_secs(30)).unwrap());
        assert!(started.elapsed() < Duration::from_millis(500));
        canceller.join().unwrap();
    }

    #[test]
    fn the_production_wait_reads_the_global_flag() {
        // The three tests above drive their own flag, so none of them covers
        // the wiring between `wait_cancellable` and `cancel_input`. This is
        // that wiring. It touches the global flag, so it takes the lock that
        // keeps it away from any other test that does the same.
        let _guard = GLOBAL_FLAG_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_input_cancel();
        assert!(wait_cancellable(Duration::from_millis(20)).unwrap());
        cancel_input();
        assert!(!wait_cancellable(Duration::from_secs(30)).unwrap());
        reset_input_cancel();
    }

    #[test]
    fn a_click_count_outside_one_to_three_is_rejected() {
        assert!(click(MouseButton::Left, 0, None).is_err());
        assert!(click(MouseButton::Left, 4, None).is_err());
    }

    #[test]
    fn a_non_positive_scroll_amount_is_rejected() {
        assert!(scroll(ScrollDirection::Down, 0).is_err());
        assert!(scroll(ScrollDirection::Down, -1).is_err());
    }
}
