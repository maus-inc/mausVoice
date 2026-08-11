use serde::Serialize;
use std::sync::Arc;

use crate::platform::Recorder;

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InputDeviceDescriptor {
    pub label: String,
    pub is_default: bool,
    pub caution: bool,
}

pub fn new_recorder() -> Arc<dyn Recorder> {
    Arc::new(cpal_impl::RecordingManager::new())
}

pub fn list_input_devices() -> Vec<InputDeviceDescriptor> {
    cpal_impl::list_input_devices()
}

// ── CPAL backend (macOS, Windows) ──────────────────────────────────────

mod cpal_impl {
    use super::InputDeviceDescriptor;
    use crate::domain::{RecordedAudio, RecordingMetrics, RecordingResult};
    use crate::errors::RecordingError;
    use crate::platform::{ChunkCallback, LevelCallback, Recorder};
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{Device, HostId, SampleFormat, Stream, StreamConfig};
    use std::cmp;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, MutexGuard};
    use std::time::{Duration, Instant};

    #[derive(Clone)]
    struct CachedDeviceInfo {
        host_id: HostId,
        /// Disambiguated label, so the cache re-resolves the exact same device
        /// even when the host exposes several inputs under one name.
        device_label: String,
    }

    pub struct RecordingManager {
        inner: Arc<Mutex<Option<ActiveRecording>>>,
        preferred_input_name: Arc<Mutex<Option<String>>>,
        last_successful_device: Arc<Mutex<Option<CachedDeviceInfo>>>,
    }

    struct ActiveRecording {
        _stream: Stream,
        start: Instant,
        buffer: Arc<Mutex<Vec<f32>>>,
        sample_rate: u32,
        _level_emitter: Option<Arc<LevelEmitter>>,
        _chunk_emitter: Option<Arc<ChunkEmitter>>,
    }

    const LEVEL_BIN_COUNT: usize = 12;
    const LEVEL_DISPATCH_INTERVAL_MS: u64 = 48;
    const CHUNK_DISPATCH_INTERVAL_MS: u64 = 100;

    struct LevelEmitter {
        callback: LevelCallback,
        throttle: Duration,
        last_emit: Mutex<Option<Instant>>,
    }

    impl LevelEmitter {
        fn new(callback: LevelCallback) -> Arc<Self> {
            Arc::new(Self {
                callback,
                throttle: Duration::from_millis(LEVEL_DISPATCH_INTERVAL_MS),
                last_emit: Mutex::new(None),
            })
        }

        fn emit(&self, samples: &[f32]) {
            if samples.is_empty() {
                return;
            }

            let now = Instant::now();
            let should_emit = {
                let mut guard = match self.last_emit.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                let should_send = match *guard {
                    Some(last) => now.duration_since(last) >= self.throttle,
                    None => true,
                };
                if should_send {
                    *guard = Some(now);
                }
                should_send
            };

            if !should_emit {
                return;
            }

            let levels = compute_level_bins(samples);
            (self.callback)(levels);
        }
    }

    struct ChunkEmitter {
        callback: ChunkCallback,
        throttle: Duration,
        last_emit: Mutex<Option<Instant>>,
        buffer: Mutex<Vec<f32>>,
    }

    impl ChunkEmitter {
        fn new(callback: ChunkCallback) -> Arc<Self> {
            Arc::new(Self {
                callback,
                throttle: Duration::from_millis(CHUNK_DISPATCH_INTERVAL_MS),
                last_emit: Mutex::new(None),
                buffer: Mutex::new(Vec::new()),
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

            let now = Instant::now();
            let should_emit = {
                let mut guard = match self.last_emit.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                let should_send = match *guard {
                    Some(last) => now.duration_since(last) >= self.throttle,
                    None => true,
                };
                if should_send {
                    *guard = Some(now);
                }
                should_send
            };

            if should_emit {
                if let Ok(mut buffer) = self.buffer.lock() {
                    if !buffer.is_empty() {
                        let chunk = buffer.clone();
                        buffer.clear();
                        (self.callback)(chunk);
                    }
                }
            }
        }
    }

    fn compute_level_bins(samples: &[f32]) -> Vec<f32> {
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

    impl Drop for ActiveRecording {
        fn drop(&mut self) {
            if let Err(err) = self._stream.pause() {
                log::error!("failed to pause input stream: {err}");
            }
        }
    }

    // cpal::Stream is not Send/Sync across every platform, but we only ever create,
    // use, and drop it on the dedicated event tap thread. The interior mutex prevents
    // concurrent access, so it is safe for our usage to share the manager/type
    // between threads.
    unsafe impl Send for RecordingManager {}
    unsafe impl Sync for RecordingManager {}
    unsafe impl Send for ActiveRecording {}
    unsafe impl Sync for ActiveRecording {}

    impl Default for RecordingManager {
        fn default() -> Self {
            Self::new()
        }
    }

    impl RecordingManager {
        pub fn new() -> Self {
            Self {
                inner: Arc::new(Mutex::new(None)),
                preferred_input_name: Arc::new(Mutex::new(None)),
                last_successful_device: Arc::new(Mutex::new(None)),
            }
        }

        fn cache_successful_device(&self, host_id: HostId, device_label: String) {
            if let Ok(mut guard) = self.last_successful_device.lock() {
                *guard = Some(CachedDeviceInfo {
                    host_id,
                    device_label,
                });
            }
        }

        fn try_cached_device(
            &self,
            level_emitter: Option<Arc<LevelEmitter>>,
            chunk_emitter: Option<Arc<ChunkEmitter>>,
            preferred_normalized: Option<&str>,
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

            // Fast path: try the cached device first (avoids full enumeration)
            if let Some((active, host_id, device_name)) = self.try_cached_device(
                level_emitter.clone(),
                chunk_emitter.clone(),
                preferred_normalized.as_deref(),
            ) {
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
                ) {
                    Ok((active, device_name)) => {
                        *guard = Some(active);
                        self.cache_successful_device(host_id, device_name);
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

        fn pause_recording(&self) -> Result<(), RecordingError> {
            let guard = self
                .inner
                .lock()
                .map_err(|_| RecordingError::NotRecording)?;
            let recording = guard.as_ref().ok_or(RecordingError::NotRecording)?;
            recording
                ._stream
                .pause()
                .map_err(|err| RecordingError::StreamPlay(err.to_string()))?;
            Ok(())
        }

        fn resume_recording(&self) -> Result<(), RecordingError> {
            let guard = self
                .inner
                .lock()
                .map_err(|_| RecordingError::NotRecording)?;
            let recording = guard.as_ref().ok_or(RecordingError::NotRecording)?;
            recording
                ._stream
                .play()
                .map_err(|err| RecordingError::StreamPlay(err.to_string()))?;
            Ok(())
        }

        fn stop_recording(&self) -> Result<RecordingResult, RecordingError> {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| RecordingError::NotRecording)?;
            let recording = guard.take().ok_or(RecordingError::NotRecording)?;

            let samples = recording
                .buffer
                .lock()
                .map(|buffer| buffer.clone())
                .unwrap_or_default();
            let sample_rate = recording.sample_rate;
            let fallback_duration = recording.start.elapsed();
            let duration = if !samples.is_empty() && sample_rate > 0 {
                let duration_secs = samples.len() as f64 / f64::from(sample_rate);
                std::time::Duration::from_secs_f64(duration_secs)
            } else {
                fallback_duration
            };
            let size_bytes = samples.len() as u64 * std::mem::size_of::<f32>() as u64;

            drop(recording);

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

            match self.preferred_input_name.lock() {
                Ok(mut guard) => {
                    *guard = sanitized;
                }
                Err(poisoned) => {
                    *poisoned.into_inner() = sanitized;
                }
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

    fn ordered_host_ids() -> Vec<HostId> {
        let default_host = cpal::default_host();
        let default_id = default_host.id();
        let mut others: Vec<HostId> = cpal::available_hosts()
            .into_iter()
            .filter(|id| *id != default_id)
            .collect();
        others.sort_by_key(|id| host_rank(*id));

        let mut ordered = Vec::with_capacity(others.len() + 1);
        ordered.push(default_id);
        ordered.extend(others);
        ordered
    }

    fn host_rank(_id: HostId) -> u8 {
        0
    }

    fn try_start_on_device(
        device: &Device,
        device_name: Option<&str>,
        level_emitter: Option<Arc<LevelEmitter>>,
        chunk_emitter: Option<Arc<ChunkEmitter>>,
    ) -> Result<ActiveRecording, RecordingError> {
        let label = device_name.unwrap_or(UNKNOWN_DEVICE_LABEL);

        let config = device
            .default_input_config()
            .map_err(|err| RecordingError::StreamConfig(err.to_string()))?;

        let sample_format = config.sample_format();
        let stream_config: StreamConfig = config.into();
        let sample_rate = stream_config.sample_rate.0;
        let buffer = Arc::new(Mutex::new(Vec::<f32>::new()));

        let stream = match sample_format {
            SampleFormat::I16 => build_input_stream::<i16>(
                device,
                &stream_config,
                buffer.clone(),
                level_emitter.clone(),
                chunk_emitter.clone(),
            ),
            SampleFormat::U16 => build_input_stream::<u16>(
                device,
                &stream_config,
                buffer.clone(),
                level_emitter.clone(),
                chunk_emitter.clone(),
            ),
            SampleFormat::F32 => build_input_stream::<f32>(
                device,
                &stream_config,
                buffer.clone(),
                level_emitter.clone(),
                chunk_emitter.clone(),
            ),
            other => return Err(RecordingError::UnsupportedFormat(other)),
        }?;

        stream
            .play()
            .map_err(|err| RecordingError::StreamPlay(err.to_string()))?;

        log::info!("started on device '{label}'");

        Ok(ActiveRecording {
            _stream: stream,
            start: Instant::now(),
            buffer,
            sample_rate,
            _level_emitter: level_emitter,
            _chunk_emitter: chunk_emitter,
        })
    }

    fn start_recording_on_host(
        host: &cpal::Host,
        level_emitter: Option<Arc<LevelEmitter>>,
        chunk_emitter: Option<Arc<ChunkEmitter>>,
        preferred_label: Option<&str>,
        preferred_normalized: Option<&str>,
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

            let config = match device.default_input_config() {
                Ok(cfg) => cfg,
                Err(err) => {
                    log::warn!("device '{label}' rejected default config: {err}");
                    last_err = Some(RecordingError::StreamConfig(err.to_string()));
                    continue;
                }
            };

            let sample_format = config.sample_format();
            let stream_config: StreamConfig = config.into();
            let sample_rate = stream_config.sample_rate.0;
            let buffer = Arc::new(Mutex::new(Vec::<f32>::new()));

            let stream_result = match sample_format {
                SampleFormat::I16 => build_input_stream::<i16>(
                    &device,
                    &stream_config,
                    buffer.clone(),
                    level_emitter.clone(),
                    chunk_emitter.clone(),
                ),
                SampleFormat::U16 => build_input_stream::<u16>(
                    &device,
                    &stream_config,
                    buffer.clone(),
                    level_emitter.clone(),
                    chunk_emitter.clone(),
                ),
                SampleFormat::F32 => build_input_stream::<f32>(
                    &device,
                    &stream_config,
                    buffer.clone(),
                    level_emitter.clone(),
                    chunk_emitter.clone(),
                ),
                other => {
                    log::warn!("device '{label}' has unsupported sample format: {other:?}");
                    last_err = Some(RecordingError::UnsupportedFormat(other));
                    continue;
                }
            };

            let stream = match stream_result {
                Ok(stream) => stream,
                Err(err) => {
                    log::error!("failed to build stream for '{label}': {err}");
                    last_err = Some(err);
                    continue;
                }
            };

            if let Err(err) = stream.play() {
                log::error!("failed to start stream for '{label}': {err}");
                last_err = Some(RecordingError::StreamPlay(err.to_string()));
                continue;
            }

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

            return Ok((
                ActiveRecording {
                    _stream: stream,
                    start: Instant::now(),
                    buffer,
                    sample_rate,
                    _level_emitter: level_emitter.clone(),
                    _chunk_emitter: chunk_emitter.clone(),
                },
                label.to_string(),
            ));
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

    fn normalized_name(value: &str) -> String {
        value.trim().to_ascii_lowercase()
    }

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

        // Either the host does not enumerate its own default, or the enumeration
        // failed outright and the default is all we have; keep it either way so
        // recording still has a target.
        let default_missing =
            default_index.is_none() && (default_normalized.is_some() || devices.is_empty());
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

    fn find_device_by_label(host: &cpal::Host, target_label: &str) -> Option<Device> {
        let target = normalized_name(target_label);
        labelled_devices_for_host(host)
            .into_iter()
            .find(|entry| normalized_name(&entry.label) == target)
            .map(|entry| entry.device)
    }

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

    fn build_input_stream<T>(
        device: &Device,
        config: &StreamConfig,
        buffer: Arc<Mutex<Vec<f32>>>,
        level_emitter: Option<Arc<LevelEmitter>>,
        chunk_emitter: Option<Arc<ChunkEmitter>>,
    ) -> Result<Stream, RecordingError>
    where
        T: cpal::Sample + cpal::SizedSample,
        f32: cpal::FromSample<T>,
    {
        let channel_count = cmp::max(config.channels as usize, 1);
        let callback_buffer = buffer.clone();
        let level_emitter_ref = level_emitter;
        let chunk_emitter_ref = chunk_emitter;
        device
            .build_input_stream(
                config,
                move |data: &[T], _| {
                    let mut mono_samples = Vec::with_capacity(data.len() / channel_count + 1);

                    if channel_count == 1 {
                        for sample in data {
                            let value = (*sample).to_sample::<f32>();
                            mono_samples.push(value);
                        }
                    } else {
                        let mut index = 0;
                        while index < data.len() {
                            let mut sum = 0.0f32;
                            let mut samples_in_frame = 0usize;
                            for channel in 0..channel_count {
                                let sample_index = index + channel;
                                if sample_index >= data.len() {
                                    break;
                                }
                                let sample_value = data[sample_index].to_sample::<f32>();
                                sum += sample_value;
                                samples_in_frame += 1;
                            }
                            if samples_in_frame > 0 {
                                mono_samples.push(sum / samples_in_frame as f32);
                            }
                            index += channel_count;
                        }
                    }

                    if let Some(ref level_emitter) = level_emitter_ref {
                        level_emitter.emit(&mono_samples);
                    }

                    if let Some(ref chunk_emitter) = chunk_emitter_ref {
                        chunk_emitter.emit(&mono_samples);
                    }

                    if let Ok(mut shared_buffer) = callback_buffer.lock() {
                        shared_buffer.extend_from_slice(&mono_samples);
                    }
                },
                |err| log::error!("stream error: {err}"),
                None,
            )
            .map_err(|err| RecordingError::StreamBuild(err.to_string()))
    }

    #[cfg(test)]
    mod tests {
        use super::{device_matches_preferred, disambiguated_label, is_preferred_input_device_name};

        #[test]
        fn first_device_keeps_its_bare_name() {
            assert_eq!(
                disambiguated_label("Yeti Stereo Microphone", 0),
                "Yeti Stereo Microphone"
            );
        }

        #[test]
        fn repeated_names_get_an_ordinal_suffix() {
            assert_eq!(disambiguated_label("USB Microphone", 1), "USB Microphone (2)");
            assert_eq!(disambiguated_label("USB Microphone", 2), "USB Microphone (3)");
        }

        #[test]
        fn preferences_match_labels_case_insensitively() {
            assert!(device_matches_preferred("USB Microphone (2)", "usb microphone (2)"));
            assert!(!device_matches_preferred("USB Microphone", "usb microphone (2)"));
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
