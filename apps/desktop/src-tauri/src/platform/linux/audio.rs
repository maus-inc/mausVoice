use crate::domain::{RecordedAudio, RecordingMetrics, RecordingResult};
use crate::errors::RecordingError;
use crate::platform::audio::{
    compute_level_bins, retain_finite_prefix, InputDeviceDescriptor, CHUNK_DISPATCH_INTERVAL,
    LEVEL_DISPATCH_INTERVAL,
};
use crate::platform::{ChunkCallback, LevelCallback, Recorder};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use libpulse_binding as pulse;
use libpulse_binding::mainloop::standard::Mainloop;

const FALLBACK_SAMPLE_RATE: u32 = 44_100;
const READ_CHUNK_FRAMES: usize = 1024;

pub struct PulseRecorder {
    inner: Arc<Mutex<Option<ActiveRecording>>>,
    preferred_source: Arc<Mutex<Option<String>>>,
}

struct ActiveRecording {
    stop_signal: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<Result<RecordingResult, String>>>,
    sample_rate: u32,
}

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
                .unwrap_or_else(std::sync::PoisonError::into_inner);
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

        let stop_signal = Arc::new(AtomicBool::new(false));
        let stop_signal_clone = Arc::clone(&stop_signal);
        let (ready_tx, ready_rx) = mpsc::channel();

        let thread = std::thread::Builder::new()
            .name("pulse-recorder".into())
            .spawn(move || {
                let result = record_loop(
                    source_name.as_deref(),
                    native_rate,
                    stop_signal_clone,
                    level_callback,
                    chunk_callback,
                    &ready_tx,
                );
                if let Err(error) = &result {
                    let _ = ready_tx.send(Err(error.clone()));
                }
                result
            })
            .map_err(|err| RecordingError::StreamBuild(err.to_string()))?;

        match ready_rx.recv_timeout(Duration::from_secs(6)) {
            Ok(Ok(())) => {}
            result => {
                stop_signal.store(true, Ordering::Release);
                let _ = thread.join();
                let error = match result {
                    Ok(Err(error)) => error,
                    Err(error) => format!("PulseAudio startup failed: {error}"),
                    Ok(Ok(())) => unreachable!(),
                };
                return Err(Box::new(RecordingError::StreamBuild(error)));
            }
        }

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
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut recording = guard.take().ok_or(RecordingError::NotRecording)?;

        recording.stop_signal.store(true, Ordering::Release);

        let thread = recording
            .thread
            .take()
            .ok_or(RecordingError::NotRecording)?;
        let result = thread
            .join()
            .map_err(|_| RecordingError::StreamBuild("recording thread panicked".into()))?
            .map_err(RecordingError::StreamBuild)?;

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

    fn is_recording(&self) -> bool {
        self.current_sample_rate().is_some()
    }

    fn current_sample_rate(&self) -> Option<u32> {
        let guard = match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard.as_ref().map(|r| r.sample_rate)
    }

    fn pause(&self) -> Result<(), Box<dyn std::error::Error>> {
        // The capture worker does not yet implement pause/resume.
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

fn pulse_iterate(mainloop: &mut Mainloop) -> Result<(), String> {
    match mainloop.iterate(false) {
        pulse::mainloop::standard::IterateResult::Success(_) => Ok(()),
        pulse::mainloop::standard::IterateResult::Quit(_) => {
            Err("PulseAudio mainloop stopped".into())
        }
        pulse::mainloop::standard::IterateResult::Err(error) => {
            Err(format!("PulseAudio mainloop failed: {error}"))
        }
    }
}

fn wait_for_pulse(
    mainloop: &mut Mainloop,
    stop: &AtomicBool,
    mut state: impl FnMut() -> Result<bool, String>,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if stop.load(Ordering::Acquire) {
            return Err("Recording start was cancelled".into());
        }
        if state()? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("PulseAudio startup timed out".into());
        }
        pulse_iterate(mainloop)?;
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn pulse_samples(fragment: pulse::stream::PeekResult<'_>) -> Result<Option<Vec<f32>>, String> {
    match fragment {
        pulse::stream::PeekResult::Empty => Ok(None),
        pulse::stream::PeekResult::Hole(bytes) => {
            if bytes % 4 != 0 {
                return Err("Invalid PulseAudio sample alignment".into());
            }
            Ok(Some(vec![0.0; bytes / 4]))
        }
        pulse::stream::PeekResult::Data(bytes) => {
            if bytes.len() % 4 != 0 {
                return Err("Invalid PulseAudio sample alignment".into());
            }
            Ok(Some(
                bytes
                    .chunks_exact(4)
                    .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                    .collect(),
            ))
        }
    }
}

fn record_loop(
    source_name: Option<&str>,
    sample_rate: u32,
    stop_signal: Arc<AtomicBool>,
    level_callback: Option<LevelCallback>,
    chunk_callback: Option<ChunkCallback>,
    ready: &mpsc::Sender<Result<(), String>>,
) -> Result<RecordingResult, String> {
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
        fragsize: (READ_CHUNK_FRAMES * std::mem::size_of::<f32>()) as u32,
    };
    let mut mainloop = Mainloop::new().ok_or("failed to create PulseAudio mainloop")?;
    let mut context = pulse::context::Context::new(&mainloop, "mausVoice")
        .ok_or("failed to create PulseAudio context")?;
    context
        .connect(None, pulse::context::FlagSet::NOFLAGS, None)
        .map_err(|error| format!("failed to connect PulseAudio: {error}"))?;
    wait_for_pulse(&mut mainloop, &stop_signal, || match context.get_state() {
        pulse::context::State::Ready => Ok(true),
        pulse::context::State::Failed | pulse::context::State::Terminated => {
            Err("PulseAudio context failed".into())
        }
        _ => Ok(false),
    })?;
    let mut stream = pulse::stream::Stream::new(&mut context, "Recording", &spec, None)
        .ok_or("failed to create PulseAudio stream")?;
    stream
        .connect_record(source_name, Some(&attr), pulse::stream::FlagSet::NOFLAGS)
        .map_err(|error| format!("failed to open PulseAudio stream: {error}"))?;
    wait_for_pulse(&mut mainloop, &stop_signal, || match stream.get_state() {
        pulse::stream::State::Ready => Ok(true),
        pulse::stream::State::Failed | pulse::stream::State::Terminated => {
            Err("PulseAudio stream failed".into())
        }
        _ => Ok(false),
    })?;
    if ready.send(Ok(())).is_err() {
        return Err("Recording start was cancelled".into());
    }

    log::info!(
        "PulseAudio recording started (source: {})",
        source_name.unwrap_or("default")
    );

    Ok(capture_samples(
        sample_rate,
        &stop_signal,
        level_callback,
        chunk_callback,
        |stopping| {
            if !stopping {
                pulse_iterate(&mut mainloop)?;
            }
            match stream.get_state() {
                pulse::stream::State::Failed | pulse::stream::State::Terminated => {
                    return Err("PulseAudio recording stream failed".into())
                }
                _ => {}
            }
            let samples = pulse_samples(
                stream
                    .peek()
                    .map_err(|error| format!("PulseAudio read failed: {error}"))?,
            )?;
            if samples.is_some() {
                stream
                    .discard()
                    .map_err(|error| format!("PulseAudio discard failed: {error}"))?;
            }
            Ok(samples)
        },
    ))
}

/// One step of the capture loop, so the loop body itself stays a flat match
/// instead of nesting the buffer, callback, and shutdown cases together.
enum CaptureStep {
    Samples(Vec<f32>),
    /// No samples were ready yet; the caller should poll again.
    Idle,
    /// The recorder is stopping and the source has nothing left to hand over.
    Stopped,
    Failed(String),
}

fn read_capture_step(
    read: &mut impl FnMut(bool) -> Result<Option<Vec<f32>>, String>,
    stopping: bool,
) -> CaptureStep {
    match read(stopping) {
        Ok(Some(samples)) => CaptureStep::Samples(samples),
        Ok(None) if stopping => CaptureStep::Stopped,
        Ok(None) => {
            std::thread::sleep(Duration::from_millis(5));
            CaptureStep::Idle
        }
        Err(error) => CaptureStep::Failed(error),
    }
}

fn emit_level_bins(callback: Option<&LevelCallback>, samples: &[f32], last_emit: &mut Instant) {
    let Some(callback) = callback else {
        return;
    };
    let now = Instant::now();
    if now.duration_since(*last_emit) < LEVEL_DISPATCH_INTERVAL {
        return;
    }
    *last_emit = now;
    callback(compute_level_bins(samples));
}

fn emit_audio_chunks(
    callback: Option<&ChunkCallback>,
    chunk_buffer: &mut Vec<f32>,
    emitted_samples: &mut u64,
    last_emit: &mut Instant,
    samples: &[f32],
) {
    let Some(callback) = callback else {
        return;
    };
    chunk_buffer.extend_from_slice(samples);
    let now = Instant::now();
    if now.duration_since(*last_emit) < CHUNK_DISPATCH_INTERVAL {
        return;
    }
    *last_emit = now;
    if chunk_buffer.is_empty() {
        return;
    }
    let offset = *emitted_samples;
    let batch = std::mem::take(chunk_buffer);
    *emitted_samples += batch.len() as u64;
    callback(batch, offset);
}

fn flush_audio_chunks(
    callback: Option<&ChunkCallback>,
    chunk_buffer: &mut Vec<f32>,
    emitted_samples: u64,
) {
    let Some(callback) = callback else {
        return;
    };
    if chunk_buffer.is_empty() {
        return;
    }
    callback(std::mem::take(chunk_buffer), emitted_samples);
}

fn capture_samples(
    sample_rate: u32,
    stop_signal: &AtomicBool,
    level_callback: Option<LevelCallback>,
    chunk_callback: Option<ChunkCallback>,
    mut read: impl FnMut(bool) -> Result<Option<Vec<f32>>, String>,
) -> RecordingResult {
    let start = Instant::now();
    let mut all_samples: Vec<f32> = Vec::new();
    let mut last_level_emit = Instant::now();
    let mut last_chunk_emit = Instant::now();
    let mut chunk_buffer: Vec<f32> = Vec::new();
    let mut emitted_samples: u64 = 0;
    let mut capture_failed = false;

    loop {
        let stopping = stop_signal.load(Ordering::Acquire);
        let mut samples = match read_capture_step(&mut read, stopping) {
            CaptureStep::Samples(samples) => samples,
            CaptureStep::Idle => continue,
            CaptureStep::Stopped => break,
            CaptureStep::Failed(error) => {
                log::error!("PulseAudio read failed: {error}");
                capture_failed = true;
                break;
            }
        };

        let finite = retain_finite_prefix(&mut samples);
        capture_failed |= !finite;
        // Accumulate for final result
        all_samples.extend_from_slice(&samples);
        emit_level_bins(level_callback.as_ref(), &samples, &mut last_level_emit);
        emit_audio_chunks(
            chunk_callback.as_ref(),
            &mut chunk_buffer,
            &mut emitted_samples,
            &mut last_chunk_emit,
            &samples,
        );
        if !finite {
            break;
        }
    }

    flush_audio_chunks(chunk_callback.as_ref(), &mut chunk_buffer, emitted_samples);

    if capture_failed {
        for sample in &mut all_samples {
            if !sample.is_finite() {
                *sample = 0.0;
            }
        }
    }

    let duration = if !all_samples.is_empty() {
        Duration::from_secs_f64(all_samples.len() as f64 / f64::from(sample_rate))
    } else {
        start.elapsed()
    };
    let size_bytes = all_samples.len() as u64 * std::mem::size_of::<f32>() as u64;

    RecordingResult {
        metrics: RecordingMetrics {
            duration,
            size_bytes,
        },
        audio: RecordedAudio {
            samples: all_samples,
            sample_rate,
        },
        capture_failed,
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

fn poll_pulse_before(mainloop: &mut Mainloop, deadline: Instant) -> bool {
    if Instant::now() >= deadline || pulse_iterate(mainloop).is_err() {
        return false;
    }
    std::thread::sleep(Duration::from_millis(5));
    true
}

fn read_flag(flag: &Mutex<bool>) -> bool {
    flag.lock().map(|done| *done).unwrap_or(false)
}

fn set_flag(flag: &Mutex<bool>) {
    if let Ok(mut done) = flag.lock() {
        *done = true;
    }
}

/// Pump the mainloop until `done` is set or the deadline passes. Both callers
/// treat a timeout and a mainloop failure the same way: take whatever was
/// collected and move on.
fn wait_for_pulse_flag(mainloop: &mut Mainloop, done: &Mutex<bool>, deadline: Instant) {
    while !read_flag(done) && poll_pulse_before(mainloop, deadline) {}
}

fn connect_pulse_context(
    mainloop: &mut Mainloop,
    deadline: Instant,
) -> Option<pulse::context::Context> {
    let mut ctx = pulse::context::Context::new(mainloop, "mausVoice Enumerate")?;

    if ctx
        .connect(None, pulse::context::FlagSet::NOFLAGS, None)
        .is_err()
    {
        log::error!("failed to connect PulseAudio context");
        return None;
    }

    loop {
        if !poll_pulse_before(mainloop, deadline) {
            log::error!("PulseAudio mainloop failed or timed out during connect");
            return None;
        }
        match ctx.get_state() {
            pulse::context::State::Ready => return Some(ctx),
            pulse::context::State::Failed | pulse::context::State::Terminated => {
                log::error!("PulseAudio context failed to connect");
                return None;
            }
            _ => {}
        }
    }
}

fn pulse_source_from_info(
    info: &pulse::context::introspect::SourceInfo<'_>,
    default_name: &str,
) -> PulseSource {
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
    PulseSource {
        is_default: name == default_name,
        name,
        description,
        is_monitor: info.monitor_of_sink.is_some(),
        sample_rate: info.sample_spec.rate,
    }
}

fn take_pulse_sources(sources: Arc<Mutex<Vec<PulseSource>>>) -> Vec<PulseSource> {
    match Arc::try_unwrap(sources) {
        Ok(mutex) => mutex.into_inner().unwrap_or_default(),
        Err(arc) => arc
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone(),
    }
}

fn enumerate_pulse_sources() -> Vec<PulseSource> {
    let deadline = Instant::now() + Duration::from_secs(3);
    let Some(mut ml) = Mainloop::new() else {
        log::error!("failed to create PulseAudio mainloop");
        return Vec::new();
    };
    let Some(mut ctx) = connect_pulse_context(&mut ml, deadline) else {
        return Vec::new();
    };
    let introspect = ctx.introspect();

    // Get the default source name from server info.
    let default_source: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let default_source_clone = Arc::clone(&default_source);
    let server_done = Arc::new(Mutex::new(false));
    let server_done_clone = Arc::clone(&server_done);
    introspect.get_server_info(move |info| {
        if let Some(ref name) = info.default_source_name {
            if let Ok(mut guard) = default_source_clone.lock() {
                *guard = Some(name.to_string());
            }
        }
        set_flag(&server_done_clone);
    });
    wait_for_pulse_flag(&mut ml, &server_done, deadline);

    let default_name = default_source
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default();

    // Enumerate sources.
    let sources: Arc<Mutex<Vec<PulseSource>>> = Arc::new(Mutex::new(Vec::new()));
    let sources_clone = Arc::clone(&sources);
    let default_name_clone = default_name.clone();
    let list_done = Arc::new(Mutex::new(false));
    let list_done_clone = Arc::clone(&list_done);
    introspect.get_source_info_list(move |result| match result {
        pulse::callbacks::ListResult::Item(info) => {
            if let Ok(mut guard) = sources_clone.lock() {
                guard.push(pulse_source_from_info(info, &default_name_clone));
            }
        }
        pulse::callbacks::ListResult::End | pulse::callbacks::ListResult::Error => {
            set_flag(&list_done_clone);
        }
    });
    wait_for_pulse_flag(&mut ml, &list_done, deadline);

    ctx.disconnect();

    take_pulse_sources(sources)
}

/// List microphone sources via PulseAudio, filtering out monitors.
/// Returns descriptors compatible with the existing UI.
pub fn list_pulse_input_devices() -> Vec<InputDeviceDescriptor> {
    let sources = enumerate_pulse_sources();

    let mut devices: Vec<InputDeviceDescriptor> = sources
        .into_iter()
        .filter(|s| !s.is_monitor)
        .map(|s| InputDeviceDescriptor {
            label: s.description,
            is_default: s.is_default,
            caution: false,
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
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::mpsc;

    #[test]
    fn pulse_fragments_preserve_float_samples_and_silence_holes() {
        let bytes = [0.5f32.to_le_bytes(), (-0.25f32).to_le_bytes()].concat();
        assert_eq!(
            pulse_samples(pulse::stream::PeekResult::Data(&bytes)).unwrap(),
            Some(vec![0.5, -0.25])
        );
        assert_eq!(
            pulse_samples(pulse::stream::PeekResult::Hole(8)).unwrap(),
            Some(vec![0.0, 0.0])
        );
        assert_eq!(
            pulse_samples(pulse::stream::PeekResult::Empty).unwrap(),
            None
        );
        assert!(pulse_samples(pulse::stream::PeekResult::Data(&[1, 2, 3])).is_err());
        assert!(pulse_samples(pulse::stream::PeekResult::Hole(3)).is_err());
    }

    #[test]
    fn stopping_drains_buffered_chunks_and_preserves_offsets() {
        let stop = AtomicBool::new(true);
        let mut batches = VecDeque::from([vec![0.25, 0.5], vec![-0.25]]);
        let chunks = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&chunks);
        let callback: ChunkCallback =
            Arc::new(move |samples, offset| recorded.lock().unwrap().push((samples, offset)));
        let result = capture_samples(1_000, &stop, None, Some(callback), |_| {
            Ok(batches.pop_front())
        });
        assert_eq!(result.audio.samples, vec![0.25, 0.5, -0.25]);
        assert_eq!(*chunks.lock().unwrap(), vec![(vec![0.25, 0.5, -0.25], 0)]);
        assert_eq!(result.audio.sample_rate, 1_000);
    }

    #[test]
    fn non_finite_input_returns_and_emits_only_the_valid_prefix() {
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let stop = AtomicBool::new(false);
            let mut batches = VecDeque::from([vec![0.25], vec![0.5, bad, -0.25]]);
            let chunks = Arc::new(Mutex::new(Vec::new()));
            let recorded = Arc::clone(&chunks);
            let callback: ChunkCallback = Arc::new(move |samples, offset| {
                recorded.lock().unwrap().push((samples, offset));
            });
            let result = capture_samples(1_000, &stop, None, Some(callback), |_| {
                Ok(Some(
                    batches.pop_front().expect("must stop at invalid input"),
                ))
            });
            assert!(result.capture_failed);
            assert_eq!(result.audio.samples, vec![0.25, 0.5]);
            assert_eq!(*chunks.lock().unwrap(), vec![(vec![0.25, 0.5], 0)]);
        }
    }

    #[test]
    fn stream_error_returns_and_emits_partial_recording() {
        let stop = AtomicBool::new(false);
        let mut calls = 0;
        let chunks = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&chunks);
        let callback: ChunkCallback = Arc::new(move |samples, offset| {
            recorded.lock().unwrap().push((samples, offset));
        });
        let result = capture_samples(1_000, &stop, None, Some(callback), |_| {
            calls += 1;
            if calls == 1 {
                Ok(Some(vec![0.25, -0.5]))
            } else {
                Err("disconnected".into())
            }
        });
        assert_eq!(result.audio.samples, vec![0.25, -0.5]);
        assert_eq!(*chunks.lock().unwrap(), vec![(vec![0.25, -0.5], 0)]);
    }

    #[test]
    fn silent_capture_stops_without_waiting_for_an_audio_fragment() {
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let (reading_tx, reading_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = capture_samples(1_000, &worker_stop, None, None, |_| {
                let _ = reading_tx.send(());
                Ok(None)
            });
            finished_tx.send(result).unwrap();
        });
        reading_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        stop.store(true, Ordering::Release);
        let result = finished_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(result.audio.samples.is_empty());
        worker.join().unwrap();
    }

    #[test]
    fn stopped_start_does_not_poll_pulse() {
        let mut mainloop = Mainloop::new().unwrap();
        let stop = AtomicBool::new(true);
        assert!(
            wait_for_pulse(&mut mainloop, &stop, || -> Result<bool, String> {
                panic!("cancelled startup polled the server")
            })
            .is_err()
        );
    }

    // Run explicitly against an isolated PulseAudio server with a null source,
    // Set PULSE_SERVER to its socket and PULSE_SOURCE=maus_test before running.
    #[test]
    #[ignore = "requires an isolated PulseAudio server with a null source"]
    fn pulse_null_source_capture() {
        assert!(std::env::var("PULSE_SERVER")
            .is_ok_and(|server| server.starts_with("unix:") && server.len() > 5));
        assert_eq!(std::env::var("PULSE_SOURCE").as_deref(), Ok("maus_test"));
        let recorder = PulseRecorder::new();
        let (chunk_tx, chunk_rx) = mpsc::channel();
        let callback: ChunkCallback = Arc::new(move |samples, offset| {
            let _ = chunk_tx.send((samples, offset));
        });
        recorder.start(None, Some(callback)).unwrap();
        assert!(recorder.is_recording());
        let first = chunk_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(first.1, 0);
        let started = Instant::now();
        let result = recorder.stop().unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!recorder.is_recording());
        let mut samples = first.0;
        for (chunk, offset) in chunk_rx.try_iter() {
            assert_eq!(offset, samples.len() as u64);
            samples.extend(chunk);
        }
        assert!(!samples.is_empty());
        assert_eq!(samples, result.audio.samples);
        assert!(result.audio.sample_rate > 0);

        // A second recording must acquire the source after the first worker exits.
        recorder.start(None, None).unwrap();
        recorder.stop().unwrap();
        assert!(!recorder.is_recording());

        // Exercise ownership with an actual PulseAudio stream, not just a fake
        // recorder: a competing owner cannot acquire it until release finishes.
        use crate::platform::recording_ownership::{RecordingOwnership, StartControl};
        let ownership = RecordingOwnership::default();
        let window = ownership.window(1);
        let cancelled = AtomicBool::new(false);
        let generation = ownership.reserve("first", &window).unwrap();
        let admission = ownership
            .claim_admission("first", &window, generation)
            .unwrap();
        ownership
            .start(
                "first",
                &window,
                generation,
                StartControl {
                    cancelled: &cancelled,
                    admission: Some(&admission),
                    wait: Duration::ZERO,
                },
                || {
                    recorder
                        .start(None, None)
                        .map_err(|error| error.to_string())
                },
                || false,
            )
            .unwrap();
        ownership.finish_admission(&admission);
        let generation = ownership.reserve("second", &window).unwrap();
        let admission = ownership
            .claim_admission("second", &window, generation)
            .unwrap();
        assert!(ownership
            .start(
                "second",
                &window,
                generation,
                StartControl {
                    cancelled: &cancelled,
                    admission: Some(&admission),
                    wait: Duration::ZERO,
                },
                || -> Result<(), String> { panic!("a competing recording must not start") },
                || false,
            )
            .is_err());
        ownership.finish_admission(&admission);
        assert!(recorder.is_recording());
        ownership
            .discard("second", || -> (Result<(), String>, bool) {
                panic!("a different owner must not stop the recorder")
            })
            .unwrap();
        ownership
            .stop("first", || {
                let result = recorder.stop().map_err(|error| error.to_string());
                (result, recorder.is_recording())
            })
            .unwrap();
        assert!(!recorder.is_recording());
        let generation = ownership.reserve("successor", &window).unwrap();
        let admission = ownership
            .claim_admission("successor", &window, generation)
            .unwrap();
        ownership
            .start(
                "successor",
                &window,
                generation,
                StartControl {
                    cancelled: &cancelled,
                    admission: Some(&admission),
                    wait: Duration::ZERO,
                },
                || {
                    recorder
                        .start(None, None)
                        .map_err(|error| error.to_string())
                },
                || false,
            )
            .unwrap();
        ownership.finish_admission(&admission);
        ownership.begin_reset().unwrap();
        assert!(ownership.reserve("during-reset", &window).is_err());
        ownership
            .force_stop(|| {
                let result = recorder
                    .stop()
                    .map(|_| ())
                    .map_err(|error| error.to_string());
                (result, recorder.is_recording())
            })
            .unwrap();
        assert!(!recorder.is_recording());
        assert!(ownership.reserve("still-resetting", &window).is_err());
        ownership.end_reset();
        assert!(ownership.reserve("after-reset", &window).is_ok());
        ownership.cancel_admission("after-reset");
    }

    #[test]
    fn missing_pulse_server_rejects_start() {
        const CHILD: &str = "MAUS_PULSE_FAILURE_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let recorder = PulseRecorder::new();
            assert!(recorder.start(None, None).is_err());
            assert!(!recorder.is_recording());
            return;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "platform::linux::audio::tests::missing_pulse_server_rejects_start",
            ])
            .env(CHILD, "1")
            .env("PULSE_SERVER", "unix:/nonexistent/maus-pulse-socket")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    }
}
