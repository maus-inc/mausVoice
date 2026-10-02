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
                // so a thock never plays louder than the user-controlled
                // `INTERACTION_FEEDBACK_VOLUME` (clamped to the safe window
                // by `current_interaction_feedback_volume`).
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

// Thock haptic feedback (short click transients for pill interactions).
// The gain is read from `INTERACTION_FEEDBACK_VOLUME`, which the frontend
// syncs from the user preference at startup and on slider commit. The
// default lives in the atomic so a fresh process plays at the same level
// the user last chose.
/// Play the press-thock clip at the user-controlled gain.
pub fn play_thock_press() {
    play_thock_clip(THOCK_PRESS_CLIP);
}

/// Play the deep-thock clip at the user-controlled gain.
pub fn play_thock_deep() {
    play_thock_clip(THOCK_DEEP_CLIP);
}

/// Play the release-thock clip at the user-controlled gain.
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
pub static INTERACTION_FEEDBACK_VOLUME: AtomicU32 =
    AtomicU32::new(crate::domain::user::DEFAULT_INTERACTION_FEEDBACK_VOLUME_BITS);

pub const MIN_SAFE_VOLUME: f32 = 0.05;
pub const MAX_SAFE_VOLUME: f32 = 0.5;

/// A `0.35` typed into the sink, or a window that no longer contains the
/// default, is invisible to every test that runs in a shared process: the
/// static is mutable, so whichever test writes it last decides what a later
/// reader sees. Asserting it at compile time is the only form that cannot be
/// reordered.
const _: () = assert!(
    MIN_SAFE_VOLUME <= crate::domain::user::DEFAULT_INTERACTION_FEEDBACK_VOLUME
        && crate::domain::user::DEFAULT_INTERACTION_FEEDBACK_VOLUME <= MAX_SAFE_VOLUME
);

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
        use super::super::{
            current_interaction_feedback_volume, set_interaction_feedback_volume,
            INTERACTION_FEEDBACK_VOLUME, MAX_SAFE_VOLUME,
        };
        use super::*;
        use std::sync::{Mutex, MutexGuard};

        /// Every test that touches `INTERACTION_FEEDBACK_VOLUME` queues on this.
        ///
        /// The atomic is process-global, so a write and the read that has to
        /// observe it are only adjacent if nothing else writes in between. The
        /// test runner interleaves freely: with the guard taken off the four
        /// tests below, all 20 full-suite runs at `--test-threads=16` failed —
        /// `a_volume_round_trips_through_the_shared_window` reading a value
        /// `interaction_feedback_volume_clamps_to_safe_window` had written — and
        /// either test could be the one asserting another's value.
        static VOLUME_TEST_LOCK: Mutex<()> = Mutex::new(());

        /// Exclusive use of the volume for one test, restored on drop.
        ///
        /// Dropping restores the bits the test found, so a test that leaves the
        /// volume at its own last value cannot decide what the next one reads.
        /// A test that panics mid-way still gives the lock up, so the failure
        /// does not cascade into every later test reporting a poisoned lock.
        struct ExclusiveVolume {
            _queued: MutexGuard<'static, ()>,
            previous_bits: u32,
        }

        impl ExclusiveVolume {
            fn take() -> Self {
                let queued = VOLUME_TEST_LOCK
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                Self {
                    _queued: queued,
                    previous_bits: INTERACTION_FEEDBACK_VOLUME.load(Ordering::Relaxed),
                }
            }
        }

        impl Drop for ExclusiveVolume {
            fn drop(&mut self) {
                INTERACTION_FEEDBACK_VOLUME.store(self.previous_bits, Ordering::Relaxed);
            }
        }

        /// The persistence boundary clamps to this same window, so a value
        /// stored on one side is played back at the volume it was stored as.
        ///
        /// The seed is read here rather than left to the `const` assertion
        /// above because this test now owns the atomic for its duration: with
        /// `ExclusiveVolume` held, the round-trip below is about the clamp and
        /// nothing else can answer for it.
        #[test]
        fn a_volume_round_trips_through_the_shared_window() {
            let _volume = ExclusiveVolume::take();
            assert_eq!(
                INTERACTION_FEEDBACK_VOLUME.load(Ordering::Relaxed),
                crate::domain::user::DEFAULT_INTERACTION_FEEDBACK_VOLUME_BITS,
                "the atomic starts at the shared default, so a fresh install and the database agree"
            );
            let default = crate::domain::user::DEFAULT_INTERACTION_FEEDBACK_VOLUME;
            set_interaction_feedback_volume(default);
            assert_eq!(current_interaction_feedback_volume(), default);
            set_interaction_feedback_volume(1.0);
            assert_eq!(
                current_interaction_feedback_volume(),
                MAX_SAFE_VOLUME,
                "the sink clamps what it is given, so an out-of-range value cannot be played",
            );
        }

        /// Restoring on drop is what keeps one test's last write from deciding
        /// what the next one reads: the seed the round trip above asserts is
        /// only there because every other test handed the atomic back the bits
        /// it found rather than keeping its own last value.
        #[test]
        fn a_guarded_test_hands_the_volume_back_unchanged() {
            let before = {
                let _volume = ExclusiveVolume::take();
                let before = INTERACTION_FEEDBACK_VOLUME.load(Ordering::Relaxed);
                set_interaction_feedback_volume(MAX_SAFE_VOLUME);
                assert_eq!(current_interaction_feedback_volume(), MAX_SAFE_VOLUME);
                before
                // `_volume` drops here, on the way out, restoring `before`.
            };
            // The read is taken under a guard of its own. Releasing the first one
            // and then reading the global is the same unguarded read that made
            // this file flaky in the first place: between the two statements any
            // other test on this thread can store whatever it likes.
            let _check = ExclusiveVolume::take();
            assert_eq!(
                INTERACTION_FEEDBACK_VOLUME.load(Ordering::Relaxed),
                before,
                "a guarded test must not leave its last write behind for the next one to read"
            );
        }

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
            let _volume = ExclusiveVolume::take();
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
            // The stored value is process-global state, so it is read under the
            // same lock as the writes above. Read outside it, a concurrent test
            // could store between the load and this assertion.
            let _volume = ExclusiveVolume::take();
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
        "press" => {
            play_thock_press();
            true
        }
        "deep" => {
            play_thock_deep();
            true
        }
        "release" => {
            play_thock_release();
            true
        }
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
/// `Some`, the sink is scaled so a thock plays at the user-controlled
/// gain (clamped to `[0.05, 0.5]` by `current_interaction_feedback_volume`)
/// on the no-default-output path instead of reverting to 1.0.
fn play_clip_fallback(bytes: &'static [u8], volume: Option<f32>) {
    thread::spawn(move || {
        // The stream binding must stay alive for the whole closure: it is
        // what keeps playback running until `sleep_until_end` finishes.
        if let Ok((_stream, handle)) = OutputStream::try_default() {
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
            // `_stream` retires here, ending the fallback playback exactly
            // as the previous explicit `drop` did.
        } else {
            log::error!("Failed to open default audio output stream");
        }
    });
}
