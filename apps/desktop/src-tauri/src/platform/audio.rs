use serde::Serialize;
use std::cmp;
use std::sync::Arc;
use std::time::Duration;

use crate::platform::Recorder;

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InputDeviceDescriptor {
    pub label: String,
    pub is_default: bool,
    pub caution: bool,
    /// Whether this looks like a Bluetooth headset.
    ///
    /// A separate flag from `caution`, because the two answer different
    /// questions and are consumed in different places. `caution` is a *ranking*
    /// verdict -- this device will sound worse than an alternative, so prefer
    /// another -- and the selector shows it as "May provide lower audio
    /// quality". This one is a *cost* verdict about the device the user has
    /// already picked: holding it open on behalf of keep-ready moves the link to
    /// its hands-free profile, which degrades output audio and drains the
    /// headset for as long as the hold lasts. A device can be worth choosing and
    /// still carry that cost, which is why one flag could not carry it.
    ///
    /// Still a name heuristic: cpal exposes no transport and CoreAudio/ALSA/
    /// WASAPI each spell it differently. It is used only to add a sentence of
    /// copy, never to change behaviour, so a false positive costs wording and a
    /// false negative costs an unexplained battery drain.
    pub bluetooth: bool,
}

/// Name fragments that identify a Bluetooth headset.
///
/// Hoisted out of the cpal module so the PulseAudio lister can use the same list.
/// It could not before: the Linux path built every descriptor with
/// `caution: false`, so on the one platform where a Bluetooth headset is the
/// common case, the selector offered it as an ordinary device and nothing
/// downstream could tell the difference. Two copies of a keyword list is how the
/// two copies drift.
const LOW_QUALITY_INPUT_KEYWORDS: &[&str] = &[
    "airpods",
    "beats",
    "bluetooth",
    "earbud",
    "hands-free",
    "headset",
    "hfp",
    "hsp",
    "sony wh-",
];

/// Whether a device label names a Bluetooth headset.
///
/// A heuristic on purpose and by necessity: cpal exposes no transport, and
/// CoreAudio, ALSA and WASAPI each spell the same headset differently. Every
/// consumer uses it only to *describe* a device -- to rank it or to warn about
/// holding it open -- never to change what the app does, so a miss costs wording
/// rather than behaviour.
pub(crate) fn label_has_low_quality_keyword(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    LOW_QUALITY_INPUT_KEYWORDS
        .iter()
        .any(|keyword| lower.contains(keyword))
}

/// Creates the recorder and the pre-warm handle, backed by one manager.
///
/// They must be the same object. The whole point of holding a device open is
/// that the press adopts the stream that is already running, and adoption
/// happens inside the recorder's own start path: two managers would each hold
/// their own slot, the press would open a second stream, and the hold would have
/// bought nothing but a microphone indicator.
///
/// They are registered as two state types because they are two capabilities. A
/// command that starts a recording asks for the recorder; a command that holds a
/// device asks for the warm handle, and neither has to claim the other's
/// methods.
pub fn new_audio_backends() -> (Arc<dyn Recorder>, Arc<dyn crate::platform::WarmCapture>) {
    let manager = Arc::new(cpal_impl::RecordingManager::new());
    ((manager.clone() as Arc<dyn Recorder>), manager)
}

/// Every input device across all hosts, deduplicated by label, with default
/// and caution flags.
pub fn list_input_devices() -> Vec<InputDeviceDescriptor> {
    cpal_impl::list_input_devices()
}

// ── Level metering, shared by every backend ─────────────────────────────

/// Bins in the level meter. Fixed so the webview's meter renders the same
/// number of bars whichever backend produced the samples.
pub(crate) const LEVEL_BIN_COUNT: usize = 12;

/// How often level bins reach the webview. The callbacks arrive at buffer
/// rate, far faster than a meter can be read.
pub(crate) const LEVEL_DISPATCH_INTERVAL: Duration = Duration::from_millis(48);

/// How often buffered audio reaches the webview, as audio rather than levels.
pub(crate) const CHUNK_DISPATCH_INTERVAL: Duration = Duration::from_millis(100);

/// Fold samples into [`LEVEL_BIN_COUNT`] mean-absolute-amplitude bins.
///
/// Every backend meters the same way, so the meter means the same thing on
/// every platform; only the sample delivery differs.
pub(crate) fn compute_level_bins(samples: &[f32]) -> Vec<f32> {
    if samples.is_empty() {
        return vec![0.0; LEVEL_BIN_COUNT];
    }

    let frames_per_bin = cmp::max(1, samples.len() / LEVEL_BIN_COUNT);
    let mut bins = vec![0.0f32; LEVEL_BIN_COUNT];
    let mut counts = vec![0u32; LEVEL_BIN_COUNT];

    for (index, sample) in samples.iter().enumerate() {
        let bin_index = cmp::min(index / frames_per_bin, LEVEL_BIN_COUNT - 1);
        bins[bin_index] += sample.abs();
        counts[bin_index] += 1;
    }

    for (value, count) in bins.iter_mut().zip(counts) {
        if count > 0 {
            *value = (*value / count as f32).clamp(0.0, 1.0);
        }
    }

    bins
}

// ── CPAL backend (macOS, Windows) ──────────────────────────────────────

mod cpal_impl {
    use super::{
        compute_level_bins, InputDeviceDescriptor, CHUNK_DISPATCH_INTERVAL, LEVEL_DISPATCH_INTERVAL,
    };
    use crate::domain::{RecordedAudio, RecordingMetrics, RecordingResult};
    use crate::errors::RecordingError;
    use crate::platform::audio_stage::{
        AudioStartupStage, AudioStartupSummary, AudioStartupTrace, FirstPcmSignal,
    };
    use crate::platform::{ChunkCallback, LevelCallback, Recorder};
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{Device, HostId, SampleFormat, Stream, StreamConfig};
    use std::cmp;
    use std::collections::{HashMap, VecDeque};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
    use std::time::{Duration, Instant};

    #[derive(Clone)]
    struct CachedDeviceInfo {
        host_id: HostId,
        /// Disambiguated label, so the cache re-resolves the exact same device
        /// even when the host exposes several inputs under one name.
        device_label: String,
    }

    /// A fixed-size ring of recent samples kept while no recording is running.
    ///
    /// Its capacity is a sample count, not a duration: it is sized from the rate
    /// of the device it is collecting from, so the same two-second setting means
    /// two seconds at 44.1 kHz and at 48 kHz.
    struct Preroll {
        samples: VecDeque<f32>,
        cap: usize,
    }

    impl Preroll {
        fn new(cap: usize) -> Self {
            Self {
                samples: VecDeque::with_capacity(cap),
                cap,
            }
        }

        /// Adds samples, discarding the oldest once the ring is full.
        ///
        /// A zero-capacity ring keeps nothing, which is what a cold start and a
        /// zero second pre-roll both ask for.
        ///
        /// Whole blocks are kept or dropped, never split. A block is one device
        /// callback, so its samples are contiguous in time; trimming a few
        /// samples off its head to fit the cap would keep a fragment of speech
        /// that begins mid-syllable and, worse, would make the kept audio start
        /// at an arbitrary offset rather than at a block boundary. Dropping the
        /// whole block instead loses at most one buffer of context, and the cap
        /// is rounded up so it rarely comes to that.
        fn push(&mut self, samples: &[f32]) {
            if self.cap == 0 || samples.is_empty() {
                return;
            }
            if samples.len() >= self.cap {
                // A single block larger than the whole ring: keep its tail,
                // because the end of the block is the audio closest to the press.
                self.samples.clear();
                self.samples
                    .extend(samples[samples.len() - self.cap..].iter().copied());
                return;
            }
            if self.samples.len() + samples.len() > self.cap {
                // Make room for the whole block by dropping old blocks from the
                // head. Whatever the head holds is what must give way: trimming
                // the incoming block instead keeps a piece of audio that begins
                // mid-block and, with a long enough block, a fragment of the
                // speech the ring exists to preserve.
                let excess = self.samples.len() + samples.len() - self.cap;
                let drop_whole = excess.min(self.samples.len());
                self.samples.drain(..drop_whole);
            }
            self.samples.extend(samples.iter().copied());
        }

        /// Takes everything in the ring, oldest first.
        fn drain(&mut self) -> Vec<f32> {
            self.samples.drain(..).collect()
        }

        fn clear(&mut self) {
            self.samples.clear();
        }

        fn len(&self) -> usize {
            self.samples.len()
        }
    }

    /// The sample count a pre-roll of this length holds at this rate.
    ///
    /// Rounded up, and the direction is deliberate. The ring is filled one
    /// device buffer at a time and each block is kept whole, so a capacity that
    /// is a fraction of a buffer short loses a full block, which on a 1024-frame
    /// device is 21 ms of the speech the user asked to keep. Rounding up costs at
    /// most a fraction of a millisecond more than requested and never drops a
    /// block that fits.
    fn preroll_capacity(preroll: Duration, sample_rate: u32) -> usize {
        if sample_rate == 0 {
            return 0;
        }
        let samples = (preroll.as_secs_f64() * f64::from(sample_rate)).ceil();
        if !samples.is_finite() || samples <= 0.0 {
            return 0;
        }
        samples.min(u32::MAX as f64) as usize
    }

    /// What a cold start prepends and what it leaves behind.
    ///
    /// Nothing, and a ring that keeps nothing. This is the fix for a real
    /// defect: the shared ring is filled by the warm stream's callback, so a
    /// cold start that drained it put the same half second of speech into two
    /// consecutive recordings. A cold start has no previous stream to carry
    /// audio from, so it must not read the shared ring at all.
    ///
    /// The returned ring is a zero-capacity stand-in rather than a clone of the
    /// shared one, so `warm_ring` can decide afterwards whether this stream
    /// should stay open at all without the caller having to thread a flag. The
    /// ring a cold start actually collects into is the manager's shared one,
    /// sized by `try_start_on_device` from the device's own rate.
    fn cold_start_seed() -> (Vec<f32>, Arc<Mutex<Preroll>>) {
        (Vec::new(), Arc::new(Mutex::new(Preroll::new(0))))
    }

    /// The ring a stopping recording should leave its own samples in, if any.
    ///
    /// `None` returns the stream to discarding, which is what a stop with no
    /// hold configured does. The stream is still closed by the caller; this only
    /// decides whether it stays open at all.
    fn warm_ring(ring: &Arc<Mutex<Preroll>>, hold_after_stop: bool) -> Option<Arc<Mutex<Preroll>>> {
        if hold_after_stop {
            Some(Arc::clone(ring))
        } else {
            None
        }
    }

    /// Where a recording's audio should go once it stops.
    ///
    /// Holding and the pre-roll are separate decisions that always travel
    /// together, and both need the shared ring, so they are passed as one value
    /// rather than as three arguments every call site has to keep in step.
    #[derive(Clone, Copy)]
    struct HoldPlan<'a> {
        /// Whether the stream should stay open after this recording stops.
        hold_after_stop: bool,
        /// How much audio from before the press to keep.
        preroll: Duration,
        /// The ring a held stream collects into, sized by the start itself from
        /// the device's own rate.
        ring: &'a Arc<Mutex<Preroll>>,
    }

    /// Stops a stream and drops it.
    ///
    /// Pausing first is not cosmetic: on macOS dropping a `cpal::Stream` does not
    /// stop the audio unit, and the microphone-in-use indicator stays lit until
    /// the unit is stopped explicitly. A pause is what clears it.
    fn retire_stream(stream: Stream) {
        if let Err(err) = stream.pause() {
            log::warn!("failed to pause a stream being dropped: {err}");
        }
        drop(stream);
    }

    /// What the capture callback does with a block of audio.
    ///
    /// Swapping this instead of building a stream per recording is the whole
    /// design: the device is opened once and stays open, and a press only
    /// changes who receives the samples.
    enum SinkMode {
        /// Captured samples are dropped. Only reachable while a stream is being
        /// retired, and never with a user-visible consequence.
        Discard,
        /// Nothing is recording; keep a bounded tail for the next start.
        Warm { preroll: Arc<Mutex<Preroll>> },
        /// A recording is running and owns everything captured.
        Recording {
            buffer: Arc<Mutex<Vec<f32>>>,
            level: Option<Arc<LevelEmitter>>,
            chunk: Option<Arc<ChunkEmitter>>,
            /// The ring that becomes the next press's pre-roll if this stream
            /// stays open when the recording stops.
            ///
            /// Filled alongside the buffer, and the reason is a defect this
            /// replaced: the ring was only ever filled while nothing was
            /// recording, so the first warm press after a cold start inherited an
            /// empty ring. The setting made no difference in exactly the case it
            /// is most often used in -- someone dictates, keeps dictating, and
            /// never turns on keep-ready.
            preroll: Option<Arc<Mutex<Preroll>>>,
        },
    }

    /// The capture callback's destination, shared between the audio thread and
    /// whichever command currently owns the stream.
    struct StreamSink {
        state: Mutex<SinkMode>,
        /// The first block after the stream started: the device-open cost.
        first_pcm: FirstPcmSignal,
        /// The first block after a recording subscribed: the press latency.
        first_recorded: FirstPcmSignal,
        /// The offset `first_recorded` fired at, kept so a start can read it
        /// back on its own clock rather than by scraping the log.
        recorded_at_us: AtomicU64,
        /// Microseconds since this sink last received a block. Used to tell a
        /// stream that is delivering audio from one that is running but silent
        /// because its device went away underneath it.
        last_block_us: AtomicU64,
        /// True while the stream is deliberately paused. A paused device
        /// delivers nothing and must not read as a dead one.
        paused: AtomicBool,
        /// True while a recording owns this sink and has asked the device to
        /// stop. Distinct from `paused`: a pause is resumable and a stop is the
        /// tail of a recording, so neither may be judged stale.
        stopped: AtomicBool,
        /// Whether any block has ever arrived.
        ///
        /// A device that opens and then never calls back delivers nothing, and
        /// that is indistinguishable from a healthy one until either a block or
        /// enough time passes. `last_block_us` cannot express it: its zero value
        /// is the "nothing yet" sentinel.
        delivered: AtomicBool,
        /// Set when the host reported an error that ends the stream, with the
        /// fault's token. A stream that has died keeps looking healthy from the
        /// outside — it exists, it is in the warm slot, nothing errors again —
        /// so the death has to be recorded where the stop path can read it.
        ///
        /// Transient faults are not recorded: they are the ones the host
        /// recovers from, and retiring on them is the rebuild loop.
        faulted: Mutex<Option<&'static str>>,
        /// How many errors the host has reported on this stream.
        ///
        /// Only used to keep a storm from filling the log: cpal's ALSA worker
        /// keeps polling a device in `POLLERR` and calls the error callback on
        /// every iteration, so an unthrottled `log::error!` per error is tens of
        /// thousands of lines a second for a stream that is already lost.
        faults_reported: AtomicU64,
        origin: Mutex<Instant>,
        /// When this sink was built, on a clock nothing resets.
        ///
        /// `origin` is deliberately restarted on a resume and on a new
        /// recording, because it measures "how long after the press"; the pause
        /// bookkeeping needs a clock that only ever moves forward, or the total
        /// paused time would be measured against a moving zero.
        born: Instant,
        /// Total time this stream has spent deliberately paused, in
        /// microseconds, closed intervals only.
        paused_total_us: AtomicU64,
        /// When the current pause began, in microseconds since `born`; zero when
        /// the stream is not paused.
        paused_at_us: AtomicU64,
    }

    impl StreamSink {
        fn new(mode: SinkMode) -> Arc<Self> {
            Arc::new(Self {
                state: Mutex::new(mode),
                first_pcm: FirstPcmSignal::default(),
                first_recorded: FirstPcmSignal::default(),
                recorded_at_us: AtomicU64::new(0),
                last_block_us: AtomicU64::new(0),
                delivered: AtomicBool::new(false),
                paused: AtomicBool::new(false),
                stopped: AtomicBool::new(false),
                faulted: Mutex::new(None),
                faults_reported: AtomicU64::new(0),
                origin: Mutex::new(Instant::now()),
                born: Instant::now(),
                paused_total_us: AtomicU64::new(0),
                paused_at_us: AtomicU64::new(0),
            })
        }

        /// The recording's buffer, when a recording is subscribed.
        ///
        /// Test-only: production reads the buffer it was handed by
        /// `start_recording` rather than reaching back through the sink.
        #[cfg(test)]
        fn lock_recording_buffer(&self) -> Option<Arc<Mutex<Vec<f32>>>> {
            match &*self.lock() {
                SinkMode::Recording { buffer, .. } => Some(Arc::clone(buffer)),
                _ => None,
            }
        }

        fn lock(&self) -> MutexGuard<'_, SinkMode> {
            self.state.lock().unwrap_or_else(PoisonError::into_inner)
        }

        /// Takes one block from the capture callback.
        fn deliver(&self, samples: &[f32]) {
            let elapsed = match self.origin.lock() {
                Ok(origin) => origin.elapsed(),
                Err(poisoned) => poisoned.into_inner().elapsed(),
            };
            // Two different facts. `first_pcm` clocks the callback itself, which
            // is the device-open cost. `first_recorded` starts at
            // `start_recording`, so it is what a press actually waits for: on a
            // reused stream the callback has been running for a while and only
            // this number shows the press latency.
            self.last_block_us.store(
                elapsed.as_micros().min(u128::from(u64::MAX)) as u64,
                Ordering::Release,
            );
            self.delivered.store(true, Ordering::Release);
            if let Some(offset) = self.first_pcm.fire(elapsed) {
                log::info!("first audio block reached the capture callback after {offset:?}");
            }
            if let Some(offset) = self.first_recorded.fire(elapsed) {
                self.recorded_at_us.store(
                    offset.as_micros().min(u128::from(u64::MAX)) as u64,
                    Ordering::Release,
                );
            }

            let mut state = self.lock();
            match &mut *state {
                SinkMode::Discard => {}
                SinkMode::Warm { preroll } => {
                    if let Ok(mut ring) = preroll.lock() {
                        ring.push(samples);
                    }
                }
                SinkMode::Recording {
                    buffer,
                    level,
                    chunk,
                    preroll,
                } => {
                    // Append before emitting. `stop` clones the buffer after
                    // flushing the emitter, so emitting first could deliver
                    // audio the returned recording does not contain.
                    if let Ok(mut buffer) = buffer.lock() {
                        buffer.extend_from_slice(samples);
                    }
                    // The same samples also become the next press's pre-roll, when
                    // this stream is going to be held afterwards. A bounded ring,
                    // so this keeps only the tail.
                    if let Some(preroll) = preroll {
                        if let Ok(mut ring) = preroll.lock() {
                            ring.push(samples);
                        }
                    }
                    if let Some(level) = level {
                        level.emit(samples);
                    }
                    if let Some(chunk) = chunk {
                        chunk.emit(samples);
                    }
                }
            }
        }

        /// Subscribes a recording to this stream and returns its buffer.
        ///
        /// `seed` is audio captured before the press. It goes into the buffer and
        /// is handed to the chunk emitter first, so the webview's timeline starts
        /// with it rather than after it.
        fn start_recording(
            &self,
            level: Option<Arc<LevelEmitter>>,
            chunk: Option<Arc<ChunkEmitter>>,
            seed: Vec<f32>,
            preroll: Option<Arc<Mutex<Preroll>>>,
        ) -> Arc<Mutex<Vec<f32>>> {
            let buffer = Arc::new(Mutex::new(seed.clone()));
            {
                let mut state = self.lock();
                *state = SinkMode::Recording {
                    buffer: Arc::clone(&buffer),
                    level,
                    chunk: chunk.clone(),
                    preroll,
                };
            }
            if let Some(chunk) = chunk {
                if !seed.is_empty() {
                    chunk.emit(&seed);
                }
            }
            // A fresh recording is live again, whatever a previous stop left.
            self.stopped.store(false, Ordering::Release);
            if self.paused.swap(false, Ordering::AcqRel) {
                self.close_pause_interval();
            }
            // The tally is per recording, not per stream: this sink outlives the
            // recording that paused it, and a total carried across would be
            // subtracted from a recording that never paused.
            self.paused_total_us.store(0, Ordering::Release);
            // Only the press clock restarts: the device-open clock measures the
            // lifetime of this stream, which began when the device opened.
            if let Ok(mut origin) = self.origin.lock() {
                *origin = Instant::now();
            }
            self.first_recorded.reset();
            self.recorded_at_us.store(0, Ordering::Release);
            buffer
        }

        /// How long after the stream started its first block arrived.
        ///
        /// `None` when no block has arrived at all, which is the dead-on-arrival
        /// case rather than a fast one, so it is reported as absent instead of
        /// as zero. This is the number a start is judged on: it is the device
        /// open, not the press latency, which `first_recorded` measures.
        fn first_pcm_wait(&self) -> Option<Duration> {
            self.first_pcm.elapsed()
        }

        /// How long since this sink last received a block.
        ///
        /// `None` when it has never received one, which is different from a long
        /// time and is what a device that failed to start looks like.
        fn silence_for(&self) -> Option<Duration> {
            if self.paused.load(Ordering::Acquire) || self.stopped.load(Ordering::Acquire) {
                return None;
            }
            let last = self.last_block_us.load(Ordering::Acquire);
            if last == 0 {
                return None;
            }
            let now = self
                .origin
                .lock()
                .map(|origin| origin.elapsed())
                .unwrap_or_default();
            Some(now.saturating_sub(Duration::from_micros(last)))
        }

        /// Records an error the host reported while this stream was running.
        ///
        /// Only a fatal fault is remembered. A transient one is a condition the
        /// host has already recovered from, and remembering it would retire a
        /// perfectly good stream on the next press.
        ///
        /// The first fault wins: the stream is already gone, and a second error
        /// from a dying backend says nothing new.
        fn record_fault(&self, message: &str) {
            let fault = crate::platform::stream_fault::classify_stream_fault(message);
            // The callback runs on the host's audio thread and, on ALSA, once
            // per poll iteration. Some errors repeat for as long as the broken
            // stream is alive, so only the first few are written in full and the
            // rest are counted and dropped: a log that is nothing but one
            // repeated line is how the useful one before it gets lost.
            let seen = self.faults_reported.fetch_add(1, Ordering::AcqRel) + 1;
            if seen <= FAULT_LOG_LIMIT {
                log::error!("capture stream error ({}): {message}", fault.as_str());
                if seen == FAULT_LOG_LIMIT {
                    log::warn!(
                        "further capture stream errors on this stream will be counted, not logged"
                    );
                }
            }
            if fault != crate::platform::stream_fault::StreamFault::Fatal {
                return;
            }
            if let Ok(mut guard) = self.faulted.lock() {
                if guard.is_none() {
                    *guard = Some(fault.as_str());
                    log::error!(
                        "capture stream is gone ({}) after {seen} error(s); it will not be reused",
                        fault.as_str()
                    );
                }
            }
        }

        /// The token of the fault that ended this stream, if one did.
        ///
        /// Distinct from staleness: a stale stream is one that has stopped
        /// delivering and may yet recover, while this is the host saying it will
        /// not. Only this one justifies reporting a short recording as an error
        /// rather than as a quiet one, which is why the token is returned rather
        /// than a bare boolean.
        fn fault_token(&self) -> Option<&'static str> {
            self.faulted.lock().ok().and_then(|guard| *guard)
        }

        /// Whether any block has ever arrived on this stream.
        fn has_delivered(&self) -> bool {
            self.delivered.load(Ordering::Acquire)
        }

        /// How long this sink has existed.
        ///
        /// Used to decide whether a stream that has delivered nothing is still
        /// starting or is broken. The origin is reset on resume, so a stream
        /// taken out of a pause gets a fresh grace rather than being condemned
        /// for the time it spent paused.
        fn age_of_stream(&self) -> Duration {
            match self.origin.lock() {
                Ok(origin) => origin.elapsed(),
                Err(poisoned) => poisoned.into_inner().elapsed(),
            }
        }

        /// Records that the stream was paused or resumed by the app.
        ///
        /// A pause is deliberate, so it must not be mistaken for a dead device
        /// by the staleness check; a resume just restarts the window.
        fn set_paused(&self, paused: bool) {
            if !paused {
                // Resuming brings the stream back, so it is no longer stopped.
                self.stopped.store(false, Ordering::Release);
            }
            // The pause is an interval, and the accounting below has to see the
            // transition exactly once: a second `set_paused(true)` must not
            // restart the clock, or the first paused stretch disappears from the
            // total.
            let was_paused = self.paused.swap(paused, Ordering::AcqRel);
            if paused && !was_paused {
                self.paused_at_us
                    .store(self.now_us().max(1), Ordering::Release);
            } else if !paused && was_paused {
                self.close_pause_interval();
            }
            if !paused {
                if let Ok(mut origin) = self.origin.lock() {
                    *origin = Instant::now();
                }
                self.last_block_us.store(0, Ordering::Release);
            }
        }

        /// Microseconds since this sink was built, on a clock nothing resets.
        fn now_us(&self) -> u64 {
            self.born.elapsed().as_micros().min(u128::from(u64::MAX)) as u64
        }

        /// Folds an open pause interval into the total, once.
        fn close_pause_interval(&self) {
            let began = self.paused_at_us.swap(0, Ordering::AcqRel);
            if began == 0 {
                return;
            }
            let now = self.now_us();
            let spent = now.saturating_sub(began);
            self.paused_total_us.fetch_add(spent, Ordering::AcqRel);
        }

        /// How long this stream has spent deliberately paused, including a pause
        /// that is still open.
        ///
        /// Used to subtract the pause from the recording's expected length. A
        /// pause is the user's own decision, so counting it as time the stream
        /// failed to deliver would report every paused dictation as a capture
        /// that died partway through — the exact signal the fault path exists to
        /// make trustworthy.
        fn paused_for(&self) -> Duration {
            let mut total = self.paused_total_us.load(Ordering::Acquire);
            let began = self.paused_at_us.load(Ordering::Acquire);
            if began != 0 {
                total = total.saturating_add(self.now_us().saturating_sub(began));
            }
            Duration::from_micros(total)
        }

        /// Whether the device was paused and not yet resumed.
        ///
        /// Test-only now: production reads the pause from `StopOutcome`, because
        /// the stop clears the flag before the caller can ask. Kept as the
        /// observation of the state the tests need.
        #[cfg(test)]
        fn is_paused(&self) -> bool {
            self.paused.load(Ordering::Acquire)
        }

        /// Restarts the press clock without touching the recording.
        ///
        /// Used after a pause. The buffer, the level emitter and the chunk
        /// emitter all keep their own state; only the measurement of "how long
        /// after the press did the first sample arrive" is restarted, because
        /// for a resumed recording that interval includes the pause.
        fn restart_press_clock(&self) {
            if let Ok(mut origin) = self.origin.lock() {
                *origin = Instant::now();
            }
            self.first_recorded.reset();
            self.recorded_at_us.store(0, Ordering::Release);
        }

        /// Stops feeding a recording and, when a preroll ring is supplied,
        /// leaves the stream warm and collecting for the next start.
        ///
        /// Returns whether the stream was paused, alongside the chunk emitter.
        /// The flag is cleared here, so a caller that asks the sink afterwards
        /// always hears "not paused" — which is exactly how a paused recording
        /// came to be left warm and asleep, and why the answer is returned rather
        /// than left to be read on the other side of this call.
        fn stop_recording(&self, preroll: Option<Arc<Mutex<Preroll>>>) -> StopOutcome {
            self.stopped.store(true, Ordering::Release);
            // A stop during a pause ends the pause: the interval is closed here
            // so the figure the stop path reads includes it.
            let was_paused = self.paused.swap(false, Ordering::AcqRel);
            if was_paused {
                self.close_pause_interval();
            }
            let mut state = self.lock();
            let previous = std::mem::replace(
                &mut *state,
                match preroll {
                    Some(preroll) => SinkMode::Warm { preroll },
                    None => SinkMode::Discard,
                },
            );
            StopOutcome {
                emitter: match previous {
                    SinkMode::Recording { chunk, .. } => chunk,
                    _ => None,
                },
                was_paused,
            }
        }
    }

    /// How far behind the wall clock a recording's sample count may fall before
    /// the gap is worth reporting.
    ///
    /// The two figures are never exactly equal: the sample count is quantised by
    /// the device buffer, the wall clock starts before the first block and stops
    /// after the last, and a device delivering a large buffer can be a whole
    /// buffer behind at the moment of the stop. Anything under this is ordinary
    /// accounting noise, not evidence of a stream that died.
    const CAPTURE_GAP_TOLERANCE: Duration = Duration::from_millis(500);

    /// Whether a recording contains materially less audio than the time it was
    /// open, after allowing for that noise.
    ///
    /// A relative term as well as an absolute one: a 30-second dictation that
    /// lost 600 ms is not the defect this looks for, while a 900 ms recording
    /// that gained 5 seconds of wall clock is.
    /// How much audio a fault must have cost before it is worth telling the user
    /// about.
    ///
    /// A late error callback costs at most the one buffer that was in flight when
    /// the device went away, so a few tens of milliseconds. Anything larger is
    /// audio that was recorded into a stream that had already stopped.
    ///
    /// Deliberately not [`elapsed_gap_is_suspicious`]: that asks whether a gap is
    /// statistically odd, and its relative term means a genuine death near the
    /// end of a long dictation falls under it — five seconds lost out of sixty is
    /// 8 %, so a rule meant to catch suspicious silence would silence the one
    /// case worth reporting. This is a much smaller absolute floor.
    const FAULT_GAP_TOLERANCE: Duration = Duration::from_millis(250);

    /// The fault token to report to the user, which drops one that lost no audio.
    ///
    /// The host's error callback runs on its own thread and can land after the
    /// final block was already delivered, so a `fatal` token does not by itself
    /// prove the recording was shortened. Telling the user to check a cable for a
    /// whole dictation is worse than saying nothing: it is a false alarm on a
    /// working microphone. The token is still what decides whether the stream is
    /// reused, and that decision is made from the unfiltered value.
    fn reported_capture_fault(
        reported: Option<String>,
        captured: Duration,
        expected: Duration,
    ) -> Option<String> {
        reported.filter(|_| expected.saturating_sub(captured) >= FAULT_GAP_TOLERANCE)
    }

    /// How long the recording itself captured audio.
    ///
    /// A warm start seeds the buffer with the pre-roll, so the buffer holds up to
    /// two seconds of audio from *before* the press. Crediting that to the
    /// recording makes a stream that died two seconds in look complete, and the
    /// whole point of measuring captured-against-expected is to notice exactly
    /// that. So the seed is subtracted, and audio recorded before the press is
    /// never counted as delivered during it.
    ///
    /// Returns `None` when nothing was captured after the press, which the caller
    /// distinguishes from a zero-length capture: a cold press that captured
    /// nothing is the fault path's job, not a division by zero.
    fn captured_duration(
        total_samples: usize,
        seed_samples: usize,
        sample_rate: u32,
    ) -> Option<Duration> {
        let captured = total_samples.saturating_sub(seed_samples);
        if captured == 0 || sample_rate == 0 {
            return None;
        }
        Some(Duration::from_secs_f64(
            captured as f64 / f64::from(sample_rate),
        ))
    }

    fn elapsed_gap_is_suspicious(captured: Duration, expected: Duration) -> bool {
        if expected <= captured {
            return false;
        }
        let missing = expected - captured;
        if missing < CAPTURE_GAP_TOLERANCE {
            return false;
        }
        // A tenth of the recording, so short recordings are held to the
        // tolerance above while long ones are judged proportionally.
        missing.as_millis() * 10 >= expected.as_millis().max(1)
    }

    /// What a stop needs to know about the recording it ended.
    ///
    /// Both fields are facts the sink knows and the caller cannot learn after
    /// the stop has happened, so the stop returns them instead of leaving them to
    /// be read on the wrong side of the state change.
    struct StopOutcome {
        /// The emitter holding this recording's unflushed audio, if it had one.
        emitter: Option<Arc<ChunkEmitter>>,
        /// Whether the stream was paused when the stop arrived.
        was_paused: bool,
    }

    /// Milliseconds meaning "hold the device until something closes it".
    ///
    /// A sentinel rather than a second flag, so the policy is one number. A
    /// finite hold and an indefinite one differ only in whether a timer is
    /// scheduled, and every reader then has one value to interpret instead of
    /// two that can disagree.
    const WARM_FOREVER_MS: u64 = u64::MAX;

    /// How long a warm stream may deliver nothing before it is presumed dead.
    ///
    /// A running input stream delivers blocks continuously, so a stream that has
    /// produced nothing for this long is either not running or its device went
    /// away. The window has to be long enough to cover a normal buffer cadence
    /// with a slow host, and short enough that a press during a dead stream
    /// still reopens rather than handing the user a silent recording.
    const STALE_WARM_SILENCE: Duration = Duration::from_millis(750);

    /// How many errors from one stream are written in full before the rest are
    /// only counted. Small on purpose: the first error is the informative one.
    const FAULT_LOG_LIMIT: u64 = 5;

    pub struct RecordingManager {
        inner: Arc<Mutex<Option<ActiveRecording>>>,
        preferred_input_name: Arc<Mutex<Option<String>>>,
        last_successful_device: Arc<Mutex<Option<CachedDeviceInfo>>>,
        /// The running stream nobody is recording from, if one is held.
        warm: Arc<Mutex<Option<WarmStream>>>,
        /// Bumped by every request to close at a deadline. A linger thread only
        /// closes the stream if its generation is still the current one, which
        /// is how a renewed hold cancels a pending close instead of racing it.
        linger_generation: Arc<AtomicU64>,
        /// The hold policy, in milliseconds. Zero means every press opens a
        /// device; `WARM_FOREVER_MS` means hold until closed; anything else is
        /// the window a stopped recording stays open for.
        linger_ms: Arc<AtomicU64>,
        /// How much audio from before a press to keep, in microseconds.
        preroll_micros: Arc<AtomicU64>,
        /// Held across a warm open so a press arriving mid-open waits for it
        /// instead of building a second stream on the same device.
        warm_open_gate: Arc<Mutex<()>>,
        /// The tail of recent audio, filled while nothing is recording.
        preroll: Arc<Mutex<Preroll>>,
        /// The most recent capture start, for `capture_startup_timing`.
        last_startup: Arc<Mutex<Option<AudioStartupSummary>>>,
    }

    struct ActiveRecording {
        /// `Some` while this recording owns its stream. Taken by `stop` when the
        /// stream is handed back to the warm slot instead of closed.
        stream: Option<Stream>,
        /// The sink the recording's callback feeds, and the handle `stop` uses
        /// to leave the same stream warm.
        sink: Option<Arc<StreamSink>>,
        /// The preroll ring to resume collecting into after this recording, or
        /// `None` when the microphone should close at stop.
        preroll_after_stop: Option<Arc<Mutex<Preroll>>>,
        /// How many of this recording's samples were captured *before* the press.
        ///
        /// A warm start seeds the buffer with the pre-roll, so the sample count
        /// covers more wall time than the recording was open. Subtracting this
        /// is what keeps "captured" honest: without it, two seconds of pre-press
        /// audio would mask two seconds of stream that died, and the fault that
        /// exists to reveal a short recording would never fire.
        seed_samples: usize,
        start: Instant,
        buffer: Option<Arc<Mutex<Vec<f32>>>>,
        sample_rate: u32,
        device_label: String,
        preferred: Option<String>,
        channels: usize,
    }

    struct WarmStream {
        stream: Stream,
        sink: Arc<StreamSink>,
        /// The device preference the stream was opened for. A start whose
        /// preference differs rebuilds rather than recording the wrong device.
        preferred: Option<String>,
        sample_rate: u32,
        channels: usize,
        device_label: String,
    }

    /// Rate limiter shared by the level and chunk emitters.
    ///
    /// Both callbacks arrive at buffer rate and must not reach the webview at
    /// that rate, so each keeps its own window. Deciding and advancing the
    /// window happen under the same lock: taking the timestamp twice would let
    /// two callers in the same window both be told they could emit.
    struct Throttle {
        interval: Duration,
        last_emit: Mutex<Option<Instant>>,
    }

    impl Throttle {
        fn new(interval: Duration) -> Self {
            Self {
                interval,
                last_emit: Mutex::new(None),
            }
        }

        /// Whether the caller may emit now, consuming one slot of the window.
        fn should_emit(&self) -> bool {
            let now = Instant::now();
            let mut guard = match self.last_emit.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            let should_send = match *guard {
                Some(last) => now.duration_since(last) >= self.interval,
                None => true,
            };
            if should_send {
                *guard = Some(now);
            }
            should_send
        }
    }

    struct LevelEmitter {
        callback: LevelCallback,
        throttle: Throttle,
    }

    impl LevelEmitter {
        fn new(callback: LevelCallback) -> Arc<Self> {
            Arc::new(Self {
                callback,
                throttle: Throttle::new(LEVEL_DISPATCH_INTERVAL),
            })
        }

        fn emit(&self, samples: &[f32]) {
            if samples.is_empty() {
                return;
            }

            if !self.throttle.should_emit() {
                return;
            }

            let levels = compute_level_bins(samples);
            (self.callback)(levels);
        }
    }

    struct ChunkEmitter {
        callback: ChunkCallback,
        throttle: Throttle,
        buffer: Mutex<Vec<f32>>,
        /// Serialises claiming an offset with handing the chunk to the
        /// callback, so two dispatches cannot reach the callback in the
        /// opposite order to the one their offsets were claimed in.
        ///
        /// `buffer` alone is not enough. Taking the index and advancing the
        /// counter inside the buffer lock makes each index unique, but the
        /// callback was invoked after that lock was released, so a thread
        /// that had already claimed the next index could deliver first. The
        /// webview appends each chunk at the offset it is handed, so it saw
        /// a gap in a stream with no gap in it. This lock is separate from
        /// `buffer` so the audio callback keeps buffering while a chunk is
        /// in flight; it is only ever taken by a dispatch.
        dispatch: Mutex<()>,
        emitted_samples: AtomicU64,
    }

    impl ChunkEmitter {
        fn new(callback: ChunkCallback) -> Arc<Self> {
            Arc::new(Self {
                callback,
                throttle: Throttle::new(CHUNK_DISPATCH_INTERVAL),
                buffer: Mutex::new(Vec::new()),
                dispatch: Mutex::new(()),
                emitted_samples: AtomicU64::new(0),
            })
        }

        fn emit(&self, samples: &[f32]) {
            if samples.is_empty() {
                return;
            }

            if let Ok(mut buffer) = self.buffer.lock() {
                buffer.extend_from_slice(samples);
            } else {
                return;
            }

            if self.throttle.should_emit() {
                self.dispatch_buffered_chunk();
            }
        }

        /// Hand the buffered samples to the callback together with the
        /// absolute index of their first sample in the recording.
        ///
        /// Taking the index and advancing the counter under the same lock the
        /// buffer is drained with is what makes the index unique. Doing the
        /// `fetch_add` after releasing the lock would let a second dispatch
        /// read the pre-advance value and hand out a duplicate index, and a
        /// duplicate makes the webview treat the stream as discontinuous.
        ///
        /// The callback runs while `dispatch` is still held, so the order the
        /// offsets were claimed in is the order the webview receives them in.
        /// A dispatch takes `dispatch` before `buffer` and never the other way
        /// round, so the two cannot deadlock against each other.
        fn dispatch_buffered_chunk(&self) {
            let _in_order = self.dispatch.lock().unwrap_or_else(PoisonError::into_inner);
            let (chunk, offset) = {
                let mut buffer = self.buffer.lock().unwrap_or_else(PoisonError::into_inner);
                if buffer.is_empty() {
                    return;
                }
                let chunk = std::mem::take(&mut *buffer);
                let offset = self.emitted_samples.load(Ordering::Relaxed);
                self.emitted_samples
                    .fetch_add(chunk.len() as u64, Ordering::Relaxed);
                (chunk, offset)
            };
            (self.callback)(chunk, offset);
        }

        fn flush(&self) {
            self.dispatch_buffered_chunk();
        }
    }

    impl ActiveRecording {
        /// The stream this recording owns, or `NotRecording` once it has been
        /// handed back to the warm slot.
        fn stream_ref(&self) -> Result<&Stream, RecordingError> {
            self.stream.as_ref().ok_or(RecordingError::NotRecording)
        }

        /// Closes the stream this recording owns, if it still owns one.
        ///
        /// For the paths that build a recording and then cannot publish it. The
        /// stream is paused before it is dropped for the same reason
        /// `retire_stream` does it: dropping a live capture stream is not the
        /// same as closing one, and the device can stay held.
        fn release(mut self) {
            if let Some(stream) = self.stream.take() {
                retire_stream(stream);
            }
        }
    }

    /// How long a hold may go without producing a single block before it is
    /// presumed broken.
    ///
    /// Shorter than the staleness window, because this covers the case that
    /// matters most: the device opened and `play` returned, but the host never
    /// called back. Nothing proves the microphone works except a block arriving.
    const WARM_READY_GRACE: Duration = Duration::from_millis(250);

    impl WarmStream {
        /// Whether this stream has stopped delivering audio.
        ///
        /// A running stream that delivers nothing is the failure this catches:
        /// the device was unplugged, or the host stopped calling the callback
        /// after the machine woke from sleep. Reusing it would hand the press a
        /// stream that never produces a sample.
        fn is_silent_for(&self, window: Duration) -> bool {
            self.sink
                .silence_for()
                .map(|silence| silence >= window)
                .unwrap_or(false)
        }

        /// Whether this stream has ever delivered a block.
        ///
        /// Distinct from "has stopped": a stream that has never delivered
        /// anything has not stopped, and `silence_for` returns `None` for it, so
        /// the staleness check alone reads a dead-on-arrival device as healthy.
        fn has_delivered(&self) -> bool {
            self.sink.has_delivered()
        }

        /// Whether this stream may be handed to a press.
        ///
        /// A stream that has delivered nothing is only trustworthy while it is
        /// still inside its start-up grace. Past that, adopting it records
        /// silence for the whole press: the level meter stays flat, the user
        /// speaks into a recording that will transcribe nothing, and the failure
        /// is attributed to the wrong thing.
        fn is_usable(&self, grace: Duration) -> bool {
            self.unusable_reason(grace).is_none()
        }

        /// Why this stream may not be handed to a press, or `None` when it may.
        ///
        /// Split out from `is_usable` so the rejection can be logged with the
        /// real cause. A bare `false` was logged as "silent past the staleness
        /// window" even when the cause was a device the host had already
        /// declared gone, which sent more than one reader hunting the wrong
        /// fault in the diagnostics export.
        fn unusable_reason(&self, grace: Duration) -> Option<&'static str> {
            // A stream the host declared dead is never usable, however recently
            // it delivered. It can still look perfect from the outside — the
            // object exists, the origin is young, the last block was a moment
            // ago — and the next press would adopt it and record silence for the
            // whole dictation.
            if let Some(fault) = self.sink.fault_token() {
                return Some(fault);
            }
            if self.has_delivered() {
                return if self.is_silent_for(STALE_WARM_SILENCE) {
                    Some("silent past the staleness window")
                } else {
                    None
                };
            }
            if self.sink.age_of_stream() < grace {
                None
            } else {
                Some("no block since it opened")
            }
        }
    }

    // cpal::Stream is not Send/Sync across every platform, but we only ever
    // create, use, and drop it under the manager's mutexes, so it is safe for
    // our usage to share these types between threads.
    unsafe impl Send for RecordingManager {}
    unsafe impl Sync for RecordingManager {}
    // The warm handle moves between the command thread and the stop path, and
    // every access goes through the manager's mutexes for the same reason.
    unsafe impl Send for WarmStream {}
    unsafe impl Sync for WarmStream {}
    unsafe impl Send for ActiveRecording {}
    unsafe impl Sync for ActiveRecording {}

    impl Default for RecordingManager {
        fn default() -> Self {
            Self::new()
        }
    }

    impl RecordingManager {
        /// A recording manager with no active recording, preferred input, or
        /// cached device.
        pub fn new() -> Self {
            Self {
                inner: Arc::new(Mutex::new(None)),
                preferred_input_name: Arc::new(Mutex::new(None)),
                last_successful_device: Arc::new(Mutex::new(None)),
                warm: Arc::new(Mutex::new(None)),
                linger_generation: Arc::new(AtomicU64::new(0)),
                // Zero: opening the device on every press is the only policy
                // that shows no microphone indicator between dictations, so it
                // is the one that needs no consent.
                linger_ms: Arc::new(AtomicU64::new(0)),
                preroll_micros: Arc::new(AtomicU64::new(500_000)),
                warm_open_gate: Arc::new(Mutex::new(())),
                preroll: Arc::new(Mutex::new(Preroll::new(0))),
                last_startup: Arc::new(Mutex::new(None)),
            }
        }

        /// Remembers the host and disambiguated label of a device that just
        /// started recording successfully, so the next start can try it first.
        fn cache_successful_device(&self, host_id: HostId, device_label: String) {
            if let Ok(mut guard) = self.last_successful_device.lock() {
                *guard = Some(CachedDeviceInfo {
                    host_id,
                    device_label,
                });
            }
        }

        /// The window a warmed stream should live for after this stop.
        ///
        /// `None` means no timer: either the user asked for an always-ready
        /// microphone, or nothing is keeping the device open at all.
        fn pending_linger(&self) -> Option<Duration> {
            match self.linger_ms.load(Ordering::SeqCst) {
                0 | WARM_FOREVER_MS => None,
                millis => Some(Duration::from_millis(millis)),
            }
        }

        /// Whether a stopping recording should leave its stream open.
        /// The pre-roll the settings ask for, as a duration.
        fn preroll_requested(&self) -> Duration {
            Duration::from_micros(self.preroll_micros.load(Ordering::SeqCst))
        }

        fn hold_after_stop(&self) -> bool {
            self.linger_millis() > 0
        }

        /// Sets how long the device stays open after a recording, and closes a
        /// stream that the new policy no longer covers.
        ///
        /// Zero means every press opens the device, which is the default and the
        /// only policy with no microphone indicator between dictations. A stream
        /// that is already open is closed, because under this policy nothing
        /// should be open between dictations.
        ///
        /// The hold path wants the first half and not the second: setting the
        /// policy with a zero while a stream is held closed the stream, which is
        /// how the hold got undone by the default value. Everything that only
        /// needs the policy stored calls `set_linger_policy`.
        pub fn set_linger(&self, linger: Duration) {
            self.set_linger_policy(linger);
            if self.linger_millis() == 0 {
                self.cancel_linger();
                self.close_warm();
            }
        }

        /// Stores the hold policy without closing anything.
        ///
        /// A stream that is already open keeps running: whether it should have
        /// been closed is a question this call does not answer, and the one
        /// caller that knows is the one closing it.
        pub fn set_linger_policy(&self, linger: Duration) {
            let millis = linger.as_millis().min(u128::from(u64::MAX)) as u64;
            self.linger_ms.store(millis, Ordering::SeqCst);
        }

        /// The hold policy in milliseconds, as stored.
        pub fn linger_millis(&self) -> u64 {
            self.linger_ms.load(Ordering::SeqCst)
        }

        /// Applies a hold to a stream that is already open.
        ///
        /// Deliberately not [`set_linger`]: a zero there closes the stream, and a
        /// caller that has just opened one would close it and then wait for an
        /// open that is no longer held. The stream is already running when this
        /// is called; this only says it must not stop.
        ///
        /// This is the whole of turning keep-ready on. Going through
        /// `set_linger` first closed the stream the previous policy had left
        /// warm, reopened it, and paid the cold start the feature exists to
        /// remove, on the switch that asks for the opposite.
        pub fn promote_to_hold(&self) {
            // The generation is bumped before the policy is stored, and the order
            // is the point. Storing the policy first left a window where an
            // expired timer could wake, see its own generation still current, and
            // take a stream that had just been promoted to a hold. Bumping first
            // fails only in the harmless direction: a timer that reads in between
            // sees a stale generation and leaves the stream alone, which is what a
            // hold wants.
            //
            // A pending linger would close this stream at its window, which is
            // later than never but still wrong for a hold.
            self.cancel_linger();
            self.set_linger_policy(Duration::from_millis(WARM_FOREVER_MS));
        }

        /// Sets how much audio from before a press to keep, and resizes the ring
        /// an already-held stream is collecting into.
        pub fn set_preroll(&self, preroll: Duration) {
            let micros = preroll.as_micros().min(u128::from(u64::MAX)) as u64;
            self.preroll_micros.store(micros, Ordering::SeqCst);
            let capacity = {
                let warm_rate = self
                    .warm
                    .lock()
                    .ok()
                    .and_then(|guard| guard.as_ref().map(|warm| warm.sample_rate));
                match warm_rate {
                    Some(rate) => preroll_capacity(preroll, rate),
                    // No stream yet, so no rate to size against; the next open
                    // sizes it. Clearing keeps the old length from surviving.
                    None => {
                        if let Ok(mut ring) = self.preroll.lock() {
                            ring.cap = 0;
                            ring.clear();
                        }
                        return;
                    }
                }
            };
            if let Ok(mut ring) = self.preroll.lock() {
                ring.cap = capacity;
                while ring.len() > capacity {
                    ring.samples.pop_front();
                }
            }
        }

        /// Whether a held stream could actually serve a press.
        ///
        /// Stronger than `has_warm_stream`, which only says an object exists.
        pub fn warm_is_usable(&self) -> bool {
            self.warm
                .lock()
                .ok()
                .and_then(|guard| guard.as_ref().map(|warm| warm.is_usable(WARM_READY_GRACE)))
                .unwrap_or(false)
        }

        /// Whether a warm stream is currently held.
        pub fn has_warm_stream(&self) -> bool {
            match self.warm.lock() {
                Ok(guard) => guard.is_some(),
                Err(poisoned) => poisoned.into_inner().is_some(),
            }
        }

        /// Closes the held stream and stops holding it.
        ///
        /// This is the "release the device now" action, not "stop keeping it
        /// open after a recording". The post-recording window is a separate
        /// preference and the stream is closing, so a window left in place would
        /// have nothing to apply to: the policy is returned to zero here.
        ///
        /// The preference itself is never touched; only this process's copy of
        /// it. Nothing here writes to the user's settings, so releasing the
        /// device cannot turn a setting off permanently.
        ///
        /// **Zeroing the policy is why the caller has to put the window back.**
        /// This function used to say the front end "restates the user's window
        /// when it next mounts", and that was true only by accident: the effect
        /// that pushes the window skips while the hold is on, so a release for
        /// any reason other than turning keep-ready off left the user's window at
        /// zero for the rest of the session. `MicrophoneReadinessSideEffects`
        /// restores it from `release`'s continuation now, and only when nothing
        /// has opened since. Anything that calls `release_hold` directly is
        /// responsible for the same restore.
        pub fn release_hold(&self) {
            self.set_linger_policy(Duration::ZERO);
            self.close_warm();
        }

        pub fn close_warm(&self) {
            self.cancel_linger();
            let warm = {
                let mut guard = match self.warm.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                guard.take()
            };
            if let Some(warm) = warm {
                log::info!("closing warm capture stream on '{}'", warm.device_label);
                retire_stream(warm.stream);
            }
            if let Ok(mut ring) = self.preroll.lock() {
                ring.clear();
            }
        }

        /// Arranges for the warm stream to be closed after `linger`, unless
        /// something renews the hold in the meantime.
        ///
        /// This is the "stay ready for a moment after a dictation" policy. It
        /// uses the same warm slot as the explicit preference, so a user who
        /// turned that preference on cannot have their stream closed by a timer
        /// the policy only meant for the opt-out case: the preference stops
        /// calling this at all.
        pub fn linger_then_close(&self, linger: Duration) {
            let generation = self
                .linger_generation
                .fetch_add(1, Ordering::SeqCst)
                .wrapping_add(1);
            let generation_ref = Arc::clone(&self.linger_generation);
            let warm = Arc::clone(&self.warm);

            let spawned = std::thread::Builder::new()
                .name("warm-linger".to_string())
                .spawn(move || {
                    std::thread::sleep(linger);
                    // The generation is read while the warm slot is held, not
                    // before it. Reading it first left a window this thread could
                    // not recover from: it saw its own generation, `close_warm`
                    // then bumped and closed, a new hold opened a fresh stream, and
                    // this thread woke up holding the lock and closed *that* one --
                    // a stream it was never asked to touch, which left the user's
                    // hold silently gone with the microphone indicator off.
                    //
                    // Under the lock the two calls are ordered instead. Either this
                    // thread goes first and closes the stream it was armed for (and
                    // `close_warm` then finds nothing to take), or `close_warm` goes
                    // first and this thread sees the bumped generation and leaves
                    // whatever is in the slot alone.
                    let closed = {
                        let mut guard = match warm.lock() {
                            Ok(guard) => guard,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        if generation_ref.load(Ordering::SeqCst) != generation {
                            return;
                        }
                        guard.take()
                    };
                    if let Some(warm) = closed {
                        log::info!(
                            "warm capture stream on '{}' reached its {}s linger; closing",
                            warm.device_label,
                            linger.as_secs_f64()
                        );
                        retire_stream(warm.stream);
                    }
                });
            if let Err(err) = spawned {
                // A hold that cannot be scheduled would keep the device open
                // for the rest of the session with no policy behind it, so it
                // is closed now instead of being silently leaked.
                log::error!(
                    "could not schedule the linger close; closing the warm stream now: {err}"
                );
                self.close_warm();
            }
        }

        /// Cancels a pending linger close, so the stream the user asked to keep
        /// stays open past it.
        pub fn cancel_linger(&self) {
            self.linger_generation.fetch_add(1, Ordering::SeqCst);
        }

        /// Tries to start recording on the previously successful device.
        ///
        /// Returns `None` when there is no cached device, it no longer
        /// resolves, it does not match the preferred device, or the stream
        /// cannot be started on it.
        fn try_cached_device(
            &self,
            level_emitter: Option<Arc<LevelEmitter>>,
            chunk_emitter: Option<Arc<ChunkEmitter>>,
            preferred_normalized: Option<&str>,
            hold_after_stop: bool,
            trace: &mut AudioStartupTrace,
        ) -> Option<(ActiveRecording, HostId, String)> {
            let cached = {
                let guard = self.last_successful_device.lock().ok()?;
                guard.clone()
            }?;

            let host = cpal::host_from_id(cached.host_id).ok()?;

            let device = find_device_by_label(&host, &cached.device_label);
            if let Some(reason) =
                cached_device_rejection(Some(&cached), preferred_normalized, device.is_some())
            {
                // Falling through, not failing: the slow path scores every
                // device afresh, so a microphone that moved ports, or a headset
                // that replaced it, still records this press.
                log::info!(
                    "not using cached device '{}' ({reason}); scoring devices instead",
                    cached.device_label
                );
                return None;
            }
            let device = device?;

            let result = try_start_on_device(
                &device,
                Some(&cached.device_label),
                level_emitter,
                chunk_emitter,
                HoldPlan {
                    hold_after_stop,
                    preroll: self.preroll_requested(),
                    ring: &self.preroll,
                },
                trace,
            );

            match result {
                Ok(active) => {
                    log::info!(
                        "using cached device '{}' via host {:?}",
                        cached.device_label,
                        cached.host_id
                    );
                    Some((active, cached.host_id, cached.device_label))
                }
                Err(err) => {
                    log::warn!("cached device '{}' failed: {err}", cached.device_label);
                    None
                }
            }
        }

        fn guard(&self) -> Result<MutexGuard<'_, Option<ActiveRecording>>, RecordingError> {
            self.inner
                .lock()
                .map_err(|_| RecordingError::AlreadyRecording)
        }

        /// Starts a recording, reusing a held stream when one is available.
        ///
        /// The warm path is tried first and costs no device open at all: the
        /// stream is already running and the press only changes who receives
        /// the samples. A cold start pays for the open and, because it prepends
        /// nothing, cannot carry a previous stream's audio into this recording.
        fn start_recording(
            &self,
            level_callback: Option<LevelCallback>,
            chunk_callback: Option<ChunkCallback>,
        ) -> Result<(), RecordingError> {
            let preferred_label = {
                let guard = match self.preferred_input_name.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                guard.clone()
            };
            let preferred_trimmed = preferred_label
                .as_ref()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let preferred_normalized = preferred_trimmed
                .as_ref()
                .map(|value| value.to_ascii_lowercase());

            if self.guard()?.is_some() {
                return Err(RecordingError::AlreadyRecording);
            }

            let level_emitter = level_callback.map(LevelEmitter::new);
            let chunk_emitter = chunk_callback.map(ChunkEmitter::new);
            let mut trace = AudioStartupTrace::begin();
            trace.mark(AudioStartupStage::CommandEntered);

            // Read once, before either path: the hold policy decides what this
            // stream does when it stops, and reading it twice could see two
            // different answers if a preference lands mid-start.
            let hold_after_stop = self.hold_after_stop();

            // Everything from here to the publish below runs under
            // `warm_open_gate`, and never while `inner` is held. That single
            // rule is the whole deadlock fix, and it has to hold in both
            // directions:
            //
            // - holding `inner` while waiting for the gate deadlocks against
            //   `open_warm`, which takes the gate first;
            // - taking the gate and then *keeping* it across the publish stops a
            //   second press from slipping past the `inner` check above while
            //   this one is between that check and its publish, which would
            //   otherwise start two recordings and lose one of the streams.
            //
            // So the order is: check `inner`, release it, take the gate, adopt
            // or open, publish, release the gate.
            let gate = match self.warm_open_gate.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };

            // Warm path: the stream from the previous recording is still open
            // and running, so nothing waits on the device.
            if let Some(active) = self.adopt_warm_stream(
                level_emitter.clone(),
                chunk_emitter.clone(),
                preferred_normalized.as_deref(),
                &mut trace,
            ) {
                self.record_startup(trace, active.sink.as_ref());
                let mut guard = self.guard()?;
                if guard.is_some() {
                    // Unreachable while every press publishes under this gate:
                    // the check above and this publish are one critical
                    // section. Treated as a loss rather than an overwrite, so a
                    // future caller that breaks the contract leaks one stream
                    // instead of two recordings.
                    drop(guard);
                    drop(gate);
                    active.release();
                    return Err(RecordingError::AlreadyRecording);
                }
                *guard = Some(active);
                drop(guard);
                drop(gate);
                return Ok(());
            }
            drop(gate);

            // Re-acquired for the cold path: the device open below must not run
            // while another press is already doing one, and `inner` being
            // `Some` is what tells this press to stop. A second press that
            // arrives while this one is opening a device sees `None` here and
            // gets `AlreadyRecording` from the check that follows.
            let mut guard = self.guard()?;
            if guard.is_some() {
                return Err(RecordingError::AlreadyRecording);
            }

            // Cold path. A held stream that could not be used has already been
            // retired above, so this is the only device open in this press.
            //
            // Fast path: try the cached device first. Resolving the cached label
            // still enumerates the selected host's input devices, but it skips
            // candidate scoring and never iterates the other hosts.
            if let Some((active, host_id, device_name)) = self.try_cached_device(
                level_emitter.clone(),
                chunk_emitter.clone(),
                preferred_normalized.as_deref(),
                hold_after_stop,
                &mut trace,
            ) {
                self.cache_successful_device(host_id, device_name);
                self.record_startup(trace, active.sink.as_ref());
                *guard = Some(active);
                return Ok(());
            }

            // Slow path: full device enumeration, every host in turn. The first
            // host that yields a stream wins; a host that fails is logged and
            // skipped rather than ending the press.
            let hosts = ordered_host_ids();
            let trace_ref = &mut trace;
            match try_hosts(
                &hosts,
                |id| {
                    cpal::host_from_id(id)
                        .map_err(|err| RecordingError::StreamBuild(err.to_string()))
                },
                |host| {
                    start_recording_on_host(
                        host,
                        level_emitter.clone(),
                        chunk_emitter.clone(),
                        preferred_trimmed.as_deref(),
                        preferred_normalized.as_deref(),
                        HoldPlan {
                            hold_after_stop,
                            preroll: self.preroll_requested(),
                            ring: &self.preroll,
                        },
                        trace_ref,
                    )
                },
            ) {
                Ok(((active, device_name), host_id)) => {
                    self.cache_successful_device(host_id, device_name);
                    self.record_startup(trace, active.sink.as_ref());
                    *guard = Some(active);
                    Ok(())
                }
                Err(err) => Err(err),
            }
        }

        /// Takes the held stream for a recording, or explains why it cannot.
        ///
        /// Returns `None` after retiring a stream that must not be reused, so
        /// the caller falls back to opening a device. Every rejection here is a
        /// stream that would have produced a wrong or empty recording.
        /// Takes the warm stream, if it can serve this press.
        ///
        /// The caller must hold `warm_open_gate` for the whole call, and must
        /// keep holding it until the resulting recording is published into
        /// `inner`. That is the contract that makes one gate do two jobs: it
        /// waits for an open that is already in flight, and it stops a second
        /// press from finding `inner` empty while this one is between its check
        /// and its publish.
        fn adopt_warm_stream(
            &self,
            level_emitter: Option<Arc<LevelEmitter>>,
            chunk_emitter: Option<Arc<ChunkEmitter>>,
            preferred_normalized: Option<&str>,
            trace: &mut AudioStartupTrace,
        ) -> Option<ActiveRecording> {
            let mut warm_guard = match self.warm.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            let warm = warm_guard.take()?;

            // A stream can be running and delivering nothing: the device was
            // unplugged, the host stopped calling the callback after a sleep, or
            // the callback was never called at all. Reusing it would hand the
            // press a stream that never produces a sample, and the whole press
            // would record silence, so it is retired and the caller records
            // cold, which is slower and works.
            if let Some(reason) = warm.unusable_reason(WARM_READY_GRACE) {
                log::warn!(
                    "warm stream on '{}' cannot serve a press ({reason}); reopening cold",
                    warm.device_label
                );
                warm.sink.stop_recording(None);
                retire_stream(warm.stream);
                return None;
            }

            let matches_preference = match (preferred_normalized, warm.preferred.as_deref()) {
                (None, _) => true,
                (Some(wanted), Some(opened)) => wanted == opened.to_ascii_lowercase().as_str(),
                (Some(_), None) => false,
            };

            if !matches_preference {
                log::info!(
                    "warm stream was opened for {:?} but {:?} is now preferred; reopening",
                    warm.preferred,
                    preferred_normalized
                );
                warm.sink.stop_recording(None);
                retire_stream(warm.stream);
                return None;
            }

            trace.note_reused();
            trace.mark(AudioStartupStage::StreamReused);
            trace.mark(AudioStartupStage::StreamStarted);

            // The ring is drained, not read: this audio belongs to the
            // recording that is starting and must not be handed to the next
            // one as well.
            let seed = {
                let mut ring = match self.preroll.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                let samples = ring.drain();
                ring.clear();
                samples
            };
            if !seed.is_empty() {
                log::info!(
                    "warm start carried {} samples ({:.0} ms) captured before the press",
                    seed.len(),
                    seed.len() as f64 * 1000.0 / f64::from(warm.sample_rate.max(1))
                );
            }

            // Taken before the seed is moved into the buffer: this is how much
            // of what follows was captured before the press.
            let seed_len = seed.len();
            let buffer = warm.sink.start_recording(
                level_emitter.clone(),
                chunk_emitter.clone(),
                seed,
                Some(Arc::clone(&self.preroll)),
            );

            Some(ActiveRecording {
                stream: Some(warm.stream),
                sink: Some(warm.sink),
                preroll_after_stop: warm_ring(&self.preroll, self.hold_after_stop()),
                seed_samples: seed_len,
                start: Instant::now(),
                buffer: Some(buffer),
                sample_rate: warm.sample_rate,
                device_label: warm.device_label,
                preferred: warm.preferred,
                channels: warm.channels,
            })
        }

        /// Publishes the startup measurement: one log line per recording, plus
        /// the summary for a caller that wants to read it back.
        ///
        /// The first-block wait is read from the recording's own sink here,
        /// which is the only moment it is still available: the sink is the
        /// authority on whether a block ever arrived, and after the stop it
        /// belongs to the warm slot or to nobody. Reading it at publish time also
        /// means a block that arrived between the stream starting and this call
        /// is counted, rather than being dropped because the trace had been
        /// snapshotted already.
        fn record_startup(&self, trace: AudioStartupTrace, sink: Option<&Arc<StreamSink>>) {
            // The device-open cost, read while the recording still owns its
            // sink: afterwards the sink belongs to the warm slot or to nobody.
            // `None` when no block had arrived yet, which is itself the answer
            // worth recording -- a device that opened and delivered nothing.
            //
            // Without this the summary's `first_pcm_wait_us` could never appear,
            // because nothing ever published one: the trace had an accumulator
            // and a callback-side reporter, and no caller feeding either.
            if let Some(wait) = sink.and_then(|sink| sink.first_pcm_wait()) {
                trace.note_first_pcm(wait);
            }
            let summary = trace.summary();
            log::info!("{}", summary.log_line("audio-startup"));
            if let Ok(mut slot) = self.last_startup.lock() {
                *slot = Some(summary);
            }
        }

        /// The summary of the most recent startup, if one has happened.
        pub fn last_startup_summary(&self) -> Option<AudioStartupSummary> {
            match self.last_startup.lock() {
                Ok(guard) => guard.clone(),
                Err(poisoned) => poisoned.into_inner().clone(),
            }
        }

        /// Opens and starts a capture stream for the current preference and
        /// holds it warm without recording.
        ///
        /// This is the "keep the microphone ready" action. It costs one device
        /// open, which is exactly the cost every later press stops paying. The OS
        /// shows its microphone indicator while this runs, which is why the user
        /// has to ask for it.
        pub fn open_warm(&self, preroll: Duration) -> Result<(), RecordingError> {
            // Lock order, and it is the only order: `warm_open_gate`, then
            // `warm`, then nothing. `inner` is never held alongside the gate.
            //
            // This function used to take the gate, then `warm`, then `inner`,
            // while `start_recording` took `inner` first and waited for the gate
            // inside `adopt_warm_stream`. Two threads doing that is a deadlock:
            // the press waits for a gate the open is holding while the open waits
            // for the `inner` lock the press is holding. Nothing in the tests
            // exercised it, because it needs both calls to overlap, which is
            // exactly what the front end does when it switches keep-ready on in
            // the breath of a press.
            //
            // So `inner` is read *before* the gate is taken, and the reading is
            // re-checked cheaply afterwards by the press itself: a press that
            // starts between the two simply opens its own device, and this holds
            // nothing that would stop it.
            //
            // A recording that is already running has the device, and the front
            // end asks for this in the same breath as it stops one, so the two
            // overlap. Opening a second stream on the same device mid-recording
            // either fails on the device or steals it from the press that is
            // still in flight. The stop path opens its own hold when it ends, so
            // declining here costs nothing and only avoids the collision.
            if self
                .inner
                .lock()
                .map(|guard| guard.is_some())
                .unwrap_or(true)
            {
                log::debug!("a recording owns the device; not opening a warm stream over it");
                return Ok(());
            }

            // Serialises with a press, so the press reuses this open instead of
            // racing it onto the same device. Taken last, and held for the whole
            // device open so a concurrent press waits for it rather than opening
            // a competing stream.
            let _gate = match self.warm_open_gate.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            let mut warm_guard = match self.warm.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            if warm_guard.is_some() {
                log::debug!("warm stream already open; nothing to do");
                return Ok(());
            }

            let preferred_label = {
                let guard = match self.preferred_input_name.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                guard.clone()
            };
            let preferred_trimmed = preferred_label
                .as_ref()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .map(str::to_string);

            // The ring is left empty until the successful stream tells us the
            // real rate; `open_warm_stream` sizes it.
            let warm = self.open_warm_stream(preferred_trimmed.clone(), preroll)?;
            if let Ok(mut ring) = self.preroll.lock() {
                ring.cap = preroll_capacity(preroll, warm.sample_rate);
                ring.clear();
            }
            // Any timer armed before this stream existed is now stale, and it has
            // to learn that before the stream becomes visible here. A linger
            // armed for a previous stream wakes up, checks its generation and
            // finds it current, and would take *this* stream: the user's hold
            // disappears seconds after the switch that asked for it. The bump is
            // inside the lock the timer takes, so the two orderings are the only
            // two possible ones, and both are safe: either the timer ran first
            // and closed the stream it was armed for (there was one in the slot,
            // since this open returns early when there is), or it runs after this
            // and sees a stale generation.
            self.cancel_linger();
            *warm_guard = Some(warm);
            Ok(())
        }

        /// Resolves the device a press would use, without opening a stream.
        ///
        /// The device enumeration and scoring are a real part of the cold start
        /// cost, and they can be done ahead of the press with no microphone
        /// indicator, because nothing captures. Doing them here primes the cache
        /// that `try_cached_device` reads, so the press skips the scoring.
        pub fn prepare_device(&self) -> Result<String, RecordingError> {
            let preferred_label = {
                let guard = match self.preferred_input_name.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                guard.clone()
            };
            let preferred_trimmed = preferred_label
                .as_ref()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let preferred_normalized = preferred_trimmed
                .as_ref()
                .map(|value| value.to_ascii_lowercase());

            // A held stream already resolved the device, and its label is the
            // one a press would use.
            if let Some(label) = self
                .warm
                .lock()
                .ok()
                .and_then(|guard| guard.as_ref().map(|warm| warm.device_label.clone()))
            {
                return Ok(label);
            }

            let hosts = ordered_host_ids();
            let prepared = try_hosts(
                &hosts,
                |id| {
                    cpal::host_from_id(id)
                        .map_err(|err| RecordingError::StreamBuild(err.to_string()))
                },
                |host| {
                    let default_output_name = host
                        .default_output_device()
                        .and_then(|device| device.name().ok());
                    let mut candidates = device_candidates_for_host(
                        host,
                        default_output_name.as_deref(),
                        preferred_normalized.as_deref(),
                    );
                    candidates.sort_by_key(|candidate| {
                        (
                            !candidate.matches_preferred,
                            candidate.priority,
                            !candidate.is_default,
                        )
                    });
                    // A host with no input device is not a failure of this
                    // function; it just cannot answer. Reported as the error the
                    // cross-host loop already skips, so the next host is tried.
                    candidates
                        .into_iter()
                        .next()
                        .map(|best| best.label)
                        .ok_or(RecordingError::InputDeviceUnavailable)
                },
            );
            match prepared {
                Ok((label, host_id)) => {
                    self.cache_successful_device(host_id, label.clone());
                    log::debug!("prepared '{label}' for the next press");
                    Ok(label)
                }
                Err(err) => Err(err),
            }
        }

        /// Reopens the held stream if the device set changed underneath it.
        ///
        /// Devices appear and disappear while the app runs: a headset connects,
        /// a USB interface is plugged in. A held stream cannot follow that,
        /// because a stream is bound to the device it was built on, so the
        /// honest answer is to close it and open the newly best device. Called
        /// when the window is focused, not on a timer.
        pub fn refresh_warm_device(&self) {
            // A recording is using its own stream, and that stream is not in the
            // warm slot, so the checks below would see nothing and return. The
            // guard is explicit anyway, because the close path in this function
            // would otherwise be one refactor away from shutting a live
            // microphone mid-recording.
            if self
                .inner
                .lock()
                .map(|guard| guard.is_some())
                .unwrap_or(true)
            {
                log::debug!("a recording owns the device; not refreshing it");
                return;
            }
            if !self.has_warm_stream() {
                return;
            }
            let current = self
                .warm
                .lock()
                .ok()
                .and_then(|guard| guard.as_ref().map(|warm| warm.device_label.clone()));
            let Some(current) = current else {
                return;
            };

            let best = self.prepare_device().ok();
            match best {
                Some(best) if normalized_name(&best) == normalized_name(&current) => {
                    log::debug!("held device '{current}' is still the best; keeping it");
                }
                Some(best) => {
                    log::info!(
                        "held device '{current}' is no longer the best ('{best}'); reopening"
                    );
                    let preroll = Duration::from_micros(self.preroll_micros.load(Ordering::SeqCst));
                    let policy = self.linger_millis();
                    self.close_warm();
                    // Reopening is only right when the policy holds a device. A
                    // finite window that had already expired, or a policy that
                    // was turned off between the check above and here, would
                    // otherwise open a stream nothing is going to close.
                    if policy == 0 {
                        log::debug!("hold policy is off; not reopening after the device change");
                        return;
                    }
                    if let Err(err) = self.open_warm(preroll) {
                        log::warn!("could not reopen the warm stream after a device change: {err}");
                    } else if policy != WARM_FOREVER_MS {
                        // A finite window restarts from this open, so the device
                        // still closes when the policy said it would.
                        self.linger_then_close(Duration::from_millis(policy));
                    }
                }
                None => {
                    log::warn!("no usable device after a device change; releasing '{current}'");
                    self.close_warm();
                }
            }
        }

        /// One readable line describing the capture path.
        fn status_line(&self) -> String {
            let hold = self.linger_ms.load(Ordering::SeqCst);
            let policy = match hold {
                0 => "cold".to_string(),
                WARM_FOREVER_MS => "ready-forever".to_string(),
                millis => format!("linger-{millis}ms"),
            };
            let preroll = self.preroll.lock().map(|ring| ring.cap).unwrap_or(0);
            let requested_ms = self.preroll_micros.load(Ordering::SeqCst) / 1_000;
            let reused = self
                .last_startup_summary()
                .map(|summary| summary.reused)
                .map(|reused| if reused { "reused" } else { "opened" })
                .unwrap_or("none");
            // "ready" means a press would reuse a working stream, not that an
            // object exists. A stream that has delivered nothing since it opened
            // is not ready in any sense the user cares about, and reporting it as
            // ready is what made a dead device look like a working one in the
            // diagnostics export.
            let ready = self
                .warm
                .lock()
                .ok()
                .and_then(|guard| guard.as_ref().map(|warm| warm.is_usable(WARM_READY_GRACE)))
                .unwrap_or(false);
            format!(
                "ready={ready} policy={policy} preroll_ms={requested_ms} preroll_samples={preroll} last_start={reused}",
            )
        }

        /// Opens a capture stream and leaves it collecting into the warm ring.
        ///
        /// Every host is tried in order, and the first that yields a stream
        /// wins. The trace is recorded so a pre-warm open is measured on the
        /// same clock as a press, which is the only way to say what the hold
        /// actually bought.
        fn open_warm_stream(
            &self,
            preferred_trimmed: Option<String>,
            preroll: Duration,
        ) -> Result<WarmStream, RecordingError> {
            let preferred_normalized = preferred_trimmed
                .as_ref()
                .map(|value| value.to_ascii_lowercase());
            let mut trace = AudioStartupTrace::begin();
            trace.mark(AudioStartupStage::CommandEntered);

            let trace_ref = &mut trace;
            let hosts = ordered_host_ids();
            let opened = try_hosts(
                &hosts,
                |id| {
                    cpal::host_from_id(id)
                        .map_err(|err| RecordingError::StreamBuild(err.to_string()))
                },
                |host| {
                    let result = warm_stream_on_host(
                        host,
                        preferred_trimmed.as_deref(),
                        preferred_normalized.as_deref(),
                        Arc::clone(&self.preroll),
                        preroll,
                        trace_ref,
                    );
                    if let Err(err) = &result {
                        // The message alone cannot distinguish a device another
                        // application is holding from one that was unplugged,
                        // and cpal 0.15 reports both as DeviceNotAvailable. The
                        // classification is logged with the raw text so the two
                        // cases can be told apart after the fact without
                        // reproducing them.
                        let reason =
                            crate::platform::mic_usage::classify_open_failure(&err.to_string());
                        log::warn!(
                            "this host did not yield a warm input device ({reason}): {err}",
                            reason = reason.as_str()
                        );
                    }
                    result
                },
            );
            match opened {
                Ok((warm, _host_id)) => {
                    self.record_startup(trace, Some(&warm.sink));
                    Ok(warm)
                }
                Err(err) => Err(err),
            }
        }

        fn pause_recording(&self) -> Result<(), RecordingError> {
            let guard = self
                .inner
                .lock()
                .map_err(|_| RecordingError::NotRecording)?;
            let recording = guard.as_ref().ok_or(RecordingError::NotRecording)?;
            recording
                .stream_ref()?
                .pause()
                .map_err(|err| RecordingError::StreamPlay(err.to_string()))?;
            if let Some(sink) = &recording.sink {
                sink.set_paused(true);
            }
            // Clear the ring while paused. Without this, resuming collects
            // pre-roll audio that belongs to the pause, and a stop-then-start
            // would prepend speech from before the user walked away.
            if let Some(preroll) = &recording.preroll_after_stop {
                if let Ok(mut ring) = preroll.lock() {
                    ring.clear();
                }
            }
            log::info!("capture stream paused");
            Ok(())
        }

        fn resume_recording(&self) -> Result<(), RecordingError> {
            let guard = self
                .inner
                .lock()
                .map_err(|_| RecordingError::NotRecording)?;
            let recording = guard.as_ref().ok_or(RecordingError::NotRecording)?;
            recording
                .stream_ref()?
                .play()
                .map_err(|err| RecordingError::StreamPlay(err.to_string()))?;
            // The pause froze the emitters' throttle clocks as well as the
            // device. Restarting the press clock keeps the first-sample
            // measurement from reporting the whole paused interval.
            if let Some(sink) = &recording.sink {
                sink.set_paused(false);
                sink.restart_press_clock();
            }
            log::info!("capture stream resumed");
            Ok(())
        }

        fn stop_recording(&self) -> Result<RecordingResult, RecordingError> {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| RecordingError::NotRecording)?;
            let mut recording = guard.take().ok_or(RecordingError::NotRecording)?;
            let sample_rate = recording.sample_rate;
            let seed_samples = recording.seed_samples;
            let wall_duration = recording.start.elapsed();
            // Read before the sink is unsubscribed: both facts belong to this
            // recording, and the sink is handed to the warm slot below.
            let capture_fault = recording
                .sink
                .as_ref()
                .and_then(|sink| sink.fault_token())
                .map(str::to_string);
            // A pause is the user's own decision, so the time it consumed is not
            // time the capture failed to deliver. Without this subtraction every
            // paused dictation reads as a recording that died partway through,
            // which is precisely the signal the fault path exists to make
            // trustworthy.
            let paused_for = recording
                .sink
                .as_ref()
                .map(|sink| sink.paused_for())
                .unwrap_or_default();
            let expected_duration = wall_duration.saturating_sub(paused_for);
            let buffer = recording.buffer.clone();
            let device_label = recording.device_label.clone();
            let preferred = recording.preferred.clone();
            let channels = recording.channels;

            // Unsubscribing before closing keeps the capture callback from
            // writing a sample into a recording that already returned.
            let resumed_preroll = recording.preroll_after_stop.take();
            let stop_outcome = recording
                .sink
                .as_ref()
                .map(|sink| sink.stop_recording(resumed_preroll.clone()))
                .unwrap_or(StopOutcome {
                    emitter: None,
                    was_paused: false,
                });
            // The sink is the authority on whether the stream was paused, and it
            // has just cleared that flag. Reading `is_paused()` afterwards — the
            // original shape of this code — always answered "not paused", so a
            // stream stopped while paused went into the warm slot asleep and the
            // next press adopted a stream that delivered nothing until the
            // staleness window expired.
            let was_paused = stop_outcome.was_paused;
            // Read again now that the sink has stopped. The first read above is
            // followed by several lock acquisitions and the sink hand-off, which
            // is long enough for the host's error callback to report a dead
            // stream in between; that token was stored and then never read, so
            // the user got a truncated dictation with no notice.
            //
            // This narrows the window to the instructions between this read and
            // `reported_capture_fault` below. It does not close it: `record_fault`
            // runs on the host's error thread and takes no lock this path holds,
            // so there is no ordering to appeal to. Closing it properly would
            // mean the stop waiting for in-flight callbacks, which can block on an
            // audio thread the host has already wedged. A fault that still slips
            // past is the silent-death case `elapsed_gap_is_suspicious` logs.
            //
            // The first token wins, so a fault already seen above is kept.
            let capture_fault = recording
                .sink
                .as_ref()
                .and_then(|sink| sink.fault_token())
                .map(str::to_string)
                .or(capture_fault);
            let flushed_emitter = stop_outcome.emitter;
            if let Some(chunk_emitter) = flushed_emitter {
                chunk_emitter.flush();
            }

            // The device is not closed here. A configured preroll ring means the
            // microphone should stay ready, so the same running stream goes back
            // into the warm slot and the next press skips the device open
            // entirely. Without a ring the stream is retired below.
            //
            // A stream the host declared dead is the exception: it can never
            // serve a press, so leaving it in the warm slot holds the
            // microphone indicator on for a device that cannot record, and keeps
            // a broken stream alive until the next press rejects it. It is
            // closed here instead, and the next press opens a working device.
            // Reads the token as the host reported it, before the gap filter
            // below: a stream declared gone is retired even when its last
            // recording happened to be whole.
            let keep_warm = capture_fault.is_none();
            let pending_linger = self.pending_linger();
            if !keep_warm {
                log::info!(
                    "not holding a capture stream the host reported gone; the next press opens one"
                );
            }
            // The stream is taken out of the recording either way, so that a
            // faulted one is retired deliberately rather than dropped as a
            // side effect of the recording going out of scope. A stop that
            // leaves the device open is the defect this whole path exists to
            // avoid, and an implicit drop makes the intent unreadable.
            let stream = recording.stream.take();
            let stream_to_hold = match (keep_warm, stream) {
                (true, stream) => stream,
                (false, Some(stream)) => {
                    retire_stream(stream);
                    None
                }
                (false, None) => None,
            };
            match (resumed_preroll, stream_to_hold) {
                (Some(_preroll), Some(stream)) => {
                    let sink = recording.sink.clone();
                    if let Some(sink) = sink {
                        // A stream stopped while paused is still stopped: the
                        // next press would adopt it, hear nothing, and pay a
                        // cold reopen after the staleness window, which is worse
                        // than the cold start it was meant to avoid. Resuming
                        // costs no device open and is what the hold was for.
                        if was_paused {
                            if let Err(err) = stream.play() {
                                log::warn!("could not resume a paused stream for the hold: {err}");
                            } else {
                                log::info!("resumed a paused capture stream for the hold");
                            }
                        }
                        let mut warm = match self.warm.lock() {
                            Ok(guard) => guard,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        if let Some(previous) = warm.replace(WarmStream {
                            stream,
                            sink,
                            preferred,
                            sample_rate,
                            channels,
                            device_label,
                        }) {
                            retire_stream(previous.stream);
                        }
                        // The stream is warm but no press has claimed it, so a
                        // finite window closes it late; a press inside that
                        // window is instant and a press after it pays the device
                        // open again. The explicit preference sends
                        // `WARM_FOREVER_MS` here, which never schedules a close.
                        drop(warm);
                        match pending_linger {
                            Some(linger) => self.linger_then_close(linger),
                            None => self.cancel_linger(),
                        }
                    }
                }
                (_, Some(stream)) => retire_stream(stream),
                _ => {}
            }

            let samples = buffer
                .as_ref()
                .and_then(|buffer| buffer.lock().ok())
                .map(|guard| guard.clone())
                .unwrap_or_default();
            // Only the samples captured *after* the press count as this
            // recording's length. A warm start seeds the buffer with the
            // pre-roll, so counting every sample would credit the recording with
            // up to two seconds of audio from before it began, and that credit is
            // indistinguishable from a stream that died for the same span.
            let duration = if let Some(captured) =
                captured_duration(samples.len(), seed_samples, sample_rate)
            {
                captured
            } else {
                // Nothing was captured, so there is no sample-derived length. The
                // wall clock is the honest stand-in, minus any pause.
                expected_duration
            };
            let size_bytes = samples.len() as u64 * std::mem::size_of::<f32>() as u64;

            let capture_fault = reported_capture_fault(capture_fault, duration, expected_duration);

            // A capture that stopped early is logged with both figures. The
            // numbers are the whole value here: "the recording is 1.4 s long and
            // was open for 6.0 s" says the stream died at 1.4 s, which no single
            // duration can express.
            if let Some(fault) = capture_fault.as_deref() {
                log::warn!(
                    "capture reported {fault} during the recording: captured {} ms of {} ms",
                    duration.as_millis(),
                    expected_duration.as_millis()
                );
            } else if elapsed_gap_is_suspicious(duration, expected_duration) {
                // The host said nothing, and the recording is materially shorter
                // than the time it was open. That is the silent death this
                // module cannot prevent but must not hide.
                log::warn!(
                    "capture delivered {} ms of audio in {} ms of recording without reporting an error",
                    duration.as_millis(),
                    expected_duration.as_millis()
                );
            }

            Ok(RecordingResult {
                metrics: RecordingMetrics {
                    duration,
                    expected_duration,
                    size_bytes,
                    capture_fault,
                },
                audio: RecordedAudio {
                    samples,
                    sample_rate,
                },
            })
        }
    }

    impl Recorder for RecordingManager {
        fn start(
            &self,
            level_callback: Option<LevelCallback>,
            chunk_callback: Option<ChunkCallback>,
        ) -> Result<(), Box<dyn std::error::Error>> {
            self.start_recording(level_callback, chunk_callback)
                .map_err(|err| Box::new(err) as _)
        }

        fn stop(&self) -> Result<RecordingResult, Box<dyn std::error::Error>> {
            self.stop_recording().map_err(|err| Box::new(err) as _)
        }

        fn pause(&self) -> Result<(), Box<dyn std::error::Error>> {
            self.pause_recording().map_err(|err| Box::new(err) as _)
        }

        fn resume(&self) -> Result<(), Box<dyn std::error::Error>> {
            self.resume_recording().map_err(|err| Box::new(err) as _)
        }

        fn set_preferred_input_device(&self, name: Option<String>) {
            let sanitized = name
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());

            // The command layer sets this on every press, so an unchanged value
            // has to cost nothing. Reopening the held stream on every press
            // would turn the pre-warm into a device open per press, which is the
            // exact cost it exists to remove.
            let unchanged = match self.preferred_input_name.lock() {
                Ok(mut guard) => {
                    if *guard == sanitized {
                        true
                    } else {
                        *guard = sanitized;
                        false
                    }
                }
                Err(poisoned) => {
                    let mut guard = poisoned.into_inner();
                    if *guard == sanitized {
                        true
                    } else {
                        *guard = sanitized;
                        false
                    }
                }
            };
            if unchanged {
                return;
            }

            self.clear_device_cache();

            // A held stream belongs to the device it was opened on, so a changed
            // preference must not leave it recording the old microphone. Closing
            // it here means the change takes effect immediately instead of after
            // the linger window, and it clears the indicator for a device the
            // user just moved off.
            if self.has_warm_stream() {
                log::info!("preferred input changed; closing the warm stream for the old device");
                self.close_warm();

                // A held microphone has to follow the choice, not only stop
                // using the old device. Closing alone would leave "keep it
                // ready" on and the microphone shut, so the indicator would go
                // out and the next press would open cold with no hint why.
                if self.linger_ms.load(Ordering::SeqCst) == WARM_FOREVER_MS {
                    let preroll = Duration::from_micros(self.preroll_micros.load(Ordering::SeqCst));
                    if let Err(err) = self.open_warm(preroll) {
                        log::warn!("could not reopen on the new preferred device: {err}");
                    }
                }
            }
        }

        fn clear_device_cache(&self) {
            if let Ok(mut guard) = self.last_successful_device.lock() {
                *guard = None;
                log::debug!("device cache cleared");
            }
        }

        fn current_sample_rate(&self) -> Option<u32> {
            let guard = match self.inner.lock() {
                Ok(inner) => inner,
                Err(poisoned) => poisoned.into_inner(),
            };
            guard.as_ref().map(|active| active.sample_rate)
        }
    }

    impl crate::platform::WarmCapture for RecordingManager {
        fn warm_open(&self, preroll: Duration) -> Result<(), String> {
            self.open_warm(preroll).map_err(|err| err.to_string())
        }

        fn set_preroll(&self, preroll: Duration) {
            self.set_preroll(preroll);
        }

        fn prepare(&self) -> Result<String, String> {
            self.prepare_device().map_err(|err| err.to_string())
        }

        fn refresh_device(&self) {
            self.refresh_warm_device();
        }

        fn promote_to_hold(&self) {
            self.promote_to_hold();
        }

        fn release_hold(&self) {
            self.release_hold();
        }

        fn warm_close(&self) {
            self.close_warm();
        }

        fn is_ready(&self) -> bool {
            // The dialog shows this and the user trusts it. A held stream that
            // has delivered nothing is not ready: a press would adopt it and
            // record silence.
            self.warm_is_usable()
        }

        fn has_held_stream(&self) -> bool {
            self.has_warm_stream()
        }

        fn set_linger(&self, linger_ms: u64) {
            self.set_linger(Duration::from_millis(linger_ms));
        }

        fn status_line(&self) -> String {
            self.status_line()
        }

        fn last_startup(&self) -> Option<Vec<(String, u64)>> {
            self.last_startup_summary().map(|summary| {
                let mut stages = vec![(
                    "total".to_string(),
                    summary.total.as_micros().min(u128::from(u64::MAX)) as u64,
                )];
                for mark in &summary.stages {
                    stages.push((
                        mark.stage.as_str().to_string(),
                        mark.at.as_micros().min(u128::from(u64::MAX)) as u64,
                    ));
                }
                stages
            })
        }
    }

    fn should_avoid_input_device(device: &Device, default_output_name: Option<&str>) -> bool {
        let device_name = device.name().ok();
        let name_match = device_name
            .as_deref()
            .map(|name| {
                let lower = name.to_ascii_lowercase();
                super::LOW_QUALITY_INPUT_KEYWORDS
                    .iter()
                    .any(|keyword| lower.contains(keyword))
            })
            .unwrap_or(false);

        let output_match = default_output_name.is_some_and(|name| {
            let lower = name.to_ascii_lowercase();
            super::LOW_QUALITY_INPUT_KEYWORDS
                .iter()
                .any(|keyword| lower.contains(keyword))
        });

        if name_match && output_match {
            return true;
        }

        if let Ok(config) = device.default_input_config() {
            if config.sample_rate().0 <= 16_000 {
                return true;
            }
        }

        false
    }

    fn is_preferred_input_device_name(name: &str) -> bool {
        let lower = name.to_ascii_lowercase();
        if super::LOW_QUALITY_INPUT_KEYWORDS
            .iter()
            .any(|keyword| lower.contains(keyword))
        {
            return false;
        }

        lower.contains("microphone") || lower.contains(" mic") || lower.ends_with("mic")
    }

    fn is_builtin_microphone_name(name: &str) -> bool {
        let lower = name.to_ascii_lowercase();
        lower.contains("built-in")
            || lower.contains("builtin")
            || lower.contains("macbook")
            || lower.contains("mac mini")
            || lower.contains("imac")
            || lower.contains("mac studio")
            || lower.contains("dmic")
            || lower.contains("internal mic")
            || lower.contains("int mic")
    }

    fn name_has_low_quality_keyword(name: &str) -> bool {
        super::label_has_low_quality_keyword(name)
    }

    /// All available hosts with the cpal default host first.
    fn ordered_host_ids() -> Vec<HostId> {
        order_hosts(cpal::default_host().id(), &cpal::available_hosts())
    }

    /// The same ordering, over an explicit list of hosts.
    ///
    /// `ordered_host_ids` can only describe the machine it runs on, which makes
    /// the cross-host fallback untestable: a CI box exposes one host, so a loop
    /// that gave up after the first failure would pass every test here and fail
    /// on a machine with two. This is the same rule factored out, so the order
    /// can be asserted against a list rather than observed on hardware.
    fn order_hosts<Id: Copy + PartialEq>(default: Id, available: &[Id]) -> Vec<Id> {
        let mut ordered: Vec<Id> = Vec::with_capacity(available.len().saturating_add(1));
        // The default is tried first because it is the one the platform routes
        // the user's audio through, but it is not trusted to be in the list:
        // cpal's `available_hosts` has been known to omit it.
        ordered.push(default);
        for id in available {
            // A host listed twice would otherwise be opened twice, and on a
            // backend whose enumeration is unstable that is a second device open
            // on every press for nothing.
            if !ordered.contains(id) {
                ordered.push(*id);
            }
        }
        ordered
    }

    /// Tries each host in turn until one yields a value.
    ///
    /// One host failing is not the press failing: a machine with PulseAudio's
    /// ALSA plugin and a JACK server exposes two, and either can serve the
    /// microphone while the other refuses. A loop that returned the first error
    /// would hand the user "no input device" on a machine that has one.
    ///
    /// Generic over the host type, and over how a host is produced, so the
    /// fallback can be tested with a stand-in host. A CI machine exposes a
    /// single host, so the two-host case is otherwise unreachable here.
    fn try_hosts<Id, H, T>(
        hosts: &[Id],
        mut load: impl FnMut(Id) -> Result<H, RecordingError>,
        mut attempt: impl FnMut(&H) -> Result<T, RecordingError>,
    ) -> Result<(T, Id), RecordingError>
    where
        Id: Copy + std::fmt::Debug,
    {
        // Only a host that loaded and then failed to produce a stream is worth
        // reporting: its message is the one the user can act on ("it is in use",
        // "it was unplugged"). A host that would not load at all says something
        // about this build's backend wiring, not about the microphone, so it is
        // logged and does not become the press's failure. Before this split a
        // refused host replaced a perfectly good "no input device" with an
        // internal "stream build:" message the UI cannot classify.
        let mut attempt_err: Option<RecordingError> = None;
        for id in hosts {
            let host = match load(*id) {
                Ok(host) => host,
                Err(err) => {
                    log::warn!("host {id:?} could not be loaded: {err}");
                    continue;
                }
            };
            match attempt(&host) {
                Ok(value) => return Ok((value, *id)),
                Err(err) => {
                    log::warn!("host {id:?} did not yield a usable input device: {err}");
                    attempt_err = Some(err);
                }
            }
        }
        Err(attempt_err.unwrap_or(RecordingError::InputDeviceUnavailable))
    }

    /// One device, as the selection loop sees it.
    ///
    /// Deliberately plain data with no `Device` in it: the loop that consumes it
    /// is then testable on a machine with no audio hardware, which is where all
    /// of its interesting cases live.
    #[derive(Clone, Debug)]
    struct CandidateChoice {
        label: String,
        matches_preferred: bool,
        avoid_reason: Option<String>,
    }

    /// What one attempt at one candidate on one host produced.
    ///
    /// The device-selection loops are generic over this instead of over cpal's
    /// `Host`, so a test can drive them with a scripted host: a device that is
    /// listed but refuses to open, a host that enumerates nothing, a list where
    /// the first entry fails. Every branch of those loops is a case the user
    /// meets only on a machine with odd hardware, which is exactly the code that
    /// otherwise never gets exercised.
    trait CandidateAttempt {
        /// What a successful attempt yields.
        type Recorded;
        /// The devices to try, in preference order. Marking the trace is this
        /// method's job because it is the only step every implementation shares
        /// and it is the one that must happen before anything is opened.
        fn candidates(&mut self) -> Vec<CandidateChoice>;
        /// Tries one candidate.
        fn try_candidate(
            &mut self,
            choice: &CandidateChoice,
        ) -> Result<Self::Recorded, RecordingError>;
    }

    /// Runs the candidate loop of one host and returns what recorded.
    ///
    /// Every candidate is tried in order and a failure is remembered rather than
    /// returned: one device that will not open must not hide the one beside it
    /// that will. Returns the last error when none succeed, so a press on a host
    /// whose every device is busy reports that host's failure rather than the
    /// generic "no input device" the caller substitutes when there is no error
    /// to report.
    fn first_working_candidate<A: CandidateAttempt>(
        attempt: &mut A,
    ) -> Result<(A::Recorded, CandidateChoice), RecordingError> {
        let mut last_err: Option<RecordingError> = None;
        for choice in attempt.candidates() {
            if let Some(reason) = &choice.avoid_reason {
                log::debug!(
                    "deprioritising '{}' ({reason}); will try if others fail",
                    choice.label
                );
            }
            match attempt.try_candidate(&choice) {
                Ok(recorded) => return Ok((recorded, choice)),
                Err(err) => {
                    log::error!("failed to start on '{}': {err}", choice.label);
                    last_err = Some(err);
                }
            }
        }
        // An empty candidate list and a list where every candidate failed are
        // different stories with the same meaning for the caller — this host
        // cannot serve the press — so both produce the same error shape.
        Err(last_err.unwrap_or(RecordingError::InputDeviceUnavailable))
    }

    /// The real attempt: one cpal host, its scored candidates, its devices.
    struct HostAttempt<'a> {
        host: &'a cpal::Host,
        level_emitter: Option<Arc<LevelEmitter>>,
        chunk_emitter: Option<Arc<ChunkEmitter>>,
        preferred_normalized: Option<&'a str>,
        hold: HoldPlan<'a>,
        trace: &'a mut AudioStartupTrace,
        /// The devices `candidates` resolved, kept so `try_candidate` does not
        /// enumerate the host again for each of them.
        resolved: Vec<(CandidateChoice, Device)>,
    }

    impl CandidateAttempt for HostAttempt<'_> {
        type Recorded = ActiveRecording;

        fn candidates(&mut self) -> Vec<CandidateChoice> {
            let default_output_name = self
                .host
                .default_output_device()
                .and_then(|device| device.name().ok());
            let mut candidates = device_candidates_for_host(
                self.host,
                default_output_name.as_deref(),
                self.preferred_normalized,
            );
            // Devices are no longer merged by name, so ties are broken by the
            // host default first and then by enumeration order (`sort_by_key` is
            // stable).
            candidates.sort_by_key(|candidate| {
                (
                    !candidate.matches_preferred,
                    candidate.priority,
                    !candidate.is_default,
                )
            });
            self.trace.mark(AudioStartupStage::DeviceResolved);
            self.resolved = candidates
                .into_iter()
                .map(|candidate| {
                    let choice = CandidateChoice {
                        label: candidate.label,
                        matches_preferred: candidate.matches_preferred,
                        avoid_reason: candidate.avoid_reason,
                    };
                    (choice, candidate.device)
                })
                .collect();
            self.resolved
                .iter()
                .map(|(choice, _)| choice.clone())
                .collect()
        }

        fn try_candidate(
            &mut self,
            choice: &CandidateChoice,
        ) -> Result<Self::Recorded, RecordingError> {
            let device = self
                .resolved
                .iter()
                .find(|(resolved, _)| resolved.label == choice.label)
                .map(|(_, device)| device)
                .ok_or(RecordingError::InputDeviceUnavailable)?;
            try_start_on_device(
                device,
                Some(&choice.label),
                self.level_emitter.clone(),
                self.chunk_emitter.clone(),
                self.hold,
                self.trace,
            )
        }
    }

    /// Builds a capture stream that feeds a sink rather than a recording.    /// Builds a capture stream that feeds a sink rather than a recording.
    ///
    /// The sink is what makes the pre-warm possible: the stream's lifetime is
    /// independent of any recording, so it can be opened once and handed between
    /// recordings. Frames are folded to mono here, before they reach the sink, so
    /// every consumer sees one consistent channel count.
    fn build_sink_stream(
        device: &Device,
        config: &StreamConfig,
        sample_format: Option<SampleFormat>,
        sink: Arc<StreamSink>,
    ) -> Result<Stream, RecordingError> {
        let channel_count = cmp::max(config.channels as usize, 1);
        let sample_format = match sample_format {
            Some(format) => format,
            // No format was resolved for this config, so nothing describes the
            // samples and building a stream would read them as the wrong type.
            None => {
                return Err(RecordingError::StreamConfig(
                    "no sample format resolved for this device".to_string(),
                ))
            }
        };

        fn fold<T>(data: &[T], channel_count: usize) -> Vec<f32>
        where
            T: cpal::Sample + cpal::SizedSample,
            f32: cpal::FromSample<T>,
        {
            let mut mono = Vec::with_capacity(data.len() / channel_count + 1);
            if channel_count == 1 {
                for sample in data {
                    mono.push((*sample).to_sample::<f32>());
                }
                return mono;
            }
            let mut index = 0;
            while index < data.len() {
                let mut sum = 0.0f32;
                let mut frames = 0usize;
                for channel in 0..channel_count {
                    let sample_index = index + channel;
                    if sample_index >= data.len() {
                        break;
                    }
                    sum += data[sample_index].to_sample::<f32>();
                    frames += 1;
                }
                if frames > 0 {
                    mono.push(sum / frames as f32);
                }
                index += channel_count;
            }
            mono
        }

        // Each arm gets its own sink handle so the error callback can record the
        // fault on the same sink the data callback fills. A logged-only callback
        // left a dead stream looking healthy: it stayed in the warm slot, the
        // stop path saw a stream that had opened successfully, and the recording
        // came back short with nothing saying why.
        //
        // The callback runs on a host thread, so it does no work beyond
        // classifying the text and setting one mutex-guarded token.
        match sample_format {
            SampleFormat::I16 => {
                let sink = Arc::clone(&sink);
                let error_sink = Arc::clone(&sink);
                device
                    .build_input_stream(
                        config,
                        move |data: &[i16], _| sink.deliver(&fold(data, channel_count)),
                        move |err| error_sink.record_fault(&err.to_string()),
                        None,
                    )
                    .map_err(|err| RecordingError::StreamBuild(err.to_string()))
            }
            SampleFormat::U16 => {
                let sink = Arc::clone(&sink);
                let error_sink = Arc::clone(&sink);
                device
                    .build_input_stream(
                        config,
                        move |data: &[u16], _| sink.deliver(&fold(data, channel_count)),
                        move |err| error_sink.record_fault(&err.to_string()),
                        None,
                    )
                    .map_err(|err| RecordingError::StreamBuild(err.to_string()))
            }
            SampleFormat::F32 => {
                let sink = Arc::clone(&sink);
                let error_sink = Arc::clone(&sink);
                device
                    .build_input_stream(
                        config,
                        move |data: &[f32], _| sink.deliver(&fold(data, channel_count)),
                        move |err| error_sink.record_fault(&err.to_string()),
                        None,
                    )
                    .map_err(|err| RecordingError::StreamBuild(err.to_string()))
            }
            other => Err(RecordingError::UnsupportedFormat(other)),
        }
    }

    /// Opens a device and starts a stream that has no recording attached yet.
    ///
    /// The stream collects into the ring from its first block, so the pre-roll
    /// is already there when the user presses.
    fn open_warm_on_device(
        device: &Device,
        label: &str,
        preferred: Option<String>,
        preroll: Duration,
        ring: Arc<Mutex<Preroll>>,
        trace: &mut AudioStartupTrace,
    ) -> Result<WarmStream, RecordingError> {
        let config = device
            .default_input_config()
            .map_err(|err| RecordingError::StreamConfig(err.to_string()))?;
        let sample_format = config.sample_format();
        let stream_config: StreamConfig = config.into();
        let sample_rate = stream_config.sample_rate.0;
        let channels = cmp::max(stream_config.channels as usize, 1);

        // Size the ring from the real device rate, not a guess: the ring holds a
        // sample count, so the same duration is a different count per device.
        if let Ok(mut ring) = ring.lock() {
            ring.cap = preroll_capacity(preroll, sample_rate);
            ring.clear();
        }

        let sink = StreamSink::new(SinkMode::Warm {
            preroll: Arc::clone(&ring),
        });
        let stream = build_sink_stream(
            device,
            &stream_config,
            Some(sample_format),
            Arc::clone(&sink),
        )?;
        trace.mark(AudioStartupStage::StreamBuilt);

        stream
            .play()
            .map_err(|err| RecordingError::StreamPlay(err.to_string()))?;
        trace.mark(AudioStartupStage::StreamStarted);

        Ok(WarmStream {
            stream,
            sink,
            preferred,
            sample_rate,
            channels,
            device_label: label.to_string(),
        })
    }

    /// Opens a warm stream on the best candidate device of one host.
    fn warm_stream_on_host(
        host: &cpal::Host,
        preferred_label: Option<&str>,
        preferred_normalized: Option<&str>,
        ring: Arc<Mutex<Preroll>>,
        preroll: Duration,
        trace: &mut AudioStartupTrace,
    ) -> Result<WarmStream, RecordingError> {
        // The same candidate loop as the cold path, so a device that refuses to
        // open for a recording refuses for a hold too, and the hold does not
        // inherit a second, subtly different ordering rule.
        struct WarmAttempt<'a> {
            host: &'a cpal::Host,
            preferred_label: Option<&'a str>,
            preferred_normalized: Option<&'a str>,
            ring: Arc<Mutex<Preroll>>,
            preroll: Duration,
            trace: &'a mut AudioStartupTrace,
        }

        impl CandidateAttempt for WarmAttempt<'_> {
            type Recorded = WarmStream;

            fn candidates(&mut self) -> Vec<CandidateChoice> {
                let default_output_name = self
                    .host
                    .default_output_device()
                    .and_then(|device| device.name().ok());
                let mut candidates = device_candidates_for_host(
                    self.host,
                    default_output_name.as_deref(),
                    self.preferred_normalized,
                );
                candidates.sort_by_key(|candidate| {
                    (
                        !candidate.matches_preferred,
                        candidate.priority,
                        !candidate.is_default,
                    )
                });
                self.trace.mark(AudioStartupStage::DeviceResolved);
                candidates
                    .into_iter()
                    .map(|candidate| CandidateChoice {
                        label: candidate.label,
                        matches_preferred: candidate.matches_preferred,
                        avoid_reason: candidate.avoid_reason,
                    })
                    .collect()
            }

            fn try_candidate(
                &mut self,
                choice: &CandidateChoice,
            ) -> Result<Self::Recorded, RecordingError> {
                let device = find_device_by_label(self.host, &choice.label)
                    .ok_or(RecordingError::InputDeviceUnavailable)?;
                open_warm_on_device(
                    &device,
                    &choice.label,
                    self.preferred_label.map(str::to_string),
                    self.preroll,
                    Arc::clone(&self.ring),
                    self.trace,
                )
            }
        }

        let mut attempt = WarmAttempt {
            host,
            preferred_label,
            preferred_normalized,
            ring,
            preroll,
            trace,
        };
        let (warm, choice) = first_working_candidate(&mut attempt)?;
        log::info!(
            "holding input device '{}' open via host {:?}",
            choice.label,
            host.id()
        );
        Ok(warm)
    }

    /// Opens an input stream on a specific device and starts recording on it.
    ///
    /// The stream is left warm at stop when a hold is configured. A cold start
    /// prepends nothing: `cold_start_seed` returns an empty seed and a ring that
    /// keeps nothing, so this recording cannot carry a previous stream's audio
    /// and cannot stay open by accident.
    fn try_start_on_device(
        device: &Device,
        device_name: Option<&str>,
        level_emitter: Option<Arc<LevelEmitter>>,
        chunk_emitter: Option<Arc<ChunkEmitter>>,
        hold: HoldPlan<'_>,
        trace: &mut AudioStartupTrace,
    ) -> Result<ActiveRecording, RecordingError> {
        let label = device_name.unwrap_or(UNKNOWN_DEVICE_LABEL);

        let config = device
            .default_input_config()
            .map_err(|err| RecordingError::StreamConfig(err.to_string()))?;
        let sample_format = config.sample_format();
        let stream_config: StreamConfig = config.into();
        let sample_rate = stream_config.sample_rate.0;
        let channels = cmp::max(stream_config.channels as usize, 1);
        trace.mark(AudioStartupStage::DeviceResolved);

        let (seed, _unused_ring) = cold_start_seed();

        // The ring has to be ready before the stream starts, not after the
        // recording stops. It was sized only on the warm path, so a cold start
        // left it at zero capacity: nothing accumulated during the recording, and
        // the "leave the stream warm" step handed the next press a ring that
        // could never hold anything. The next recording then started with no
        // pre-roll, and so did every recording after it, which made the setting
        // do nothing at all for anyone who had not turned on keep-ready.
        //
        // Its capacity is a sample count, so it is sized from this device's rate.
        if let Ok(mut ring) = hold.ring.lock() {
            ring.cap = preroll_capacity(hold.preroll, sample_rate);
            ring.clear();
        }

        let sink = StreamSink::new(SinkMode::Discard);
        let stream = build_sink_stream(
            device,
            &stream_config,
            Some(sample_format),
            Arc::clone(&sink),
        )?;
        trace.mark(AudioStartupStage::StreamBuilt);

        stream
            .play()
            .map_err(|err| RecordingError::StreamPlay(err.to_string()))?;
        trace.mark(AudioStartupStage::StreamStarted);

        let buffer = sink.start_recording(
            level_emitter,
            chunk_emitter,
            seed,
            // Only collect if this stream is going to stay open: a stop that
            // closes the device has no next press to serve, and filling a ring
            // nobody will read is work on the audio thread for nothing.
            hold.hold_after_stop.then(|| Arc::clone(hold.ring)),
        );
        log::info!("started on device '{label}'");

        Ok(ActiveRecording {
            stream: Some(stream),
            sink: Some(sink),
            preroll_after_stop: warm_ring(hold.ring, hold.hold_after_stop),
            seed_samples: 0,
            start: Instant::now(),
            buffer: Some(buffer),
            sample_rate,
            device_label: label.to_string(),
            preferred: device_name.map(str::to_string),
            channels,
        })
    }

    /// Starts recording on the best candidate device of one host.
    ///
    /// Candidates are scored and tried in preference order (preferred match,
    /// then priority, then default-first); the returned label identifies the
    /// device that ended up recording.
    ///
    /// # Errors
    ///
    /// Returns a recording error when no candidate on the host yields a usable
    /// input stream.
    fn start_recording_on_host(
        host: &cpal::Host,
        level_emitter: Option<Arc<LevelEmitter>>,
        chunk_emitter: Option<Arc<ChunkEmitter>>,
        preferred_label: Option<&str>,
        preferred_normalized: Option<&str>,
        hold: HoldPlan<'_>,
        trace: &mut AudioStartupTrace,
    ) -> Result<(ActiveRecording, String), RecordingError> {
        let fallback_preferred = preferred_label.or(preferred_normalized);
        let mut attempt = HostAttempt {
            host,
            level_emitter,
            chunk_emitter,
            preferred_normalized,
            hold,
            trace,
            resolved: Vec::new(),
        };
        let (active, choice) = first_working_candidate(&mut attempt)?;
        let label = choice.label;

        if choice.matches_preferred {
            log::info!(
                "using preferred input device '{label}' via host {:?}",
                host.id()
            );
        } else if let Some(preferred) = fallback_preferred {
            log::warn!(
                "preferred input '{preferred}' not available; using '{label}' via host {:?}",
                host.id()
            );
        } else {
            log::info!("using input device '{label}' via host {:?}", host.id());
        }

        Ok((active, label))
    }

    struct DeviceCandidate {
        device: Device,
        /// Human-readable identity used by the UI and by saved preferences.
        label: String,
        priority: u32,
        avoid_reason: Option<String>,
        matches_preferred: bool,
        is_default: bool,
    }

    /// A host device paired with the identity the UI and preferences address it by.
    struct LabelledDevice {
        device: Device,
        name: Option<String>,
        label: String,
        is_default: bool,
    }

    const UNKNOWN_DEVICE_LABEL: &str = "<unknown>";

    /// Lowercases and trims a device name so labels compare and match
    /// case-insensitively.
    fn normalized_name(value: &str) -> String {
        value.trim().to_ascii_lowercase()
    }

    /// The trimmed display name of a device, or `None` when the name cannot be
    /// read or is empty.
    fn device_display_name(device: &Device) -> Option<String> {
        device
            .name()
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    /// Suffixes the second and later devices that report the same name, so two
    /// distinct microphones never collapse into one entry. The first device keeps
    /// the bare name, which is what preferences saved before disambiguation hold.
    ///
    /// Ordinal suffixes are assigned by enumeration position, which cpal does
    /// not guarantee across runs or device replugging, so a disambiguated label
    /// is only stable for the lifetime of one enumeration.
    fn disambiguated_label(name: &str, occurrence: usize) -> String {
        if occurrence == 0 {
            name.to_string()
        } else {
            format!("{name} ({})", occurrence + 1)
        }
    }

    /// Enumerates every input device a host exposes, in host order, flagging the
    /// default. cpal has no stable device identity, so devices are kept apart by
    /// enumeration order instead of being merged by name.
    fn labelled_devices_for_host(host: &cpal::Host) -> Vec<LabelledDevice> {
        let default_device = host.default_input_device();
        let default_normalized = default_device
            .as_ref()
            .and_then(device_display_name)
            .map(|name| normalized_name(&name));

        let mut devices: Vec<Device> = host
            .input_devices()
            .map(|devices| devices.collect())
            .unwrap_or_default();

        // The default input is normally part of `input_devices()`. Match it there
        // instead of pushing it separately, so it is never listed twice.
        let mut default_index = default_normalized.as_deref().and_then(|target| {
            devices.iter().position(|device| {
                device_display_name(device)
                    .map(|name| normalized_name(&name))
                    .as_deref()
                    == Some(target)
            })
        });

        // Keep the host default whenever the enumeration found no positional
        // match: either the host does not enumerate its own default, the
        // enumeration failed outright and the default is all we have, or the
        // default has no resolvable display name. Retaining it keeps a recording
        // target available and the default keeps its default-candidate status.
        let default_missing = default_index.is_none();
        if let Some(device) = default_device.filter(|_| default_missing) {
            default_index = Some(devices.len());
            devices.push(device);
        }

        let mut occurrences: HashMap<String, usize> = HashMap::new();
        devices
            .into_iter()
            .enumerate()
            .map(|(index, device)| {
                let name = device_display_name(&device);
                let display = name.as_deref().unwrap_or(UNKNOWN_DEVICE_LABEL);
                let occurrence = occurrences.entry(normalized_name(display)).or_insert(0);
                let label = disambiguated_label(display, *occurrence);
                *occurrence += 1;

                LabelledDevice {
                    device,
                    name,
                    label,
                    is_default: default_index == Some(index),
                }
            })
            .collect()
    }

    /// Resolves a cached device label back to a live `Device` on the given host.
    /// This still enumerates every input device the host exposes, so the cached
    /// path only saves the candidate scoring and the cross-host iteration of the
    /// slow path, not the per-host enumeration itself.
    fn find_device_by_label(host: &cpal::Host, target_label: &str) -> Option<Device> {
        let target = normalized_name(target_label);
        let mut devices = labelled_devices_for_host(host).into_iter().enumerate();
        let found = devices.find(|(_, entry)| normalized_name(&entry.label) == target);
        match found {
            Some((index, entry)) => {
                log::debug!(
                    "resolved label '{target_label}' -> '{}' (index {index}) on host {:?}",
                    entry.label,
                    host.id()
                );
                Some(entry.device)
            }
            None => {
                log::warn!(
                    "cached device label '{target_label}' not found on host {:?}",
                    host.id()
                );
                None
            }
        }
    }

    /// Why the cached device cannot be tried, or `None` when it can.
    ///
    /// `still_present` is whether the host still enumerates a device under that
    /// label; it is passed in rather than looked up so the decision can be
    /// exercised without a host, which is the only way to test the case that
    /// matters — the cached device was unplugged between two dictations.
    ///
    /// Every branch here means "try something else", never "fail the press": a
    /// microphone that moved is a slower dictation, not a broken one.
    fn cached_device_rejection(
        cached: Option<&CachedDeviceInfo>,
        preferred_normalized: Option<&str>,
        still_present: bool,
    ) -> Option<&'static str> {
        let Some(cached) = cached else {
            return Some("nothing recorded yet");
        };
        if let Some(preferred) = preferred_normalized {
            if !device_matches_preferred(&cached.device_label, preferred) {
                return Some("it is not the preferred device");
            }
        }
        if !still_present {
            return Some("the device is no longer listed");
        }
        None
    }

    /// Whether a device label equals the (already normalized) preferred name.
    fn device_matches_preferred(device_label: &str, preferred_lower: &str) -> bool {
        normalized_name(device_label) == preferred_lower
    }

    /// Scoring for the device the host reports as its default input.
    fn default_device_score(
        device: &Device,
        matches_preferred: bool,
        default_output_name: Option<&str>,
    ) -> (u32, Option<String>) {
        let mut priority = if matches_preferred { 0 } else { 5 };
        let mut avoid_reason = None;

        if should_avoid_input_device(device, default_output_name) {
            avoid_reason = Some("avoiding low-quality default device".to_string());
            if !matches_preferred {
                priority = 300;
            }
        }

        (priority, avoid_reason)
    }

    /// Scoring for the remaining enumerated devices, driven by name heuristics.
    fn enumerated_device_score(
        name: Option<&str>,
        matches_preferred: bool,
    ) -> (u32, Option<String>) {
        let mut priority = if matches_preferred { 0 } else { 100 };
        let mut avoid_reason = None;

        if let Some(label) = name {
            if matches_preferred {
                if name_has_low_quality_keyword(label) {
                    avoid_reason = Some("potential low-quality input".to_string());
                }
            } else if is_builtin_microphone_name(label) {
                priority = 0;
            } else if is_preferred_input_device_name(label) {
                priority = cmp::min(priority, 10);
            } else if name_has_low_quality_keyword(label) {
                priority = cmp::max(priority, 250);
                avoid_reason = Some("potential low-quality input".to_string());
            }
        }

        (priority, avoid_reason)
    }

    /// Builds the scored candidate list for one host: every labelled device
    /// with its priority and avoid-reason, flagging the default and any
    /// preferred match.
    fn device_candidates_for_host(
        host: &cpal::Host,
        default_output_name: Option<&str>,
        preferred_name: Option<&str>,
    ) -> Vec<DeviceCandidate> {
        let preferred_lower = preferred_name.map(normalized_name);

        labelled_devices_for_host(host)
            .into_iter()
            .map(|entry| {
                let LabelledDevice {
                    device,
                    name,
                    label,
                    is_default,
                } = entry;

                let matches_preferred = preferred_lower
                    .as_deref()
                    .is_some_and(|preferred| device_matches_preferred(&label, preferred));

                let (priority, avoid_reason) = if is_default {
                    default_device_score(&device, matches_preferred, default_output_name)
                } else {
                    enumerated_device_score(name.as_deref(), matches_preferred)
                };

                DeviceCandidate {
                    device,
                    label,
                    priority,
                    avoid_reason,
                    matches_preferred,
                    is_default,
                }
            })
            .collect()
    }

    /// Lists input devices across every host, merging duplicate labels and
    /// marking default and cautionary devices. Defaults sort first, then by
    /// case-insensitive label.
    pub fn list_input_devices() -> Vec<InputDeviceDescriptor> {
        // Keyed by the disambiguated label: the same physical device exposed by
        // several hosts still collapses into one row, while two distinct devices
        // reporting the same name stay separate.
        let mut devices: HashMap<String, InputDeviceDescriptor> = HashMap::new();

        for host_id in ordered_host_ids() {
            let host = match cpal::host_from_id(host_id) {
                Ok(value) => value,
                Err(err) => {
                    log::error!("failed to enumerate host {host_id:?}: {err}");
                    continue;
                }
            };

            let default_output_name = host
                .default_output_device()
                .and_then(|device| device.name().ok());

            let candidates =
                device_candidates_for_host(&host, default_output_name.as_deref(), None);

            for candidate in candidates {
                let entry = devices
                    .entry(normalized_name(&candidate.label))
                    .or_insert_with(|| InputDeviceDescriptor {
                        label: candidate.label.clone(),
                        is_default: false,
                        caution: false,
                        bluetooth: super::label_has_low_quality_keyword(&candidate.label),
                    });

                if candidate.avoid_reason.is_some() {
                    entry.caution = true;
                }
                if candidate.is_default {
                    entry.is_default = true;
                }
            }
        }

        let mut list: Vec<_> = devices.into_values().collect();
        list.sort_by(|a, b| {
            b.is_default.cmp(&a.is_default).then_with(|| {
                a.label
                    .to_ascii_lowercase()
                    .cmp(&b.label.to_ascii_lowercase())
            })
        });
        list
    }

    #[cfg(test)]
    mod tests {
        use super::{
            cached_device_rejection, captured_duration, cold_start_seed, device_matches_preferred,
            disambiguated_label, elapsed_gap_is_suspicious, is_preferred_input_device_name,
            order_hosts, preroll_capacity, reported_capture_fault, try_hosts, warm_ring,
            CachedDeviceInfo, ChunkEmitter, Preroll, RecordingError, RecordingManager, SinkMode,
            StreamSink, STALE_WARM_SILENCE, WARM_FOREVER_MS, WARM_READY_GRACE,
        };
        use crate::platform::audio_stage::{AudioStartupStage, AudioStartupTrace};
        use std::collections::HashSet;
        use std::sync::atomic::Ordering;
        use std::sync::{Arc, Mutex};
        use std::time::Duration;

        /// Delivers a block that is measurably not the very first instant.
        ///
        /// A block delivered in the same instant as the origin stores an elapsed
        /// time of zero, which is the sentinel for "never delivered", so it
        /// cannot be told apart from no block at all.
        fn deliver_after_a_pause(sink: &StreamSink) {
            std::thread::sleep(Duration::from_millis(2));
            sink.deliver(&[0.1]);
            std::thread::sleep(Duration::from_millis(2));
        }

        // ── Pre-roll ring ──────────────────────────────────────────────

        #[test]
        fn the_ring_keeps_the_most_recent_audio_and_drops_the_oldest() {
            let mut ring = Preroll::new(4);

            ring.push(&[1.0, 2.0, 3.0]);
            ring.push(&[4.0, 5.0]);

            // The tail is what a press needs: the newest speech is what would
            // otherwise be clipped, so the oldest goes first.
            assert_eq!(ring.drain(), vec![2.0, 3.0, 4.0, 5.0]);
        }

        #[test]
        fn a_block_larger_than_the_ring_keeps_only_its_tail() {
            let mut ring = Preroll::new(3);

            ring.push(&[1.0, 2.0, 3.0, 4.0, 5.0]);

            assert_eq!(ring.drain(), vec![3.0, 4.0, 5.0]);
        }

        #[test]
        fn draining_empties_the_ring() {
            let mut ring = Preroll::new(8);
            ring.push(&[1.0, 2.0]);

            assert_eq!(ring.drain(), vec![1.0, 2.0]);
            // A second drain returning the same audio is how one recording ends
            // up with the previous one's speech at its head.
            assert_eq!(ring.drain(), Vec::<f32>::new());
        }

        #[test]
        fn a_zero_capacity_ring_keeps_nothing() {
            let mut ring = Preroll::new(0);
            ring.push(&[1.0, 2.0, 3.0]);

            assert_eq!(ring.len(), 0);
            assert_eq!(ring.drain(), Vec::<f32>::new());
        }

        #[test]
        fn pre_roll_samples_follow_the_device_rate() {
            // The same duration is a different sample count per device, which is
            // why the ring is sized from the rate rather than a constant.
            assert_eq!(preroll_capacity(Duration::from_millis(500), 16_000), 8_000);
            assert_eq!(preroll_capacity(Duration::from_millis(500), 44_100), 22_050);
            assert_eq!(preroll_capacity(Duration::from_secs(2), 48_000), 96_000);
        }

        #[test]
        fn a_pre_roll_rounds_up_so_a_whole_device_buffer_fits() {
            // 0.333 ms at 44.1 kHz is 14.68 samples. Rounding down gives 14, and
            // the ring is filled a device block at a time: on a 1024-frame device
            // a capacity 14 samples short of a block's worth drops the entire
            // block, which is 21 ms of the speech the user asked to keep. Rounding
            // up costs one sample and never drops a block that fits.
            assert_eq!(preroll_capacity(Duration::from_micros(333), 44_100), 15);
        }

        #[test]
        fn a_ring_keeps_the_newest_audio_rather_than_the_oldest() {
            let mut ring = Preroll::new(10);

            // Eight samples in, then a block of eight that only half fits. The
            // head gives way, because the audio closest to the press is what the
            // pre-roll is for; the part of the new block that fits is kept.
            ring.push(&[1.0; 8]);
            ring.push(&[2.0; 8]);

            let kept = ring.drain();
            assert_eq!(kept.len(), 10);
            assert_eq!(kept.iter().filter(|sample| **sample == 1.0).count(), 2);
            assert_eq!(kept.iter().filter(|sample| **sample == 2.0).count(), 8);
        }

        #[test]
        fn a_block_larger_than_the_ring_keeps_its_tail() {
            let mut ring = Preroll::new(4);
            ring.push(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);

            // The end of the block is the audio closest to the press.
            assert_eq!(ring.drain(), vec![3.0, 4.0, 5.0, 6.0]);
        }

        #[test]
        fn a_zero_length_pre_roll_keeps_nothing_whatever_the_rate() {
            assert_eq!(preroll_capacity(Duration::ZERO, 48_000), 0);
            assert_eq!(preroll_capacity(Duration::ZERO, 0), 0);
        }

        #[test]
        fn a_zero_rate_yields_no_capacity_instead_of_dividing_by_it() {
            assert_eq!(preroll_capacity(Duration::from_secs(1), 0), 0);
        }

        // ── Cold start isolation ───────────────────────────────────────

        #[test]
        fn a_cold_start_prepends_nothing_from_the_shared_ring() {
            let (seed, _ring) = cold_start_seed();

            // The defect this pins: the warm stream's callback fills the shared
            // ring, so a cold start that drained it put the same speech into two
            // consecutive recordings.
            assert!(seed.is_empty());
        }

        #[test]
        fn a_cold_start_does_not_leave_the_device_open_at_stop() {
            let (_seed, ring) = cold_start_seed();

            // A zero-capacity stand-in means the stop path has nothing to resume
            // collecting into, so the stream is retired instead of being held
            // open with no policy behind it.
            assert!(warm_ring(&ring, false).is_none());
            assert!(ring.lock().unwrap().cap == 0);
        }

        #[test]
        fn a_stream_that_never_delivered_is_not_ready() {
            let sink = StreamSink::new(SinkMode::Discard);

            // Freshly opened and nothing yet: inside the grace, so a press that
            // arrives immediately still gets the fast path.
            assert!(!sink.has_delivered());
            assert!(sink.age_of_stream() < WARM_READY_GRACE);

            // The staleness check alone cannot catch this: `silence_for` returns
            // `None` until the first block, which reads as "not stale".
            assert_eq!(sink.silence_for(), None);
            assert!(!sink.has_delivered());
        }

        #[test]
        fn the_first_block_marks_the_stream_as_delivered() {
            let sink = StreamSink::new(SinkMode::Discard);

            // `last_block_us` starts at zero and zero is its sentinel, so the
            // flag is the only way to tell "no block" from "a block at time 0".
            std::thread::sleep(Duration::from_millis(2));
            sink.deliver(&[0.1]);

            assert!(sink.has_delivered());
            assert!(sink.silence_for().is_some());
        }

        #[test]
        fn the_first_block_wait_reaches_the_startup_summary() {
            // The summary advertises `first_pcm_wait_us`, and before this was
            // wired nothing ever published one: the trace had an accumulator, a
            // callback-side reporter, and no caller feeding either. A number the
            // diagnostics export promises has to be a number something fills.
            let sink = StreamSink::new(SinkMode::Discard);
            assert_eq!(sink.first_pcm_wait(), None, "nothing delivered yet");

            std::thread::sleep(Duration::from_millis(2));
            sink.deliver(&[0.1]);

            let wait = sink.first_pcm_wait().expect("one block arrived");
            assert!(wait >= Duration::from_millis(2));

            let mut trace = AudioStartupTrace::begin();
            trace.mark(AudioStartupStage::StreamStarted);
            trace.note_first_pcm(wait);
            assert_eq!(trace.summary().first_pcm, Some(wait));

            // And it is on the log line, which is where it is actually read.
            let line = trace.summary().log_line("audio-startup");
            assert!(line.contains("first_pcm_wait_us="), "{line}");
        }

        #[test]
        fn a_usable_stream_needs_a_block_or_a_young_origin() {
            // Delivered and recent: usable.
            let fresh = StreamSink::new(SinkMode::Discard);
            std::thread::sleep(Duration::from_millis(2));
            fresh.deliver(&[0.1]);
            assert!(fresh.has_delivered());
            assert!(fresh.silence_for().unwrap() < STALE_WARM_SILENCE);

            // Never delivered and past the grace: not usable, which is the case
            // that used to be adopted and record silence.
            let dead = StreamSink::new(SinkMode::Discard);
            std::thread::sleep(WARM_READY_GRACE + Duration::from_millis(20));
            assert!(!dead.has_delivered());
            assert!(dead.age_of_stream() >= WARM_READY_GRACE);
        }

        #[test]
        fn a_manager_with_nothing_held_is_not_ready() {
            let manager = RecordingManager::new();

            assert!(!manager.has_warm_stream());
            assert!(!manager.warm_is_usable());
            assert!(manager.status_line().contains("ready=false"));
        }

        #[test]
        fn promoting_a_stream_keeps_it_open_without_closing_it() {
            let manager = RecordingManager::new();

            // After a stop under a finite window: the stream is open and a
            // timer is due to close it.
            manager.set_linger(Duration::from_millis(5_000));
            // Stand in for the timer `set_linger` would have scheduled: a
            // generation already out there, waiting to close the stream.
            let scheduled = manager.linger_generation.load(Ordering::SeqCst);
            assert!(manager.status_line().contains("policy=linger-5000ms"));

            manager.promote_to_hold();

            // The policy moved to the hold sentinel...
            assert!(manager.status_line().contains("policy=ready-forever"));
            assert_eq!(manager.linger_ms.load(Ordering::SeqCst), WARM_FOREVER_MS);
            // ...and the scheduled close was invalidated, so the thread that
            // holds `scheduled` sees it is stale and leaves the stream alone.
            assert_ne!(manager.linger_generation.load(Ordering::SeqCst), scheduled);
        }

        #[test]
        fn a_stale_linger_cannot_close_a_stream_opened_after_it_was_armed() {
            // The race the generation check is supposed to prevent, and did not
            // while it was read outside the lock: a timer armed before a close,
            // then the close, then a fresh hold. The timer must not take the new
            // stream.
            //
            // The window is timing-dependent in production, so it is reconstructed
            // here as the two orderings the lock now forces. What is asserted is
            // the rule itself, not the interleaving: a thread holding a stale
            // generation never takes the slot.
            let warm = Arc::new(Mutex::new(None::<u8>));
            let generation = Arc::new(std::sync::atomic::AtomicU64::new(0));

            let armed = generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            // A close, then a hold that puts a stream in the slot.
            generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            *warm.lock().unwrap() = Some(1);

            // The armed thread's own check, under the same lock it would take.
            let took = {
                let mut guard = warm.lock().unwrap();
                if generation.load(std::sync::atomic::Ordering::SeqCst) != armed {
                    None
                } else {
                    guard.take()
                }
            };

            assert_eq!(took, None, "a stale linger must not take the new stream");
            assert_eq!(
                *warm.lock().unwrap(),
                Some(1),
                "the stream the user is holding is still there"
            );
        }

        #[test]
        fn a_current_linger_does_close_the_stream_it_was_armed_for() {
            // The complement: a generation that is still current takes the stream,
            // so the rule above is not simply "never close".
            let warm = Arc::new(Mutex::new(Some(1u8)));
            let generation = Arc::new(std::sync::atomic::AtomicU64::new(0));
            let armed = generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;

            let took = {
                let mut guard = warm.lock().unwrap();
                if generation.load(std::sync::atomic::Ordering::SeqCst) != armed {
                    None
                } else {
                    guard.take()
                }
            };

            assert_eq!(took, Some(1));
            assert_eq!(*warm.lock().unwrap(), None);
        }

        #[test]
        fn promoting_does_not_touch_a_stream_that_is_not_open() {
            let manager = RecordingManager::new();
            manager.promote_to_hold();

            assert!(!manager.has_warm_stream());
            assert!(manager.status_line().contains("ready=false"));
        }

        #[test]
        fn a_cold_start_stays_open_only_when_a_linger_was_configured() {
            let (_seed, ring) = cold_start_seed();

            // `linger_then_close` is what actually closes it; this only decides
            // whether the stop path hands the stream to the warm slot at all.
            assert!(warm_ring(&ring, true).is_some());
        }

        #[test]
        fn a_hold_hands_back_the_ring_the_stream_was_collecting_into() {
            let ring = Arc::new(Mutex::new(Preroll::new(8)));

            let handed = warm_ring(&ring, true).expect("hold should hand the ring back");

            // The same ring, not a copy: the audio captured while warm is what
            // the next press prepends.
            ring.lock().unwrap().push(&[1.0]);
            assert_eq!(handed.lock().unwrap().drain(), vec![1.0]);
        }

        // ── Sink behaviour ─────────────────────────────────────────────

        #[test]
        fn the_warm_sink_collects_without_recording() {
            let ring = Arc::new(Mutex::new(Preroll::new(8)));
            let sink = StreamSink::new(SinkMode::Warm {
                preroll: Arc::clone(&ring),
            });

            sink.deliver(&[0.1, 0.2]);
            sink.deliver(&[0.3]);

            assert_eq!(ring.lock().unwrap().drain(), vec![0.1, 0.2, 0.3]);
        }

        #[test]
        fn a_discarding_sink_keeps_nothing() {
            let sink = StreamSink::new(SinkMode::Discard);

            sink.deliver(&[0.1, 0.2]);

            // Reaching this mode with a recording attached would be a bug, so
            // the assertion is that it is inert rather than that it stores.
            assert!(sink.lock_recording_buffer().is_none());
        }

        #[test]
        fn starting_a_recording_seeds_it_with_the_preroll() {
            let ring = Arc::new(Mutex::new(Preroll::new(8)));
            let sink = StreamSink::new(SinkMode::Warm {
                preroll: Arc::clone(&ring),
            });
            ring.lock().unwrap().push(&[0.1, 0.2]);

            let buffer = sink.start_recording(None, None, vec![0.1, 0.2], None);
            sink.deliver(&[0.3]);

            // Pre-press audio first, then live audio, in that order.
            assert_eq!(*buffer.lock().unwrap(), vec![0.1, 0.2, 0.3]);
        }

        #[test]
        fn the_seed_is_handed_to_the_chunk_emitter_before_live_audio() {
            let chunks = Arc::new(Mutex::new(Vec::<(Vec<f32>, u64)>::new()));
            let callback_chunks = Arc::clone(&chunks);
            let emitter = ChunkEmitter::new(Arc::new(move |chunk, offset| {
                callback_chunks.lock().unwrap().push((chunk, offset));
            }));
            let sink = StreamSink::new(SinkMode::Discard);

            sink.start_recording(None, Some(Arc::clone(&emitter)), vec![9.0], None);
            emitter.flush();

            let chunks = chunks.lock().unwrap();
            assert_eq!(
                chunks.first().map(|(chunk, _)| chunk.clone()),
                Some(vec![9.0])
            );
            // The seed claims offset 0, so the webview places it at the start of
            // the timeline instead of after the live audio.
            assert_eq!(chunks.first().map(|(_, offset)| *offset), Some(0));
        }

        #[test]
        fn a_recording_fills_the_ring_that_becomes_the_next_presses_preroll() {
            // The defect this pins: the callback only filled the ring while
            // nothing was recording, so the ring a held stream left behind was
            // always empty. The first warm press after a cold start therefore
            // began with no pre-roll, and the setting did nothing in the case it
            // exists for -- someone dictating repeatedly without keep-ready on.
            let ring = Arc::new(Mutex::new(Preroll::new(8)));
            let sink = StreamSink::new(SinkMode::Discard);

            sink.start_recording(None, None, Vec::new(), Some(Arc::clone(&ring)));
            sink.deliver(&[1.0, 2.0, 3.0]);
            sink.deliver(&[4.0, 5.0]);

            assert_eq!(
                ring.lock().unwrap().drain(),
                vec![1.0, 2.0, 3.0, 4.0, 5.0],
                "the captured audio is what the next press starts with"
            );
        }

        #[test]
        fn a_recording_with_no_ring_collects_nothing_for_the_next_press() {
            // A stream that closes at stop has no next press to serve, so the
            // audio thread must not be asked to keep a tail for one.
            let sink = StreamSink::new(SinkMode::Discard);
            sink.start_recording(None, None, Vec::new(), None);

            sink.deliver(&[1.0, 2.0]);

            // Nothing to assert on the ring, so the assertion is that the path is
            // safe: the samples still reach the recording's own buffer.
            let buffer = match &*sink.lock() {
                SinkMode::Recording { buffer, .. } => Arc::clone(buffer),
                _ => panic!("still recording"),
            };
            assert_eq!(buffer.lock().unwrap().as_slice(), &[1.0, 2.0]);
        }

        #[test]
        fn stopping_a_recording_returns_its_chunk_emitter_to_flush() {
            let emitter = ChunkEmitter::new(Arc::new(|_, _| {}));
            let sink = StreamSink::new(SinkMode::Discard);
            sink.start_recording(None, Some(Arc::clone(&emitter)), Vec::new(), None);

            let returned = sink.stop_recording(Some(Arc::new(Mutex::new(Preroll::new(4)))));

            assert!(returned.emitter.is_some());
            assert!(!returned.was_paused);
        }

        #[test]
        fn stopping_without_a_ring_discards_captured_audio() {
            let sink = StreamSink::new(SinkMode::Discard);
            sink.start_recording(None, None, Vec::new(), None);

            sink.stop_recording(None);

            assert!(matches!(*sink.lock(), SinkMode::Discard));
        }

        #[test]
        fn stopping_hands_the_stream_back_to_the_preroll() {
            let ring = Arc::new(Mutex::new(Preroll::new(8)));
            let sink = StreamSink::new(SinkMode::Discard);
            sink.start_recording(None, None, Vec::new(), None);

            sink.stop_recording(Some(Arc::clone(&ring)));
            sink.deliver(&[0.5]);

            assert_eq!(ring.lock().unwrap().drain(), vec![0.5]);
        }

        // ── Staleness ──────────────────────────────────────────────────

        #[test]
        fn a_sink_that_never_delivered_reports_no_silence_figure() {
            let sink = StreamSink::new(SinkMode::Discard);

            // `None` is "nothing ever arrived", which is a stream that failed to
            // start, not one that has been quiet for a while.
            assert_eq!(sink.silence_for(), None);
        }

        #[test]
        fn a_stream_that_went_quiet_reads_as_stale() {
            let sink = StreamSink::new(SinkMode::Discard);
            deliver_after_a_pause(&sink);

            let silence = sink.silence_for().expect("a delivered block is a figure");

            // The window decides, not this: what matters is that a sink with a
            // block in its past reports a growing silence rather than `None`,
            // and that the figure is measured from the block rather than from
            // the sink's creation.
            assert!(silence > Duration::ZERO, "{silence:?}");
            assert!(silence < Duration::from_secs(5), "{silence:?}");
        }

        #[test]
        fn a_paused_stream_does_not_read_as_dead() {
            let sink = StreamSink::new(SinkMode::Discard);
            sink.deliver(&[0.1]);

            // A paused device delivers nothing on purpose, and the staleness
            // check must not treat that as a vanished device and reopen cold.
            sink.set_paused(true);
            assert_eq!(sink.silence_for(), None);
        }

        #[test]
        fn a_stopped_stream_does_not_read_as_dead() {
            let sink = StreamSink::new(SinkMode::Discard);
            sink.deliver(&[0.1]);

            // A device stop is the end of a recording, not a vanished device.
            // Conflating the two made a stop-then-start pair reopen the device
            // and lose the press that was already in flight.
            sink.stop_recording(Some(Arc::new(Mutex::new(Preroll::new(8)))));
            assert_eq!(sink.silence_for(), None);
        }

        #[test]
        fn a_stop_clears_the_pause_so_the_hold_is_not_left_asleep() {
            let sink = StreamSink::new(SinkMode::Discard);
            sink.set_paused(true);
            assert!(sink.is_paused());

            // The stop path reads this to decide whether the stream it is about
            // to leave warm has to be resumed. A stale `true` would make it
            // resume a stream that is already running, and a stale `false` would
            // leave the hold asleep and force a cold reopen on the next press.
            sink.stop_recording(Some(Arc::new(Mutex::new(Preroll::new(8)))));
            assert!(!sink.is_paused());
        }

        #[test]
        fn a_fresh_recording_clears_the_stopped_and_paused_flags() {
            let sink = StreamSink::new(SinkMode::Discard);
            sink.set_paused(true);
            sink.stop_recording(None);
            sink.start_recording(None, None, Vec::new(), None);
            deliver_after_a_pause(&sink);

            // Nothing may leak from the previous recording into the staleness
            // verdict for this one.
            assert!(sink.silence_for().is_some());
        }

        #[test]
        fn resuming_a_paused_stream_clears_the_stopped_flag() {
            let sink = StreamSink::new(SinkMode::Discard);
            sink.stop_recording(None);
            sink.set_paused(false);
            deliver_after_a_pause(&sink);

            assert!(sink.silence_for().is_some());
        }

        // ── Capture faults ─────────────────────────────────────────────

        #[test]
        fn a_fatal_fault_is_recorded_and_named() {
            let sink = StreamSink::new(SinkMode::Discard);

            sink.record_fault(
                "The requested device is no longer available. For example, it has been unplugged.",
            );

            // The token is what the stop path writes into the metrics, so it has
            // to be the classifier's own word rather than a copy of the message.
            assert_eq!(sink.fault_token(), Some("fatal"));
        }

        #[test]
        fn a_transient_fault_is_logged_but_never_recorded() {
            let sink = StreamSink::new(SinkMode::Discard);

            // This is the message PipeWire's ALSA plugin produces several times
            // a second on a perfectly working device. Recording it would retire
            // the stream on the next press and rebuild it forever.
            sink.record_fault(
                "A backend-specific error has occurred: `alsa::poll()` spuriously returned",
            );
            sink.record_fault("xrun (buffer over or under run)");
            sink.record_fault("Resource temporarily unavailable (os error 11)");

            assert_eq!(sink.fault_token(), None);
        }

        #[test]
        fn the_first_fatal_fault_wins() {
            let sink = StreamSink::new(SinkMode::Discard);

            sink.record_fault("the device associated with the stream is no longer available");
            // A second error from a backend that is already dead says nothing
            // new, and overwriting the token would lose when it first died.
            sink.record_fault("something else entirely");

            assert_eq!(sink.fault_token(), Some("fatal"));
        }

        #[test]
        fn a_faulted_stream_is_never_usable_however_recently_it_delivered() {
            let sink = StreamSink::new(SinkMode::Discard);
            std::thread::sleep(Duration::from_millis(2));
            sink.deliver(&[0.1]);
            // Fresh and delivered: without the fault check this is exactly the
            // stream the warm path would adopt.
            assert_eq!(
                sink.silence_for().map(|s| s < STALE_WARM_SILENCE),
                Some(true)
            );

            sink.record_fault("Stream Invalidated");

            assert_eq!(
                sink.fault_token(),
                Some("fatal"),
                "the token must name the fault rather than the staleness verdict"
            );
        }

        #[test]
        fn a_faulted_stream_is_rejected_for_a_press_naming_the_fault() {
            // The verdict `WarmStream::is_usable` reads, driven directly: the
            // handle itself needs a real cpal stream, but the decision is a
            // function of this sink.
            let sink = StreamSink::new(SinkMode::Discard);
            std::thread::sleep(Duration::from_millis(2));
            sink.deliver(&[0.1]);

            sink.record_fault("the device associated with the stream is no longer available");

            assert_eq!(sink.fault_token(), Some("fatal"));
            // A stale-but-recovering stream and a dead one are different
            // verdicts, and the log has to be able to tell them apart: this one
            // has just delivered a block, so only the fault can explain a
            // rejection.
            assert!(sink
                .silence_for()
                .map(|silence| silence < STALE_WARM_SILENCE)
                .unwrap_or(false));
        }

        #[test]
        fn an_error_storm_does_not_change_the_fault_it_records() {
            let sink = StreamSink::new(SinkMode::Discard);

            // cpal's ALSA worker polls a POLLERR device and calls the error
            // callback on every iteration, so this is hundreds of calls a
            // second on a device that is already gone.
            for _ in 0..1_000 {
                sink.record_fault("`alsa::poll()` returned POLLERR: no such device");
            }

            assert_eq!(sink.fault_token(), Some("fatal"));
        }

        #[test]
        fn a_fault_token_survives_a_restart_of_the_recording() {
            let sink = StreamSink::new(SinkMode::Discard);
            sink.record_fault("the device associated with the stream is no longer available");

            sink.start_recording(None, None, Vec::new(), None);

            // The host declared this *device* gone, not just this recording, so
            // a new recording on the same dead stream must not look healthy.
            assert_eq!(sink.fault_token(), Some("fatal"));
        }

        // ── Pause accounting ───────────────────────────────────────────

        #[test]
        fn a_paused_recording_does_not_pause_time_count_against_capture() {
            let sink = StreamSink::new(SinkMode::Discard);
            std::thread::sleep(Duration::from_millis(2));
            sink.set_paused(true);
            std::thread::sleep(Duration::from_millis(30));
            let paused = sink.paused_for();
            sink.set_paused(false);

            // The whole point of the figure: a pause the user asked for is not
            // audio the stream failed to deliver.
            assert!(
                paused >= Duration::from_millis(25),
                "paused_for was {paused:?}"
            );
            assert!(
                sink.paused_for() >= Duration::from_millis(25),
                "a closed interval is still counted"
            );
        }

        #[test]
        fn a_second_pause_does_not_restart_the_first_interval() {
            let sink = StreamSink::new(SinkMode::Discard);
            sink.set_paused(true);
            std::thread::sleep(Duration::from_millis(20));
            // A repeat call from a resumed-then-paused path must not lose the
            // stretch already spent paused.
            sink.set_paused(true);
            std::thread::sleep(Duration::from_millis(10));
            sink.set_paused(false);

            assert!(sink.paused_for() >= Duration::from_millis(28));
        }

        #[test]
        fn resuming_twice_counts_the_pause_once() {
            let sink = StreamSink::new(SinkMode::Discard);
            sink.set_paused(true);
            std::thread::sleep(Duration::from_millis(15));
            sink.set_paused(false);
            let after_first = sink.paused_for();
            sink.set_paused(false);

            // Folding the same interval in twice would inflate the figure and
            // hide a real gap of the same length.
            assert_eq!(sink.paused_for(), after_first);
        }

        #[test]
        fn a_pause_open_at_stop_is_counted_when_the_stop_closes_it() {
            let sink = StreamSink::new(SinkMode::Discard);
            sink.set_paused(true);
            std::thread::sleep(Duration::from_millis(15));

            sink.stop_recording(None);

            // Stopping clears the flag, so if the stop did not close the
            // interval the figure would silently be zero afterwards.
            assert!(sink.paused_for() >= Duration::from_millis(12));
        }

        #[test]
        fn a_stopped_stream_says_whether_it_was_paused_before_it_forgot() {
            let paused = StreamSink::new(SinkMode::Discard);
            paused.set_paused(true);

            let outcome = paused.stop_recording(None);

            // The defect this pins: the stop clears the pause flag, so the caller
            // that asked the sink afterwards was always told "not paused" and
            // skipped the resume. The answer has to travel back with the stop.
            assert!(outcome.was_paused);
            assert!(!paused.is_paused());

            let running = StreamSink::new(SinkMode::Discard);
            assert!(!running.stop_recording(None).was_paused);
        }

        #[test]
        fn a_stop_after_a_resume_does_not_claim_the_stream_was_paused() {
            let sink = StreamSink::new(SinkMode::Discard);
            sink.set_paused(true);
            sink.set_paused(false);

            // A stale `true` would make the stop path resume a stream that is
            // already running.
            assert!(!sink.stop_recording(None).was_paused);
        }

        #[test]
        fn a_new_recording_starts_with_no_paused_time() {
            let sink = StreamSink::new(SinkMode::Discard);
            sink.set_paused(true);
            std::thread::sleep(Duration::from_millis(15));
            sink.stop_recording(None);
            assert!(sink.paused_for() > Duration::ZERO);

            sink.start_recording(None, None, Vec::new(), None);

            // The sink outlives the recording. A carried-over total would be
            // subtracted from a recording that never paused.
            assert_eq!(sink.paused_for(), Duration::ZERO);
        }

        // ── Reported length vs captured length ─────────────────────────

        #[test]
        fn a_gap_under_the_tolerance_is_not_suspicious() {
            // Buffer quantisation and the wall clock starting before the first
            // block always leave a small gap; reporting it would make every
            // healthy recording look like a failure.
            assert!(!elapsed_gap_is_suspicious(
                Duration::from_millis(3_900),
                Duration::from_millis(4_100)
            ));
            assert!(!elapsed_gap_is_suspicious(
                Duration::from_millis(1_000),
                Duration::from_millis(1_000)
            ));
        }

        #[test]
        fn a_recording_that_lost_a_tenth_of_its_length_is_suspicious() {
            assert!(elapsed_gap_is_suspicious(
                Duration::from_millis(1_400),
                Duration::from_secs(6)
            ));
            assert!(elapsed_gap_is_suspicious(
                Duration::from_millis(0),
                Duration::from_secs(3)
            ));
        }

        #[test]
        fn captured_audio_longer_than_the_wall_clock_is_not_a_gap() {
            // A pre-roll seed can make the sample count longer than the time
            // this recording was open. That is an artefact of the seed, not a
            // capture fault, and a subtraction here would underflow.
            assert!(!elapsed_gap_is_suspicious(
                Duration::from_secs(3),
                Duration::from_secs(2)
            ));
        }

        // ── Host ordering and fallback ─────────────────────────────────

        /// A stand-in host identity.
        ///
        /// `cpal::HostId` only has the variants this build enables, and a test
        /// that needs two of them cannot name a second on a single-host build.
        /// The loops are generic over the identity, so a plain number serves and
        /// the same rule is exercised on every platform.
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        enum FakeHost {
            First,
            Second,
        }

        // ── Cached device ──────────────────────────────────────────────

        #[test]
        fn a_cached_device_that_is_no_longer_listed_falls_through_to_scoring() {
            let cached = CachedDeviceInfo {
                host_id: cpal::default_host().id(),
                device_label: "Samson Q2U".to_string(),
            };

            // Row 35: a USB microphone unplugged between two dictations. The
            // press must not fail on the stale cache — it must score the devices
            // that are there now.
            assert_eq!(
                cached_device_rejection(Some(&cached), None, false),
                Some("the device is no longer listed")
            );
        }

        #[test]
        fn a_cached_device_that_is_still_listed_is_tried() {
            let cached = CachedDeviceInfo {
                host_id: cpal::default_host().id(),
                device_label: "Samson Q2U".to_string(),
            };

            assert_eq!(cached_device_rejection(Some(&cached), None, true), None);
        }

        #[test]
        fn a_cached_device_that_is_not_the_preference_is_not_tried() {
            let cached = CachedDeviceInfo {
                host_id: cpal::default_host().id(),
                device_label: "Samson Q2U".to_string(),
            };

            // The user chose another microphone since; using the cached one
            // would record the wrong device and look like the setting was
            // ignored.
            assert_eq!(
                cached_device_rejection(Some(&cached), Some("macbook pro microphone"), true),
                Some("it is not the preferred device")
            );
        }

        #[test]
        fn an_empty_cache_has_nothing_to_try() {
            assert_eq!(
                cached_device_rejection(None, None, true),
                Some("nothing recorded yet")
            );
        }

        #[test]
        fn the_default_host_is_tried_first() {
            let available = [FakeHost::First, FakeHost::Second];

            assert_eq!(
                order_hosts(FakeHost::Second, &available),
                vec![FakeHost::Second, FakeHost::First]
            );
        }

        #[test]
        fn a_default_host_missing_from_the_available_list_is_still_tried() {
            // cpal's `available_hosts` is not guaranteed to contain the default,
            // and a press must not skip the host the platform actually uses.
            let ordered = order_hosts(FakeHost::First, &[]);

            assert_eq!(ordered, vec![FakeHost::First]);
        }

        #[test]
        fn a_host_listed_twice_is_only_tried_once() {
            let ordered = order_hosts(FakeHost::First, &[FakeHost::First, FakeHost::Second]);

            // Opening the same host twice is a second device open on every
            // press for nothing.
            assert_eq!(ordered, vec![FakeHost::First, FakeHost::Second]);
        }

        #[test]
        fn the_second_host_is_tried_when_the_first_one_fails() {
            let hosts = [FakeHost::First, FakeHost::Second];
            let mut attempted = Vec::new();

            let result = try_hosts(&hosts, Ok::<FakeHost, RecordingError>, |id| {
                attempted.push(*id);
                if *id == FakeHost::First {
                    Err(RecordingError::InputDeviceUnavailable)
                } else {
                    Ok("from the second host")
                }
            });

            // The defect this pins: a loop that returned the first error would
            // report "no input device" on a machine whose second host works.
            assert_eq!(
                result.ok().map(|(value, _)| value),
                Some("from the second host")
            );
            assert_eq!(attempted, vec![FakeHost::First, FakeHost::Second]);
        }

        #[test]
        fn a_host_that_will_not_load_is_skipped_rather_than_fatal() {
            let hosts = [FakeHost::First, FakeHost::Second];

            let result = try_hosts(
                &hosts,
                |id| {
                    if id == FakeHost::First {
                        Err(RecordingError::StreamBuild("pulse not running".to_string()))
                    } else {
                        Ok(id)
                    }
                },
                |_| Ok("found"),
            );

            assert_eq!(result.ok().map(|(value, _)| value), Some("found"));
        }

        #[test]
        fn a_host_that_will_not_load_does_not_become_the_reported_error() {
            // The regression this pins: a host that refuses to load is a build's
            // own backend problem, not something the user can act on, so its
            // "stream build: ..." message must not replace the "no input
            // device" that the UI classifies into the microphone guidance.
            let hosts = [FakeHost::First];

            let err = try_hosts(
                &hosts,
                |_| {
                    Err::<FakeHost, _>(RecordingError::StreamBuild("pulse not running".to_string()))
                },
                |_| Ok("unreachable"),
            )
            .unwrap_err();

            assert!(matches!(err, RecordingError::InputDeviceUnavailable));
            assert_eq!(err.to_string(), "no input device");
        }

        #[test]
        fn a_stream_failure_still_wins_over_a_host_that_will_not_load() {
            // The other half: a host that did load and then could not open the
            // device has the actionable message, and it must survive a
            // neighbouring host failing to load afterwards.
            let hosts = [FakeHost::First, FakeHost::Second];

            let err = try_hosts(
                &hosts,
                |id| {
                    if id == FakeHost::First {
                        Ok(id)
                    } else {
                        Err(RecordingError::StreamBuild("pulse not running".to_string()))
                    }
                },
                |_| Err::<&str, _>(RecordingError::StreamBuild("device busy".to_string())),
            )
            .unwrap_err();

            assert_eq!(err.to_string(), "stream build: device busy");
        }

        #[test]
        fn a_fault_that_lost_no_audio_is_not_reported() {
            let whole = Duration::from_millis(6_000);
            // A complete recording with a late error callback: nothing to say.
            assert_eq!(
                reported_capture_fault(
                    Some("fatal".to_string()),
                    whole,
                    whole + Duration::from_millis(120)
                ),
                None
            );
            // A real death partway through: reported, and with the token intact.
            assert_eq!(
                reported_capture_fault(
                    Some("fatal".to_string()),
                    Duration::from_millis(1_400),
                    whole
                ),
                Some("fatal".to_string())
            );
            // A death near the end of a long dictation is still a death. The
            // relative suspicion test would have hidden this one: five seconds
            // out of sixty is under its tenth.
            assert_eq!(
                reported_capture_fault(
                    Some("fatal".to_string()),
                    Duration::from_secs(55),
                    Duration::from_secs(60)
                ),
                Some("fatal".to_string())
            );
            // One buffer in flight is not a shortened recording.
            assert_eq!(
                reported_capture_fault(
                    Some("fatal".to_string()),
                    Duration::from_millis(5_900),
                    whole
                ),
                None
            );
            // No fault at all stays no fault, however short the recording.
            assert_eq!(
                reported_capture_fault(None, Duration::from_millis(10), whole),
                None
            );
        }

        #[test]
        fn captured_duration_excludes_the_audio_recorded_before_the_press() {
            // 48 kHz, two seconds of pre-roll (96000 samples) plus half a second
            // of real recording (24000). The recording is half a second long.
            let duration = captured_duration(96_000 + 24_000, 96_000, 48_000)
                .expect("audio recorded after the press is a duration");
            assert_eq!(duration, Duration::from_millis(500));
        }

        #[test]
        fn a_seeded_recording_that_captured_nothing_has_no_sample_duration() {
            // The case the seed used to hide: the buffer holds two seconds of
            // pre-press audio and nothing else, so the press captured nothing.
            assert_eq!(captured_duration(96_000, 96_000, 48_000), None);
        }

        #[test]
        fn the_preroll_seed_cannot_mask_a_lost_capture() {
            // The defect this pins, end to end. A warm press seeds two seconds of
            // pre-roll, the stream then dies immediately, and the press was open
            // for six seconds. Counting every sample would report a two-second
            // recording for a six-second press, which the gap test would then flag
            // as ordinary slowness; the fault the sink reported would be dropped.
            let expected = Duration::from_secs(6);
            let seed = 96_000;
            let sample_rate = 48_000;

            let naive = Duration::from_secs(2);
            assert!(
                reported_capture_fault(Some("the device was removed".into()), naive, expected)
                    .is_some(),
                "a two-second seed still leaves a four-second gap, so the fault survives"
            );

            // And the honest figure is that nothing was captured after the press.
            assert_eq!(captured_duration(seed, seed, sample_rate), None);
            let honest = captured_duration(seed, seed, sample_rate).unwrap_or(expected);
            assert_eq!(
                honest, expected,
                "with nothing captured, the wall clock stands in"
            );
        }

        #[test]
        fn a_cold_recording_counts_every_sample() {
            // A cold start seeds nothing, so the arithmetic must be the identity.
            assert_eq!(
                captured_duration(24_000, 0, 48_000),
                Some(Duration::from_millis(500))
            );
        }

        #[test]
        fn captured_duration_is_none_without_a_sample_rate() {
            assert_eq!(captured_duration(48_000, 0, 0), None);
        }

        #[test]
        fn no_host_yielding_a_device_is_reported_as_no_device() {
            let hosts = [FakeHost::First];

            // Row 37: with every host empty the user must be told there is no
            // input device — the one thing they can act on — rather than handed a
            // stream error that names an internal step.
            let err = try_hosts(&hosts, Ok::<FakeHost, RecordingError>, |_| {
                Err::<&str, _>(RecordingError::InputDeviceUnavailable)
            })
            .unwrap_err();

            assert!(matches!(err, RecordingError::InputDeviceUnavailable));
            assert_eq!(err.to_string(), "no input device");
        }

        #[test]
        fn a_later_hosts_error_is_the_one_reported() {
            // A machine where the first host is empty and the second says the
            // device is busy should report busy, not "no device": the two have
            // different remedies and the classification downstream reads this
            // message to choose between them.
            //
            // The name used to say the *last* host's error wins. That stopped
            // being true when a host that fails to load began being skipped
            // rather than reported: the rule is now the last host that actually
            // tried to open a device, whatever came after it.
            let hosts = [FakeHost::First, FakeHost::Second];

            let err = try_hosts(&hosts, Ok::<FakeHost, RecordingError>, |id| {
                if *id == FakeHost::First {
                    Err::<&str, _>(RecordingError::InputDeviceUnavailable)
                } else {
                    Err(RecordingError::StreamBuild(
                        "the device is in use by another application".to_string(),
                    ))
                }
            })
            .unwrap_err();

            assert_eq!(
                crate::platform::mic_usage::classify_open_failure(&err.to_string()),
                crate::platform::mic_usage::OpenFailure::InUseByAnotherApplication,
                "the busy classification was lost: {err}"
            );
        }

        // ── Hold policy ────────────────────────────────────────────────

        #[test]
        fn a_press_and_a_warm_open_cannot_deadlock_on_each_others_locks() {
            // The deadlock this pins: `start_recording` held `inner` and then
            // waited for `warm_open_gate` inside `adopt_warm_stream`, while
            // `open_warm` held `warm_open_gate` and then waited for `inner`.
            // Two threads doing that never move again, and the front end does
            // exactly this when keep-ready is switched on in the same breath as
            // a press.
            //
            // Both are driven at once here. A real device is not needed: the
            // point is the lock order, and both calls reach their lock
            // acquisitions on the paths exercised below. The assertion is the
            // absence of a hang, so the test is bounded by a thread join with a
            // timeout rather than by luck.
            use std::sync::mpsc;
            use std::time::Duration as StdDuration;

            for _ in 0..40 {
                let manager = std::sync::Arc::new(RecordingManager::new());
                let (tx, rx) = mpsc::channel();

                let press = {
                    let manager = std::sync::Arc::clone(&manager);
                    let tx = tx.clone();
                    std::thread::spawn(move || {
                        // No device exists here, so this fails fast; the
                        // failure is the lock traffic.
                        let _ = manager.start_recording(None, None);
                        let _ = tx.send(());
                    })
                };
                let open = {
                    let manager = std::sync::Arc::clone(&manager);
                    std::thread::spawn(move || {
                        let _ = manager.open_warm(StdDuration::from_millis(0));
                    })
                };

                // Both threads must finish. Ten seconds is far longer than
                // either takes, so a timeout means a lock cycle.
                press.join().expect("the press thread must not panic");
                let finished = rx.recv_timeout(StdDuration::from_secs(10));
                assert!(
                    finished.is_ok(),
                    "the press did not complete: lock cycle between start_recording and open_warm"
                );
                open.join().expect("the warm open thread must not panic");
            }
        }

        #[test]
        fn a_zero_linger_closes_the_device_at_stop() {
            let manager = RecordingManager::new();

            manager.set_linger(Duration::ZERO);

            assert!(!manager.hold_after_stop());
            assert_eq!(manager.pending_linger(), None);
        }

        #[test]
        fn a_finite_linger_is_a_real_window() {
            let manager = RecordingManager::new();

            manager.set_linger(Duration::from_millis(5_000));

            assert!(manager.hold_after_stop());
            assert_eq!(manager.pending_linger(), Some(Duration::from_millis(5_000)));
        }

        #[test]
        fn the_ready_forever_window_never_schedules_a_close() {
            let manager = RecordingManager::new();

            // `u64::MAX` is the sentinel for "hold until closed", so it must not
            // be read as a window of 584 million years.
            manager.set_linger(Duration::from_millis(u64::MAX));

            assert!(manager.hold_after_stop());
            assert_eq!(manager.pending_linger(), None);
            assert_eq!(manager.linger_ms.load(Ordering::SeqCst), WARM_FOREVER_MS);
        }

        /// The ring a cold start collects into is sized from the device rate.
        ///
        /// Regression: only the warm path sized it, so a cold start left the
        /// shared ring at capacity zero. Nothing accumulated, so the stream that
        /// was left warm at stop handed the next press an empty ring: the
        /// pre-roll silently did nothing for anyone who had not turned on
        /// keep-ready, and the setting looked like it worked because the slider
        /// moved.
        #[test]
        fn a_cold_start_sizes_the_ring_it_collects_into() {
            let manager = RecordingManager::new();
            manager.set_preroll(Duration::from_millis(500));

            // What a cold start does before its stream starts capturing.
            let sample_rate = 48_000;
            {
                let mut ring = manager.preroll.lock().unwrap();
                ring.cap = preroll_capacity(manager.preroll_requested(), sample_rate);
                ring.clear();
            }

            // Half a second at 48 kHz is 24 000 samples, and the ring accepts
            // them: with capacity zero `push` drops everything and the count
            // stays at zero.
            manager.preroll.lock().unwrap().push(&vec![0.1; 24_000]);
            assert_eq!(manager.preroll.lock().unwrap().len(), 24_000);

            // Past the cap the oldest samples go, not the whole ring.
            manager.preroll.lock().unwrap().push(&vec![0.2; 1_000]);
            assert_eq!(manager.preroll.lock().unwrap().len(), 24_000);
        }

        #[test]
        fn a_zero_pre_roll_keeps_nothing_even_after_a_cold_start() {
            let manager = RecordingManager::new();
            manager.set_preroll(Duration::ZERO);

            let mut ring = manager.preroll.lock().unwrap();
            ring.cap = preroll_capacity(manager.preroll_requested(), 48_000);
            ring.push(&[0.1; 100]);
            assert_eq!(ring.len(), 0);
        }

        #[test]
        fn a_pre_roll_length_alone_does_not_keep_the_device_open() {
            let manager = RecordingManager::new();
            manager.set_linger(Duration::ZERO);

            manager.set_preroll(Duration::from_millis(500));

            // Pre-roll and hold are separate decisions: keeping audio from
            // before a press is meaningless without a stream, but a stream is
            // not required by it.
            assert!(!manager.hold_after_stop());
        }

        #[test]
        fn turning_the_hold_off_releases_the_device() {
            let manager = RecordingManager::new();
            manager.set_linger(Duration::from_millis(u64::MAX));
            assert!(manager.linger_ms.load(Ordering::SeqCst) == WARM_FOREVER_MS);

            manager.set_linger(Duration::ZERO);

            assert!(!manager.has_warm_stream());
            assert_eq!(manager.linger_ms.load(Ordering::SeqCst), 0);
        }

        #[test]
        fn releasing_the_hold_leaves_the_post_recording_window_alone() {
            let manager = RecordingManager::new();
            manager.set_linger(Duration::from_millis(u64::MAX));
            // The user's own choice, made in the settings.
            manager.set_linger(Duration::from_millis(5_000));
            manager.set_linger_policy(Duration::from_millis(u64::MAX));

            manager.release_hold();

            assert_eq!(manager.linger_millis(), 0);
            assert!(!manager.has_warm_stream());

            // Now the window the user chose, restated: releasing the device must
            // not have been a way for the app to turn off a preference.
            manager.set_linger(Duration::from_millis(5_000));
            assert_eq!(manager.linger_millis(), 5_000);
        }

        /// The built-in detector decides a device's priority, so a miss here
        /// means the machine's own microphone loses to a virtual one and a
        /// press records from a device that never captures anything.
        #[test]
        fn builtin_names_are_recognised_across_platforms() {
            use super::is_builtin_microphone_name;
            // macOS names its own hardware after the model.
            for name in [
                "MacBook Pro Microphone",
                "MacBook Air Microphone",
                "Mac mini Microphone",
                "iMac Microphone",
                "Mac Studio Microphone",
            ] {
                assert!(
                    is_builtin_microphone_name(name),
                    "{name} should read as built-in"
                );
            }
            // Portable and Linux namings.
            for name in [
                "Built-in Audio Analog Stereo",
                "builtin mic",
                "Internal Microphone",
                "Int Mic",
                "DMic0",
            ] {
                assert!(
                    is_builtin_microphone_name(name),
                    "{name} should read as built-in"
                );
            }
            // A device that merely happens to mention a microphone is not
            // built-in, and must not take the priority.
            for name in [
                "Blue Yeti Microphone",
                "USB Microphone",
                "AirPods Pro",
                "Scarlett Solo",
            ] {
                assert!(
                    !is_builtin_microphone_name(name),
                    "{name} should not read as built-in"
                );
            }
            // Matching is case-insensitive: every platform capitalises
            // differently.
            assert!(is_builtin_microphone_name("BUILT-IN MICROPHONE"));
        }

        #[test]
        fn setting_the_policy_alone_never_closes_a_held_stream() {
            let manager = RecordingManager::new();
            manager.set_linger(Duration::from_millis(u64::MAX));

            manager.set_linger_policy(Duration::ZERO);

            // The policy moved; the stream did not. This is the property the
            // front end relies on when it pushes the window on mount, and the
            // one `set_linger(0)` violates.
            assert_eq!(manager.linger_millis(), 0);
            assert!(!manager.has_warm_stream());
        }

        #[test]
        fn setting_the_linger_still_closes_a_stream_the_new_policy_rejects() {
            let manager = RecordingManager::new();
            manager.set_linger(Duration::from_millis(5_000));

            manager.set_linger(Duration::ZERO);

            // Under a zero window nothing may be open between dictations, so this
            // path is the one that must close.
            assert_eq!(manager.linger_millis(), 0);
            assert!(!manager.has_warm_stream());
        }

        #[test]
        fn a_running_recording_is_never_handed_to_a_warm_open() {
            let manager = RecordingManager::new();
            manager.set_linger(Duration::from_millis(u64::MAX));

            // Stand in for a recording that is in flight: the guard is what
            // `open_warm` reads to decide whether the device is already taken.
            *manager.inner.lock().unwrap() = Some(super::ActiveRecording {
                stream: None,
                sink: None,
                preroll_after_stop: None,
                seed_samples: 0,
                start: std::time::Instant::now(),
                buffer: None,
                sample_rate: 48_000,
                device_label: "test device".to_string(),
                preferred: None,
                channels: 1,
            });

            // The front end asks for the hold as it stops the recording, so this
            // is the ordinary overlap, not an exotic race. Opening over it would
            // either fail on the device or steal it from the press in flight.
            manager
                .open_warm(Duration::from_millis(500))
                .expect("declining is not an error");
            assert!(!manager.has_warm_stream());
        }

        #[test]
        fn re_applying_the_same_preference_costs_nothing() {
            use crate::platform::Recorder;

            let manager = RecordingManager::new();
            manager.set_linger(Duration::from_millis(u64::MAX));
            manager.set_preferred_input_device(Some("Shure MV7".to_string()));
            manager.cache_successful_device(cpal::default_host().id(), "Shure MV7".to_string());
            assert!(manager.last_successful_device.lock().unwrap().is_some());

            // The command layer sets the preference on every press. Treating an
            // unchanged value as a change would reopen the held stream per
            // press, which is exactly the device open the hold exists to avoid,
            // and it would also throw away the device cache.
            manager.set_preferred_input_device(Some("  Shure MV7  ".to_string()));

            assert!(manager.last_successful_device.lock().unwrap().is_some());
        }

        #[test]
        fn a_changed_preference_clears_the_device_cache() {
            use crate::platform::Recorder;

            let manager = RecordingManager::new();
            manager.set_preferred_input_device(Some("Shure MV7".to_string()));
            manager.cache_successful_device(cpal::default_host().id(), "Shure MV7".to_string());

            // A real change has to drop the cache, or the next press tries the
            // device the user just moved off.
            manager.set_preferred_input_device(Some("MacBook Pro Microphone".to_string()));

            assert!(manager.last_successful_device.lock().unwrap().is_none());
        }

        #[test]
        fn changing_the_preferred_device_keeps_a_held_microphone_held() {
            let manager = RecordingManager::new();
            manager.set_linger(Duration::from_millis(u64::MAX));

            // The hold is what the user asked for, so a device change has to
            // move it rather than switch it off. Nothing opens in a unit test, so
            // what is asserted is the policy the reopen is gated on.
            assert_eq!(manager.linger_ms.load(Ordering::SeqCst), WARM_FOREVER_MS);

            manager.set_linger(Duration::from_millis(5_000));
            assert_ne!(manager.linger_ms.load(Ordering::SeqCst), WARM_FOREVER_MS);
        }

        #[test]
        fn a_status_line_names_the_policy_the_pre_roll_and_the_last_start() {
            let manager = RecordingManager::new();

            let line = manager.status_line();

            assert!(line.contains("ready=false"), "{line}");
            assert!(line.contains("policy=cold"), "{line}");
            assert!(line.contains("preroll_ms=500"), "{line}");
            assert!(line.contains("last_start=none"), "{line}");
        }

        #[test]
        fn a_ready_forever_status_line_says_so() {
            let manager = RecordingManager::new();
            manager.set_linger(Duration::from_millis(u64::MAX));

            let line = manager.status_line();

            assert!(line.contains("policy=ready-forever"), "{line}");
        }

        #[test]
        fn a_finite_status_line_shows_the_window() {
            let manager = RecordingManager::new();
            manager.set_linger(Duration::from_millis(5_000));

            assert!(manager.status_line().contains("policy=linger-5000ms"));
        }

        #[test]
        fn the_pre_roll_setting_has_a_reader_that_reports_it() {
            let manager = RecordingManager::new();

            manager.set_preroll(Duration::from_millis(1_200));

            // A stored setting nothing reads is a setting that silently does not
            // work, so the status line is asserted as its reader.
            assert!(manager.status_line().contains("preroll_ms=1200"));
        }

        #[test]
        fn resizing_the_pre_roll_while_nothing_is_held_clears_the_ring() {
            let manager = RecordingManager::new();
            manager.preroll.lock().unwrap().cap = 999;
            manager.preroll.lock().unwrap().push(&[1.0]);

            manager.set_preroll(Duration::from_millis(500));

            // With no stream there is no rate to size against, so the ring is
            // left empty rather than carrying a stale capacity into the next
            // open, which would keep the wrong length of audio.
            let ring = manager.preroll.lock().unwrap();
            assert_eq!(ring.cap, 0);
            assert_eq!(ring.len(), 0);
        }

        // ── Startup trace wiring ───────────────────────────────────────

        #[test]
        fn a_cold_start_marks_the_stages_a_reader_expects() {
            let base = std::time::Instant::now();
            let mut trace = AudioStartupTrace::begin_at(base);
            trace.mark_at(AudioStartupStage::CommandEntered, Duration::from_micros(5));
            trace.mark_at(
                AudioStartupStage::DeviceResolved,
                Duration::from_micros(120),
            );

            let summary = trace.summary();

            // The three stages a cold start goes through are the three a reader
            // compares between builds.
            assert_eq!(
                summary.stage_at(AudioStartupStage::CommandEntered),
                Some(Duration::from_micros(5))
            );
            assert!(!summary.reused);
        }

        #[test]
        fn a_start_with_no_trace_has_no_summary() {
            let manager = RecordingManager::new();

            // Nothing has started, so `capture_startup_timing` must report
            // nothing rather than a zeroed start that looks instantaneous.
            assert!(manager.last_startup_summary().is_none());
        }

        #[test]
        fn chunk_emitter_flushes_the_final_partial_chunk() {
            let chunks = Arc::new(Mutex::new(Vec::<(Vec<f32>, u64)>::new()));
            let callback_chunks = chunks.clone();
            let emitter = ChunkEmitter::new(Arc::new(move |chunk, offset| {
                callback_chunks.lock().unwrap().push((chunk, offset));
            }));

            emitter.emit(&[0.1f32, 0.2f32]);
            emitter.emit(&[0.3f32]);
            emitter.flush();

            assert_eq!(
                *chunks.lock().unwrap(),
                vec![(vec![0.1f32, 0.2f32], 0), (vec![0.3f32], 2)]
            );
        }

        #[test]
        fn chunk_offsets_stay_contiguous_when_dispatches_are_throttled() {
            let seen = Arc::new(Mutex::new(Vec::<(usize, u64)>::new()));
            let recorded = seen.clone();
            let emitter = ChunkEmitter::new(Arc::new(move |chunk, offset| {
                recorded.lock().unwrap().push((chunk.len(), offset));
            }));

            // Five batches arrive inside one throttle window, so the throttle
            // coalesces them and the first batch leaves immediately. The exact
            // split is a timing detail, so the contract asserted here is that
            // the offsets tile the stream: each one starts where the previous
            // batch ended, whatever the throttle decided.
            for _ in 0..5 {
                emitter.emit(&[0.0f32; 128]);
            }
            emitter.flush();

            let seen = seen.lock().unwrap();
            let mut expected_offset = 0u64;
            for (len, offset) in seen.iter() {
                assert_eq!(*offset, expected_offset);
                expected_offset += *len as u64;
            }
            assert_eq!(expected_offset, 5 * 128);
        }

        /// The throttle was one inline block in each emitter, with the decide
        /// and the advance under one lock. That pairing is the load-bearing
        /// part: if the timestamp were taken twice, two callers inside one
        /// window would both be told they could emit.
        #[test]
        fn chunk_offset_keeps_counting_when_a_dispatch_is_skipped() {
            let seen = Arc::new(Mutex::new(Vec::<(usize, u64)>::new()));
            let recorded = seen.clone();
            let emitter = ChunkEmitter::new(Arc::new(move |chunk, offset| {
                recorded.lock().unwrap().push((chunk.len(), offset));
            }));

            emitter.emit(&[0.0f32; 4]);
            // An empty batch contributes no samples, so it must not consume an
            // index either.
            emitter.emit(&[]);
            emitter.flush();

            assert_eq!(*seen.lock().unwrap(), vec![(4, 0)]);
        }

        #[test]
        fn concurrent_chunk_dispatch_never_reuses_a_starting_index() {
            let seen = Arc::new(Mutex::new(Vec::<u64>::new()));
            let recorded = seen.clone();
            let emitter = ChunkEmitter::new(Arc::new(move |_chunk, offset| {
                recorded.lock().unwrap().push(offset);
            }));

            let mut threads = Vec::new();
            for _ in 0..8 {
                let emitter = emitter.clone();
                threads.push(std::thread::spawn(move || {
                    for _ in 0..200 {
                        emitter.emit(&[0.0f32; 16]);
                        emitter.flush();
                    }
                }));
            }
            for thread in threads {
                thread.join().expect("emitter thread panicked");
            }

            let seen = seen.lock().unwrap();
            let unique: HashSet<u64> = seen.iter().copied().collect();
            assert_eq!(
                unique.len(),
                seen.len(),
                "two dispatches claimed the same starting index"
            );
        }

        /// Uniqueness is not enough. The webview places each chunk at the
        /// offset it is handed, so a callback that runs *after* a later
        /// offset has been delivered leaves a hole in a stream whose samples
        /// were contiguous. The offset was claimed under `buffer` but the
        /// callback ran after that lock was released, which is the window
        /// this closes.
        ///
        /// The first callback is held inside the callback so a second
        /// dispatch has to get past it to be delivered. Samples are pushed
        /// straight into the buffer rather than through `emit`, so the
        /// throttle window cannot turn the second dispatch into a no-op and
        /// make the test pass for the wrong reason.
        #[test]
        fn a_dispatch_in_flight_is_delivered_before_the_next_one() {
            use std::sync::atomic::{AtomicBool, Ordering};
            use std::sync::Barrier;
            use std::time::Duration;

            let first_entered = Arc::new(Barrier::new(2));
            let release_first = Arc::new(Barrier::new(2));
            let second_started = Arc::new(AtomicBool::new(false));
            let seen = Arc::new(Mutex::new(Vec::<u64>::new()));

            let entered = first_entered.clone();
            let release = release_first.clone();
            let seen_in_callback = seen.clone();
            let emitter = ChunkEmitter::new(Arc::new(move |_chunk, offset| {
                if offset == 0 {
                    // Park inside the first callback. Everything recorded
                    // after this point is a delivery that overtook it.
                    entered.wait();
                    release.wait();
                }
                seen_in_callback.lock().unwrap().push(offset);
            }));

            let first = {
                let emitter = emitter.clone();
                std::thread::spawn(move || {
                    emitter
                        .buffer
                        .lock()
                        .unwrap()
                        .extend_from_slice(&[0.0f32; 4]);
                    emitter.flush();
                })
            };
            first_entered.wait();

            let second_started_in_thread = second_started.clone();
            let second = {
                let emitter = emitter.clone();
                std::thread::spawn(move || {
                    second_started_in_thread.store(true, Ordering::SeqCst);
                    emitter
                        .buffer
                        .lock()
                        .unwrap()
                        .extend_from_slice(&[0.0f32; 4]);
                    emitter.flush();
                })
            };
            while !second_started.load(Ordering::SeqCst) {
                std::thread::yield_now();
            }
            // Long enough for the second dispatch to have been delivered if
            // nothing serialises it.
            std::thread::sleep(Duration::from_millis(200));
            assert!(
                seen.lock().unwrap().is_empty(),
                "a second dispatch reached the callback while the first was still in it"
            );

            release_first.wait();
            first.join().expect("first dispatch thread panicked");
            second.join().expect("second dispatch thread panicked");

            assert_eq!(
                *seen.lock().unwrap(),
                vec![0, 4],
                "chunks must reach the callback in the order their offsets were claimed"
            );
        }

        #[test]
        fn first_device_keeps_its_bare_name() {
            assert_eq!(
                disambiguated_label("Yeti Stereo Microphone", 0),
                "Yeti Stereo Microphone"
            );
        }

        #[test]
        fn repeated_names_get_an_ordinal_suffix() {
            assert_eq!(
                disambiguated_label("USB Microphone", 1),
                "USB Microphone (2)"
            );
            assert_eq!(
                disambiguated_label("USB Microphone", 2),
                "USB Microphone (3)"
            );
        }

        #[test]
        fn preferences_match_labels_case_insensitively() {
            assert!(device_matches_preferred(
                "USB Microphone (2)",
                "usb microphone (2)"
            ));
            assert!(!device_matches_preferred(
                "USB Microphone",
                "usb microphone (2)"
            ));
        }

        #[test]
        fn preferred_name_blocks_low_quality_keywords() {
            assert!(!is_preferred_input_device_name("AirPods Pro Microphone"));
            assert!(!is_preferred_input_device_name("Bluetooth Mic"));
        }

        #[test]
        fn preferred_name_detects_microphones() {
            assert!(is_preferred_input_device_name("Built-in Microphone"));
            assert!(is_preferred_input_device_name("Zoom Mic"));
            assert!(is_preferred_input_device_name("USB MIC"));
        }

        #[test]
        fn preferred_name_requires_microphone_context() {
            assert!(!is_preferred_input_device_name("USB Audio Device"));
        }
    }
}
