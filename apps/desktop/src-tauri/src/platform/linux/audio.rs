use crate::domain::{RecordedAudio, RecordingMetrics, RecordingResult};
use crate::errors::RecordingError;
use crate::platform::audio::{
    compute_level_bins, label_has_low_quality_keyword, InputDeviceDescriptor,
    CHUNK_DISPATCH_INTERVAL, LEVEL_DISPATCH_INTERVAL,
};
use crate::platform::{ChunkCallback, LevelCallback, Recorder};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use libpulse_binding as pulse;
use libpulse_binding::mainloop::standard::Mainloop;
use libpulse_simple_binding as psimple;

const FALLBACK_SAMPLE_RATE: u32 = 44_100;
const READ_CHUNK_FRAMES: usize = 1024;

pub struct PulseRecorder {
    inner: Arc<Mutex<Option<ActiveRecording>>>,
    preferred_source: Arc<Mutex<Option<String>>>,
}

struct ActiveRecording {
    stop_signal: Arc<Mutex<bool>>,
    thread: Option<std::thread::JoinHandle<RecordingResult>>,
    sample_rate: u32,
}

unsafe impl Send for PulseRecorder {}
unsafe impl Sync for PulseRecorder {}

impl Default for PulseRecorder {
    fn default() -> Self {
        Self::new()
    }
}

impl PulseRecorder {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            preferred_source: Arc::new(Mutex::new(None)),
        }
    }
}

impl Recorder for PulseRecorder {
    fn start(
        &self,
        level_callback: Option<LevelCallback>,
        chunk_callback: Option<ChunkCallback>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RecordingError::AlreadyRecording)?;

        if guard.is_some() {
            return Err(Box::new(RecordingError::AlreadyRecording));
        }

        let preferred = {
            let pref_guard = self
                .preferred_source
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            pref_guard.clone()
        };

        // Resolve the PulseAudio source name to record from.
        // If the user picked a device by its display label, map it back
        // to the underlying PulseAudio source name.
        let source_name = resolve_source_name(preferred.as_deref());
        let native_rate = query_source_native_rate(source_name.as_deref());

        log::info!(
            "PulseAudio native sample rate for source {:?}: {}",
            source_name.as_deref().unwrap_or("default"),
            native_rate,
        );

        let stop_signal = Arc::new(Mutex::new(false));
        let stop_signal_clone = Arc::clone(&stop_signal);

        let thread = std::thread::Builder::new()
            .name("pulse-recorder".into())
            .spawn(move || {
                record_loop(
                    source_name.as_deref(),
                    native_rate,
                    stop_signal_clone,
                    level_callback,
                    chunk_callback,
                )
            })
            .map_err(|err| RecordingError::StreamBuild(err.to_string()))?;

        *guard = Some(ActiveRecording {
            stop_signal,
            thread: Some(thread),
            sample_rate: native_rate,
        });

        Ok(())
    }

    fn stop(&self) -> Result<RecordingResult, Box<dyn std::error::Error>> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| RecordingError::NotRecording)?;
        let mut recording = guard.take().ok_or(RecordingError::NotRecording)?;

        // Signal the recording thread to stop
        if let Ok(mut flag) = recording.stop_signal.lock() {
            *flag = true;
        }

        let thread = recording
            .thread
            .take()
            .ok_or(RecordingError::NotRecording)?;
        let result = thread
            .join()
            .map_err(|_| RecordingError::StreamBuild("recording thread panicked".into()))?;

        Ok(result)
    }

    fn set_preferred_input_device(&self, name: Option<String>) {
        let sanitized = name.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        match self.preferred_source.lock() {
            Ok(mut guard) => *guard = sanitized,
            Err(poisoned) => *poisoned.into_inner() = sanitized,
        }
    }

    fn clear_device_cache(&self) {
        // No caching needed — PulseAudio handles device routing
    }

    fn current_sample_rate(&self) -> Option<u32> {
        let guard = match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard.as_ref().map(|r| r.sample_rate)
    }

    fn pause(&self) -> Result<(), Box<dyn std::error::Error>> {
        // PulseAudio simple stream does not expose direct pause/resume.
        // Returning unsupported keeps the trait contract while making the limitation explicit.
        Err(Box::new(RecordingError::StreamPlay(
            "PulseAudio recorder does not support pause/resume".into(),
        )))
    }

    fn resume(&self) -> Result<(), Box<dyn std::error::Error>> {
        Err(Box::new(RecordingError::StreamPlay(
            "PulseAudio recorder does not support pause/resume".into(),
        )))
    }
}

/// Given the user's preferred device label (the display name shown in the UI),
/// look up the PulseAudio source name that corresponds to it. Returns None
/// to use the server default.
fn resolve_source_name(preferred_label: Option<&str>) -> Option<String> {
    let label = preferred_label?;
    if label.is_empty() {
        return None;
    }

    // If the label is already a PulseAudio source name (e.g. "alsa_input.usb-..."),
    // use it directly.
    if label.starts_with("alsa_input.") || label.starts_with("alsa_output.") {
        return Some(label.to_string());
    }

    // Otherwise, enumerate sources and find the one whose description matches.
    let sources = enumerate_pulse_sources();
    let label_lower = label.to_ascii_lowercase();

    sources
        .into_iter()
        .find(|s| s.description.to_ascii_lowercase() == label_lower)
        .map(|s| s.name)
}

/// Query the native sample rate of a PulseAudio source. Falls back to the
/// default source, then to `FALLBACK_SAMPLE_RATE` if enumeration fails.
fn query_source_native_rate(source_name: Option<&str>) -> u32 {
    let sources = enumerate_pulse_sources();

    if let Some(name) = source_name {
        if let Some(source) = sources.iter().find(|s| s.name == name) {
            return source.sample_rate;
        }
    }

    if let Some(source) = sources.iter().find(|s| s.is_default) {
        return source.sample_rate;
    }

    FALLBACK_SAMPLE_RATE
}

/// State the level emitter carries between blocks.
///
/// Pulled out of the loop so each emitter can be read, and tested, on its own:
/// the loop was one function doing capture, conversion, accumulation, level
/// dispatch, chunk dispatch and its own shutdown reasoning, which is more than a
/// reader can hold at once.
struct LevelEmitter {
    callback: Option<LevelCallback>,
    last_emit: Instant,
}

impl LevelEmitter {
    fn new(callback: Option<LevelCallback>) -> Self {
        Self {
            callback,
            last_emit: Instant::now(),
        }
    }

    /// Sends a level bin no more often than `LEVEL_DISPATCH_INTERVAL`.
    fn dispatch(&mut self, samples: &[f32]) {
        let Some(callback) = self.callback.as_ref() else {
            return;
        };
        let now = Instant::now();
        if now.duration_since(self.last_emit) < LEVEL_DISPATCH_INTERVAL {
            return;
        }
        self.last_emit = now;
        callback(compute_level_bins(samples));
    }
}

/// State the chunk emitter carries between blocks.
struct ChunkEmitter {
    callback: Option<ChunkCallback>,
    last_emit: Instant,
    buffer: Vec<f32>,
    /// Samples already handed to the callback, so each batch reports the
    /// absolute index of its first sample.
    emitted: u64,
}

impl ChunkEmitter {
    fn new(callback: Option<ChunkCallback>) -> Self {
        Self {
            callback,
            last_emit: Instant::now(),
            buffer: Vec::new(),
            emitted: 0,
        }
    }

    /// Accumulates a block and sends whatever is buffered at the dispatch
    /// interval. The flush at the end of the recording goes through
    /// [`ChunkEmitter::flush`].
    fn dispatch(&mut self, samples: &[f32]) {
        if self.callback.is_none() {
            return;
        }
        self.buffer.extend_from_slice(samples);
        let now = Instant::now();
        if now.duration_since(self.last_emit) < CHUNK_DISPATCH_INTERVAL {
            return;
        }
        self.last_emit = now;
        self.emit_buffered();
    }

    /// Sends anything still buffered. Called once, when the loop ends.
    fn flush(&mut self) {
        self.emit_buffered();
    }

    /// Takes the buffered samples and hands them over with the offset of the
    /// first one.
    ///
    /// The callback is cloned out rather than borrowed from `self`, because
    /// `emit_buffered` mutates `self` to advance the offset and clear the
    /// buffer. `ChunkCallback` is a function pointer or an `Arc`, so the clone
    /// is free.
    fn emit_buffered(&mut self) {
        let Some(callback) = self.callback.clone() else {
            return;
        };
        if self.buffer.is_empty() {
            return;
        }
        let offset = self.emitted;
        let batch = std::mem::take(&mut self.buffer);
        self.emitted += batch.len() as u64;
        callback(batch, offset);
    }
}

/// The actual blocking recording loop. Runs on a dedicated thread.
#[allow(unknown_lints)]
#[allow(clippy::chunks_exact_to_as_chunks)]
fn record_loop(
    source_name: Option<&str>,
    sample_rate: u32,
    stop_signal: Arc<Mutex<bool>>,
    level_callback: Option<LevelCallback>,
    chunk_callback: Option<ChunkCallback>,
) -> RecordingResult {
    let spec = pulse::sample::Spec {
        format: pulse::sample::Format::F32le,
        channels: 1,
        rate: sample_rate,
    };

    let attr = pulse::def::BufferAttr {
        maxlength: u32::MAX,
        tlength: u32::MAX,
        prebuf: u32::MAX,
        minreq: u32::MAX,
        // Keep the fragment size small for low-latency level/chunk callbacks
        fragsize: (READ_CHUNK_FRAMES * std::mem::size_of::<f32>()) as u32,
    };

    let source_cstr = source_name.and_then(|s| std::ffi::CString::new(s).ok());
    let source_ref = source_cstr
        .as_ref()
        .map(|c| c.as_c_str().to_str().unwrap_or_default());

    let simple = match psimple::Simple::new(
        None,        // server (default)
        "mausVoice", // app name
        pulse::stream::Direction::Record,
        source_ref,  // source (None = default)
        "Recording", // stream description
        &spec,
        None, // channel map (default)
        Some(&attr),
    ) {
        Ok(s) => s,
        Err(err) => {
            log::error!("failed to open PulseAudio recording stream: {err}");
            return empty_result();
        }
    };

    log::info!(
        "PulseAudio recording started (source: {})",
        source_name.unwrap_or("default")
    );

    let start = Instant::now();
    let mut all_samples: Vec<f32> = Vec::new();
    let mut levels = LevelEmitter::new(level_callback);
    let mut chunks = ChunkEmitter::new(chunk_callback);

    let mut read_buf = vec![0u8; READ_CHUNK_FRAMES * std::mem::size_of::<f32>()];
    // Set when the read itself failed, cleared when the stop signal explains it.
    let mut read_fault: Option<String> = None;

    loop {
        // Check stop signal
        if let Ok(flag) = stop_signal.lock() {
            if *flag {
                break;
            }
        }

        // Read audio data (blocking)
        if let Err(err) = simple.read(&mut read_buf) {
            log::error!("PulseAudio read error: {err}");
            // Decide between a shutdown and a fault *here*, not after the loop.
            //
            // The stop flag used to be sampled once the loop had exited, which
            // was several steps later: the chunk flush below, its callback, and
            // whatever that callback did. A stop pressed during any of that
            // found the flag set and cleared a fault that had already happened,
            // so a device that died mid-dictation reported a clean, short
            // recording. Sampling at the failure narrows the window to the two
            // instructions after a failed read, where only a genuine
            // simultaneous stop can be mistaken for a shutdown.
            //
            // Either way nothing is reported for a normal stop: a stop requested
            // before the read is caught by the check at the top of the loop.
            if stop_signal.lock().map(|flag| *flag).unwrap_or(false) {
                break;
            }
            read_fault = Some(READ_FAULT_TOKEN.to_string());
            break;
        }

        // Convert bytes to f32 samples (F32LE format)
        let samples: Vec<f32> = read_buf
            .as_chunks::<4>()
            .0
            .iter()
            .map(|chunk| f32::from_le_bytes(*chunk))
            .collect();

        // Accumulate for final result
        all_samples.extend_from_slice(&samples);

        levels.dispatch(&samples);
        chunks.dispatch(&samples);
    }

    chunks.flush();

    // `read_fault` was decided at the failing read, above. Re-sampling the stop
    // flag here is what used to let a stop pressed after the failure discard it.

    let expected_duration = start.elapsed();
    let duration = if !all_samples.is_empty() {
        Duration::from_secs_f64(all_samples.len() as f64 / f64::from(sample_rate))
    } else {
        expected_duration
    };
    let size_bytes = all_samples.len() as u64 * std::mem::size_of::<f32>() as u64;

    RecordingResult {
        metrics: RecordingMetrics {
            duration,
            expected_duration,
            size_bytes,
            // No host error callback exists on this backend, so the fault is the
            // read failure classified above. Without it a stream that died mid
            // dictation produced the same result as one that was stopped.
            capture_fault: read_fault,
        },
        audio: RecordedAudio {
            samples: all_samples,
            sample_rate,
        },
    }
}

/// The token recorded when the PulseAudio read fails without a stop request.
///
/// The same token the cpal path carries for a host-declared fatal error, so the
/// front end's existing classification handles it without a second dialect.
const READ_FAULT_TOKEN: &str = "fatal";

fn empty_result() -> RecordingResult {
    RecordingResult {
        metrics: RecordingMetrics {
            duration: Duration::ZERO,
            // Nothing was recorded and nothing was expected: this is the result
            // of a stop with no recording, not of a capture that died.
            expected_duration: Duration::ZERO,
            size_bytes: 0,
            capture_fault: None,
        },
        audio: RecordedAudio {
            samples: Vec::new(),
            sample_rate: FALLBACK_SAMPLE_RATE,
        },
    }
}

// ── PulseAudio source enumeration ──────────────────────────────────────

#[derive(Clone)]
struct PulseSource {
    name: String,
    description: String,
    is_monitor: bool,
    is_default: bool,
    sample_rate: u32,
}

fn enumerate_pulse_sources() -> Vec<PulseSource> {
    let mut ml = match Mainloop::new() {
        Some(ml) => ml,
        None => {
            log::error!("failed to create PulseAudio mainloop");
            return Vec::new();
        }
    };

    let mut ctx = match pulse::context::Context::new(&ml, "mausVoice Enumerate") {
        Some(ctx) => ctx,
        None => {
            log::error!("failed to create PulseAudio context");
            return Vec::new();
        }
    };

    if ctx
        .connect(None, pulse::context::FlagSet::NOFLAGS, None)
        .is_err()
    {
        log::error!("failed to connect PulseAudio context");
        return Vec::new();
    }

    // Wait for context to be ready
    loop {
        match ml.iterate(true) {
            pulse::mainloop::standard::IterateResult::Quit(_)
            | pulse::mainloop::standard::IterateResult::Err(_) => {
                log::error!("PulseAudio mainloop error during connect");
                return Vec::new();
            }
            _ => {}
        }
        match ctx.get_state() {
            pulse::context::State::Ready => break,
            pulse::context::State::Failed | pulse::context::State::Terminated => {
                log::error!("PulseAudio context failed to connect");
                return Vec::new();
            }
            _ => {}
        }
    }

    // Get the default source name from server info
    let default_source: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let default_source_clone = Arc::clone(&default_source);
    let server_done = Arc::new(Mutex::new(false));
    let server_done_clone = Arc::clone(&server_done);

    let introspect = ctx.introspect();
    introspect.get_server_info(move |info| {
        if let Some(ref name) = info.default_source_name {
            if let Ok(mut guard) = default_source_clone.lock() {
                *guard = Some(name.to_string());
            }
        }
        if let Ok(mut done) = server_done_clone.lock() {
            *done = true;
        }
    });

    // Wait for server info callback
    loop {
        if let Ok(done) = server_done.lock() {
            if *done {
                break;
            }
        }
        match ml.iterate(true) {
            pulse::mainloop::standard::IterateResult::Quit(_)
            | pulse::mainloop::standard::IterateResult::Err(_) => break,
            _ => {}
        }
    }

    let default_name = default_source
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default();

    // Enumerate sources
    let sources: Arc<Mutex<Vec<PulseSource>>> = Arc::new(Mutex::new(Vec::new()));
    let sources_clone = Arc::clone(&sources);
    let default_name_clone = default_name.clone();
    let list_done = Arc::new(Mutex::new(false));
    let list_done_clone = Arc::clone(&list_done);

    introspect.get_source_info_list(move |result| match result {
        pulse::callbacks::ListResult::Item(info) => {
            let name = info
                .name
                .as_ref()
                .map(|n| n.to_string())
                .unwrap_or_default();
            let description = info
                .description
                .as_ref()
                .map(|d| d.to_string())
                .unwrap_or_else(|| name.clone());
            let is_monitor = info.monitor_of_sink.is_some();

            let sample_rate = info.sample_spec.rate;
            if let Ok(mut guard) = sources_clone.lock() {
                guard.push(PulseSource {
                    is_default: name == default_name_clone,
                    name,
                    description,
                    is_monitor,
                    sample_rate,
                });
            }
        }
        pulse::callbacks::ListResult::End | pulse::callbacks::ListResult::Error => {
            if let Ok(mut done) = list_done_clone.lock() {
                *done = true;
            }
        }
    });

    // Wait for source list callback
    loop {
        if let Ok(done) = list_done.lock() {
            if *done {
                break;
            }
        }
        match ml.iterate(true) {
            pulse::mainloop::standard::IterateResult::Quit(_)
            | pulse::mainloop::standard::IterateResult::Err(_) => break,
            _ => {}
        }
    }

    ctx.disconnect();

    match Arc::try_unwrap(sources) {
        Ok(mutex) => mutex.into_inner().unwrap_or_default(),
        Err(arc) => arc.lock().unwrap_or_else(|p| p.into_inner()).clone(),
    }
}

/// List microphone sources via PulseAudio, filtering out monitors.
/// Returns descriptors compatible with the existing UI.
pub fn list_pulse_input_devices() -> Vec<InputDeviceDescriptor> {
    let sources = enumerate_pulse_sources();

    let mut devices: Vec<InputDeviceDescriptor> = sources
        .into_iter()
        .filter(|s| !s.is_monitor)
        .map(|s| {
            // Both flags were hard-coded to `false` here, so on the one platform
            // where a Bluetooth headset is the common case, the selector offered
            // it as an ordinary device and nothing downstream could tell the
            // difference. The keyword test is the same one the cpal path uses.
            let bluetooth = label_has_low_quality_keyword(&s.description);
            InputDeviceDescriptor {
                label: s.description,
                is_default: s.is_default,
                caution: bluetooth,
                bluetooth,
            }
        })
        .collect();

    // Sort: default first, then alphabetical
    devices.sort_by(|a, b| {
        b.is_default.cmp(&a.is_default).then_with(|| {
            a.label
                .to_ascii_lowercase()
                .cmp(&b.label.to_ascii_lowercase())
        })
    });

    devices
}

#[cfg(test)]
mod emitter_tests {
    use super::*;
    use std::sync::Mutex;

    /// Collects what a [`ChunkEmitter`] sends, so the offset bookkeeping can be
    /// asserted without a real capture device.
    /// One dispatched batch: its length and the offset it reported.
    type Batches = Arc<Mutex<Vec<(usize, u64)>>>;

    fn collector() -> (ChunkCallback, Batches) {
        let seen: Arc<Mutex<Vec<(usize, u64)>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let callback: ChunkCallback = Arc::new(move |batch: Vec<f32>, offset: u64| {
            sink.lock().unwrap().push((batch.len(), offset));
        });
        (callback, seen)
    }

    /// Every batch must report the absolute index of its first sample, and the
    /// batches must concatenate back to the whole stream. This is the invariant
    /// the emitters were extracted to keep, and a wrong `emitted` counter is
    /// silent: it only shows up as a misaligned timeline far downstream.
    #[test]
    fn chunk_offsets_are_absolute_and_contiguous() {
        let (callback, seen) = collector();
        let mut chunks = ChunkEmitter::new(Some(callback));

        // Drive the buffer past the dispatch interval so at least one real
        // dispatch happens rather than only the final flush.
        let block = vec![0.25_f32; 4096];
        for _ in 0..64 {
            chunks.dispatch(&block);
        }
        chunks.flush();

        let seen = seen.lock().unwrap();
        assert!(!seen.is_empty(), "expected at least one dispatch");
        let mut expected_offset = 0;
        for (len, offset) in seen.iter() {
            assert_eq!(*offset, expected_offset, "batch offset is not contiguous");
            assert!(*len > 0, "an empty batch must not be emitted");
            expected_offset += *len as u64;
        }
        assert_eq!(expected_offset, 64 * 4096);
    }

    /// A chunk callback that never fires must not accumulate: it is opted out
    /// of, not merely throttled.
    #[test]
    fn no_chunk_callback_buffers_nothing() {
        let mut chunks = ChunkEmitter::new(None);
        let block = vec![0.25_f32; 4096];
        for _ in 0..64 {
            chunks.dispatch(&block);
        }
        chunks.flush();
        assert!(chunks.buffer.is_empty());
        assert_eq!(chunks.emitted, 0);
    }

    /// Flushing an already-empty buffer must not send an empty batch.
    #[test]
    fn flush_without_data_sends_nothing() {
        let (callback, seen) = collector();
        let mut chunks = ChunkEmitter::new(Some(callback));
        chunks.flush();
        chunks.flush();
        assert!(seen.lock().unwrap().is_empty());
    }

    /// The level emitter throttles: a burst of blocks inside one dispatch
    /// interval sends nothing, because the clock starts at construction rather
    /// than at the first block. That matches the old inline
    /// `last_level_emit = Instant::now()` before the loop, and it is why a
    /// freshly opened microphone shows no bars for the first interval.
    #[test]
    fn level_dispatch_is_throttled_within_the_interval() {
        let seen: Arc<Mutex<usize>> = Arc::new(Mutex::new(0));
        let sink = Arc::clone(&seen);
        let callback: LevelCallback = Arc::new(move |_bins: Vec<f32>| {
            *sink.lock().unwrap() += 1;
        });
        let mut levels = LevelEmitter::new(Some(callback));
        let block = vec![0.25_f32; 512];
        for _ in 0..32 {
            levels.dispatch(&block);
        }
        assert_eq!(
            *seen.lock().unwrap(),
            0,
            "a burst inside one interval is silent"
        );

        // Once the interval has passed, the next block does emit, and only once.
        std::thread::sleep(LEVEL_DISPATCH_INTERVAL);
        levels.dispatch(&block);
        levels.dispatch(&block);
        assert_eq!(*seen.lock().unwrap(), 1);
    }

    /// A level callback that is absent must not compute bins at all.
    #[test]
    fn no_level_callback_is_a_no_op() {
        let mut levels = LevelEmitter::new(None);
        levels.dispatch(&vec![0.25_f32; 512]);
        assert!(levels.callback.is_none());
    }
}
