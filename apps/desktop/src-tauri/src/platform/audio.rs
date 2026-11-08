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

/// Creates the shared recorder used by the Tauri commands.
pub fn new_recorder() -> Arc<dyn Recorder> {
    Arc::new(cpal_impl::RecordingManager::new())
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

/// Keep only the valid prefix when an input device produces non-finite samples.
pub(crate) fn retain_finite_prefix(samples: &mut Vec<f32>) -> bool {
    if let Some(index) = samples.iter().position(|sample| !sample.is_finite()) {
        samples.truncate(index);
        false
    } else {
        true
    }
}

// ── CPAL backend ────────────────────────────────────────────────────────

#[cfg(test)]
#[path = "../../../../../patches/cpal-0.15.3/src/host/alsa/stream_buffer.rs"]
mod cpal_alsa_stream_buffer;

#[cfg(test)]
#[path = "../../../../../patches/cpal-0.15.3/src/host/alsa/output_pending.rs"]
mod cpal_alsa_output_pending;

#[cfg(test)]
#[path = "../../../../../patches/cpal-0.15.3/src/host/alsa/input_start.rs"]
mod cpal_alsa_input_start;

#[cfg(test)]
#[path = "../../../../../patches/cpal-0.15.3/src/host/alsa/input_probe.rs"]
mod cpal_alsa_input_probe;

#[cfg(test)]
#[path = "../../../../../patches/coreaudio-rs-0.11.3/src/audio_unit/input_buffer.rs"]
mod coreaudio_input_buffer;

#[cfg(test)]
#[path = "../../../../../patches/coreaudio-rs-0.11.3/tests/macos_listener_adapter.rs"]
mod coreaudio_macos_listener_adapter;

#[cfg(test)]
#[path = "../../../../../patches/coreaudio-rs-0.11.3/tests/macos_devices_adapter.rs"]
mod coreaudio_macos_devices_adapter;

#[cfg(test)]
#[path = "../../../../../patches/coreaudio-rs-0.11.3/tests/macos_sample_rate_adapter.rs"]
mod coreaudio_macos_sample_rate_adapter;

#[cfg(test)]
#[path = "../../../../../patches/coreaudio-rs-0.11.3/tests/macos_physical_format_adapter.rs"]
mod coreaudio_macos_physical_format_adapter;

#[cfg(test)]
#[path = "../../../../../patches/cpal-0.15.3/tests/macos_input_lifetime.rs"]
mod cpal_macos_input_lifetime;

#[cfg(test)]
#[path = "../../../../../patches/cpal-0.15.3/tests/macos_listener_lifetime.rs"]
mod cpal_macos_listener_lifetime;

#[cfg(test)]
#[path = "../../../../../patches/cpal-0.15.3/tests/macos_property_data.rs"]
mod cpal_macos_property_data;

mod cpal_impl {
    use super::{
        compute_level_bins, retain_finite_prefix, InputDeviceDescriptor, CHUNK_DISPATCH_INTERVAL,
        LEVEL_DISPATCH_INTERVAL,
    };
    use crate::domain::{RecordedAudio, RecordingMetrics, RecordingResult};
    use crate::errors::RecordingError;
    use crate::platform::{ChunkCallback, LevelCallback, Recorder};
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{Device, HostId, SampleFormat, Stream, StreamConfig};
    use std::cell::Cell;
    use std::cmp;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex, MutexGuard};
    use std::time::{Duration, Instant};

    fn capture_cleanup_uncertain() -> bool {
        #[cfg(target_os = "linux")]
        {
            cpal::alsa_capture_cleanup_uncertain()
        }
        #[cfg(not(target_os = "linux"))]
        {
            false
        }
    }

    #[derive(Clone)]
    struct CachedDeviceInfo {
        host_id: HostId,
        /// Disambiguated label, so the cache re-resolves the exact same device
        /// even when the host exposes several inputs under one name.
        device_label: String,
    }

    struct LocalRecordingManager {
        inner: Mutex<Option<ActiveRecording>>,
        preferred_input_name: Mutex<Option<String>>,
        last_successful_device: Mutex<Option<CachedDeviceInfo>>,
        // No live handle exists to retry a failed native build cleanup.
        release_uncertain: Cell<bool>,
    }

    #[derive(Clone, Copy)]
    struct ReleaseOutcome {
        released: bool,
        capture_failed: bool,
    }

    struct ActiveRecording {
        _stream: Stream,
        start: Instant,
        buffer: Arc<Mutex<Vec<f32>>>,
        sample_rate: u32,
        callback_gate: Arc<CallbackGate>,
        capture_failed: Arc<AtomicBool>,
        paused_for_release: bool,
        _level_emitter: Option<Arc<LevelEmitter>>,
        _chunk_emitter: Option<Arc<ChunkEmitter>>,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum CallbackState {
        Pending,
        Active,
        Paused,
        Resuming,
        Retired,
    }

    /// Serializes publication, callback completion and retirement. Pending
    /// candidates retain samples but must not publish to the shared emitter.
    struct CallbackGate(Mutex<CallbackState>);

    impl CallbackGate {
        fn new() -> Arc<Self> {
            Arc::new(Self(Mutex::new(CallbackState::Pending)))
        }

        fn with_capture(&self, callback: impl FnOnce(bool)) {
            if let Ok(state) = self.0.lock() {
                match *state {
                    CallbackState::Pending | CallbackState::Resuming => callback(false),
                    CallbackState::Active => callback(true),
                    CallbackState::Paused | CallbackState::Retired => {}
                }
            }
        }

        fn with_error(&self, callback: impl FnOnce()) {
            if let Ok(state) = self.0.lock() {
                if *state != CallbackState::Retired {
                    callback();
                }
            }
        }

        fn activate(&self, publish_prefix: impl FnOnce() -> bool) -> bool {
            let Ok(mut state) = self.0.lock() else {
                return false;
            };
            if *state != CallbackState::Pending || !publish_prefix() {
                return false;
            }
            *state = CallbackState::Active;
            true
        }

        fn pause(&self) -> bool {
            let Ok(mut state) = self.0.lock() else {
                return false;
            };
            match *state {
                CallbackState::Active => {
                    *state = CallbackState::Paused;
                    true
                }
                CallbackState::Paused => true,
                CallbackState::Pending | CallbackState::Resuming | CallbackState::Retired => false,
            }
        }

        fn begin_resume(&self) -> bool {
            let Ok(mut state) = self.0.lock() else {
                return false;
            };
            match *state {
                CallbackState::Paused => {
                    *state = CallbackState::Resuming;
                    true
                }
                CallbackState::Active => true,
                CallbackState::Pending | CallbackState::Resuming | CallbackState::Retired => false,
            }
        }

        fn finish_resume(&self, publish: impl FnOnce() -> bool) -> bool {
            let Ok(mut state) = self.0.lock() else {
                return false;
            };
            match *state {
                CallbackState::Resuming if publish() => {
                    *state = CallbackState::Active;
                    true
                }
                CallbackState::Active => true,
                _ => false,
            }
        }

        fn retire(&self) {
            *self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = CallbackState::Retired;
        }
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
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let (chunk, offset) = {
                let mut buffer = self
                    .buffer
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
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

    fn activate_capture(
        gate: &CallbackGate,
        buffer: &Mutex<Vec<f32>>,
        emitter: Option<&ChunkEmitter>,
        capture_failed: &AtomicBool,
    ) -> Result<(), RecordingError> {
        let activated = gate.activate(|| {
            if capture_failed.load(Ordering::Acquire) {
                return false;
            }
            let Ok(samples) = buffer.lock() else {
                return false;
            };
            if let Some(emitter) = emitter {
                emitter.emit(&samples);
            }
            true
        });
        if activated {
            Ok(())
        } else {
            Err(RecordingError::CaptureFailed)
        }
    }

    fn finish_resume_capture(
        gate: &CallbackGate,
        buffer: &Mutex<Vec<f32>>,
        emitter: Option<&ChunkEmitter>,
        capture_failed: &AtomicBool,
        resume_offset: usize,
    ) -> bool {
        gate.finish_resume(|| {
            if capture_failed.load(Ordering::Acquire) {
                return false;
            }
            let Ok(samples) = buffer.lock() else {
                return false;
            };
            let Some(resumed) = samples.get(resume_offset..) else {
                return false;
            };
            if let Some(emitter) = emitter {
                emitter.emit(resumed);
            }
            true
        })
    }

    fn retain_input_samples(
        buffer: &Mutex<Vec<f32>>,
        capture_failed: &AtomicBool,
        samples: &mut Vec<f32>,
    ) -> bool {
        if capture_failed.load(Ordering::Acquire) {
            return false;
        }
        if !retain_finite_prefix(samples) {
            capture_failed.store(true, Ordering::Release);
        }
        if samples.is_empty() {
            return false;
        }
        match buffer.lock() {
            Ok(mut buffer) => {
                buffer.extend_from_slice(samples);
                true
            }
            Err(_) => {
                capture_failed.store(true, Ordering::Release);
                false
            }
        }
    }

    /// Transfer a retired buffer for recovery. Poison means the callback may
    /// have been interrupted mid-update, so the result is never a success.
    fn take_captured_samples(buffer: &Mutex<Vec<f32>>, mut incomplete: bool) -> (Vec<f32>, bool) {
        let mut samples = match buffer.lock() {
            Ok(mut buffer) => std::mem::take(&mut *buffer),
            Err(poisoned) => {
                incomplete = true;
                std::mem::take(&mut *poisoned.into_inner())
            }
        };
        for sample in &mut samples {
            if !sample.is_finite() {
                *sample = 0.0;
                incomplete = true;
            }
        }
        (samples, incomplete)
    }

    fn pause_stream_with_retry<E: std::fmt::Display>(
        mut pause: impl FnMut() -> Result<(), E>,
    ) -> bool {
        match pause() {
            Ok(()) => true,
            Err(error) => {
                log::error!("failed to pause input stream: {error}");
                match pause() {
                    Ok(()) => true,
                    Err(error) => {
                        log::error!("failed to retry pausing input stream: {error}");
                        false
                    }
                }
            }
        }
    }

    fn release_or_retain<T>(
        slot: &mut Option<T>,
        mut resource: T,
        pause: impl FnOnce(&mut T) -> bool,
    ) -> bool {
        if !pause(&mut resource) {
            *slot = Some(resource);
            return false;
        }
        drop(resource);
        true
    }

    fn start_candidate<T, E>(
        retained: &mut Option<T>,
        candidate: T,
        start: impl FnOnce(&T) -> Result<(), E>,
        retire: impl FnOnce(&T),
        pause: impl FnOnce(&mut T) -> bool,
    ) -> Result<T, E> {
        match start(&candidate) {
            Ok(()) => Ok(candidate),
            Err(error) => {
                retire(&candidate);
                release_or_retain(retained, candidate, pause);
                Err(error)
            }
        }
    }

    impl ActiveRecording {
        fn pause_for_release(&mut self) -> bool {
            if self.paused_for_release {
                return true;
            }
            #[cfg(target_os = "macos")]
            {
                let cpal::platform::StreamInner::CoreAudio(stream) = self._stream.as_inner();
                if let Err(error) = stream.quiesce_input() {
                    log::error!("failed to retire input callbacks: {error}");
                    return false;
                }
            }
            #[cfg(target_os = "linux")]
            {
                #[allow(unreachable_patterns)]
                let result = match self._stream.as_inner_mut() {
                    cpal::platform::StreamInner::Alsa(stream) => {
                        let released = pause_stream_with_retry(|| stream.stop_input_for_release());
                        if released && stream.capture_worker_failed() {
                            // The device is released, so this must not retain the
                            // stream. The recording is still incomplete: the
                            // capture worker ended by panicking.
                            log::error!(
                                "ALSA capture worker panicked; reporting an incomplete recording"
                            );
                            self.capture_failed.store(true, Ordering::Release);
                        }
                        released
                    }
                    // Do not claim release for a newly enabled, unaudited host.
                    _ => false,
                };
                if !result {
                    return false;
                }
            }
            #[cfg(not(target_os = "linux"))]
            if !pause_stream_with_retry(|| self._stream.pause()) {
                return false;
            }
            #[cfg(target_os = "macos")]
            {
                let cpal::platform::StreamInner::CoreAudio(stream) = self._stream.as_inner();
                if let Err(error) = stream.close_paused_input() {
                    log::error!("failed to close input stream: {error}");
                    return false;
                }
            }
            self.paused_for_release = true;
            true
        }
    }

    impl Drop for ActiveRecording {
        fn drop(&mut self) {
            // A driver pause or destruction can block. Stop accepting samples
            // first, without holding the callback gate across driver calls.
            self.callback_gate.retire();
            if !self.paused_for_release {
                self.pause_for_release();
            }
        }
    }

    type WorkerTask<T> = Box<dyn FnOnce(&T) + Send>;

    #[derive(Debug)]
    struct WorkerUnavailable;

    impl std::fmt::Display for WorkerUnavailable {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("recording worker is unavailable")
        }
    }

    impl std::error::Error for WorkerUnavailable {}

    // The resource is constructed, accessed and dropped on the worker. The
    // commands, not the potentially !Send resource, cross the thread boundary.
    struct ThreadBoundWorker<T> {
        sender: Option<std::sync::mpsc::SyncSender<WorkerTask<T>>>,
        failed: Arc<AtomicBool>,
    }

    struct WorkerFailureGuard(Arc<AtomicBool>);

    impl Drop for WorkerFailureGuard {
        fn drop(&mut self) {
            if std::thread::panicking() {
                self.0.store(true, Ordering::SeqCst);
            }
        }
    }

    impl<T: 'static> ThreadBoundWorker<T> {
        fn new(create: impl FnOnce() -> T + Send + 'static) -> Self {
            let (sender, receiver) = std::sync::mpsc::sync_channel::<WorkerTask<T>>(1);
            let failed = Arc::new(AtomicBool::new(false));
            let worker_failed = Arc::clone(&failed);
            let result = std::thread::Builder::new()
                .name("cpal-recorder".into())
                .spawn(move || {
                    let _failure_guard = WorkerFailureGuard(worker_failed);
                    let resource = create();
                    while let Ok(task) = receiver.recv() {
                        task(&resource);
                    }
                });
            let sender = match result {
                Ok(_) => Some(sender),
                Err(error) => {
                    log::error!("Failed to spawn recording worker: {error}");
                    None
                }
            };
            Self { sender, failed }
        }

        fn send(&self, task: impl FnOnce(&T) + Send + 'static) -> Result<(), WorkerUnavailable> {
            let worker = self.sender.as_ref().ok_or(WorkerUnavailable)?;
            if worker.send(Box::new(task)).is_err() {
                self.failed.store(true, Ordering::SeqCst);
                return Err(WorkerUnavailable);
            }
            Ok(())
        }

        fn call<R: Send + 'static>(
            &self,
            task: impl FnOnce(&T) -> R + Send + 'static,
        ) -> Result<R, WorkerUnavailable> {
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            self.send(move |resource| {
                let result = task(resource);
                let _ = sender.send(result);
            })?;
            receiver.recv().map_err(|_| {
                self.failed.store(true, Ordering::SeqCst);
                WorkerUnavailable
            })
        }
    }

    /// Status is published by the thread that owns the stream, never by a
    /// caller waiting for it. A panicked or wedged worker therefore remains
    /// conservatively active until physical teardown has actually completed.
    /// Zero is idle, MAX is opening/unknown, and other values encode rate + 1.
    #[derive(Default)]
    struct RecorderActivity(AtomicU64);

    impl RecorderActivity {
        const UNKNOWN: u64 = u64::MAX;

        fn opening(&self) {
            self.0.store(Self::UNKNOWN, Ordering::SeqCst);
        }

        fn started(&self, sample_rate: Option<u32>) {
            self.0.store(
                sample_rate.map_or(Self::UNKNOWN, |rate| u64::from(rate) + 1),
                Ordering::SeqCst,
            );
        }

        fn released(&self) {
            self.0.store(0, Ordering::SeqCst);
        }

        fn is_recording(&self) -> bool {
            self.0.load(Ordering::SeqCst) != 0
        }

        fn sample_rate(&self) -> Option<u32> {
            let value = self.0.load(Ordering::SeqCst);
            if value == 0 || value == Self::UNKNOWN {
                None
            } else {
                Some((value - 1) as u32)
            }
        }
    }

    pub struct RecordingManager {
        worker: ThreadBoundWorker<LocalRecordingManager>,
        activity: Arc<RecorderActivity>,
    }

    impl RecordingManager {
        pub fn new() -> Self {
            Self {
                worker: ThreadBoundWorker::new(LocalRecordingManager::new),
                activity: Arc::new(RecorderActivity::default()),
            }
        }
    }

    impl LocalRecordingManager {
        fn new() -> Self {
            Self {
                inner: Mutex::new(None),
                preferred_input_name: Mutex::new(None),
                last_successful_device: Mutex::new(None),
                release_uncertain: Cell::new(false),
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

        /// Tries to start recording on the previously successful device.
        ///
        /// Returns `None` when the cache cannot be used or the failed
        /// candidate was fully released. An unreleased candidate stops the
        /// search and stays in `retained` for the owner's cleanup retry.
        fn try_cached_device(
            &self,
            level_emitter: Option<Arc<LevelEmitter>>,
            chunk_emitter: Option<Arc<ChunkEmitter>>,
            preferred_normalized: Option<&str>,
            retained: &mut Option<ActiveRecording>,
        ) -> Result<Option<(ActiveRecording, HostId, String)>, RecordingError> {
            let cached = self
                .last_successful_device
                .lock()
                .ok()
                .and_then(|guard| guard.clone());
            let Some(cached) = cached else {
                return Ok(None);
            };
            let Ok(host) = cpal::host_from_id(cached.host_id) else {
                return Ok(None);
            };

            if let Some(preferred) = preferred_normalized {
                if !device_matches_preferred(&cached.device_label, preferred) {
                    return Ok(None);
                }
            }

            let Some(device) = find_device_by_label(&host, &cached.device_label) else {
                return Ok(None);
            };

            let result = try_start_on_device(
                &device,
                Some(&cached.device_label),
                level_emitter,
                chunk_emitter,
                retained,
            );

            match result {
                Ok(active) => {
                    log::info!(
                        "using cached device '{}' via host {:?}",
                        cached.device_label,
                        cached.host_id
                    );
                    Ok(Some((active, cached.host_id, cached.device_label)))
                }
                Err(err) => {
                    log::warn!("cached device '{}' failed: {err}", cached.device_label);
                    if retained.is_some() || matches!(err, RecordingError::ReleaseUncertain(_)) {
                        Err(err)
                    } else {
                        Ok(None)
                    }
                }
            }
        }

        fn guard(&self) -> Result<MutexGuard<'_, Option<ActiveRecording>>, RecordingError> {
            self.inner
                .lock()
                .map_err(|_| RecordingError::AlreadyRecording)
        }

        fn start_recording(
            &self,
            level_callback: Option<LevelCallback>,
            chunk_callback: Option<ChunkCallback>,
        ) -> Result<(), RecordingError> {
            if self.release_uncertain.get() || capture_cleanup_uncertain() {
                return Err(RecordingError::ReleaseUncertain(
                    "a previous capture device could not be closed".into(),
                ));
            }
            let result = self.start_recording_attempt(level_callback, chunk_callback);
            if capture_cleanup_uncertain() && result.is_err() {
                return Err(RecordingError::ReleaseUncertain(
                    "capture probe cleanup could not confirm device release".into(),
                ));
            }
            if matches!(&result, Err(RecordingError::ReleaseUncertain(_))) {
                self.release_uncertain.set(true);
            }
            result
        }

        fn start_recording_attempt(
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

            // Fast path: try the cached device first. Resolving the cached label
            // still enumerates the selected host's input devices, but it skips
            // candidate scoring and never iterates the other hosts.
            if let Some((active, host_id, device_name)) = self.try_cached_device(
                level_emitter.clone(),
                chunk_emitter.clone(),
                preferred_normalized.as_deref(),
                &mut guard,
            )? {
                *guard = Some(active);
                self.cache_successful_device(host_id, device_name);
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
                    &mut guard,
                ) {
                    Ok((active, device_name)) => {
                        *guard = Some(active);
                        self.cache_successful_device(host_id, device_name);
                        return Ok(());
                    }
                    Err(err) => {
                        log::warn!("host {host_id:?} did not yield a usable input device: {err}");
                        if guard.is_some() || matches!(err, RecordingError::ReleaseUncertain(_)) {
                            return Err(err);
                        }
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
            #[cfg(target_os = "linux")]
            {
                #[allow(unreachable_patterns)]
                let stream = match recording._stream.as_inner() {
                    cpal::platform::StreamInner::Alsa(stream) if stream.can_pause_input() => stream,
                    _ => {
                        return Err(RecordingError::StreamPlay(
                            "The input device does not support pause".into(),
                        ));
                    }
                };
                // ALSA must finish delivering a read before publication is
                // paused, or that read could surface only after a later resume.
                if let Err(err) = stream.pause_input_and_drain() {
                    recording.capture_failed.store(true, Ordering::Release);
                    recording.callback_gate.retire();
                    return Err(RecordingError::StreamPlay(err.to_string()));
                }
                if !recording.callback_gate.pause() {
                    recording.capture_failed.store(true, Ordering::Release);
                    return Err(RecordingError::CaptureFailed);
                }
                Ok(())
            }
            #[cfg(target_os = "windows")]
            {
                #[allow(unreachable_patterns)]
                let stream = match recording._stream.as_inner() {
                    cpal::platform::StreamInner::Wasapi(stream) => stream,
                    _ => {
                        return Err(RecordingError::StreamPlay(
                            "The input device does not support pause".into(),
                        ));
                    }
                };
                // WASAPI delivers the packets it captured before the stop to
                // the callback, so publication stays open across the drain.
                // Pausing the gate first would silently drop the tail.
                if let Err(err) = stream.pause_input_and_drain() {
                    recording.capture_failed.store(true, Ordering::Release);
                    recording.callback_gate.retire();
                    return Err(RecordingError::StreamPlay(err.to_string()));
                }
                if !recording.callback_gate.pause() {
                    recording.capture_failed.store(true, Ordering::Release);
                    return Err(RecordingError::CaptureFailed);
                }
                Ok(())
            }
            #[cfg(not(any(target_os = "linux", target_os = "windows")))]
            {
                // A failed native call may still change hardware state.
                if !recording.callback_gate.pause() {
                    recording.capture_failed.store(true, Ordering::Release);
                    return Err(RecordingError::CaptureFailed);
                }
                if let Err(err) = recording._stream.pause() {
                    recording.capture_failed.store(true, Ordering::Release);
                    recording.callback_gate.retire();
                    return Err(RecordingError::StreamPlay(err.to_string()));
                }
                Ok(())
            }
        }

        fn resume_recording(&self) -> Result<(), RecordingError> {
            let guard = self
                .inner
                .lock()
                .map_err(|_| RecordingError::NotRecording)?;
            let recording = guard.as_ref().ok_or(RecordingError::NotRecording)?;
            if recording.capture_failed.load(Ordering::Acquire) {
                return Err(RecordingError::CaptureFailed);
            }
            let resume_offset = match recording
                .buffer
                .lock()
                .map(|samples| samples.len())
                .map_err(|_| ())
            {
                Ok(offset) => offset,
                Err(()) => {
                    recording.capture_failed.store(true, Ordering::Release);
                    recording.callback_gate.retire();
                    return Err(RecordingError::CaptureFailed);
                }
            };
            // Callbacks arriving during the native transition are retained but
            // not published until resume is confirmed. Never hold the gate
            // across a driver call that could invoke a callback synchronously.
            if !recording.callback_gate.begin_resume() {
                recording.capture_failed.store(true, Ordering::Release);
                return Err(RecordingError::CaptureFailed);
            }
            if let Err(err) = recording._stream.play() {
                recording.capture_failed.store(true, Ordering::Release);
                recording.callback_gate.retire();
                return Err(RecordingError::StreamPlay(err.to_string()));
            }
            if !finish_resume_capture(
                &recording.callback_gate,
                &recording.buffer,
                recording._chunk_emitter.as_deref(),
                &recording.capture_failed,
                resume_offset,
            ) {
                recording.capture_failed.store(true, Ordering::Release);
                recording.callback_gate.retire();
                return Err(RecordingError::CaptureFailed);
            }
            Ok(())
        }

        /// Seal and publish samples before potentially blocking driver teardown.
        /// Callback retirement is the same capture boundary used by Drop.
        fn stop_with_handoff(
            &self,
            publish: impl FnOnce(Result<RecordingResult, RecordingError>),
        ) -> ReleaseOutcome {
            if self.release_uncertain.get() {
                publish(Err(RecordingError::ReleaseUncertain(
                    "capture build cleanup could not confirm device release".into(),
                )));
                return ReleaseOutcome {
                    released: false,
                    capture_failed: true,
                };
            }
            let mut guard = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let Some(recording) = guard.take() else {
                if capture_cleanup_uncertain() {
                    publish(Err(RecordingError::ReleaseUncertain(
                        "capture probe cleanup could not confirm device release".into(),
                    )));
                    return ReleaseOutcome {
                        released: false,
                        capture_failed: true,
                    };
                }
                publish(Err(RecordingError::NotRecording));
                return ReleaseOutcome {
                    released: true,
                    capture_failed: false,
                };
            };
            let capture_failed = Arc::clone(&recording.capture_failed);
            let sample_rate = recording.sample_rate;
            let fallback_duration = recording.start.elapsed();
            recording.callback_gate.retire();
            let incomplete = recording.callback_gate.0.is_poisoned()
                || recording.capture_failed.load(Ordering::Acquire);
            let (samples, incomplete) = take_captured_samples(&recording.buffer, incomplete);
            if !incomplete {
                if let Some(chunk_emitter) = &recording._chunk_emitter {
                    chunk_emitter.flush();
                }
            }
            let duration = if !samples.is_empty() && sample_rate > 0 {
                Duration::from_secs_f64(samples.len() as f64 / f64::from(sample_rate))
            } else {
                fallback_duration
            };
            let size_bytes = samples.len() as u64 * std::mem::size_of::<f32>() as u64;
            publish(Ok(RecordingResult {
                metrics: RecordingMetrics {
                    duration,
                    size_bytes,
                },
                audio: RecordedAudio {
                    samples,
                    sample_rate,
                },
                capture_failed: incomplete,
            }));
            // Keep the sealed stream if release is unconfirmed. A failed
            // native close may not be safe to retry on the same handle.
            let released =
                release_or_retain(&mut guard, recording, ActiveRecording::pause_for_release);
            let probe_uncertain = capture_cleanup_uncertain();
            ReleaseOutcome {
                released: released && !probe_uncertain,
                capture_failed: capture_failed.load(Ordering::Acquire) || probe_uncertain,
            }
        }

        fn stop_recording(&self) -> (Result<RecordingResult, RecordingError>, bool) {
            let mut result = None;
            let outcome = self.stop_with_handoff(|recording| result = Some(recording));
            let mut result = result.expect("stop always publishes a result");
            if let Ok(recording) = &mut result {
                recording.capture_failed |= outcome.capture_failed;
            }
            (result, outcome.released)
        }
    }

    impl LocalRecordingManager {
        fn set_preferred_input_device(&self, name: Option<String>) {
            let sanitized = name
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());

            match self.preferred_input_name.lock() {
                Ok(mut guard) => *guard = sanitized,
                Err(poisoned) => *poisoned.into_inner() = sanitized,
            }
            self.clear_device_cache();
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

    /// The capture result is independent of the release signal: a blocked or
    /// panicking driver cannot be mistaken for successful physical teardown.
    fn await_recording_handoff(
        result_rx: std::sync::mpsc::Receiver<Result<RecordingResult, RecordingError>>,
        released_rx: std::sync::mpsc::Receiver<ReleaseOutcome>,
        worker_failed: &AtomicBool,
        release_grace: Duration,
    ) -> Result<RecordingResult, Box<dyn std::error::Error>> {
        let mut result = result_rx
            .recv()
            .map_err(|_| {
                worker_failed.store(true, Ordering::SeqCst);
                WorkerUnavailable
            })?
            .map_err(|error| Box::new(error) as Box<dyn std::error::Error>)?;
        match released_rx.recv_timeout(release_grace) {
            Ok(outcome) => {
                result.capture_failed |= !outcome.released || outcome.capture_failed;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => result.capture_failed = true,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                worker_failed.store(true, Ordering::SeqCst);
                result.capture_failed = true;
            }
        }
        Ok(result)
    }

    impl Recorder for RecordingManager {
        fn start(
            &self,
            level_callback: Option<LevelCallback>,
            chunk_callback: Option<ChunkCallback>,
        ) -> Result<(), Box<dyn std::error::Error>> {
            let activity = Arc::clone(&self.activity);
            self.worker
                .call(move |recorder| {
                    // Set this before touching the driver. If it panics or
                    // hangs while opening, no other thread can prove release.
                    activity.opening();
                    let result = recorder.start_recording(level_callback, chunk_callback);
                    let rate = recorder.current_sample_rate();
                    if result.is_ok()
                        || rate.is_some()
                        || recorder.release_uncertain.get()
                        || capture_cleanup_uncertain()
                    {
                        activity.started(rate);
                    } else {
                        activity.released();
                    }
                    result
                })?
                .map_err(|err| Box::new(err) as _)
        }

        fn stop(&self) -> Result<RecordingResult, Box<dyn std::error::Error>> {
            let activity = Arc::clone(&self.activity);
            let (result, released) = self.worker.call(move |recorder| {
                let (result, released) = recorder.stop_recording();
                // An unconfirmed release keeps the sealed stream reserved.
                // Release is published only after successful destruction.
                if released {
                    activity.released();
                }
                (result, released)
            })?;
            if !released {
                return Err("Recording release is pending".into());
            }
            result.map_err(|err| Box::new(err) as _)
        }

        fn stop_for_handoff(&self) -> Result<RecordingResult, Box<dyn std::error::Error>> {
            const RELEASE_GRACE: Duration = Duration::from_secs(2);
            let (result_tx, result_rx) = std::sync::mpsc::sync_channel(1);
            let (released_tx, released_rx) = std::sync::mpsc::sync_channel(1);
            let activity = Arc::clone(&self.activity);
            self.worker.send(move |recorder| {
                let outcome = recorder.stop_with_handoff(|result| {
                    let _ = result_tx.send(result);
                });
                // The worker does not publish release until stream destruction
                // has actually returned on its owning thread.
                if outcome.released {
                    activity.released();
                }
                let _ = released_tx.send(outcome);
            })?;
            await_recording_handoff(result_rx, released_rx, &self.worker.failed, RELEASE_GRACE)
        }

        fn pause(&self) -> Result<(), Box<dyn std::error::Error>> {
            self.worker
                .call(LocalRecordingManager::pause_recording)?
                .map_err(|err| Box::new(err) as _)
        }

        fn resume(&self) -> Result<(), Box<dyn std::error::Error>> {
            self.worker
                .call(LocalRecordingManager::resume_recording)?
                .map_err(|err| Box::new(err) as _)
        }

        fn set_preferred_input_device(&self, name: Option<String>) {
            if let Err(error) = self
                .worker
                .call(move |recorder| recorder.set_preferred_input_device(name))
            {
                log::error!("Failed to set recording device: {error}");
            }
        }

        fn clear_device_cache(&self) {
            if let Err(error) = self.worker.call(LocalRecordingManager::clear_device_cache) {
                log::error!("Failed to clear recording device cache: {error}");
            }
        }

        fn is_recording(&self) -> bool {
            self.worker.failed.load(Ordering::SeqCst)
                || self.activity.is_recording()
                || capture_cleanup_uncertain()
        }

        fn current_sample_rate(&self) -> Option<u32> {
            if self.worker.failed.load(Ordering::SeqCst) {
                None
            } else {
                self.activity.sample_rate()
            }
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

    /// Opens an input stream on a specific device.
    ///
    /// # Errors
    ///
    /// Fails when the device has no readable default input config, its sample
    /// format is unsupported, or the stream cannot be built.
    fn try_start_on_device(
        device: &Device,
        device_name: Option<&str>,
        level_emitter: Option<Arc<LevelEmitter>>,
        chunk_emitter: Option<Arc<ChunkEmitter>>,
        retained: &mut Option<ActiveRecording>,
    ) -> Result<ActiveRecording, RecordingError> {
        let label = device_name.unwrap_or(UNKNOWN_DEVICE_LABEL);

        let config = device
            .default_input_config()
            .map_err(|err| RecordingError::StreamConfig(err.to_string()))?;

        let sample_format = config.sample_format();
        let stream_config: StreamConfig = config.into();
        let sample_rate = stream_config.sample_rate.0;
        let buffer = Arc::new(Mutex::new(Vec::<f32>::new()));
        let callback_gate = CallbackGate::new();
        let capture_failed = Arc::new(AtomicBool::new(false));

        let stream = match sample_format {
            SampleFormat::I16 => build_input_stream::<i16>(
                device,
                &stream_config,
                buffer.clone(),
                callback_gate.clone(),
                capture_failed.clone(),
                level_emitter.clone(),
                chunk_emitter.clone(),
            ),
            SampleFormat::U16 => build_input_stream::<u16>(
                device,
                &stream_config,
                buffer.clone(),
                callback_gate.clone(),
                capture_failed.clone(),
                level_emitter.clone(),
                chunk_emitter.clone(),
            ),
            SampleFormat::F32 => build_input_stream::<f32>(
                device,
                &stream_config,
                buffer.clone(),
                callback_gate.clone(),
                capture_failed.clone(),
                level_emitter.clone(),
                chunk_emitter.clone(),
            ),
            other => return Err(RecordingError::UnsupportedFormat(other)),
        };
        let stream = match stream {
            Ok(stream) => stream,
            Err(err) => {
                callback_gate.retire();
                return Err(err);
            }
        };

        let active = ActiveRecording {
            _stream: stream,
            start: Instant::now(),
            buffer,
            sample_rate,
            callback_gate,
            capture_failed,
            paused_for_release: false,
            _level_emitter: level_emitter,
            _chunk_emitter: chunk_emitter,
        };
        let active = start_candidate(
            retained,
            active,
            |active| {
                active
                    ._stream
                    .play()
                    .map_err(|err| RecordingError::StreamPlay(err.to_string()))?;
                activate_capture(
                    &active.callback_gate,
                    &active.buffer,
                    active._chunk_emitter.as_deref(),
                    &active.capture_failed,
                )
            },
            |active| {
                // A rejected candidate may have started the hardware, but its
                // pending samples do not belong to the eventual session.
                active.callback_gate.retire();
                active.capture_failed.store(true, Ordering::Release);
                let _ = take_captured_samples(&active.buffer, true);
            },
            ActiveRecording::pause_for_release,
        )?;
        log::info!("started on device '{label}'");
        Ok(active)
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
        retained: &mut Option<ActiveRecording>,
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
                retained,
            ) {
                Ok(active) => active,
                Err(err) => {
                    log::warn!("failed to start input device '{label}': {err}");
                    if retained.is_some()
                        || matches!(
                            err,
                            RecordingError::CaptureFailed | RecordingError::ReleaseUncertain(_)
                        )
                    {
                        return Err(err);
                    }
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

    fn convert_to_mono<T>(data: &[T], channel_count: usize) -> Vec<f32>
    where
        T: cpal::Sample,
        f32: cpal::FromSample<T>,
    {
        if channel_count == 1 {
            return data
                .iter()
                .map(|sample| (*sample).to_sample::<f32>())
                .collect();
        }
        let mut mono = Vec::with_capacity(data.len() / channel_count + 1);
        for frame in data.chunks(channel_count) {
            let sum: f32 = frame
                .iter()
                .map(|sample| (*sample).to_sample::<f32>())
                .sum();
            mono.push(sum / frame.len() as f32);
        }
        mono
    }

    fn build_input_stream<T>(
        device: &Device,
        config: &StreamConfig,
        buffer: Arc<Mutex<Vec<f32>>>,
        callback_gate: Arc<CallbackGate>,
        capture_failed: Arc<AtomicBool>,
        level_emitter: Option<Arc<LevelEmitter>>,
        chunk_emitter: Option<Arc<ChunkEmitter>>,
    ) -> Result<Stream, RecordingError>
    where
        T: cpal::Sample + cpal::SizedSample,
        f32: cpal::FromSample<T>,
    {
        let channel_count = cmp::max(config.channels as usize, 1);
        let callback_buffer = buffer.clone();
        let error_gate = callback_gate.clone();
        let callback_failed = capture_failed.clone();
        let level_emitter_ref = level_emitter;
        let chunk_emitter_ref = chunk_emitter;
        device
            .build_input_stream(
                config,
                move |data: &[T], _| {
                    callback_gate.with_capture(|active| {
                        if callback_failed.load(Ordering::Acquire) {
                            return;
                        }
                        let mut mono_samples = convert_to_mono(data, channel_count);

                        // Retain samples before emitting: a live chunk must
                        // never get ahead of the saved recording prefix.
                        if !retain_input_samples(
                            &callback_buffer,
                            &callback_failed,
                            &mut mono_samples,
                        ) {
                            return;
                        }

                        if active {
                            if let Some(ref level_emitter) = level_emitter_ref {
                                level_emitter.emit(&mono_samples);
                            }
                        }

                        if active {
                            if let Some(ref chunk_emitter) = chunk_emitter_ref {
                                chunk_emitter.emit(&mono_samples);
                            }
                        }
                    })
                },
                move |_err| {
                    error_gate.with_error(|| {
                        // Do not log from an audio backend callback: the log
                        // sink can block teardown. Stop reports this failure.
                        capture_failed.store(true, Ordering::Release);
                    })
                },
                None,
            )
            .map_err(|error| match error {
                cpal::BuildStreamError::CleanupUncertain { err } => {
                    RecordingError::ReleaseUncertain(err.to_string())
                }
                error => RecordingError::StreamBuild(error.to_string()),
            })
    }

    #[cfg(test)]
    mod tests {
        use super::{
            activate_capture, convert_to_mono, device_matches_preferred, disambiguated_label,
            finish_resume_capture, is_preferred_input_device_name, retain_input_samples,
            take_captured_samples, CallbackGate, ChunkEmitter,
        };
        use std::collections::HashSet;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Mutex};

        #[test]
        fn coreaudio_property_listeners_use_retirable_tokens() {
            // Registry lifetime tests run portably; macOS must still test the
            // actual CoreAudio registration and notification behavior.
            let listeners = include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../patches/coreaudio-rs-0.11.3/src/audio_unit/macos_listeners.rs"
            ));
            assert!(listeners.contains("listener_registry::insert"));
            assert!(listeners.contains("listener_registry::remove"));
            assert!(listeners.contains("catch_unwind"));
            assert!(!listeners.contains("self as *const _ as *mut _"));
            assert!(!listeners.contains("sender.send(rate).unwrap()"));
        }

        #[test]
        fn coreaudio_input_buffer_uses_owned_storage_through_teardown() {
            // This source contract complements the portable buffer tests; it
            // cannot exercise AudioUnitRender or callback teardown on macOS.
            let source = include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../patches/coreaudio-rs-0.11.3/src/audio_unit/render_callback.rs"
            ));
            let input = source
                .split_once("pub fn set_input_callback")
                .unwrap()
                .1
                .split_once("pub fn free_render_callback")
                .unwrap()
                .0;
            let teardown = source.split_once("pub fn free_input_callback").unwrap().1;
            assert!(input.contains("InputBuffer::new"));
            assert!(input.contains("data.resize(data_byte_size as usize)"));
            assert!(!input.contains("mem::forget"));
            assert!(!teardown.contains("Vec::from_raw_parts"));
        }

        #[test]
        fn alsa_input_overrun_reports_lost_audio() {
            let source = include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../patches/cpal-0.15.3/src/host/alsa/mod.rs"
            ));
            let input = source
                .split_once("fn input_stream_worker(")
                .unwrap()
                .1
                .split_once("fn output_stream_worker(")
                .unwrap()
                .0;
            assert!(input.contains("ALSA input overrun lost audio samples"));
            assert!(input.contains("input.recover(||"));
            assert!(input.contains(".prepare()"));
            assert!(input.contains("stream.channel().start()"));
        }

        #[test]
        fn macos_cpal_disconnect_listener_does_not_own_its_stream() {
            // This is a source contract, not a substitute for a macOS device test.
            let manifest = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml"));
            let patch_table = manifest.split("[patch.crates-io]").nth(1).unwrap();
            assert!(patch_table.contains("cpal = { path = \"../../../patches/cpal-0.15.3\" }"));
            let source = include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../patches/cpal-0.15.3/src/host/coreaudio/macos/mod.rs"
            ));
            let listener = source
                .split_once("fn add_disconnect_listener")
                .unwrap()
                .1
                .split_once("fn fail_input_build")
                .unwrap()
                .0;
            assert!(listener.contains("Arc::downgrade(&stream.inner)"));
            assert!(listener.contains("stream_inner_weak.upgrade()"));
            assert!(listener.contains("listener_gate.run(||"));
            assert!(
                listener.find("listener_gate.run(||").unwrap()
                    < listener.find("stream_inner_weak.upgrade()").unwrap()
            );
            assert!(!listener.contains("stream.clone()"));
            let inner = source
                .split_once("struct StreamInner {")
                .unwrap()
                .1
                .split_once("impl StreamInner {")
                .unwrap()
                .0;
            assert!(!inner.contains("disconnect_listener"));
            let stream = source
                .split_once("pub struct Stream {")
                .unwrap()
                .1
                .split_once("impl Stream {")
                .unwrap()
                .0;
            assert!(
                stream.contains("disconnect_listener: Arc<Option<AudioObjectPropertyListener>>")
            );
            assert!(stream.find("disconnect_listener:").unwrap() < stream.find("inner:").unwrap());
        }

        #[test]
        fn alsa_confirmed_close_releases_after_a_worker_panic() {
            // Source contract only: a panicking capture worker cannot be staged
            // against the ALSA null device, and this suite has no microphone.
            let source = include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../patches/cpal-0.15.3/src/host/alsa/mod.rs"
            ));
            let release = source
                .split_once("pub fn stop_input_for_release")
                .unwrap()
                .1
                .split_once("impl Drop for Stream")
                .unwrap()
                .0;
            // A confirmed close means the device is free, so neither the first
            // call nor a retry may report an error that makes the recorder hold
            // a handle it can never release.
            assert!(release.contains("InputCloseState::Closed => return Ok(())"));
            assert!(
                !release.contains("ALSA capture worker panicked"),
                "a panicked worker must not turn a confirmed release into an error"
            );
            // The panic still has to reach the recorder, as an incomplete
            // recording rather than as a retained device.
            assert!(source.contains("pub fn capture_worker_failed(&self) -> bool"));
        }

        #[test]
        fn alsa_worker_panic_marks_the_recording_incomplete() {
            let recorder = include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/platform/audio.rs"
            ));
            let release = recorder
                .split_once("fn pause_for_release(&mut self)")
                .unwrap()
                .1
                .split_once("impl Drop for ActiveRecording")
                .unwrap()
                .0;
            assert!(
                release.contains("if released && stream.capture_worker_failed()"),
                "the ALSA release path must ask whether the capture worker panicked"
            );
            assert!(
                release.contains("self.capture_failed.store(true, Ordering::Release);"),
                "a panicked capture worker must mark the recording incomplete"
            );
        }

        #[test]
        fn macos_cpal_returns_input_handle_before_attempting_start() {
            // This checks the vendored source contract, not a macOS runtime.
            let source = include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../patches/cpal-0.15.3/src/host/coreaudio/macos/mod.rs"
            ));
            let implementation = source.split_once("impl Device {").unwrap().1;
            let input = implementation
                .split_once("fn build_input_stream_raw")
                .unwrap()
                .1
                .split_once("fn build_output_stream_raw")
                .unwrap()
                .0;
            assert!(input.contains("playing: false"));
            assert!(input.contains("start_attempted: false"));
            assert!(!input.contains("audio_unit.start()"));
            let methods = source
                .split_once("impl StreamInner {")
                .unwrap()
                .1
                .split_once("/// Register the on-disconnect callback")
                .unwrap()
                .0;
            assert!(methods.contains("self.start_attempted = true;"));
            assert!(methods.contains("if self.playing || self.start_attempted"));
            assert!(methods.contains("self.start_attempted = false;"));
        }

        #[test]
        fn macos_input_close_drains_callbacks_before_native_teardown() {
            let manifest = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml"));
            let patch_table = manifest.split("[patch.crates-io]").nth(1).unwrap();
            assert!(patch_table
                .contains("coreaudio-rs = { path = \"../../../patches/coreaudio-rs-0.11.3\" }"));
            let source = include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../patches/cpal-0.15.3/src/host/coreaudio/macos/mod.rs"
            ));
            let close = source
                .split_once("pub fn close_paused_input")
                .unwrap()
                .1
                .split_once("impl StreamTrait for Stream")
                .unwrap()
                .0;
            assert!(
                close.find("callback\n            .retire()").unwrap()
                    < close.find("inner.audio_unit.close_stopped()").unwrap()
            );
            assert!(
                close.find("inner.close_attempted = true").unwrap()
                    < close.find("inner.audio_unit.close_stopped()").unwrap()
            );
            let recorder = include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/platform/audio.rs"
            ));
            let release = recorder
                .split_once("fn pause_for_release(&mut self)")
                .unwrap()
                .1
                .split_once("impl Drop for ActiveRecording")
                .unwrap()
                .0;
            assert!(
                release.find("stream.quiesce_input()").unwrap()
                    < release.find("pause_stream_with_retry").unwrap()
            );
            assert!(
                release.find("pause_stream_with_retry").unwrap()
                    < release.find("stream.close_paused_input()").unwrap()
            );
        }

        #[test]
        fn wasapi_cpal_joins_even_if_its_command_receiver_disconnected() {
            // This checks the vendored source contract, not a Windows runtime.
            let source = include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../patches/cpal-0.15.3/src/host/wasapi/stream.rs"
            ));
            let drop_impl = source
                .split_once("impl Drop for Stream {")
                .unwrap()
                .1
                .split_once("impl StreamTrait for Stream")
                .unwrap()
                .0;
            assert!(drop_impl.contains("let _ = self.push_command(Command::Terminate);"));
            assert!(drop_impl.contains("let worker = self.thread.take();"));
            assert!(drop_impl.contains("Foundation::CloseHandle(self.pending_scheduled_event)"));
            assert!(
                drop_impl.contains("let _ = worker.join();"),
                "the drop path must join the worker"
            );
            // A panic inside `drop` aborts the process when the drop runs
            // during an unwind, and both checked transitions already report a
            // dead worker, so the drop path must not unwrap.
            assert!(
                !drop_impl.contains(".unwrap()"),
                "the drop path must not unwrap a join or the thread slot"
            );
        }

        #[test]
        fn wasapi_pause_acknowledges_the_native_transition() {
            // Source contract only: the WASAPI backend needs Windows to compile
            // and to run, and neither is available to this suite.
            let source = include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../patches/cpal-0.15.3/src/host/wasapi/stream.rs"
            ));
            assert!(source.contains(
                "PlayStream(Sender<Result<(), BackendSpecificError>>),\n    PauseStream(Sender<Result<(), BackendSpecificError>>),"
            ));
            let request = source
                .split_once("fn request(")
                .unwrap()
                .1
                .split_once("impl Drop for Stream {")
                .unwrap()
                .0;
            assert!(request.contains("reply_rx.recv()"));
            // A caller must not publish a paused state before the worker stopped
            // the endpoint, so the trait methods wait for the acknowledgement.
            let trait_impl = source
                .split_once("impl StreamTrait for Stream {")
                .unwrap()
                .1
                .split_once("impl Drop for StreamInner {")
                .unwrap()
                .0;
            assert!(trait_impl.contains("self.request(Command::PlayStream)"));
            assert!(trait_impl.contains("self.pause_input_and_drain()"));

            let pause = source
                .split_once("fn pause_input(")
                .unwrap()
                .1
                .split_once("fn pause_output(")
                .unwrap()
                .0;
            let first_drain = pause.find("drain_capture").unwrap();
            let stop = pause.find("stream.audio_client.Stop()").unwrap();
            let second_drain = pause[stop..].find("drain_capture").unwrap() + stop;
            assert!(first_drain < stop);
            assert!(stop < second_drain);
            assert!(pause.contains("stream.playing = false;"));

            // A paused stream must not deliver packets that were captured
            // before the stop.
            let loop_body = source
                .split_once("fn run_input(")
                .unwrap()
                .1
                .split_once("fn run_output(")
                .unwrap()
                .0;
            assert!(loop_body.contains("if !run_ctxt.stream.playing {"));
        }

        #[test]
        fn wasapi_capture_releases_every_acquired_packet() {
            let source = include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../patches/cpal-0.15.3/src/host/wasapi/stream.rs"
            ));
            let packet = source
                .split_once("fn capture_next_packet(")
                .unwrap()
                .1
                .split_once("fn drain_capture(")
                .unwrap()
                .0;
            // A successful `GetBuffer` that reports no frames acquires nothing.
            assert!(
                packet.find("if frames_available == 0 {").unwrap()
                    < packet.find("Data::from_parts").unwrap()
            );
            // A silent packet holds undefined data, so the driver buffer must
            // not be handed to the callback.
            assert!(packet.contains("AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0"));
            assert!(packet.contains("SampleFormat::U8 => scratch.fill(128)"));
            // A failed timestamp must not leave the packet acquired.
            let timestamp_error = packet
                .split_once(
                    "Err(error) => {\n                let release = capture_client.ReleaseBuffer",
                )
                .expect("timestamp failure releases the packet");
            assert!(timestamp_error.1.contains("PacketFlow::Failed"));
            assert!(packet.contains("AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 == 0"));
        }

        #[test]
        fn windows_pause_drains_before_closing_the_publication_gate() {
            let source = include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/platform/audio.rs"
            ));
            let branch = source
                .split_once("#[cfg(target_os = \"windows\")]\n            {\n                #[allow(unreachable_patterns)]")
                .expect("windows pause branch")
                .1
                .split_once("#[cfg(not(any(target_os = \"linux\", target_os = \"windows\")))]")
                .expect("generic pause branch")
                .0;
            assert!(branch.contains("cpal::platform::StreamInner::Wasapi(stream)"));
            let drain = branch.find("stream.pause_input_and_drain()").unwrap();
            let gate = branch.find("callback_gate.pause()").unwrap();
            assert!(drain < gate);
            assert!(branch.contains("recording.callback_gate.retire();"));
        }

        #[test]
        fn failed_candidate_is_retired_and_reserved_until_release_succeeds() {
            use super::{release_or_retain, start_candidate};
            use std::sync::atomic::AtomicUsize;

            struct Candidate {
                retired: Arc<AtomicBool>,
                drops: Arc<AtomicUsize>,
            }
            impl Drop for Candidate {
                fn drop(&mut self) {
                    self.drops.fetch_add(1, Ordering::SeqCst);
                }
            }
            let retired = Arc::new(AtomicBool::new(false));
            let drops = Arc::new(AtomicUsize::new(0));
            let candidate = Candidate {
                retired: Arc::clone(&retired),
                drops: Arc::clone(&drops),
            };
            let mut retained = None;
            let failure = start_candidate(
                &mut retained,
                candidate,
                |_| Err::<(), _>("play failed"),
                |candidate| candidate.retired.store(true, Ordering::SeqCst),
                |candidate| {
                    assert!(candidate.retired.load(Ordering::SeqCst));
                    false
                },
            );
            assert!(matches!(failure, Err("play failed")));
            assert!(retained.is_some());
            assert_eq!(drops.load(Ordering::SeqCst), 0);
            let candidate = retained.take().unwrap();
            assert!(release_or_retain(&mut retained, candidate, |candidate| {
                assert!(candidate.retired.load(Ordering::SeqCst));
                true
            }));
            assert!(retained.is_none());
            assert_eq!(drops.load(Ordering::SeqCst), 1);
        }

        #[test]
        fn rejected_candidate_can_fall_back_after_confirmed_release() {
            use super::start_candidate;
            use std::sync::atomic::AtomicUsize;
            struct Candidate(Arc<AtomicUsize>);
            impl Drop for Candidate {
                fn drop(&mut self) {
                    self.0.fetch_add(1, Ordering::SeqCst);
                }
            }
            let drops = Arc::new(AtomicUsize::new(0));
            let mut retained = None;
            let failed = start_candidate(
                &mut retained,
                Candidate(Arc::clone(&drops)),
                |_| Err::<(), _>("activation failed"),
                |_| {},
                |_| true,
            );
            assert!(matches!(failed, Err("activation failed")));
            assert!(retained.is_none());
            assert_eq!(drops.load(Ordering::SeqCst), 1);
            let next = start_candidate(
                &mut retained,
                Candidate(Arc::clone(&drops)),
                |_| Ok::<(), &str>(()),
                |_| panic!("successful candidate was retired"),
                |_| panic!("successful candidate was paused"),
            );
            assert!(next.is_ok());
            assert_eq!(drops.load(Ordering::SeqCst), 1);
            drop(next);
            assert_eq!(drops.load(Ordering::SeqCst), 2);
        }

        #[test]
        fn a_failed_pause_keeps_the_stream_for_a_later_release_retry() {
            use super::{pause_stream_with_retry, release_or_retain};
            use std::sync::atomic::AtomicUsize;

            struct Stream(Arc<AtomicUsize>);
            impl Drop for Stream {
                fn drop(&mut self) {
                    self.0.fetch_add(1, Ordering::SeqCst);
                }
            }
            let drops = Arc::new(AtomicUsize::new(0));
            let mut slot = None;
            let mut attempts = 0;
            let paused = pause_stream_with_retry(|| -> Result<(), &'static str> {
                attempts += 1;
                Err("device unavailable")
            });
            assert!(!paused);
            assert_eq!(attempts, 2);
            assert!(!release_or_retain(
                &mut slot,
                Stream(Arc::clone(&drops)),
                |_| paused
            ));
            assert_eq!(drops.load(Ordering::SeqCst), 0);
            let stream = slot.take().unwrap();
            let mut attempts = 0;
            assert!(release_or_retain(&mut slot, stream, |_| {
                pause_stream_with_retry(|| -> Result<(), &'static str> {
                    attempts += 1;
                    if attempts == 1 {
                        Err("transient")
                    } else {
                        Ok(())
                    }
                })
            }));
            assert_eq!(attempts, 2);
            assert!(slot.is_none());
            assert_eq!(drops.load(Ordering::SeqCst), 1);
        }

        #[test]
        fn handoff_preserves_sealed_samples_but_reports_unreleased_or_failed_driver() {
            use super::{await_recording_handoff, ReleaseOutcome};
            use crate::domain::{RecordedAudio, RecordingMetrics, RecordingResult};
            use std::sync::mpsc;
            use std::time::Duration;
            let recording = || RecordingResult {
                metrics: RecordingMetrics {
                    duration: Duration::ZERO,
                    size_bytes: 8,
                },
                audio: RecordedAudio {
                    samples: vec![0.5, -0.25],
                    sample_rate: 16000,
                },
                capture_failed: false,
            };
            for mode in [
                "released",
                "late-capture-failure",
                "blocked",
                "pause-failed",
                "panicked",
            ] {
                let (result_tx, result_rx) = mpsc::channel();
                let (released_tx, released_rx) = mpsc::channel();
                result_tx.send(Ok(recording())).unwrap();
                let mut release = Some(released_tx);
                if matches!(mode, "released" | "late-capture-failure" | "pause-failed") {
                    release
                        .as_ref()
                        .unwrap()
                        .send(ReleaseOutcome {
                            released: mode != "pause-failed",
                            capture_failed: mode == "late-capture-failure",
                        })
                        .unwrap();
                }
                if mode == "panicked" {
                    drop(release.take());
                }
                let failed = AtomicBool::new(false);
                let result = await_recording_handoff(
                    result_rx,
                    released_rx,
                    &failed,
                    Duration::from_millis(1),
                )
                .unwrap();
                assert_eq!(result.audio.samples, vec![0.5, -0.25]);
                assert_eq!(result.audio.sample_rate, 16000);
                assert_eq!(result.capture_failed, mode != "released");
                assert_eq!(failed.load(Ordering::SeqCst), mode == "panicked");
                drop(release);
            }
        }

        #[test]
        fn non_finite_input_retains_only_the_finite_prefix_and_retires_capture() {
            for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
                let buffer = Mutex::new(Vec::new());
                let failed = AtomicBool::new(false);
                assert!(retain_input_samples(&buffer, &failed, &mut vec![0.25]));
                let mut second = vec![0.5, bad, -0.25];
                assert!(retain_input_samples(&buffer, &failed, &mut second));
                assert_eq!(second, vec![0.5]);
                assert!(failed.load(Ordering::Acquire));
                assert!(!retain_input_samples(&buffer, &failed, &mut vec![0.75]));
                assert_eq!(*buffer.lock().unwrap(), vec![0.25, 0.5]);
            }
        }

        #[test]
        fn invalid_or_overflowing_multichannel_frame_does_not_reach_capture() {
            for bad in [f32::NAN, f32::INFINITY, f32::MAX] {
                let other = if bad == f32::MAX { f32::MAX } else { 0.5 };
                let mut samples = convert_to_mono(&[0.25, 0.75, bad, other, 0.5, 0.5], 2);
                let buffer = Mutex::new(Vec::new());
                let failed = AtomicBool::new(false);
                assert!(retain_input_samples(&buffer, &failed, &mut samples));
                assert!(failed.load(Ordering::Acquire));
                assert_eq!(samples, vec![0.5]);
                assert_eq!(*buffer.lock().unwrap(), vec![0.5]);
            }
            assert_eq!(convert_to_mono(&[0.25f32, 0.75, 0.5], 2), vec![0.5, 0.5]);
        }

        #[test]
        fn non_finite_first_sample_and_poisoned_buffer_cannot_be_emitted() {
            let failed = AtomicBool::new(false);
            let buffer = Mutex::new(Vec::new());
            assert!(!retain_input_samples(
                &buffer,
                &failed,
                &mut vec![f32::NAN, 0.5]
            ));
            assert!(failed.load(Ordering::Acquire));
            assert!(buffer.lock().unwrap().is_empty());

            let buffer = Arc::new(Mutex::new(Vec::new()));
            let poisoned = Arc::clone(&buffer);
            let _ = std::thread::spawn(move || {
                let _guard = poisoned.lock().unwrap();
                panic!("simulate interrupted capture");
            })
            .join();
            let failed = AtomicBool::new(false);
            assert!(!retain_input_samples(&buffer, &failed, &mut vec![0.5]));
            assert!(failed.load(Ordering::Acquire));
        }

        #[test]
        fn unexpected_non_finite_buffer_is_always_marked_incomplete() {
            let buffer = Mutex::new(vec![0.25, f32::NAN, 0.5]);
            let (samples, incomplete) = take_captured_samples(&buffer, false);
            assert!(incomplete);
            assert_eq!(samples, vec![0.25, 0.0, 0.5]);
        }

        #[test]
        fn failed_or_poisoned_capture_retains_only_a_marked_finite_prefix() {
            let buffer = Mutex::new(vec![0.5, f32::NAN, -0.25]);
            let (samples, failed) = take_captured_samples(&buffer, true);
            assert!(failed);
            assert_eq!(samples, vec![0.5, 0.0, -0.25]);
            assert!(buffer.lock().unwrap().is_empty());

            let poisoned = Arc::new(Mutex::new(vec![0.25, f32::INFINITY]));
            let other = poisoned.clone();
            let _ = std::thread::spawn(move || {
                let _guard = other.lock().unwrap();
                panic!("simulated callback panic");
            })
            .join();
            let (samples, failed) = take_captured_samples(&poisoned, false);
            assert!(failed);
            assert_eq!(samples, vec![0.25, 0.0]);
            assert!(poisoned.lock().unwrap_err().into_inner().is_empty());
        }

        #[test]
        fn callback_gate_waits_for_inflight_work_and_rejects_late_callbacks() {
            use std::sync::mpsc;
            use std::thread;
            use std::time::Duration;

            let gate = CallbackGate::new();
            assert!(gate.activate(|| true));
            let samples = Arc::new(Mutex::new(Vec::new()));
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let callback = {
                let gate = gate.clone();
                let samples = samples.clone();
                thread::spawn(move || {
                    gate.with_capture(|_| {
                        entered_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        samples.lock().unwrap().push(1);
                    })
                })
            };
            entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            let (retired_tx, retired_rx) = mpsc::channel();
            let retirement = {
                let gate = gate.clone();
                thread::spawn(move || {
                    gate.retire();
                    retired_tx.send(()).unwrap();
                })
            };
            assert!(retired_rx.recv_timeout(Duration::from_millis(50)).is_err());
            release_tx.send(()).unwrap();
            callback.join().unwrap();
            retired_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            retirement.join().unwrap();
            gate.with_capture(|_| samples.lock().unwrap().push(2));
            assert_eq!(*samples.lock().unwrap(), vec![1]);
        }

        #[test]
        fn pause_drains_callbacks_suppresses_samples_and_preserves_errors() {
            use std::sync::atomic::AtomicUsize;
            use std::sync::mpsc;
            use std::thread;
            use std::time::Duration;

            let gate = CallbackGate::new();
            assert!(gate.activate(|| true));
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let worker_gate = Arc::clone(&gate);
            let worker = thread::spawn(move || {
                worker_gate.with_capture(|_| {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                })
            });
            entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            let (paused_tx, paused_rx) = mpsc::channel();
            let pause_gate = Arc::clone(&gate);
            let pause = thread::spawn(move || paused_tx.send(pause_gate.pause()).unwrap());
            assert!(paused_rx.recv_timeout(Duration::from_millis(30)).is_err());
            release_tx.send(()).unwrap();
            worker.join().unwrap();
            assert!(paused_rx.recv_timeout(Duration::from_secs(1)).unwrap());
            pause.join().unwrap();
            let calls = AtomicUsize::new(0);
            gate.with_capture(|_| {
                calls.fetch_add(1, Ordering::SeqCst);
            });
            gate.with_error(|| {
                calls.fetch_add(10, Ordering::SeqCst);
            });
            assert_eq!(calls.load(Ordering::SeqCst), 10);
            assert!(gate.begin_resume());
            gate.with_capture(|active| {
                assert!(!active);
                calls.fetch_add(1, Ordering::SeqCst);
            });
            assert!(gate.finish_resume(|| true));
            gate.with_capture(|active| {
                assert!(active);
                calls.fetch_add(1, Ordering::SeqCst);
            });
            gate.retire();
            assert!(!gate.begin_resume());
            gate.with_error(|| {
                calls.fetch_add(100, Ordering::SeqCst);
            });
            assert_eq!(calls.load(Ordering::SeqCst), 12);
        }

        #[test]
        fn resume_stages_audio_until_confirmation_without_duplicating_the_prefix() {
            let gate = CallbackGate::new();
            let buffer = Mutex::new(vec![1.0]);
            let failed = AtomicBool::new(false);
            let events = Arc::new(Mutex::new(Vec::new()));
            let output = Arc::clone(&events);
            let emitter = ChunkEmitter::new(Arc::new(move |samples, offset| {
                output.lock().unwrap().push((samples, offset));
            }));
            activate_capture(&gate, &buffer, Some(&emitter), &failed).unwrap();
            assert!(gate.pause());
            assert!(gate.begin_resume());
            gate.with_capture(|active| {
                assert!(!active);
                buffer.lock().unwrap().push(2.0);
            });
            assert_eq!(*events.lock().unwrap(), vec![(vec![1.0], 0)]);
            assert!(finish_resume_capture(
                &gate,
                &buffer,
                Some(&emitter),
                &failed,
                1
            ));
            gate.with_capture(|active| {
                assert!(active);
                buffer.lock().unwrap().push(3.0);
                emitter.emit(&[3.0]);
            });
            emitter.flush();
            let events = events.lock().unwrap();
            let mut combined = Vec::new();
            for (samples, offset) in events.iter() {
                assert_eq!(*offset, combined.len() as u64);
                combined.extend_from_slice(samples);
            }
            assert_eq!(combined, vec![1.0, 2.0, 3.0]);
        }

        #[test]
        fn blocked_driver_pause_cannot_accept_late_audio() {
            use std::sync::mpsc;
            use std::thread;
            use std::time::Duration;

            let gate = CallbackGate::new();
            assert!(gate.activate(|| true));
            let samples = Arc::new(Mutex::new(Vec::new()));
            gate.with_capture(|_| samples.lock().unwrap().push(1));
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let shutdown = {
                let gate = gate.clone();
                thread::spawn(move || {
                    gate.retire();
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                })
            };
            entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            gate.with_capture(|_| samples.lock().unwrap().push(2));
            assert_eq!(*samples.lock().unwrap(), vec![1]);
            release_tx.send(()).unwrap();
            shutdown.join().unwrap();
        }

        #[test]
        fn pending_candidate_audio_is_published_only_after_success_in_order() {
            let events = Arc::new(Mutex::new(Vec::<(Vec<f32>, u64)>::new()));
            let emitter = {
                let events = events.clone();
                ChunkEmitter::new(Arc::new(move |samples, offset| {
                    events.lock().unwrap().push((samples, offset));
                }))
            };
            let failed = CallbackGate::new();
            let failed_buffer = Mutex::new(Vec::new());
            failed.with_capture(|active| {
                assert!(!active);
                failed_buffer.lock().unwrap().extend_from_slice(&[9.0]);
            });
            failed.retire();
            assert!(activate_capture(
                &failed,
                &failed_buffer,
                Some(&emitter),
                &std::sync::atomic::AtomicBool::new(false)
            )
            .is_err());
            assert!(events.lock().unwrap().is_empty());

            let selected = CallbackGate::new();
            let buffer = Mutex::new(Vec::new());
            selected.with_capture(|active| {
                assert!(!active);
                buffer.lock().unwrap().extend_from_slice(&[1.0, 2.0]);
            });
            activate_capture(
                &selected,
                &buffer,
                Some(&emitter),
                &std::sync::atomic::AtomicBool::new(false),
            )
            .unwrap();
            selected.with_capture(|active| {
                assert!(active);
                buffer.lock().unwrap().push(3.0);
                emitter.emit(&[3.0]);
            });
            selected.retire();
            emitter.flush();
            let events = events.lock().unwrap();
            let mut offset = 0;
            let mut samples = Vec::new();
            for (chunk, chunk_offset) in events.iter() {
                assert_eq!(*chunk_offset, offset);
                offset += chunk.len() as u64;
                samples.extend_from_slice(chunk);
            }
            assert_eq!(samples, *buffer.lock().unwrap());
            assert_eq!(samples, vec![1.0, 2.0, 3.0]);
        }

        #[test]
        fn failed_pending_stream_does_not_publish_its_prefix() {
            use std::sync::atomic::AtomicBool;
            let gate = CallbackGate::new();
            let buffer = Mutex::new(vec![1.0]);
            let emitted = Arc::new(Mutex::new(Vec::new()));
            let emitter = {
                let emitted = emitted.clone();
                ChunkEmitter::new(Arc::new(move |chunk, _| {
                    emitted.lock().unwrap().extend(chunk)
                }))
            };
            assert!(
                activate_capture(&gate, &buffer, Some(&emitter), &AtomicBool::new(true)).is_err()
            );
            gate.retire();
            assert!(emitted.lock().unwrap().is_empty());
        }

        #[test]
        fn poisoned_callback_gate_rejects_later_callbacks() {
            let gate = CallbackGate::new();
            let poisoned = gate.clone();
            assert!(std::thread::spawn(move || {
                poisoned.with_capture(|_| panic!("simulated callback failure"));
            })
            .join()
            .is_err());
            gate.retire();
            assert!(gate.0.is_poisoned());
            gate.with_capture(|_| panic!("poisoned callback gate reopened"));
        }

        #[test]
        fn thread_bound_worker_keeps_non_send_state_on_one_thread() {
            use super::ThreadBoundWorker;
            use std::cell::Cell;
            use std::rc::Rc;
            use std::sync::mpsc;
            use std::thread;
            use std::time::Duration;

            struct Resource {
                count: Rc<Cell<usize>>,
                owner: thread::ThreadId,
                dropped: mpsc::Sender<thread::ThreadId>,
            }
            impl Drop for Resource {
                fn drop(&mut self) {
                    let _ = self.dropped.send(thread::current().id());
                }
            }
            let (dropped_tx, dropped_rx) = mpsc::channel();
            let worker = Arc::new(ThreadBoundWorker::new(move || Resource {
                count: Rc::new(Cell::new(0)),
                owner: thread::current().id(),
                dropped: dropped_tx,
            }));
            let owner = worker.call(|resource| resource.owner).unwrap();
            let mut callers = Vec::new();
            for _ in 0..8 {
                let worker = Arc::clone(&worker);
                callers.push(thread::spawn(move || {
                    for _ in 0..25 {
                        worker
                            .call(|resource| {
                                assert_eq!(thread::current().id(), resource.owner);
                                resource.count.set(resource.count.get() + 1);
                            })
                            .unwrap();
                    }
                }));
            }
            for caller in callers {
                caller.join().unwrap();
            }
            assert_eq!(worker.call(|resource| resource.count.get()).unwrap(), 200);
            drop(worker);
            assert_eq!(
                dropped_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
                owner
            );
        }

        #[test]
        fn thread_bound_worker_bounds_pending_tasks() {
            use super::{ThreadBoundWorker, WorkerTask};
            use std::sync::mpsc::{self, TrySendError};
            use std::time::Duration;

            let worker = ThreadBoundWorker::new(|| ());
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            worker
                .sender
                .as_ref()
                .unwrap()
                .send(Box::new(move |_| {
                    entered_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                }))
                .unwrap();
            entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            worker
                .sender
                .as_ref()
                .unwrap()
                .try_send(Box::new(|_| ()))
                .unwrap();
            let extra: WorkerTask<()> = Box::new(|_| ());
            assert!(matches!(
                worker.sender.as_ref().unwrap().try_send(extra),
                Err(TrySendError::Full(_))
            ));
            release_tx.send(()).unwrap();
            worker.call(|_| ()).unwrap();
        }

        #[test]
        fn capture_status_does_not_wait_for_a_stalled_worker() {
            use super::RecordingManager;
            use crate::platform::Recorder;
            use std::sync::mpsc;
            use std::time::Duration;

            let manager = Arc::new(RecordingManager::new());
            manager.activity.opening();
            assert!(manager.is_recording());
            assert_eq!(manager.current_sample_rate(), None);
            manager.activity.started(Some(48_000));
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            manager
                .worker
                .sender
                .as_ref()
                .unwrap()
                .send(Box::new(move |_| {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                }))
                .unwrap();
            entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            let (status_tx, status_rx) = mpsc::channel();
            let observed = Arc::clone(&manager);
            let observer = std::thread::spawn(move || {
                status_tx
                    .send((observed.is_recording(), observed.current_sample_rate()))
                    .unwrap();
            });
            let status = status_rx.recv_timeout(Duration::from_millis(500));
            release_tx.send(()).unwrap();
            observer.join().unwrap();
            assert_eq!(status.unwrap(), (true, Some(48_000)));
            manager.worker.call(|_| ()).unwrap();
            manager.activity.released();
            assert!(!manager.is_recording());
            assert_eq!(manager.current_sample_rate(), None);
        }

        #[test]
        fn a_failed_worker_cannot_claim_capture_is_inactive() {
            use super::RecordingManager;
            use crate::platform::Recorder;

            let manager = RecordingManager::new();
            assert!(manager
                .worker
                .call::<()>(|_| panic!("worker failure"))
                .is_err());
            assert!(manager.is_recording());
            assert!(manager.stop().is_err());
            assert!(manager.start(None, None).is_err());
        }

        #[test]
        fn a_worker_that_never_started_cannot_own_capture() {
            use super::{RecordingManager, ThreadBoundWorker};
            use crate::platform::Recorder;

            let manager = RecordingManager {
                worker: ThreadBoundWorker {
                    sender: None,
                    failed: Arc::new(AtomicBool::new(false)),
                },
                activity: Arc::default(),
            };
            assert!(!manager.is_recording());
            assert!(manager.start(None, None).is_err());
            assert!(manager.stop().is_err());
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires an isolated ALSA null capture device"]
        fn cpal_worker_captures_and_hands_off_on_an_alsa_null_device() {
            use super::RecordingManager;
            use crate::platform::Recorder;
            use std::sync::mpsc;
            use std::thread;
            use std::time::Duration;

            let manager = Arc::new(RecordingManager::new());
            for iteration in 0..2 {
                let (captured_tx, captured_rx) = mpsc::sync_channel(1);
                let chunks = Arc::new(Mutex::new(Vec::<(Vec<f32>, u64)>::new()));
                let observed = Arc::clone(&chunks);
                let start_manager = Arc::clone(&manager);
                thread::spawn(move || {
                    start_manager
                        .start(
                            Some(Arc::new(move |_| {
                                let _ = captured_tx.try_send(());
                                thread::sleep(Duration::from_millis(1));
                            })),
                            Some(Arc::new(move |samples, offset| {
                                observed.lock().unwrap().push((samples, offset));
                            })),
                        )
                        .map_err(|error| error.to_string())
                })
                .join()
                .unwrap()
                .unwrap();
                captured_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                assert!(manager.is_recording());
                let original_rate = manager.current_sample_rate().unwrap();
                let duplicate_start = manager.start(None, None).unwrap_err();
                assert!(matches!(
                    duplicate_start.downcast_ref::<crate::errors::RecordingError>(),
                    Some(crate::errors::RecordingError::AlreadyRecording)
                ));
                assert!(manager.is_recording());
                assert_eq!(manager.current_sample_rate(), Some(original_rate));
                let pause_manager = Arc::clone(&manager);
                thread::spawn(move || pause_manager.pause().map_err(|error| error.to_string()))
                    .join()
                    .unwrap()
                    .unwrap();
                let resume_manager = Arc::clone(&manager);
                thread::spawn(move || resume_manager.resume().map_err(|error| error.to_string()))
                    .join()
                    .unwrap()
                    .unwrap();
                let stop_manager = Arc::clone(&manager);
                let result = thread::spawn(move || {
                    if iteration == 0 {
                        stop_manager.stop()
                    } else {
                        stop_manager.stop_for_handoff()
                    }
                    .map_err(|error| error.to_string())
                })
                .join()
                .unwrap()
                .unwrap();
                assert!(!manager.is_recording());
                let duplicate_stop = manager.stop().unwrap_err();
                assert!(matches!(
                    duplicate_stop.downcast_ref::<crate::errors::RecordingError>(),
                    Some(crate::errors::RecordingError::NotRecording)
                ));
                assert!(!result.capture_failed);
                assert!(result.audio.sample_rate > 0);
                assert!(!result.audio.samples.is_empty());
                let chunks = chunks.lock().unwrap();
                let mut combined = Vec::new();
                for (samples, offset) in chunks.iter() {
                    assert_eq!(*offset, combined.len() as u64);
                    combined.extend_from_slice(samples);
                }
                assert_eq!(combined, result.audio.samples);
            }
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires an isolated ALSA null capture device"]
        fn cpal_alsa_pause_suppresses_samples_until_resume() {
            use super::LocalRecordingManager;
            use std::time::Duration;
            let manager = LocalRecordingManager::new();
            manager.start_recording(None, None).unwrap();
            let buffer = Arc::clone(&manager.guard().unwrap().as_ref().unwrap().buffer);
            std::thread::sleep(Duration::from_millis(10));
            manager.pause_recording().unwrap();
            let paused_len = buffer.lock().unwrap().len();
            assert!(paused_len > 0);
            std::thread::sleep(Duration::from_millis(20));
            assert_eq!(buffer.lock().unwrap().len(), paused_len);
            manager.resume_recording().unwrap();
            std::thread::sleep(Duration::from_millis(10));
            assert!(buffer.lock().unwrap().len() > paused_len);
            let (result, released) = manager.stop_recording();
            assert!(released);
            assert!(!result.unwrap().capture_failed);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the delayed-callback preload"]
        fn cpal_alsa_pause_drains_a_read_before_its_callback() {
            use super::RecordingManager;
            use crate::platform::Recorder;
            use std::sync::mpsc;
            use std::time::{Duration, Instant};

            let symbol = |name: &std::ffi::CStr| {
                let pointer = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
                assert!(!pointer.is_null(), "delayed callback preload required");
                pointer
            };
            let arm: unsafe extern "C" fn() =
                unsafe { std::mem::transmute(symbol(c"maus_test_arm_delayed_callback")) };
            let entered: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(symbol(c"maus_test_delayed_callback_entered")) };
            let release: unsafe extern "C" fn() =
                unsafe { std::mem::transmute(symbol(c"maus_test_release_delayed_callback")) };
            let manager = Arc::new(RecordingManager::new());
            manager.start(None, None).unwrap();
            unsafe { arm() };
            let deadline = Instant::now() + Duration::from_secs(2);
            while unsafe { entered() } == 0 && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(1));
            }
            if unsafe { entered() } == 0 {
                unsafe { release() };
                panic!("capture did not reach the delayed callback");
            }

            let (done_tx, done_rx) = mpsc::channel();
            let (started_tx, started_rx) = mpsc::channel();
            let worker = {
                let manager = Arc::clone(&manager);
                std::thread::spawn(move || {
                    started_tx.send(()).unwrap();
                    let result = manager.pause().map_err(|error| error.to_string());
                    done_tx.send(result).unwrap();
                })
            };
            if started_rx.recv_timeout(Duration::from_secs(2)).is_err() {
                unsafe { release() };
                panic!("pause worker did not start");
            }
            let early = done_rx.recv_timeout(Duration::from_millis(100));
            unsafe { release() };
            let result = match early {
                Ok(result) => Some(result),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(error) => panic!("pause worker exited: {error}"),
            };
            assert!(result.is_none(), "pause completed before delivery drained");
            done_rx
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap();
            worker.join().unwrap();
            manager.resume().unwrap();
            let result = manager.stop().unwrap();
            assert!(!result.capture_failed);
            assert!(!result.audio.samples.is_empty());
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the stale-poll preload"]
        fn cpal_alsa_stale_poll_xrun_does_not_restart_after_resume() {
            use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
            use std::sync::mpsc;
            use std::time::{Duration, Instant};

            let symbol = |name: &std::ffi::CStr| {
                let pointer = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
                assert!(!pointer.is_null(), "stale poll preload required");
                pointer
            };
            let arm: unsafe extern "C" fn() =
                unsafe { std::mem::transmute(symbol(c"maus_test_arm_stale_poll")) };
            let entered: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(symbol(c"maus_test_stale_poll_entered")) };
            let release: unsafe extern "C" fn() =
                unsafe { std::mem::transmute(symbol(c"maus_test_release_stale_poll")) };
            let preparations: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(symbol(c"maus_test_stale_poll_preparations")) };
            let starts: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(symbol(c"maus_test_stale_poll_starts")) };
            let device = cpal::default_host().default_input_device().unwrap();
            let supported = device.default_input_config().unwrap();
            let format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();
            let (error_tx, error_rx) = mpsc::channel();
            let (data_tx, data_rx) = mpsc::sync_channel(1);
            let reported = Arc::new(AtomicBool::new(false));
            let mut stream = device
                .build_input_stream_raw(
                    &config,
                    format,
                    {
                        let reported = Arc::clone(&reported);
                        move |_, _| {
                            if reported.load(Ordering::Acquire) {
                                let _ = data_tx.try_send(());
                            }
                        }
                    },
                    move |error| {
                        reported.store(true, Ordering::Release);
                        let _ = error_tx.send(error.to_string());
                    },
                    None,
                )
                .unwrap();
            stream.play().unwrap();
            unsafe { arm() };
            let deadline = Instant::now() + Duration::from_secs(2);
            while unsafe { entered() } == 0 && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(1));
            }
            if unsafe { entered() } == 0 {
                unsafe { release() };
                panic!("capture did not reach the delayed poll");
            }
            // A blocking poll is not an admitted cycle. Pause must not wait for
            // it, and its old result must not recover the resumed stream.
            #[allow(unreachable_patterns)]
            let pause = match stream.as_inner() {
                cpal::platform::StreamInner::Alsa(stream) => stream.pause_input_and_drain(),
                _ => panic!("ALSA stream required"),
            };
            let resume = stream.play();
            unsafe { release() };
            pause.unwrap();
            resume.unwrap();
            let error = error_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            assert!(error.contains("overrun lost audio samples"));
            // Wait for a subsequent read. Recovery, if mistakenly attempted,
            // runs after reporting the error and before that next callback.
            data_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            assert_eq!(unsafe { preparations() }, 0);
            assert_eq!(unsafe { starts() }, 0);
            #[allow(unreachable_patterns)]
            match stream.as_inner_mut() {
                cpal::platform::StreamInner::Alsa(stream) => {
                    stream.stop_input_for_release().unwrap()
                }
                _ => panic!("ALSA stream required"),
            }
        }

        #[cfg(target_os = "linux")]
        fn exercise_alsa_pause_fault(mode: libc::c_int) {
            use super::LocalRecordingManager;
            use std::time::Duration;
            let arm =
                unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"maus_test_arm_alsa_pause".as_ptr()) };
            let calls =
                unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"maus_test_alsa_pause_calls".as_ptr()) };
            assert!(
                !arm.is_null() && !calls.is_null(),
                "pause-failure preload required"
            );
            let arm: unsafe extern "C" fn(libc::c_int) = unsafe { std::mem::transmute(arm) };
            let calls: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(calls) };
            unsafe { arm(mode) };
            let manager = LocalRecordingManager::new();
            manager.start_recording(None, None).unwrap();
            let buffer = Arc::clone(&manager.guard().unwrap().as_ref().unwrap().buffer);
            std::thread::sleep(Duration::from_millis(10));
            if mode == 3 {
                manager.pause_recording().unwrap();
                assert!(manager.resume_recording().is_err());
            } else {
                assert!(manager.pause_recording().is_err());
            }
            let count = buffer.lock().unwrap().len();
            std::thread::sleep(Duration::from_millis(10));
            let after = buffer.lock().unwrap().len();
            if mode == 1 {
                assert_eq!(unsafe { calls() }, 0);
                assert!(
                    after > count,
                    "unsupported pause must leave capture running"
                );
            } else {
                assert_eq!(
                    after, count,
                    "failed transition must retire capture callbacks"
                );
                assert!(manager.resume_recording().is_err());
            }
            let (result, released) = manager.stop_recording();
            assert!(released);
            assert_eq!(result.unwrap().capture_failed, mode != 1);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only pause-failure preload"]
        fn cpal_alsa_unsupported_pause_keeps_recording() {
            exercise_alsa_pause_fault(1);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only pause-failure preload"]
        fn cpal_alsa_failed_pause_marks_partial_capture() {
            exercise_alsa_pause_fault(2);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only pause-failure preload"]
        fn cpal_alsa_failed_resume_marks_partial_capture() {
            exercise_alsa_pause_fault(3);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires an isolated ALSA null capture device"]
        fn cpal_alsa_input_waits_for_play_and_can_be_dropped_unstarted() {
            use cpal::traits::{DeviceTrait, HostTrait};
            use std::sync::mpsc;
            use std::time::Duration;

            let device = cpal::default_host().default_input_device().unwrap();
            let supported = device.default_input_config().unwrap();
            let format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();
            let (tx, rx) = mpsc::channel();
            let errors = tx.clone();
            let stream = device
                .build_input_stream_raw(
                    &config,
                    format,
                    move |_, _| {
                        let _ = tx.send(());
                    },
                    move |_| {
                        let _ = errors.send(());
                    },
                    None,
                )
                .unwrap();
            assert!(matches!(
                rx.recv_timeout(Duration::from_millis(100)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ));
            drop(stream);
            assert!(rx.try_recv().is_err());
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only start-failure preload"]
        fn cpal_alsa_failed_start_retains_an_uncertain_active_device() {
            use super::RecordingManager;
            use crate::platform::Recorder;

            let arm = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_arm_alsa_start_failure".as_ptr(),
                )
            };
            let starts = unsafe {
                libc::dlsym(libc::RTLD_DEFAULT, c"maus_test_alsa_failed_starts".as_ptr())
            };
            let stops = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_alsa_failed_start_stops".as_ptr(),
                )
            };
            assert!(
                !arm.is_null() && !starts.is_null() && !stops.is_null(),
                "start-failure preload required"
            );
            let arm: unsafe extern "C" fn() = unsafe { std::mem::transmute(arm) };
            let starts: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(starts) };
            let stops: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(stops) };
            let manager = RecordingManager::new();
            unsafe { arm() };
            assert!(manager.start(None, None).is_err());
            assert_eq!(unsafe { starts() }, 1);
            assert_eq!(unsafe { stops() }, 2);
            assert!(manager.is_recording());
            assert!(manager.start(None, None).is_err());
            manager.stop().unwrap();
            assert!(!manager.is_recording());
            manager.start(None, None).unwrap();
            manager.stop().unwrap();
        }

        #[cfg(target_os = "linux")]
        unsafe fn alsa_probe_symbol(name: &std::ffi::CStr) -> *mut libc::c_void {
            let pointer = libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr());
            assert!(!pointer.is_null(), "ALSA fault-injection preload required");
            pointer
        }

        #[cfg(target_os = "linux")]
        fn exercise_alsa_probe_close_failure(active: bool) {
            use super::RecordingManager;
            use crate::platform::Recorder;
            use cpal::traits::{DeviceTrait, HostTrait};

            let arm: unsafe extern "C" fn() = unsafe {
                std::mem::transmute(alsa_probe_symbol(c"maus_test_arm_alsa_probe_close_failure"))
            };
            let closes: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(alsa_probe_symbol(c"maus_test_alsa_probe_closes")) };
            let opens: unsafe extern "C" fn() -> libc::c_int = unsafe {
                std::mem::transmute(alsa_probe_symbol(
                    c"maus_test_alsa_opens_after_probe_failure",
                ))
            };
            let capture_opens: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(alsa_probe_symbol(c"maus_test_alsa_capture_opens")) };
            // Read the configuration before starting, because a live recording
            // now refuses capability probes.
            let device = cpal::default_host().default_input_device().unwrap();
            let supported = device.default_input_config().unwrap();
            let format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();
            let manager = RecordingManager::new();
            if active {
                manager.start(None, None).unwrap();
            }
            unsafe { arm() };
            if active {
                // Discovery while a stream owns the device must refuse to probe
                // rather than open a second handle, so a failing probe close
                // cannot poison admission during a recording.
                assert!(device.default_input_config().is_err());
                assert_eq!(unsafe { closes() }, 0);
                assert_eq!(unsafe { capture_opens() }, 0);
                assert!(!cpal::alsa_capture_cleanup_uncertain());
                let listing = super::list_input_devices();
                assert!(!listing.is_empty());
                std::thread::sleep(std::time::Duration::from_millis(20));
                let recording = manager.stop_for_handoff().unwrap();
                assert!(!recording.capture_failed);
                // With the stream released, the armed probe runs and latches the
                // uncertainty that keeps later capture from being admitted.
                assert!(device.default_input_config().is_err());
            } else {
                assert!(device.default_input_config().is_err());
            }
            assert_eq!(unsafe { closes() }, 1);
            assert!(cpal::alsa_capture_cleanup_uncertain());
            assert!(manager.is_recording());
            if !active {
                assert!(manager.stop().is_err());
            }
            assert!(manager.is_recording());
            assert!(manager.start(None, None).is_err());
            let other = RecordingManager::new();
            assert!(other.is_recording());
            assert!(other.start(None, None).is_err());
            assert!(matches!(
                device.build_input_stream_raw(&config, format, |_, _| {}, |_| {}, None),
                Err(cpal::BuildStreamError::CleanupUncertain { .. })
            ));
            assert_eq!(unsafe { opens() }, 0);
            assert_eq!(unsafe { closes() }, 1);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires isolated ALSA null and the test-only probe-close preload"]
        fn cpal_alsa_capture_build_waits_for_probe_close() {
            use cpal::traits::{DeviceTrait, HostTrait};
            use std::sync::mpsc;
            use std::time::{Duration, Instant};

            let hold: unsafe extern "C" fn() = unsafe {
                std::mem::transmute(alsa_probe_symbol(c"maus_test_hold_alsa_probe_close"))
            };
            let release: unsafe extern "C" fn() = unsafe {
                std::mem::transmute(alsa_probe_symbol(c"maus_test_release_alsa_probe_close"))
            };
            let closing: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(alsa_probe_symbol(c"maus_test_alsa_probe_closing")) };
            let opens: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(alsa_probe_symbol(c"maus_test_alsa_capture_opens")) };
            struct Release(unsafe extern "C" fn());
            impl Drop for Release {
                fn drop(&mut self) {
                    unsafe { (self.0)() }
                }
            }

            let device = cpal::default_host().default_input_device().unwrap();
            let supported = device.default_input_config().unwrap();
            let format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();
            unsafe { hold() };
            let release_on_drop = Release(release);
            let probe = device.clone();
            let probe_thread = std::thread::spawn(move || probe.default_input_config());
            let deadline = Instant::now() + Duration::from_secs(2);
            while unsafe { closing() } == 0 {
                assert!(Instant::now() < deadline, "probe did not reach close");
                std::thread::sleep(Duration::from_millis(1));
            }
            let (attempt_tx, attempt_rx) = mpsc::channel();
            let (done_tx, done_rx) = mpsc::channel();
            let build_thread = std::thread::spawn(move || {
                attempt_tx.send(()).unwrap();
                let result =
                    device.build_input_stream_raw(&config, format, |_, _| {}, |_| {}, None);
                let success = result
                    .map(|mut stream| {
                        #[allow(unreachable_patterns)]
                        match stream.as_inner_mut() {
                            cpal::platform::StreamInner::Alsa(inner) => {
                                inner.stop_input_for_release().unwrap()
                            }
                            _ => panic!("expected ALSA stream"),
                        }
                    })
                    .is_ok();
                done_tx.send(success).unwrap();
            });
            attempt_rx.recv().unwrap();
            assert!(done_rx.recv_timeout(Duration::from_millis(100)).is_err());
            assert_eq!(unsafe { opens() }, 1);
            drop(release_on_drop);
            assert!(probe_thread.join().unwrap().is_ok());
            assert!(done_rx.recv_timeout(Duration::from_secs(2)).unwrap());
            build_thread.join().unwrap();
            assert_eq!(unsafe { opens() }, 2);
            assert!(!cpal::alsa_capture_cleanup_uncertain());
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires isolated ALSA null and the test-only probe-close preload"]
        fn cpal_alsa_uncertain_probe_blocks_successor_capture() {
            exercise_alsa_probe_close_failure(false);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires isolated ALSA null and the test-only probe-close preload"]
        fn cpal_alsa_discovery_during_recording_leaves_capture_running() {
            exercise_alsa_probe_close_failure(true);
        }

        #[cfg(target_os = "linux")]
        fn exercise_alsa_uncertain_open(probe: bool) {
            use super::RecordingManager;
            use crate::platform::Recorder;
            use cpal::traits::{DeviceTrait, HostTrait};

            let arm: unsafe extern "C" fn() = unsafe {
                std::mem::transmute(alsa_probe_symbol(c"maus_test_arm_alsa_open_failure"))
            };
            let opens: unsafe extern "C" fn() -> libc::c_int = unsafe {
                std::mem::transmute(alsa_probe_symbol(
                    c"maus_test_alsa_opens_after_open_failure",
                ))
            };
            let closes: unsafe extern "C" fn() -> libc::c_int = unsafe {
                std::mem::transmute(alsa_probe_symbol(c"maus_test_alsa_uncertain_open_closes"))
            };
            let device = cpal::default_host().default_input_device().unwrap();
            let supported = device.default_input_config().unwrap();
            let format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();
            unsafe { arm() };
            if probe {
                assert!(device.default_input_config().is_err());
            } else {
                assert!(matches!(
                    device.build_input_stream_raw(&config, format, |_, _| {}, |_| {}, None),
                    Err(cpal::BuildStreamError::CleanupUncertain { .. })
                ));
            }
            assert!(cpal::alsa_capture_cleanup_uncertain());
            let manager = RecordingManager::new();
            assert!(manager.is_recording());
            assert!(manager.start(None, None).is_err());
            assert_eq!(unsafe { opens() }, 0);
            assert_eq!(unsafe { closes() }, 0);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires isolated ALSA null and the test-only open-failure preload"]
        fn cpal_alsa_uncertain_probe_open_blocks_capture() {
            exercise_alsa_uncertain_open(true);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires isolated ALSA null and the test-only open-failure preload"]
        fn cpal_alsa_uncertain_stream_open_blocks_capture() {
            exercise_alsa_uncertain_open(false);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only build-failure preload"]
        fn cpal_alsa_build_failure_distinguishes_confirmed_close() {
            use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

            let arm = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_arm_alsa_build_failure".as_ptr(),
                )
            };
            let closes = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_alsa_build_close_calls".as_ptr(),
                )
            };
            assert!(
                !arm.is_null() && !closes.is_null(),
                "build-failure preload required"
            );
            let arm: unsafe extern "C" fn(libc::c_int) = unsafe { std::mem::transmute(arm) };
            let closes: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(closes) };
            let device = cpal::default_host().default_input_device().unwrap();
            let supported = device.default_input_config().unwrap();
            let format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();
            unsafe { arm(0) };
            let result = device.build_input_stream_raw(&config, format, |_, _| {}, |_| {}, None);
            assert!(matches!(
                result,
                Err(cpal::BuildStreamError::BackendSpecific { .. })
            ));
            assert_eq!(unsafe { closes() }, 1);
            let stream = device
                .build_input_stream_raw(&config, format, |_, _| {}, |_| {}, None)
                .unwrap();
            stream.play().unwrap();
            drop(stream);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only build-failure preload"]
        fn cpal_alsa_poll_count_error_closes_capture_and_reports_cause() {
            use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

            let arm = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_arm_alsa_poll_count_failure".as_ptr(),
                )
            };
            let closes = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_alsa_build_close_calls".as_ptr(),
                )
            };
            assert!(
                !arm.is_null() && !closes.is_null(),
                "build-failure preload required"
            );
            let arm: unsafe extern "C" fn() = unsafe { std::mem::transmute(arm) };
            let closes: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(closes) };
            let device = cpal::default_host().default_input_device().unwrap();
            let supported = device.default_input_config().unwrap();
            let format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();
            unsafe { arm() };
            let error = device
                .build_input_stream_raw(&config, format, |_, _| {}, |_| {}, None)
                .err()
                .expect("poll descriptor failure must reject the stream");
            assert!(error.to_string().contains("snd_pcm_poll_descriptors_count"));
            assert_eq!(unsafe { closes() }, 1);
            let stream = device
                .build_input_stream_raw(&config, format, |_, _| {}, |_| {}, None)
                .unwrap();
            stream.play().unwrap();
            drop(stream);
        }

        #[cfg(target_os = "linux")]
        fn exercise_alsa_uncertain_build_close(cached: bool) {
            use super::RecordingManager;
            use crate::platform::Recorder;

            let arm = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_arm_alsa_build_failure".as_ptr(),
                )
            };
            let setups = unsafe {
                libc::dlsym(libc::RTLD_DEFAULT, c"maus_test_alsa_failed_setups".as_ptr())
            };
            let closes = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_alsa_build_close_calls".as_ptr(),
                )
            };
            assert!(
                !arm.is_null() && !setups.is_null() && !closes.is_null(),
                "build-failure preload required"
            );
            let arm: unsafe extern "C" fn(libc::c_int) = unsafe { std::mem::transmute(arm) };
            let setups: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(setups) };
            let closes: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(closes) };
            {
                let manager = RecordingManager::new();
                if cached {
                    manager.start(None, None).unwrap();
                    manager.stop().unwrap();
                }
                unsafe { arm(1) };
                let error = manager.start(None, None).unwrap_err();
                assert!(matches!(
                    error.downcast_ref::<crate::errors::RecordingError>(),
                    Some(crate::errors::RecordingError::ReleaseUncertain(_))
                ));
                assert_eq!(unsafe { setups() }, 1);
                assert_eq!(unsafe { closes() }, 1);
                assert!(manager.is_recording());
                assert!(manager.start(None, None).is_err());
                assert!(manager.stop().is_err());
                assert!(manager.is_recording());
                assert_eq!(unsafe { closes() }, 1);
            }
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires isolated ALSA null and the test-only build-failure preload"]
        fn cpal_alsa_uncertain_build_close_blocks_successor_capture() {
            exercise_alsa_uncertain_build_close(false);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires isolated ALSA null and the test-only build-failure preload"]
        fn cpal_alsa_uncertain_cached_build_close_blocks_successor_capture() {
            exercise_alsa_uncertain_build_close(true);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only close-failure preload"]
        fn cpal_alsa_failed_close_never_reuses_the_uncertain_handle() {
            use super::RecordingManager;
            use crate::platform::Recorder;
            use std::sync::mpsc;
            use std::time::Duration;

            let arm = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_arm_alsa_close_failure".as_ptr(),
                )
            };
            let calls =
                unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"maus_test_alsa_close_calls".as_ptr()) };
            assert!(
                !arm.is_null() && !calls.is_null(),
                "close-failure preload required"
            );
            let arm: unsafe extern "C" fn() = unsafe { std::mem::transmute(arm) };
            let calls: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(calls) };
            let manager = RecordingManager::new();
            let (captured_tx, captured_rx) = mpsc::sync_channel(1);
            manager
                .start(
                    Some(Arc::new(move |_| {
                        let _ = captured_tx.try_send(());
                    })),
                    None,
                )
                .unwrap();
            captured_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            unsafe { arm() };
            assert!(manager.stop_for_handoff().unwrap().capture_failed);
            assert_eq!(unsafe { calls() }, 1);
            assert!(manager.is_recording());
            assert!(manager.start(None, None).is_err());
            assert!(manager.stop().is_err());
            assert_eq!(unsafe { calls() }, 1);
            assert!(manager.is_recording());
            // Model process teardown: dropping the retained recording must not
            // close the already-consumed, potentially invalid native handle.
            manager
                .worker
                .call(|recorder| drop(recorder.guard().unwrap().take()))
                .unwrap();
            assert_eq!(unsafe { calls() }, 1);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only stop-failure preload"]
        fn cpal_alsa_failed_stop_retains_ownership_until_retry_succeeds() {
            use super::RecordingManager;
            use crate::platform::Recorder;
            use std::sync::mpsc;
            use std::time::Duration;

            let arm = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_fail_next_alsa_stops".as_ptr(),
                )
            };
            let failures = unsafe {
                libc::dlsym(libc::RTLD_DEFAULT, c"maus_test_alsa_stop_failures".as_ptr())
            };
            assert!(
                !arm.is_null() && !failures.is_null(),
                "stop-failure preload required"
            );
            let arm: unsafe extern "C" fn() = unsafe { std::mem::transmute(arm) };
            let failures: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(failures) };
            let manager = RecordingManager::new();
            let (captured_tx, captured_rx) = mpsc::sync_channel(1);
            manager
                .start(
                    Some(Arc::new(move |_| {
                        let _ = captured_tx.try_send(());
                    })),
                    None,
                )
                .unwrap();
            captured_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            unsafe { arm() };
            let result = manager.stop_for_handoff().unwrap();
            assert!(result.capture_failed);
            assert_eq!(unsafe { failures() }, 2);
            assert!(manager.is_recording());
            assert!(manager.start(None, None).is_err());
            manager.stop().unwrap();
            assert!(!manager.is_recording());
            manager.start(None, None).unwrap();
            manager.stop().unwrap();
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires an isolated ALSA null playback device"]
        fn cpal_alsa_playback_uses_aligned_sample_buffers() {
            use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
            use std::sync::mpsc;
            use std::time::Duration;

            let device = cpal::default_host().default_output_device().unwrap();
            let supported = device.default_output_config().unwrap();
            let format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();
            let (data_tx, data_rx) = mpsc::sync_channel(1);
            let stream = device
                .build_output_stream_raw(
                    &config,
                    format,
                    move |data, _| {
                        let bytes = data.bytes_mut();
                        let _ = data_tx.try_send((bytes.len(), bytes.as_ptr() as usize));
                        bytes.fill(0);
                    },
                    |_| {},
                    None,
                )
                .unwrap();
            stream.play().unwrap();
            let (len, address) = data_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            drop(stream);
            assert!(len > 0);
            assert_eq!(address % std::mem::align_of::<u64>(), 0);
        }

        #[cfg(target_os = "linux")]
        fn check_alsa_partial_playback(no_progress: bool, expect_error: bool) {
            use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
            use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
            use std::sync::Arc;
            use std::time::{Duration, Instant};

            unsafe fn symbol(name: &std::ffi::CStr) -> *mut libc::c_void {
                let result = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
                assert!(!result.is_null(), "short-write preload required");
                result
            }
            let calls: unsafe extern "C" fn() -> libc::c_ulong =
                unsafe { std::mem::transmute(symbol(c"maus_test_write_calls")) };
            let completed: unsafe extern "C" fn() -> libc::c_ulong =
                unsafe { std::mem::transmute(symbol(c"maus_test_write_completed")) };
            let mismatch: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(symbol(c"maus_test_write_mismatch")) };
            let device = cpal::default_host().default_output_device().unwrap();
            let config = cpal::StreamConfig {
                channels: 1,
                sample_rate: cpal::SampleRate(48_000),
                buffer_size: cpal::BufferSize::Default,
            };
            let callbacks = Arc::new(AtomicUsize::new(0));
            let duplicate = Arc::new(AtomicBool::new(false));
            let errors = Arc::new(AtomicUsize::new(0));
            let stream = device
                .build_output_stream(
                    &config,
                    {
                        let callbacks = Arc::clone(&callbacks);
                        let duplicate = Arc::clone(&duplicate);
                        move |data: &mut [f32], _| {
                            if callbacks.fetch_add(1, Ordering::SeqCst) != 0
                                && unsafe { completed() } == 0
                            {
                                duplicate.store(true, Ordering::SeqCst);
                            }
                            for (index, sample) in data.iter_mut().enumerate() {
                                *sample = index as f32;
                            }
                        }
                    },
                    {
                        let errors = Arc::clone(&errors);
                        move |_| {
                            errors.fetch_add(1, Ordering::SeqCst);
                        }
                    },
                    None,
                )
                .unwrap();
            stream.play().unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                let done = if no_progress {
                    unsafe { calls() >= 10 }
                } else {
                    unsafe { completed() != 0 || mismatch() != 0 }
                };
                if done {
                    break;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            assert!(unsafe { calls() >= if no_progress { 10 } else { 4 } });
            if !no_progress {
                assert_eq!(unsafe { completed() }, 1);
            }
            assert_eq!(unsafe { mismatch() }, 0);
            assert!(!duplicate.load(Ordering::SeqCst));
            assert_eq!(errors.load(Ordering::SeqCst), usize::from(expect_error));
            let drop_started = Instant::now();
            drop(stream);
            assert!(drop_started.elapsed() < Duration::from_millis(500));
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only short-write preload"]
        fn cpal_alsa_partial_playback_preserves_unwritten_frames() {
            check_alsa_partial_playback(false, false);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only partial-write XRUN preload"]
        fn cpal_alsa_playback_recovers_xrun_after_partial_write() {
            check_alsa_partial_playback(false, false);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only permanent-EAGAIN preload"]
        fn cpal_alsa_playback_drop_interrupts_retry() {
            check_alsa_partial_playback(true, false);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only fatal-write preload"]
        fn cpal_alsa_playback_coalesces_persistent_errors() {
            check_alsa_partial_playback(true, true);
        }

        #[cfg(target_os = "linux")]
        fn check_alsa_stalled_read() {
            use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
            use std::sync::atomic::AtomicUsize;
            use std::time::{Duration, Instant};
            let calls =
                unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"maus_test_read_calls".as_ptr()) };
            assert!(!calls.is_null(), "short-read preload required");
            let calls: unsafe extern "C" fn() -> libc::c_ulong =
                unsafe { std::mem::transmute(calls) };
            let device = cpal::default_host().default_input_device().unwrap();
            let supported = device.default_input_config().unwrap();
            let format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();
            let callbacks = Arc::new(AtomicUsize::new(0));
            let errors = Arc::new(AtomicUsize::new(0));
            let mut stream = device
                .build_input_stream_raw(
                    &config,
                    format,
                    {
                        let callbacks = Arc::clone(&callbacks);
                        move |_, _| {
                            callbacks.fetch_add(1, Ordering::SeqCst);
                        }
                    },
                    {
                        let errors = Arc::clone(&errors);
                        move |_| {
                            errors.fetch_add(1, Ordering::SeqCst);
                        }
                    },
                    None,
                )
                .unwrap();
            stream.play().unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            while unsafe { calls() } < 10 {
                assert!(Instant::now() < deadline, "read retry did not run");
                std::thread::sleep(Duration::from_millis(2));
            }
            let before = unsafe { calls() };
            std::thread::sleep(Duration::from_millis(50));
            assert!(
                unsafe { calls() } - before <= 15,
                "read retry spun despite no progress"
            );
            assert_eq!(callbacks.load(Ordering::SeqCst), 0);
            assert_eq!(errors.load(Ordering::SeqCst), 0);
            let started = Instant::now();
            #[allow(unreachable_patterns)]
            match stream.as_inner_mut() {
                cpal::platform::StreamInner::Alsa(inner) => inner.stop_input_for_release().unwrap(),
                _ => panic!("expected ALSA stream"),
            }
            assert!(started.elapsed() < Duration::from_millis(500));
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only permanent-EAGAIN read preload"]
        fn cpal_alsa_stalled_read_is_interruptible() {
            check_alsa_stalled_read();
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only zero-read preload"]
        fn cpal_alsa_zero_read_is_interruptible() {
            check_alsa_stalled_read();
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only short-read preload"]
        fn cpal_alsa_delivers_only_frames_returned_by_a_short_read() {
            use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
            use std::sync::mpsc;
            use std::time::Duration;

            let requested = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_last_read_requested".as_ptr(),
                )
            };
            let returned = unsafe {
                libc::dlsym(libc::RTLD_DEFAULT, c"maus_test_last_read_returned".as_ptr())
            };
            assert!(
                !requested.is_null() && !returned.is_null(),
                "short-read preload required"
            );
            let requested: unsafe extern "C" fn() -> libc::c_ulong =
                unsafe { std::mem::transmute(requested) };
            let returned: unsafe extern "C" fn() -> libc::c_long =
                unsafe { std::mem::transmute(returned) };
            let device = cpal::default_host().default_input_device().unwrap();
            let supported = device.default_input_config().unwrap();
            let format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();
            let channels = config.channels as usize;
            let (data_tx, data_rx) = mpsc::sync_channel(1);
            let (error_tx, error_rx) = mpsc::sync_channel(1);
            let stream = device
                .build_input_stream_raw(
                    &config,
                    format,
                    move |data, _| {
                        let _ = data_tx.try_send((
                            data.len(),
                            data.bytes().as_ptr() as usize % std::mem::align_of::<u64>(),
                            unsafe { requested() },
                            unsafe { returned() },
                        ));
                    },
                    move |error| {
                        let _ = error_tx.try_send(error.to_string());
                    },
                    None,
                )
                .unwrap();
            stream.play().unwrap();
            let (samples, alignment, requested, returned) =
                data_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            stream.pause().unwrap();
            drop(stream);
            assert!(returned > 0 && (returned as libc::c_ulong) < requested);
            assert_eq!(samples, returned as usize * channels);
            assert_eq!(alignment, 0);
            assert!(
                error_rx.try_recv().is_err(),
                "EAGAIN must not report capture failure"
            );
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only POLLERR overrun preload"]
        fn cpal_alsa_pollerr_overrun_is_reported_and_prepared() {
            use super::RecordingManager;
            use crate::platform::Recorder;
            use std::sync::mpsc;
            use std::time::{Duration, Instant};

            let arm = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_inject_alsa_poll_xrun".as_ptr(),
                )
            };
            let preparations = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_alsa_xrun_preparations".as_ptr(),
                )
            };
            assert!(
                !arm.is_null() && !preparations.is_null(),
                "POLLERR overrun preload required"
            );
            let arm: unsafe extern "C" fn() = unsafe { std::mem::transmute(arm) };
            let preparations: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(preparations) };
            let manager = RecordingManager::new();
            let (captured_tx, captured_rx) = mpsc::sync_channel(1);
            manager
                .start(
                    Some(Arc::new(move |_| {
                        let _ = captured_tx.try_send(());
                    })),
                    None,
                )
                .unwrap();
            captured_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            unsafe { arm() };
            let deadline = Instant::now() + Duration::from_secs(2);
            while unsafe { preparations() } == 0 {
                assert!(
                    Instant::now() < deadline,
                    "POLLERR overrun was not prepared"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            let recording = manager.stop_for_handoff().unwrap();
            assert!(recording.capture_failed);
            assert!(!recording.audio.samples.is_empty());
            assert!(!manager.is_recording());
        }

        #[cfg(target_os = "linux")]
        fn check_alsa_capture_disconnect(disconnected_state: bool) {
            use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
            use std::sync::mpsc;
            use std::time::Duration;
            let arm = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_inject_alsa_disconnect".as_ptr(),
                )
            };
            let observations = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_alsa_disconnect_observations".as_ptr(),
                )
            };
            let clear = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_clear_alsa_disconnect".as_ptr(),
                )
            };
            assert!(
                !arm.is_null() && !observations.is_null() && !clear.is_null(),
                "disconnect preload required"
            );
            let clear: unsafe extern "C" fn() = unsafe { std::mem::transmute(clear) };
            let arm: unsafe extern "C" fn() = unsafe { std::mem::transmute(arm) };
            let observations: unsafe extern "C" fn() -> libc::c_uint =
                unsafe { std::mem::transmute(observations) };
            let device = cpal::default_host().default_input_device().unwrap();
            let supported = device.default_input_config().unwrap();
            let format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();
            let (data_tx, data_rx) = mpsc::sync_channel(1);
            let (error_tx, error_rx) = mpsc::channel();
            let mut stream = device
                .build_input_stream_raw(
                    &config,
                    format,
                    move |_, _| {
                        let _ = data_tx.try_send(());
                    },
                    move |error| {
                        let _ = error_tx.send(error);
                    },
                    None,
                )
                .unwrap();
            stream.play().unwrap();
            data_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            unsafe { arm() };
            let error = error_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            assert!(
                matches!(error, cpal::StreamError::DeviceNotAvailable),
                "expected a device disconnect, got {error:?}"
            );
            std::thread::sleep(Duration::from_millis(30));
            assert!(error_rx.try_recv().is_err());
            assert_eq!(unsafe { observations() }, 1);
            #[allow(unreachable_patterns)]
            match stream.as_inner_mut() {
                cpal::platform::StreamInner::Alsa(inner) => {
                    let result = inner.stop_input_for_release();
                    if disconnected_state {
                        assert!(
                            result.is_err(),
                            "unconfirmed native stop must remain retryable"
                        );
                        unsafe { clear() };
                        inner.stop_input_for_release().unwrap();
                    } else {
                        result.unwrap();
                    }
                }
                _ => panic!("expected ALSA stream"),
            }
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only POLLHUP preload"]
        fn cpal_alsa_capture_disconnect_stops_worker() {
            check_alsa_capture_disconnect(false);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only disconnected-state preload"]
        fn cpal_alsa_capture_disconnected_state_stops_worker() {
            check_alsa_capture_disconnect(true);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only disconnect-stage preload"]
        fn cpal_alsa_disconnect_during_descriptor_fill_stops_worker() {
            check_alsa_capture_disconnect(false);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only disconnect-stage preload"]
        fn cpal_alsa_disconnect_during_revents_stops_worker() {
            check_alsa_capture_disconnect(false);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only disconnect-stage preload"]
        fn cpal_alsa_disconnect_during_status_stops_worker() {
            check_alsa_capture_disconnect(false);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only disconnect-stage preload"]
        fn cpal_alsa_disconnect_during_avail_stops_worker() {
            check_alsa_capture_disconnect(false);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only disconnect-stage preload"]
        fn cpal_alsa_disconnect_during_read_stops_worker() {
            check_alsa_capture_disconnect(false);
        }

        #[cfg(target_os = "linux")]
        fn check_alsa_playback_disconnect() {
            use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
            use std::sync::mpsc;
            use std::time::Duration;

            let arm = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_inject_alsa_disconnect".as_ptr(),
                )
            };
            let observations = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_alsa_disconnect_observations".as_ptr(),
                )
            };
            assert!(
                !arm.is_null() && !observations.is_null(),
                "disconnect preload required"
            );
            let arm: unsafe extern "C" fn() = unsafe { std::mem::transmute(arm) };
            let observations: unsafe extern "C" fn() -> libc::c_uint =
                unsafe { std::mem::transmute(observations) };
            let device = cpal::default_host().default_output_device().unwrap();
            let supported = device.default_output_config().unwrap();
            let format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();
            let (data_tx, data_rx) = mpsc::sync_channel(1);
            let (error_tx, error_rx) = mpsc::channel();
            let stream = device
                .build_output_stream_raw(
                    &config,
                    format,
                    move |_, _| {
                        let _ = data_tx.try_send(());
                    },
                    move |error| {
                        let _ = error_tx.send(error);
                    },
                    None,
                )
                .unwrap();
            stream.play().unwrap();
            data_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            unsafe { arm() };
            let error = error_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            assert!(
                matches!(error, cpal::StreamError::DeviceNotAvailable),
                "expected a device disconnect, got {error:?}"
            );
            std::thread::sleep(Duration::from_millis(30));
            assert!(error_rx.try_recv().is_err());
            assert_eq!(unsafe { observations() }, 1);
            drop(stream);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only disconnect-stage preload"]
        fn cpal_alsa_playback_disconnect_during_write_stops_worker() {
            check_alsa_playback_disconnect();
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only disconnect-stage preload"]
        fn cpal_alsa_playback_disconnect_during_recovery_stops_worker() {
            check_alsa_playback_disconnect();
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only POLLHUP preload"]
        fn cpal_alsa_disconnect_preserves_incomplete_recording() {
            use super::RecordingManager;
            use crate::platform::Recorder;
            use std::sync::mpsc;
            use std::time::{Duration, Instant};

            let arm = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_inject_alsa_disconnect".as_ptr(),
                )
            };
            assert!(!arm.is_null(), "disconnect preload required");
            let arm: unsafe extern "C" fn() = unsafe { std::mem::transmute(arm) };
            let manager = RecordingManager::new();
            let (captured_tx, captured_rx) = mpsc::sync_channel(1);
            manager
                .start(
                    Some(Arc::new(move |_| {
                        let _ = captured_tx.try_send(());
                    })),
                    None,
                )
                .unwrap();
            captured_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            unsafe { arm() };
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let failed = manager
                    .worker
                    .call(|recorder| {
                        recorder
                            .inner
                            .lock()
                            .unwrap()
                            .as_ref()
                            .unwrap()
                            .capture_failed
                            .load(Ordering::Acquire)
                    })
                    .unwrap();
                if failed {
                    break;
                }
                assert!(Instant::now() < deadline, "disconnect was not reported");
                std::thread::sleep(Duration::from_millis(5));
            }
            let recording = manager.stop_for_handoff().unwrap();
            assert!(recording.capture_failed);
            assert!(!recording.audio.samples.is_empty());
            assert!(!manager.is_recording());
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only read XRUN preload"]
        fn cpal_alsa_read_overrun_restarts_and_reports_loss() {
            use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
            use std::sync::atomic::AtomicUsize;
            use std::time::{Duration, Instant};

            let symbol =
                |name: &std::ffi::CStr| unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
            let arm = symbol(c"maus_test_inject_read_xrun");
            let prepares = symbol(c"maus_test_read_xrun_preparations");
            let starts = symbol(c"maus_test_read_xrun_starts");
            assert!(!arm.is_null() && !prepares.is_null() && !starts.is_null());
            let arm: unsafe extern "C" fn() = unsafe { std::mem::transmute(arm) };
            let prepares: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(prepares) };
            let starts: unsafe extern "C" fn() -> libc::c_int =
                unsafe { std::mem::transmute(starts) };
            let device = cpal::default_host().default_input_device().unwrap();
            let supported = device.default_input_config().unwrap();
            let format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();
            let captured = Arc::new(AtomicUsize::new(0));
            let errors = Arc::new(AtomicUsize::new(0));
            let observed = Arc::clone(&captured);
            let observed_errors = Arc::clone(&errors);
            let stream = device
                .build_input_stream_raw(
                    &config,
                    format,
                    move |_, _| {
                        observed.fetch_add(1, Ordering::SeqCst);
                    },
                    move |_| {
                        observed_errors.fetch_add(1, Ordering::SeqCst);
                    },
                    None,
                )
                .unwrap();
            stream.play().unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            while captured.load(Ordering::SeqCst) == 0 {
                assert!(Instant::now() < deadline);
                std::thread::yield_now();
            }
            unsafe { arm() };
            while unsafe { starts() } == 0 {
                assert!(Instant::now() < deadline, "read overrun was not restarted");
                std::thread::yield_now();
            }
            assert_eq!(unsafe { prepares() }, 1);
            assert_eq!(unsafe { starts() }, 1);
            assert!(errors.load(Ordering::SeqCst) > 0);
            let after_restart = captured.load(Ordering::SeqCst);
            while captured.load(Ordering::SeqCst) == after_restart {
                assert!(Instant::now() < deadline, "capture did not resume");
                std::thread::yield_now();
            }
            drop(stream);
        }

        #[cfg(target_os = "linux")]
        #[test]
        #[ignore = "requires ALSA null and the test-only overrun preload"]
        fn cpal_alsa_overrun_marks_the_captured_prefix_incomplete() {
            use super::RecordingManager;
            use crate::platform::Recorder;
            use std::sync::mpsc;
            use std::thread;
            use std::time::{Duration, Instant};

            let symbol = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"maus_test_inject_alsa_overrun".as_ptr(),
                )
            };
            assert!(!symbol.is_null(), "test-only ALSA preload is required");
            let inject: unsafe extern "C" fn() = unsafe { std::mem::transmute(symbol) };
            let manager = RecordingManager::new();
            let (captured_tx, captured_rx) = mpsc::sync_channel(1);
            manager
                .start(
                    Some(Arc::new(move |_| {
                        let _ = captured_tx.try_send(());
                    })),
                    None,
                )
                .unwrap();
            captured_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            unsafe { inject() };
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let failed = manager
                    .worker
                    .call(|recorder| {
                        recorder
                            .inner
                            .lock()
                            .unwrap()
                            .as_ref()
                            .unwrap()
                            .capture_failed
                            .load(Ordering::Acquire)
                    })
                    .unwrap();
                if failed {
                    break;
                }
                assert!(Instant::now() < deadline, "overrun was not reported");
                thread::sleep(Duration::from_millis(10));
            }
            let recording = manager.stop_for_handoff().unwrap();
            assert!(recording.capture_failed);
            assert!(!recording.audio.samples.is_empty());
            assert!(!manager.is_recording());
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
