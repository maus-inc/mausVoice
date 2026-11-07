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
    use std::sync::{Arc, Mutex, MutexGuard};
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
        fn push(&mut self, samples: &[f32]) {
            if self.cap == 0 || samples.is_empty() {
                return;
            }
            if samples.len() >= self.cap {
                self.samples.clear();
                self.samples
                    .extend(samples[samples.len() - self.cap..].iter().copied());
                return;
            }
            self.samples.extend(samples.iter().copied());
            while self.samples.len() > self.cap {
                self.samples.pop_front();
            }
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
    /// Rounded down. A ring that rounds up can hand back slightly more audio
    /// than the user asked to keep, which is the wrong direction to be wrong in.
    fn preroll_capacity(preroll: Duration, sample_rate: u32) -> usize {
        if sample_rate == 0 {
            return 0;
        }
        let samples = (preroll.as_secs_f64() * f64::from(sample_rate)).floor();
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
    /// should stay open at all without the caller having to thread a flag.
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
        origin: Mutex<Instant>,
    }

    impl StreamSink {
        fn new(mode: SinkMode) -> Arc<Self> {
            Arc::new(Self {
                state: Mutex::new(mode),
                first_pcm: FirstPcmSignal::default(),
                first_recorded: FirstPcmSignal::default(),
                recorded_at_us: AtomicU64::new(0),
                last_block_us: AtomicU64::new(0),
                paused: AtomicBool::new(false),
                stopped: AtomicBool::new(false),
                origin: Mutex::new(Instant::now()),
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
            self.state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
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
                } => {
                    // Append before emitting. `stop` clones the buffer after
                    // flushing the emitter, so emitting first could deliver
                    // audio the returned recording does not contain.
                    if let Ok(mut buffer) = buffer.lock() {
                        buffer.extend_from_slice(samples);
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
        ) -> Arc<Mutex<Vec<f32>>> {
            let buffer = Arc::new(Mutex::new(seed.clone()));
            {
                let mut state = self.lock();
                *state = SinkMode::Recording {
                    buffer: Arc::clone(&buffer),
                    level,
                    chunk: chunk.clone(),
                };
            }
            if let Some(chunk) = chunk {
                if !seed.is_empty() {
                    chunk.emit(&seed);
                }
            }
            // A fresh recording is live again, whatever a previous stop left.
            self.stopped.store(false, Ordering::Release);
            self.paused.store(false, Ordering::Release);
            // Only the press clock restarts: the device-open clock measures the
            // lifetime of this stream, which began when the device opened.
            if let Ok(mut origin) = self.origin.lock() {
                *origin = Instant::now();
            }
            self.first_recorded.reset();
            self.recorded_at_us.store(0, Ordering::Release);
            buffer
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

        /// Records that the stream was paused or resumed by the app.
        ///
        /// A pause is deliberate, so it must not be mistaken for a dead device
        /// by the staleness check; a resume just restarts the window.
        fn set_paused(&self, paused: bool) {
            if !paused {
                // Resuming brings the stream back, so it is no longer stopped.
                self.stopped.store(false, Ordering::Release);
            }
            self.paused.store(paused, Ordering::Release);
            if !paused {
                if let Ok(mut origin) = self.origin.lock() {
                    *origin = Instant::now();
                }
                self.last_block_us.store(0, Ordering::Release);
            }
        }

        /// Whether the device was paused and not yet resumed.
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
        fn stop_recording(
            &self,
            preroll: Option<Arc<Mutex<Preroll>>>,
        ) -> Option<Arc<ChunkEmitter>> {
            self.stopped.store(true, Ordering::Release);
            self.paused.store(false, Ordering::Release);
            let mut state = self.lock();
            let previous = std::mem::replace(
                &mut *state,
                match preroll {
                    Some(preroll) => SinkMode::Warm { preroll },
                    None => SinkMode::Discard,
                },
            );
            match previous {
                SinkMode::Recording { chunk, .. } => chunk,
                _ => None,
            }
        }
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
            let _in_order = self
                .dispatch
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let (chunk, offset) = {
                let mut buffer = self
                    .buffer
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
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
    }

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
        fn hold_after_stop(&self) -> bool {
            self.linger_ms.load(Ordering::SeqCst) > 0
        }

        /// Sets how long the device stays open after a recording, and applies
        /// the matching policy to a stream that is already open.
        ///
        /// Zero means every press opens the device, which is the default and the
        /// only policy with no microphone indicator between dictations.
        pub fn set_linger(&self, linger: Duration) {
            let millis = linger.as_millis().min(u128::from(u64::MAX)) as u64;
            self.linger_ms.store(millis, Ordering::SeqCst);
            if millis == 0 {
                self.cancel_linger();
                self.close_warm();
            }
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
            self.linger_ms.store(WARM_FOREVER_MS, Ordering::SeqCst);
            // A pending linger would close this stream at its window, which is
            // later than never but still wrong for a hold.
            self.cancel_linger();
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

        /// Whether a warm stream is currently held.
        pub fn has_warm_stream(&self) -> bool {
            match self.warm.lock() {
                Ok(guard) => guard.is_some(),
                Err(poisoned) => poisoned.into_inner().is_some(),
            }
        }

        /// Closes the held stream, if any.
        ///
        /// An explicit close overrides a scheduled linger, so a close issued
        /// inside a linger window is not followed by a timer that was only ever
        /// meant to close the stream this call is closing now.
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
                    if generation_ref.load(Ordering::SeqCst) != generation {
                        return;
                    }
                    let closed = {
                        let mut guard = match warm.lock() {
                            Ok(guard) => guard,
                            Err(poisoned) => poisoned.into_inner(),
                        };
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

            if let Some(preferred) = preferred_normalized {
                if !device_matches_preferred(&cached.device_label, preferred) {
                    return None;
                }
            }

            let device = find_device_by_label(&host, &cached.device_label)?;

            let result = try_start_on_device(
                &device,
                Some(&cached.device_label),
                level_emitter,
                chunk_emitter,
                hold_after_stop,
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
                .map(|value| value.to_string());
            let preferred_normalized = preferred_trimmed
                .as_ref()
                .map(|value| value.to_ascii_lowercase());

            let mut guard = self.guard()?;

            if guard.is_some() {
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

            // Warm path: the stream from the previous recording is still open
            // and running, so nothing waits on the device.
            if let Some(active) = self.adopt_warm_stream(
                level_emitter.clone(),
                chunk_emitter.clone(),
                preferred_normalized.as_deref(),
                &mut trace,
            ) {
                self.record_startup(trace);
                *guard = Some(active);
                return Ok(());
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
                self.record_startup(trace);
                *guard = Some(active);
                return Ok(());
            }

            // Slow path: full device enumeration
            let mut last_err: Option<RecordingError> = None;

            for host_id in ordered_host_ids() {
                let host = match cpal::host_from_id(host_id) {
                    Ok(value) => value,
                    Err(err) => {
                        log::error!("failed to load host {host_id:?}: {err}");
                        continue;
                    }
                };

                match start_recording_on_host(
                    &host,
                    level_emitter.clone(),
                    chunk_emitter.clone(),
                    preferred_trimmed.as_deref(),
                    preferred_normalized.as_deref(),
                    hold_after_stop,
                    &mut trace,
                ) {
                    Ok((active, device_name)) => {
                        self.cache_successful_device(host_id, device_name);
                        self.record_startup(trace);
                        *guard = Some(active);
                        return Ok(());
                    }
                    Err(err) => {
                        log::warn!("host {host_id:?} did not yield a usable input device: {err}");
                        last_err = Some(err);
                    }
                }
            }

            Err(last_err.unwrap_or(RecordingError::InputDeviceUnavailable))
        }

        /// Takes the held stream for a recording, or explains why it cannot.
        ///
        /// Returns `None` after retiring a stream that must not be reused, so
        /// the caller falls back to opening a device. Every rejection here is a
        /// stream that would have produced a wrong or empty recording.
        fn adopt_warm_stream(
            &self,
            level_emitter: Option<Arc<LevelEmitter>>,
            chunk_emitter: Option<Arc<ChunkEmitter>>,
            preferred_normalized: Option<&str>,
            trace: &mut AudioStartupTrace,
        ) -> Option<ActiveRecording> {
            // Waits for an open that is already in flight, then takes what it
            // produced. Without this the press would open a second stream on
            // the same device and the two would compete for it.
            {
                let _gate = match self.warm_open_gate.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
            }
            let mut warm_guard = match self.warm.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            let warm = warm_guard.take()?;

            // A stream can be running and delivering nothing: the device was
            // unplugged, or the host stopped calling the callback after a sleep.
            // Reusing it would hand the press a stream that never produces a
            // sample, so it is retired and the caller records cold, which is
            // slower and works.
            if warm.is_silent_for(STALE_WARM_SILENCE) {
                log::warn!(
                    "warm stream on '{}' has delivered nothing for {:?}; reopening cold",
                    warm.device_label,
                    STALE_WARM_SILENCE
                );
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

            let buffer =
                warm.sink
                    .start_recording(level_emitter.clone(), chunk_emitter.clone(), seed);

            Some(ActiveRecording {
                stream: Some(warm.stream),
                sink: Some(warm.sink),
                preroll_after_stop: warm_ring(&self.preroll, self.hold_after_stop()),
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
        fn record_startup(&self, trace: AudioStartupTrace) {
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
            // Serialises with a press, so the press reuses this open instead of
            // racing it onto the same device.
            // The press takes these two in the same order, so that order is the
            // one that cannot deadlock against it.
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
                .map(|value| value.to_string());

            // The ring is left empty until the successful stream tells us the
            // real rate; `open_warm_stream` sizes it.
            let warm = self.open_warm_stream(preferred_trimmed.clone(), preroll)?;
            if let Ok(mut ring) = self.preroll.lock() {
                ring.cap = preroll_capacity(preroll, warm.sample_rate);
                ring.clear();
            }
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
                .map(|value| value.to_string());
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

            let mut last_err: Option<RecordingError> = None;
            for host_id in ordered_host_ids() {
                let host = match cpal::host_from_id(host_id) {
                    Ok(value) => value,
                    Err(err) => {
                        log::error!("failed to load host {host_id:?}: {err}");
                        last_err = Some(RecordingError::InputDeviceUnavailable);
                        log::debug!("host {host_id:?} unavailable while preparing: {err}");
                        continue;
                    }
                };
                let default_output_name = host
                    .default_output_device()
                    .and_then(|device| device.name().ok());
                let mut candidates = device_candidates_for_host(
                    &host,
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
                let Some(best) = candidates.into_iter().next() else {
                    last_err = Some(RecordingError::InputDeviceUnavailable);
                    continue;
                };
                self.cache_successful_device(host_id, best.label.clone());
                log::debug!("prepared '{}' for the next press", best.label);
                return Ok(best.label);
            }
            Err(last_err.unwrap_or(RecordingError::InputDeviceUnavailable))
        }

        /// Reopens the held stream if the device set changed underneath it.
        ///
        /// Devices appear and disappear while the app runs: a headset connects,
        /// a USB interface is plugged in. A held stream cannot follow that,
        /// because a stream is bound to the device it was built on, so the
        /// honest answer is to close it and open the newly best device. Called
        /// when the window is focused, not on a timer.
        pub fn refresh_warm_device(&self) {
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
                    self.close_warm();
                    if let Err(err) = self.open_warm(preroll) {
                        log::warn!("could not reopen the warm stream after a device change: {err}");
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
            format!(
                "ready={} policy={policy} preroll_ms={requested_ms} preroll_samples={preroll} last_start={reused}",
                self.has_warm_stream()
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

            let mut last_err: Option<RecordingError> = None;
            for host_id in ordered_host_ids() {
                let host = match cpal::host_from_id(host_id) {
                    Ok(value) => value,
                    Err(err) => {
                        log::error!("failed to load host {host_id:?}: {err}");
                        continue;
                    }
                };
                match warm_stream_on_host(
                    &host,
                    preferred_trimmed.as_deref(),
                    preferred_normalized.as_deref(),
                    Arc::clone(&self.preroll),
                    preroll,
                    &mut trace,
                ) {
                    Ok(warm) => {
                        self.record_startup(trace);
                        return Ok(warm);
                    }
                    Err(err) => {
                        log::warn!("host {host_id:?} did not yield a warm input device: {err}");
                        last_err = Some(err);
                    }
                }
            }
            Err(last_err.unwrap_or(RecordingError::InputDeviceUnavailable))
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
            let fallback_duration = recording.start.elapsed();
            let buffer = recording.buffer.clone();
            let device_label = recording.device_label.clone();
            let preferred = recording.preferred.clone();
            let channels = recording.channels;

            // Unsubscribing before closing keeps the capture callback from
            // writing a sample into a recording that already returned.
            let resumed_preroll = recording.preroll_after_stop.take();
            let flushed_emitter = recording
                .sink
                .as_ref()
                .and_then(|sink| sink.stop_recording(resumed_preroll.clone()));
            if let Some(chunk_emitter) = flushed_emitter {
                chunk_emitter.flush();
            }

            // The device is not closed here. A configured preroll ring means the
            // microphone should stay ready, so the same running stream goes back
            // into the warm slot and the next press skips the device open
            // entirely. Without a ring the stream is retired below.
            let pending_linger = self.pending_linger();
            match (resumed_preroll, recording.stream.take()) {
                (Some(_preroll), Some(stream)) => {
                    let sink = recording.sink.clone();
                    if let Some(sink) = sink {
                        // A stream stopped while paused is still stopped: the
                        // next press would adopt it, hear nothing, and pay a
                        // cold reopen after the staleness window, which is worse
                        // than the cold start it was meant to avoid. Resuming
                        // costs no device open and is what the hold was for.
                        if sink.is_paused() {
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
                .and_then(|buffer| buffer.lock().ok().map(|guard| guard.clone()))
                .unwrap_or_default();
            let duration = if !samples.is_empty() && sample_rate > 0 {
                let duration_secs = samples.len() as f64 / f64::from(sample_rate);
                std::time::Duration::from_secs_f64(duration_secs)
            } else {
                fallback_duration
            };
            let size_bytes = samples.len() as u64 * std::mem::size_of::<f32>() as u64;

            Ok(RecordingResult {
                metrics: RecordingMetrics {
                    duration,
                    size_bytes,
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

        fn warm_close(&self) {
            self.close_warm();
        }

        fn is_ready(&self) -> bool {
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

    fn should_avoid_input_device(device: &Device, default_output_name: Option<&str>) -> bool {
        let device_name = device.name().ok();
        let name_match = device_name
            .as_deref()
            .map(|name| {
                let lower = name.to_ascii_lowercase();
                LOW_QUALITY_INPUT_KEYWORDS
                    .iter()
                    .any(|keyword| lower.contains(keyword))
            })
            .unwrap_or(false);

        let output_match = default_output_name
            .map(|name| {
                let lower = name.to_ascii_lowercase();
                LOW_QUALITY_INPUT_KEYWORDS
                    .iter()
                    .any(|keyword| lower.contains(keyword))
            })
            .unwrap_or(false);

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
        if LOW_QUALITY_INPUT_KEYWORDS
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
        let lower = name.to_ascii_lowercase();
        LOW_QUALITY_INPUT_KEYWORDS
            .iter()
            .any(|keyword| lower.contains(keyword))
    }

    /// All available hosts with the cpal default host first.
    fn ordered_host_ids() -> Vec<HostId> {
        let default_host = cpal::default_host();
        let default_id = default_host.id();
        let mut ordered: Vec<HostId> = cpal::available_hosts()
            .into_iter()
            .filter(|id| *id != default_id)
            .collect();
        ordered.insert(0, default_id);
        ordered
    }

    /// Builds a capture stream that feeds a sink rather than a recording.
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

        let on_error = |err| log::error!("capture stream error: {err}");

        match sample_format {
            SampleFormat::I16 => {
                let sink = Arc::clone(&sink);
                device
                    .build_input_stream(
                        config,
                        move |data: &[i16], _| sink.deliver(&fold(data, channel_count)),
                        on_error,
                        None,
                    )
                    .map_err(|err| RecordingError::StreamBuild(err.to_string()))
            }
            SampleFormat::U16 => {
                let sink = Arc::clone(&sink);
                device
                    .build_input_stream(
                        config,
                        move |data: &[u16], _| sink.deliver(&fold(data, channel_count)),
                        on_error,
                        None,
                    )
                    .map_err(|err| RecordingError::StreamBuild(err.to_string()))
            }
            SampleFormat::F32 => {
                let sink = Arc::clone(&sink);
                device
                    .build_input_stream(
                        config,
                        move |data: &[f32], _| sink.deliver(&fold(data, channel_count)),
                        on_error,
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
        let default_output_name = host
            .default_output_device()
            .and_then(|device| device.name().ok());
        let mut candidates =
            device_candidates_for_host(host, default_output_name.as_deref(), preferred_normalized);
        candidates.sort_by_key(|candidate| {
            (
                !candidate.matches_preferred,
                candidate.priority,
                !candidate.is_default,
            )
        });
        trace.mark(AudioStartupStage::DeviceResolved);

        let mut last_err: Option<RecordingError> = None;
        for candidate in candidates {
            let DeviceCandidate {
                device,
                label,
                avoid_reason,
                ..
            } = candidate;
            if let Some(reason) = avoid_reason {
                log::debug!("deprioritising '{label}' ({reason}); will try if others fail");
            }
            match open_warm_on_device(
                &device,
                &label,
                preferred_label.map(|value| value.to_string()),
                preroll,
                Arc::clone(&ring),
                trace,
            ) {
                Ok(warm) => {
                    log::info!(
                        "holding input device '{label}' open via host {:?}",
                        host.id()
                    );
                    return Ok(warm);
                }
                Err(err) => {
                    log::warn!("'{label}' did not yield a warm stream: {err}");
                    last_err = Some(err);
                }
            }
        }
        Err(last_err.unwrap_or(RecordingError::InputDeviceUnavailable))
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
        hold_after_stop: bool,
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

        let (seed, ring) = cold_start_seed();
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

        let buffer = sink.start_recording(level_emitter, chunk_emitter, seed);
        log::info!("started on device '{label}'");

        Ok(ActiveRecording {
            stream: Some(stream),
            sink: Some(sink),
            preroll_after_stop: warm_ring(&ring, hold_after_stop),
            start: Instant::now(),
            buffer: Some(buffer),
            sample_rate,
            device_label: label.to_string(),
            preferred: device_name.map(|value| value.to_string()),
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
        hold_after_stop: bool,
        trace: &mut AudioStartupTrace,
    ) -> Result<(ActiveRecording, String), RecordingError> {
        let default_output_name = host
            .default_output_device()
            .and_then(|device| device.name().ok());

        let mut candidates =
            device_candidates_for_host(host, default_output_name.as_deref(), preferred_normalized);
        // Devices are no longer merged by name, so ties are broken by the host
        // default first and then by enumeration order (`sort_by_key` is stable).
        candidates.sort_by_key(|candidate| {
            (
                !candidate.matches_preferred,
                candidate.priority,
                !candidate.is_default,
            )
        });
        trace.mark(AudioStartupStage::DeviceResolved);

        let mut last_err: Option<RecordingError> = None;

        for candidate in candidates {
            let DeviceCandidate {
                device,
                label: device_label,
                avoid_reason,
                matches_preferred,
                ..
            } = candidate;
            let label = device_label.as_str();
            let fallback_preferred = preferred_label.or(preferred_normalized);

            if let Some(reason) = avoid_reason {
                log::debug!("deprioritising device '{label}' ({reason}); will try if others fail");
            }

            let active = match try_start_on_device(
                &device,
                Some(label),
                level_emitter.clone(),
                chunk_emitter.clone(),
                hold_after_stop,
                trace,
            ) {
                Ok(active) => active,
                Err(err) => {
                    log::error!("failed to start on '{label}': {err}");
                    last_err = Some(err);
                    continue;
                }
            };

            if matches_preferred {
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

            return Ok((active, label.to_string()));
        }

        Err(last_err.unwrap_or(RecordingError::InputDeviceUnavailable))
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
                    .map(|preferred| device_matches_preferred(&label, preferred))
                    .unwrap_or(false);

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
            cold_start_seed, device_matches_preferred, disambiguated_label,
            is_preferred_input_device_name, preroll_capacity, warm_ring, ChunkEmitter, Preroll,
            RecordingManager, SinkMode, StreamSink, WARM_FOREVER_MS,
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
        fn a_pre_roll_rounds_down_so_it_never_keeps_more_than_asked() {
            // 0.333 ms at 44.1 kHz is 14.68 samples. Keeping 15 would hand back
            // audio from before the window the user set.
            assert_eq!(preroll_capacity(Duration::from_micros(333), 44_100), 14);
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

            let buffer = sink.start_recording(None, None, vec![0.1, 0.2]);
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

            sink.start_recording(None, Some(Arc::clone(&emitter)), vec![9.0]);
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
        fn stopping_a_recording_returns_its_chunk_emitter_to_flush() {
            let emitter = ChunkEmitter::new(Arc::new(|_, _| {}));
            let sink = StreamSink::new(SinkMode::Discard);
            sink.start_recording(None, Some(Arc::clone(&emitter)), Vec::new());

            let returned = sink.stop_recording(Some(Arc::new(Mutex::new(Preroll::new(4)))));

            assert!(returned.is_some());
        }

        #[test]
        fn stopping_without_a_ring_discards_captured_audio() {
            let sink = StreamSink::new(SinkMode::Discard);
            sink.start_recording(None, None, Vec::new());

            sink.stop_recording(None);

            assert!(matches!(*sink.lock(), SinkMode::Discard));
        }

        #[test]
        fn stopping_hands_the_stream_back_to_the_preroll() {
            let ring = Arc::new(Mutex::new(Preroll::new(8)));
            let sink = StreamSink::new(SinkMode::Discard);
            sink.start_recording(None, None, Vec::new());

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
            sink.start_recording(None, None, Vec::new());
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

        // ── Hold policy ────────────────────────────────────────────────

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
        fn a_running_recording_is_never_handed_to_a_warm_open() {
            let manager = RecordingManager::new();
            manager.set_linger(Duration::from_millis(u64::MAX));

            // Stand in for a recording that is in flight: the guard is what
            // `open_warm` reads to decide whether the device is already taken.
            *manager.inner.lock().unwrap() = Some(super::ActiveRecording {
                stream: None,
                sink: None,
                preroll_after_stop: None,
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
