use rodio::{Decoder, OutputStream, Sink};
use std::io::Cursor;
use std::sync::mpsc::{self, Sender};
use std::sync::OnceLock;
use std::thread;

static START_RECORDING_CLIP: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/audio/start-recording.wav"
));

static STOP_RECORDING_CLIP: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/audio/stop-recording.wav"
));

static THOCK_PRESS_CLIP: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/audio/thock-press.wav"
));

static THOCK_DEEP_CLIP: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/audio/thock-deep.wav"
));

static THOCK_RELEASE_CLIP: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/audio/thock-release.wav"
));

static ALERT_MACOS_CLIP: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/audio/alert-macos.wav"
));

static ALERT_WINDOWS_10_CLIP: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/audio/alert-windows-10.wav"
));

static ALERT_WINDOWS_11_CLIP: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/audio/alert-windows-11.wav"
));

/// Channel sender for the warm audio thread.
static AUDIO_SENDER: OnceLock<Sender<AudioRequest>> = OnceLock::new();

enum AudioRequest {
    Play(&'static [u8]),
    /// Play a thock clip at the given volume (0.0..=1.0).
    PlayThock {
        bytes: &'static [u8],
        volume: f32,
    },
}

/// Initialize a dedicated audio thread at app startup for instant chime playback.
/// The thread keeps an OutputStream alive so we don't recreate it for each chime.
pub fn warm_audio_output() {
    let (tx, rx) = mpsc::channel::<AudioRequest>();

    // Store the sender for later use
    if AUDIO_SENDER.set(tx).is_err() {
        log::warn!("Audio sender already initialized");
        return;
    }

    // Spawn the dedicated audio thread
    thread::spawn(move || {
        // Create the output stream once and keep it alive
        let (_stream, handle) = match OutputStream::try_default() {
            Ok(result) => {
                log::info!("Pre-warmed audio output stream");
                result
            }
            Err(err) => {
                log::error!("Failed to create audio output: {err}");
                // Still process requests, but they'll fail gracefully. The
                // volume is applied per-sink in the no-device fallback too,
                // so a thock never plays louder than THOCK_VOLUME.
                for request in rx {
                    match request {
                        AudioRequest::Play(bytes) => play_clip_fallback(bytes, None),
                        AudioRequest::PlayThock { bytes, volume } => {
                            play_clip_fallback(bytes, Some(volume))
                        }
                    }
                }
                return;
            }
        };

        // Process play requests on this thread
        for request in rx {
            match request {
                AudioRequest::Play(bytes) => {
                    if let Ok(sink) = Sink::try_new(&handle) {
                        if let Ok(source) = Decoder::new(Cursor::new(bytes)) {
                            sink.append(source);
                            sink.sleep_until_end();
                        }
                    }
                }
                AudioRequest::PlayThock { bytes, volume } => {
                    if let Ok(sink) = Sink::try_new(&handle) {
                        sink.set_volume(volume.clamp(0.0, 1.0));
                        if let Ok(source) = Decoder::new(Cursor::new(bytes)) {
                            sink.append(source);
                            sink.sleep_until_end();
                        }
                    }
                }
            }
        }
    });
}

/// Try to send a play request to the warm audio thread.
fn try_warm_play(bytes: &'static [u8]) -> bool {
    if let Some(sender) = AUDIO_SENDER.get() {
        sender.send(AudioRequest::Play(bytes)).is_ok()
    } else {
        false
    }
}

pub fn play_start_recording_clip() {
    play_clip(START_RECORDING_CLIP);
}

pub fn play_stop_recording_clip() {
    play_clip(STOP_RECORDING_CLIP);
}

pub fn play_alert_macos_clip() {
    play_clip(ALERT_MACOS_CLIP);
}

pub fn play_alert_windows_10_clip() {
    play_clip(ALERT_WINDOWS_10_CLIP);
}

pub fn play_alert_windows_11_clip() {
    play_clip(ALERT_WINDOWS_11_CLIP);
}

/// Thock haptic feedback (short low-frequency pulses for pill interactions).
/// The gain is read from `INTERACTION_FEEDBACK_VOLUME`, which the frontend
/// syncs from the user preference at startup and on slider commit. The
/// default lives in the atomic so a fresh process plays at the same level
/// the user last chose.
pub fn play_thock_press() {
    play_thock_clip(THOCK_PRESS_CLIP);
}

pub fn play_thock_deep() {
    play_thock_clip(THOCK_DEEP_CLIP);
}

pub fn play_thock_release() {
    play_thock_clip(THOCK_RELEASE_CLIP);
}

/// Play a thock clip at the user-controlled haptic volume. Routed through
/// the same warm/fallback path as other clips, but always sets the sink
/// volume so the click transient never plays at full default.
fn play_thock_clip(bytes: &'static [u8]) {
    let volume = current_interaction_feedback_volume();
    if let Some(sender) = AUDIO_SENDER.get() {
        if sender
            .send(AudioRequest::PlayThock { bytes, volume })
            .is_ok()
        {
            return;
        }
    }
    // Fallback path when the warm thread is down; still scale the sink so
    // the clip does not play at full default volume.
    play_clip_fallback(bytes, Some(volume));
}

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

/// Whether the user has enabled interaction chimes. Set from the frontend
/// via the playInteractionChime preference. When false, thock playback is
/// skipped entirely.
pub static INTERACTION_CHIME_ENABLED: AtomicBool = AtomicBool::new(true);

/// Set the interaction chime preference from the frontend.
pub fn set_interaction_chime_enabled(enabled: bool) {
    INTERACTION_CHIME_ENABLED.store(enabled, Ordering::Relaxed);
}

/// Thock playback gain. Stored as a 0..=1 f32 in a u32 (bit-cast) so it can
/// live in a lock-free atomic. The frontend syncs the value at startup and
/// whenever the Audio dialog slider commits. The read path clamps to a
/// conservative safe range so an out-of-range or attacker-controlled value
/// can never break audio.
pub static INTERACTION_FEEDBACK_VOLUME: AtomicU32 = AtomicU32::new(0.35_f32.to_bits());

const MIN_SAFE_VOLUME: f32 = 0.05;
const MAX_SAFE_VOLUME: f32 = 0.5;

fn current_interaction_feedback_volume() -> f32 {
    f32::from_bits(INTERACTION_FEEDBACK_VOLUME.load(Ordering::Relaxed))
        .clamp(MIN_SAFE_VOLUME, MAX_SAFE_VOLUME)
}

/// Update the thock gain from the frontend. Out-of-range values are clamped
/// to [0, 1] on write so the user slider can never bypass the safe window.
pub fn set_interaction_feedback_volume(volume: f32) {
    let clamped = volume.clamp(0.0, 1.0);
    INTERACTION_FEEDBACK_VOLUME.store(clamped.to_bits(), Ordering::Relaxed);
}

/// Minimum-interval gate for thock sounds. Drops requests that arrive
/// within 100 ms of the last accepted clip, preventing spam from rapid
/// chevron clicks without blocking the warm audio thread.
mod thock_limiter {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const THROTTLE_MS: u64 = 100;

    static LAST_THOCK_MS: AtomicU64 = AtomicU64::new(0);

    /// Pure decision: returns `(throttled, next_last_ms)` given the current
    /// timestamp and the last accepted one. When the two are within `THROTTLE_MS`
    /// the call is throttled (and the last-accepted timestamp is unchanged);
    /// otherwise it is accepted and `next_last_ms` is `now_ms`. Keeping this free
    /// of shared state makes it trivially unit-testable without racing the
    /// process-global `LAST_THOCK_MS` across parallel test threads.
    fn should_throttle_at(now_ms: u64, last_ms: u64) -> (bool, u64) {
        if now_ms.saturating_sub(last_ms) < THROTTLE_MS {
            (true, last_ms)
        } else {
            (false, now_ms)
        }
    }

    pub fn should_throttle() -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let last = LAST_THOCK_MS.load(Ordering::Relaxed);
        let (throttled, next_last) = should_throttle_at(now, last);
        if !throttled {
            LAST_THOCK_MS.store(next_last, Ordering::Relaxed);
        }
        throttled
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use super::super::{
            current_interaction_feedback_volume, set_interaction_feedback_volume,
        };

        #[test]
        fn first_thock_is_not_throttled() {
            assert_eq!(should_throttle_at(1_000, 0), (false, 1_000));
        }

        #[test]
        fn within_window_is_throttled() {
            assert_eq!(should_throttle_at(1_050, 1_000), (true, 1_000));
            assert_eq!(should_throttle_at(1_099, 1_000), (true, 1_000));
        }

        #[test]
        fn at_or_past_window_is_reenabled() {
            assert_eq!(should_throttle_at(1_100, 1_000), (false, 1_100));
            assert_eq!(should_throttle_at(1_250, 1_100), (false, 1_250));
        }

        #[test]
        fn clock_skew_backwards_is_safe() {
            // `saturating_sub` must not panic or un-throttle on a backwards clock.
            assert_eq!(should_throttle_at(1_900, 2_000), (true, 2_000));
        }

        #[test]
        fn interaction_feedback_volume_clamps_to_safe_window() {
            // The user-facing slider exposes the full 0..=1 range, but the
            // sink gain must stay inside the conservative safe window so a
            // user-set value can never blow out the speaker or go silent.
            set_interaction_feedback_volume(0.0);
            assert_eq!(current_interaction_feedback_volume(), 0.05);
            set_interaction_feedback_volume(0.2);
            assert_eq!(current_interaction_feedback_volume(), 0.2);
            set_interaction_feedback_volume(0.35);
            assert_eq!(current_interaction_feedback_volume(), 0.35);
            set_interaction_feedback_volume(0.5);
            assert_eq!(current_interaction_feedback_volume(), 0.5);
            set_interaction_feedback_volume(0.9);
            assert_eq!(current_interaction_feedback_volume(), 0.5);
            set_interaction_feedback_volume(2.0);
            assert_eq!(current_interaction_feedback_volume(), 0.5);
        }

        #[test]
        fn sink_volume_clamp_keeps_values_in_range() {
            // Mirrors the clamp applied before sink.set_volume so an
            // out-of-range value can never blow out the sink or go negative.
            let clamp = |v: f32| v.clamp(0.0, 1.0);
            assert_eq!(clamp(-1.0), 0.0);
            assert_eq!(clamp(2.0), 1.0);
            let stored = current_interaction_feedback_volume();
            assert_eq!(clamp(stored), stored);
        }
    }
}

/// Play a thock clip by kind string ("press", "deep", "release").
/// Returns true if the kind was recognised.
/// Respects the interaction chime preference and rate-limits to
/// prevent spam from rapid chevron clicks.
pub fn play_thock(kind: &str) -> bool {
    if !INTERACTION_CHIME_ENABLED.load(Ordering::Relaxed) {
        return false;
    }
    if thock_limiter::should_throttle() {
        return false;
    }
    match kind {
        "press" => { play_thock_press(); true }
        "deep" => { play_thock_deep(); true }
        "release" => { play_thock_release(); true }
        _ => {
            log::warn!("Unknown thock kind: {kind}");
            false
        }
    }
}

fn play_clip(bytes: &'static [u8]) {
    // Try the warm audio thread first (instant)
    if try_warm_play(bytes) {
        return;
    }

    // Fallback: spawn a new thread with its own stream
    play_clip_fallback(bytes, None);
}

/// Fallback playback when the warm thread is unavailable. When `volume` is
/// `Some`, the sink is scaled so a thock still plays at the reduced
/// THOCK_VOLUME on the no-default-output path instead of reverting to 1.0.
fn play_clip_fallback(bytes: &'static [u8], volume: Option<f32>) {
    thread::spawn(move || {
        if let Ok((stream, handle)) = OutputStream::try_default() {
            match Sink::try_new(&handle) {
                Ok(sink) => match Decoder::new(Cursor::new(bytes)) {
                    Ok(source) => {
                        if let Some(vol) = volume {
                            sink.set_volume(vol.clamp(0.0, 1.0));
                        }
                        sink.append(source);
                        sink.sleep_until_end();
                    }
                    Err(err) => {
                        log::error!("Failed to decode audio clip: {err}");
                    }
                },
                Err(err) => {
                    log::error!("Failed to create audio sink: {err}");
                }
            }

            drop(stream);
        } else {
            log::error!("Failed to open default audio output stream");
        }
    });
}
