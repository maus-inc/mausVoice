extern crate alsa;
extern crate libc;

use self::alsa::poll::Descriptors;
use crate::traits::{DeviceTrait, HostTrait, StreamTrait};
use crate::{
    BackendSpecificError, BufferSize, BuildStreamError, ChannelCount, Data,
    DefaultStreamConfigError, DeviceNameError, DevicesError, InputCallbackInfo, OutputCallbackInfo,
    PauseStreamError, PlayStreamError, SampleFormat, SampleRate, StreamConfig, StreamError,
    SupportedBufferSize, SupportedStreamConfig, SupportedStreamConfigRange,
    SupportedStreamConfigsError,
};
use std::cmp;
use std::convert::TryInto;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use std::vec::IntoIter as VecIntoIter;

pub use self::enumerate::{default_input_device, default_output_device, Devices};

pub type SupportedInputConfigs = VecIntoIter<SupportedStreamConfigRange>;
pub type SupportedOutputConfigs = VecIntoIter<SupportedStreamConfigRange>;

mod enumerate;
mod input_probe;
mod input_start;
mod output_pending;
mod stream_buffer;

const ALSA_SAMPLE_FORMATS: [SampleFormat; 8] = [
    SampleFormat::I8,
    SampleFormat::U8,
    SampleFormat::I16,
    SampleFormat::U16,
    SampleFormat::I32,
    SampleFormat::U32,
    SampleFormat::F32,
    SampleFormat::F64,
];

fn alsa_format_for_sample(sample: SampleFormat, big_endian: bool) -> Option<alsa::pcm::Format> {
    use alsa::pcm::Format;
    match (sample, big_endian) {
        (SampleFormat::I8, _) => Some(Format::S8),
        (SampleFormat::U8, _) => Some(Format::U8),
        (SampleFormat::I16, false) => Some(Format::S16LE),
        (SampleFormat::I16, true) => Some(Format::S16BE),
        (SampleFormat::U16, false) => Some(Format::U16LE),
        (SampleFormat::U16, true) => Some(Format::U16BE),
        (SampleFormat::I32, false) => Some(Format::S32LE),
        (SampleFormat::I32, true) => Some(Format::S32BE),
        (SampleFormat::U32, false) => Some(Format::U32LE),
        (SampleFormat::U32, true) => Some(Format::U32BE),
        (SampleFormat::F32, false) => Some(Format::FloatLE),
        (SampleFormat::F32, true) => Some(Format::FloatBE),
        (SampleFormat::F64, false) => Some(Format::Float64LE),
        (SampleFormat::F64, true) => Some(Format::Float64BE),
        _ => None,
    }
}

fn formats_for_discovery(
    big_endian: bool,
) -> impl Iterator<Item = (SampleFormat, alsa::pcm::Format)> {
    ALSA_SAMPLE_FORMATS.into_iter().filter_map(move |sample| {
        alsa_format_for_sample(sample, big_endian).map(|format| (sample, format))
    })
}

static CAPTURE_GATE: input_probe::CaptureGate = input_probe::CaptureGate::new();

pub(crate) fn capture_cleanup_uncertain() -> bool {
    CAPTURE_GATE.is_uncertain()
}

fn uncertain_capture_error() -> BuildStreamError {
    BuildStreamError::CleanupUncertain {
        err: BackendSpecificError {
            description: "ALSA capture cleanup could not be confirmed".into(),
        },
    }
}

/// The default linux, dragonfly, freebsd and netbsd host type.
#[derive(Debug)]
pub struct Host;

impl Host {
    pub fn new() -> Result<Self, crate::HostUnavailable> {
        Ok(Host)
    }
}

impl HostTrait for Host {
    type Devices = Devices;
    type Device = Device;

    fn is_available() -> bool {
        // Assume ALSA is always available on linux/dragonfly/freebsd/netbsd.
        true
    }

    fn devices(&self) -> Result<Self::Devices, DevicesError> {
        Devices::new()
    }

    fn default_input_device(&self) -> Option<Self::Device> {
        default_input_device()
    }

    fn default_output_device(&self) -> Option<Self::Device> {
        default_output_device()
    }
}

impl DeviceTrait for Device {
    type SupportedInputConfigs = SupportedInputConfigs;
    type SupportedOutputConfigs = SupportedOutputConfigs;
    type Stream = Stream;

    fn name(&self) -> Result<String, DeviceNameError> {
        Device::name(self)
    }

    fn supported_input_configs(
        &self,
    ) -> Result<Self::SupportedInputConfigs, SupportedStreamConfigsError> {
        Device::supported_input_configs(self)
    }

    fn supported_output_configs(
        &self,
    ) -> Result<Self::SupportedOutputConfigs, SupportedStreamConfigsError> {
        Device::supported_output_configs(self)
    }

    fn default_input_config(&self) -> Result<SupportedStreamConfig, DefaultStreamConfigError> {
        Device::default_input_config(self)
    }

    fn default_output_config(&self) -> Result<SupportedStreamConfig, DefaultStreamConfigError> {
        Device::default_output_config(self)
    }

    fn build_input_stream_raw<D, E>(
        &self,
        conf: &StreamConfig,
        sample_format: SampleFormat,
        data_callback: D,
        error_callback: E,
        timeout: Option<Duration>,
    ) -> Result<Self::Stream, BuildStreamError>
    where
        D: FnMut(&Data, &InputCallbackInfo) + Send + 'static,
        E: FnMut(StreamError) + Send + 'static,
    {
        let mut gate = CAPTURE_GATE
            .enter()
            .map_err(|_| uncertain_capture_error())?;
        gate.arm();
        let stream_inner =
            match self.build_stream_inner(conf, sample_format, alsa::Direction::Capture) {
                Ok(inner) => inner,
                Err(error) => {
                    // The device refused capture, so stop advertising it from
                    // the capability cache: enumeration during a later
                    // recording would otherwise keep listing a dead input.
                    input_probe::forget_capture_capable(&self.name);
                    if matches!(error, BuildStreamError::CleanupUncertain { .. }) {
                        gate.uncertain();
                    } else {
                        gate.confirmed();
                    }
                    return Err(error);
                }
            };
        let stream = Stream::new_input(
            Arc::new(stream_inner),
            data_callback,
            error_callback,
            timeout,
        );
        // Discovery during a later recording lists this device from this
        // observation instead of opening it again.
        input_probe::record_capture_capable(&self.name);
        gate.confirmed();
        Ok(stream)
    }

    fn build_output_stream_raw<D, E>(
        &self,
        conf: &StreamConfig,
        sample_format: SampleFormat,
        data_callback: D,
        error_callback: E,
        timeout: Option<Duration>,
    ) -> Result<Self::Stream, BuildStreamError>
    where
        D: FnMut(&mut Data, &OutputCallbackInfo) + Send + 'static,
        E: FnMut(StreamError) + Send + 'static,
    {
        let stream_inner =
            self.build_stream_inner(conf, sample_format, alsa::Direction::Playback)?;
        let stream = Stream::new_output(
            Arc::new(stream_inner),
            data_callback,
            error_callback,
            timeout,
        );
        Ok(stream)
    }
}

struct TriggerSender(libc::c_int);

struct TriggerReceiver(libc::c_int);

impl TriggerSender {
    fn wakeup(&self) -> std::io::Result<()> {
        let buf = 1u64;
        loop {
            let ret = unsafe { libc::write(self.0, &buf as *const u64 as *const _, 8) };
            if ret == 8 {
                return Ok(());
            }
            if ret < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "short ALSA worker termination signal",
            ));
        }
    }
}

impl TriggerReceiver {
    fn clear_pipe(&self) {
        let mut out = 0u64;
        let ret = unsafe { libc::read(self.0, &mut out as *mut u64 as *mut _, 8) };
        assert_eq!(ret, 8);
    }
}

fn trigger() -> (TriggerSender, TriggerReceiver) {
    let mut fds = [0, 0];
    match unsafe { libc::pipe(fds.as_mut_ptr()) } {
        0 => (TriggerSender(fds[1]), TriggerReceiver(fds[0])),
        _ => panic!("Could not create pipe"),
    }
}

impl Drop for TriggerSender {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.0);
        }
    }
}

impl Drop for TriggerReceiver {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.0);
        }
    }
}

fn map_config_open_error(error: alsa::Error) -> SupportedStreamConfigsError {
    match error.errno() {
        libc::ENOENT | libc::EBUSY => SupportedStreamConfigsError::DeviceNotAvailable,
        libc::EINVAL => SupportedStreamConfigsError::InvalidArgument,
        _ => error.into(),
    }
}

enum CaptureProbeError<E> {
    Open(alsa::Error),
    Query(E),
    Close(alsa::Error),
    Uncertain,
    /// A capture stream owns a device in this process. Probing would open a
    /// second handle on it, so capabilities are reported as unavailable.
    Busy,
}

fn probe_capture<T, E>(
    name: &str,
    query: impl FnOnce(&alsa::PCM) -> Result<T, E>,
) -> Result<T, CaptureProbeError<E>> {
    // Fast path: never wait for the gate, and never open a device that a live
    // capture stream owns. Discovery while recording must not be able to
    // disturb the recording or poison admission with a failed probe close.
    if input_probe::capture_stream_is_live() {
        return Err(CaptureProbeError::Busy);
    }
    let mut gate = CAPTURE_GATE
        .enter()
        .map_err(|_| CaptureProbeError::Uncertain)?;
    // Recheck once the gate is held: a stream cannot be built while the gate is
    // held, so this rules out a stream that appeared after the fast check.
    if input_probe::capture_stream_is_live() {
        gate.confirmed();
        return Err(CaptureProbeError::Busy);
    }
    gate.arm();
    let handle = match alsa::PCM::new_checked(name, alsa::Direction::Capture, true) {
        Ok(handle) => handle,
        Err(alsa::pcm::CheckedOpenError::Failed(error)) => {
            // A device that used to open for capture and now does not must not
            // stay in the cache that enumeration trusts while recording.
            input_probe::forget_capture_capable(name);
            gate.confirmed();
            return Err(CaptureProbeError::Open(error));
        }
        Err(alsa::pcm::CheckedOpenError::Uncertain(_)) => {
            gate.uncertain();
            return Err(CaptureProbeError::Uncertain);
        }
    };
    let result = query(&handle);
    match handle.close_checked() {
        Ok(()) => gate.confirmed(),
        Err(error) => {
            gate.uncertain();
            return Err(CaptureProbeError::Close(error));
        }
    }
    input_probe::record_capture_capable(name);
    result.map_err(CaptureProbeError::Query)
}

#[derive(Default)]
struct DeviceHandles {
    playback: Option<alsa::PCM>,
}

impl DeviceHandles {
    /// Keep playback handles as upstream does, but never cache a capture
    /// probe. A device with no playback is included if capture opens and
    /// closes successfully.
    fn open(name: &str) -> Result<Self, alsa::Error> {
        let mut handles = Self::default();
        match handles.playback(name) {
            Ok(_) => Ok(handles),
            Err(playback_error) => {
                // A capture-only device has to be probed to be recognised. While
                // a stream owns a capture device, only a previous observation
                // can prove it: opening it again is what this guard avoids.
                if input_probe::capture_stream_is_live() {
                    return if input_probe::is_known_capture_capable(name) {
                        Ok(handles)
                    } else {
                        Err(playback_error)
                    };
                }
                let probe = probe_capture(name, |_| Ok::<_, ()>(()));
                if probe.is_ok() {
                    Ok(handles)
                } else {
                    Err(playback_error)
                }
            }
        }
    }

    fn playback(&mut self, name: &str) -> Result<&mut alsa::PCM, alsa::Error> {
        if self.playback.is_none() {
            self.playback = Some(alsa::PCM::new(name, alsa::Direction::Playback, true)?);
        }
        Ok(self.playback.as_mut().unwrap())
    }

    fn take_playback(&mut self, name: &str) -> Result<alsa::PCM, alsa::Error> {
        self.playback(name)?;
        Ok(self.playback.take().unwrap())
    }
}

#[derive(Clone)]
pub struct Device {
    name: String,
    handles: Arc<Mutex<DeviceHandles>>,
}

impl Device {
    fn build_stream_inner(
        &self,
        conf: &StreamConfig,
        sample_format: SampleFormat,
        stream_type: alsa::Direction,
    ) -> Result<StreamInner, BuildStreamError> {
        let handle_result = if stream_type == alsa::Direction::Capture {
            match alsa::PCM::new_checked(&self.name, stream_type, true) {
                Ok(handle) => Ok(handle),
                Err(alsa::pcm::CheckedOpenError::Failed(error)) => Err(error),
                Err(alsa::pcm::CheckedOpenError::Uncertain(error)) => {
                    return Err(BuildStreamError::CleanupUncertain {
                        err: BackendSpecificError {
                            description: format!(
                                "ALSA capture open returned an uncertain handle: {error}"
                            ),
                        },
                    });
                }
            }
        } else {
            self.handles.lock().unwrap().take_playback(&self.name)
        };

        let handle = match handle_result {
            Err(error) if error.errno() == libc::EBUSY => {
                return Err(BuildStreamError::DeviceNotAvailable)
            }
            Err(error) if error.errno() == libc::EINVAL => {
                return Err(BuildStreamError::InvalidArgument)
            }
            Err(error) => return Err(error.into()),
            Ok(handle) => handle,
        };
        let setup = (|| -> Result<_, BuildStreamError> {
            let can_pause = set_hw_params_from_format(&handle, conf, sample_format)?;
            let period_len = set_sw_params_from_format(&handle, conf, stream_type)?;
            handle.prepare()?;

            let num_descriptors = handle.try_count()?;
            if num_descriptors == 0 {
                return Err(BackendSpecificError {
                    description: "invalid poll descriptor count for ALSA stream".to_string(),
                }
                .into());
            }

            // Some devices do not report valid high-resolution timestamps.
            let ts = handle.status()?.get_htstamp();
            let creation_instant = match (ts.tv_sec, ts.tv_nsec) {
                (0, 0) => Some(std::time::Instant::now()),
                _ => None,
            };
            Ok((can_pause, period_len, num_descriptors, creation_instant))
        })();
        let (can_pause, period_len, num_descriptors, creation_instant) = match setup {
            Ok(setup) => setup,
            Err(error) if stream_type == alsa::Direction::Capture => {
                return match handle.close_checked() {
                    Ok(()) => Err(error),
                    Err(close_error) => Err(BuildStreamError::CleanupUncertain {
                        err: BackendSpecificError {
                            description: format!(
                                "ALSA capture setup failed: {error}; close failed: {close_error}"
                            ),
                        },
                    }),
                };
            }
            Err(error) => return Err(error),
        };

        let stream_inner = StreamInner {
            input_start: (stream_type == alsa::Direction::Capture)
                .then(input_start::InputStart::new),
            channel: Some(handle),
            sample_format,
            num_descriptors,
            conf: conf.clone(),
            period_len,
            can_pause,
            creation_instant,
        };

        Ok(stream_inner)
    }

    #[inline]
    fn name(&self) -> Result<String, DeviceNameError> {
        Ok(self.name.clone())
    }

    fn supported_configs(
        &self,
        stream_t: alsa::Direction,
    ) -> Result<VecIntoIter<SupportedStreamConfigRange>, SupportedStreamConfigsError> {
        if stream_t == alsa::Direction::Capture {
            return probe_capture(&self.name, Self::configs_for_handle).map_err(
                |error| match error {
                    CaptureProbeError::Open(error) => map_config_open_error(error),
                    CaptureProbeError::Query(error) => error,
                    CaptureProbeError::Close(error) => BackendSpecificError {
                        description: format!("ALSA capture probe close failed: {error}"),
                    }
                    .into(),
                    CaptureProbeError::Uncertain => BackendSpecificError {
                        description: "ALSA capture cleanup could not be confirmed".into(),
                    }
                    .into(),
                    CaptureProbeError::Busy => BackendSpecificError {
                        description: "ALSA capture is in use, so its capabilities cannot be probed"
                            .into(),
                    }
                    .into(),
                },
            );
        }
        let mut guard = self.handles.lock().unwrap();
        let handle = guard.playback(&self.name).map_err(map_config_open_error)?;
        Self::configs_for_handle(handle)
    }

    fn configs_for_handle(
        handle: &alsa::PCM,
    ) -> Result<VecIntoIter<SupportedStreamConfigRange>, SupportedStreamConfigsError> {
        let hw_params = alsa::pcm::HwParams::any(handle)?;

        let formats = formats_for_discovery(cfg!(target_endian = "big"));

        let mut supported_formats = Vec::new();
        for (sample_format, alsa_format) in formats {
            if hw_params.test_format(alsa_format).is_ok() {
                supported_formats.push(sample_format);
            }
        }

        let min_rate = hw_params.get_rate_min()?;
        let max_rate = hw_params.get_rate_max()?;

        let sample_rates = if min_rate == max_rate || hw_params.test_rate(min_rate + 1).is_ok() {
            vec![(min_rate, max_rate)]
        } else {
            const RATES: [libc::c_uint; 13] = [
                5512, 8000, 11025, 16000, 22050, 32000, 44100, 48000, 64000, 88200, 96000, 176400,
                192000,
            ];

            let mut rates = Vec::new();
            for &rate in RATES.iter() {
                if hw_params.test_rate(rate).is_ok() {
                    rates.push((rate, rate));
                }
            }

            if rates.is_empty() {
                vec![(min_rate, max_rate)]
            } else {
                rates
            }
        };

        let min_channels = hw_params.get_channels_min()?;
        let max_channels = hw_params.get_channels_max()?;

        let max_channels = cmp::min(max_channels, 32); // TODO: limiting to 32 channels or too much stuff is returned
        let supported_channels = (min_channels..max_channels + 1)
            .filter_map(|num| {
                if hw_params.test_channels(num).is_ok() {
                    Some(num as ChannelCount)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();

        let min_buffer_size = hw_params.get_buffer_size_min()?;
        let max_buffer_size = hw_params.get_buffer_size_max()?;

        let buffer_size_range = SupportedBufferSize::Range {
            min: min_buffer_size as u32,
            max: max_buffer_size as u32,
        };

        let mut output = Vec::with_capacity(
            supported_formats.len() * supported_channels.len() * sample_rates.len(),
        );
        for &sample_format in supported_formats.iter() {
            for &channels in supported_channels.iter() {
                for &(min_rate, max_rate) in sample_rates.iter() {
                    output.push(SupportedStreamConfigRange {
                        channels,
                        min_sample_rate: SampleRate(min_rate as u32),
                        max_sample_rate: SampleRate(max_rate as u32),
                        buffer_size: buffer_size_range.clone(),
                        sample_format,
                    });
                }
            }
        }

        Ok(output.into_iter())
    }

    fn supported_input_configs(
        &self,
    ) -> Result<SupportedInputConfigs, SupportedStreamConfigsError> {
        self.supported_configs(alsa::Direction::Capture)
    }

    fn supported_output_configs(
        &self,
    ) -> Result<SupportedOutputConfigs, SupportedStreamConfigsError> {
        self.supported_configs(alsa::Direction::Playback)
    }

    // ALSA does not offer default stream formats, so instead we compare all supported formats by
    // the `SupportedStreamConfigRange::cmp_default_heuristics` order and select the greatest.
    fn default_config(
        &self,
        stream_t: alsa::Direction,
    ) -> Result<SupportedStreamConfig, DefaultStreamConfigError> {
        let mut formats: Vec<_> = {
            match self.supported_configs(stream_t) {
                Err(SupportedStreamConfigsError::DeviceNotAvailable) => {
                    return Err(DefaultStreamConfigError::DeviceNotAvailable);
                }
                Err(SupportedStreamConfigsError::InvalidArgument) => {
                    // this happens sometimes when querying for input and output capabilities, but
                    // the device supports only one
                    return Err(DefaultStreamConfigError::StreamTypeNotSupported);
                }
                Err(SupportedStreamConfigsError::BackendSpecific { err }) => {
                    return Err(err.into());
                }
                Ok(fmts) => fmts.collect(),
            }
        };

        formats.sort_by(|a, b| a.cmp_default_heuristics(b));

        match formats.into_iter().last() {
            Some(f) => {
                let min_r = f.min_sample_rate;
                let max_r = f.max_sample_rate;
                let mut format = f.with_max_sample_rate();
                const HZ_44100: SampleRate = SampleRate(44_100);
                if min_r <= HZ_44100 && HZ_44100 <= max_r {
                    format.sample_rate = HZ_44100;
                }
                Ok(format)
            }
            None => Err(DefaultStreamConfigError::StreamTypeNotSupported),
        }
    }

    fn default_input_config(&self) -> Result<SupportedStreamConfig, DefaultStreamConfigError> {
        self.default_config(alsa::Direction::Capture)
    }

    fn default_output_config(&self) -> Result<SupportedStreamConfig, DefaultStreamConfigError> {
        self.default_config(alsa::Direction::Playback)
    }
}

struct StreamInner {
    // Capture is not started until the public stream handle exists.
    input_start: Option<input_start::InputStart>,

    // The ALSA channel.
    channel: Option<alsa::pcm::PCM>,

    // When converting between file descriptors and `snd_pcm_t`, this is the number of
    // file descriptors that this `snd_pcm_t` uses.
    num_descriptors: usize,

    // Format of the samples.
    sample_format: SampleFormat,

    // The configuration used to open this stream.
    conf: StreamConfig,

    // Minimum number of samples to put in the buffer.
    period_len: usize,

    // Whether or not the configured PCM supports hardware pause.
    can_pause: bool,

    // In the case that the device does not return valid timestamps via `get_htstamp`, this field
    // will be `Some` and will contain an `Instant` representing the moment the stream was created.
    //
    // If this field is `Some`, then the stream will use the duration since this instant as a
    // source for timestamps.
    //
    // If this field is `None` then the elapsed duration between `get_trigger_htstamp` and
    // `get_htstamp` is used.
    creation_instant: Option<std::time::Instant>,
}

impl StreamInner {
    fn channel(&self) -> &alsa::pcm::PCM {
        self.channel.as_ref().expect("ALSA PCM already closed")
    }
}

// Assume that the ALSA library is built with thread safe option.
unsafe impl Sync for StreamInner {}

#[derive(Debug, Eq, PartialEq)]
enum StreamType {
    Input,
    Output,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum InputCloseState {
    Open,
    Uncertain,
    Closed,
}

pub struct Stream {
    /// The high-priority audio processing thread calling callbacks.
    /// Option used for moving out in destructor.
    thread: Option<JoinHandle<()>>,

    /// Handle to the underlying stream for playback controls.
    inner: Arc<StreamInner>,

    /// Used to signal to stop processing.
    trigger: TriggerSender,
    is_input: bool,
    worker_failed: bool,
    input_close: InputCloseState,
    /// Released when this stream can no longer hold a capture device, so
    /// device discovery can probe again.
    capture_slot: Option<input_probe::CaptureSlot>,
}

struct StreamWorkerContext {
    descriptors: Vec<libc::pollfd>,
    buffer: stream_buffer::StreamBuffer,
    poll_timeout: i32,
}

impl StreamWorkerContext {
    fn new(poll_timeout: &Option<Duration>) -> Self {
        let poll_timeout: i32 = if let Some(d) = poll_timeout {
            d.as_millis().try_into().unwrap()
        } else {
            -1
        };

        Self {
            descriptors: Vec::new(),
            buffer: stream_buffer::StreamBuffer::default(),
            poll_timeout,
        }
    }
}

fn input_stream_worker(
    rx: TriggerReceiver,
    stream: &StreamInner,
    data_callback: &mut (dyn FnMut(&Data, &InputCallbackInfo) + Send + 'static),
    error_callback: &mut (dyn FnMut(StreamError) + Send + 'static),
    timeout: Option<Duration>,
) {
    let mut ctxt = StreamWorkerContext::new(&timeout);
    let input = stream.input_start.as_ref().expect("capture start gate");
    loop {
        if !input.wait_until_started() {
            return;
        }
        let generation = match input.running_generation() {
            Ok(Some(generation)) => generation,
            Ok(None) => continue,
            Err(()) => {
                error_callback(
                    BackendSpecificError {
                        description: "ALSA input state is poisoned".into(),
                    }
                    .into(),
                );
                return;
            }
        };
        let flow = poll_descriptors_and_prepare_buffer(&rx, stream, &mut ctxt, false);
        // The termination pipe may have been consumed while pause was in flight.
        if matches!(flow, Ok(PollDescriptorsFlow::Return)) {
            return;
        }
        // A readiness result from before a pause cannot drive a read or XRUN
        // recovery after resume. The permit also covers callback delivery.
        let _cycle = match input.begin_cycle(generation) {
            Ok(Some(cycle)) => cycle,
            Ok(None) => {
                // Do not restart a stale XRUN, but do report its lost audio.
                match flow {
                    Ok(PollDescriptorsFlow::XRun) => report_input_xrun(error_callback),
                    Ok(PollDescriptorsFlow::Disconnected) => {
                        error_callback(StreamError::DeviceNotAvailable)
                    }
                    Err(err) => error_callback(err.into()),
                    _ => {}
                }
                continue;
            }
            Err(()) => {
                error_callback(
                    BackendSpecificError {
                        description: "ALSA input state is poisoned".into(),
                    }
                    .into(),
                );
                return;
            }
        };
        let flow = flow.unwrap_or_else(|err| {
            error_callback(err.into());
            PollDescriptorsFlow::Continue
        });

        match flow {
            PollDescriptorsFlow::Continue => {
                continue;
            }
            PollDescriptorsFlow::XRun => {
                recover_input_xrun(stream, error_callback);
                continue;
            }
            PollDescriptorsFlow::Return => return,
            PollDescriptorsFlow::Disconnected => {
                error_callback(StreamError::DeviceNotAvailable);
                return;
            }
            PollDescriptorsFlow::Ready {
                status,
                avail_frames: _,
                delay_frames,
                stream_type,
            } => {
                assert_eq!(
                    stream_type,
                    StreamType::Input,
                    "expected input stream, but polling descriptors indicated output",
                );
                match process_input(
                    stream,
                    ctxt.buffer.bytes_mut(),
                    status,
                    delay_frames,
                    data_callback,
                ) {
                    Ok(InputReadFlow::Continue) => {}
                    Ok(InputReadFlow::Retry) => {
                        if wait_for_retry(&rx) {
                            return;
                        }
                    }
                    Ok(InputReadFlow::XRun) => recover_input_xrun(stream, error_callback),
                    Err(err) => error_callback(err.into()),
                }
            }
        }
    }
}

fn report_input_xrun(error_callback: &mut (dyn FnMut(StreamError) + Send + 'static)) {
    error_callback(
        BackendSpecificError {
            description: "ALSA input overrun lost audio samples".to_owned(),
        }
        .into(),
    );
}

fn recover_input_xrun(
    stream: &StreamInner,
    error_callback: &mut (dyn FnMut(StreamError) + Send + 'static),
) {
    // Preparing cannot restore samples lost to the overrun.
    report_input_xrun(error_callback);
    let input = stream.input_start.as_ref().expect("capture start gate");
    if let Err(description) = input.recover(|| {
        stream
            .channel()
            .prepare()
            .map_err(|error| error.to_string())?;
        stream.channel().start().map_err(|error| error.to_string())
    }) {
        error_callback(BackendSpecificError { description }.into());
    }
}

fn output_stream_worker(
    rx: TriggerReceiver,
    stream: &StreamInner,
    data_callback: &mut (dyn FnMut(&mut Data, &OutputCallbackInfo) + Send + 'static),
    error_callback: &mut (dyn FnMut(StreamError) + Send + 'static),
    timeout: Option<Duration>,
) {
    let mut ctxt = StreamWorkerContext::new(&timeout);
    let mut pending = None;
    let mut reported_error = false;
    loop {
        let flow =
            match poll_descriptors_and_prepare_buffer(&rx, stream, &mut ctxt, pending.is_some()) {
                Ok(flow) => flow,
                Err(err) => {
                    if !reported_error {
                        error_callback(err.into());
                        reported_error = true;
                    }
                    if wait_for_retry(&rx) {
                        return;
                    }
                    continue;
                }
            };

        match flow {
            PollDescriptorsFlow::Continue => {
                if wait_for_retry(&rx) {
                    return;
                }
                continue;
            }
            PollDescriptorsFlow::XRun => {
                if let Err(err) = stream.channel().prepare() {
                    if !reported_error {
                        error_callback(err.into());
                        reported_error = true;
                    }
                }
                if wait_for_retry(&rx) {
                    return;
                }
            }
            PollDescriptorsFlow::Return => return,
            PollDescriptorsFlow::Disconnected => {
                error_callback(StreamError::DeviceNotAvailable);
                return;
            }
            PollDescriptorsFlow::Ready {
                status,
                avail_frames,
                delay_frames,
                stream_type,
            } => {
                assert_eq!(
                    stream_type,
                    StreamType::Output,
                    "expected output stream, but polling descriptors indicated input",
                );
                let should_wait = match process_output(
                    stream,
                    ctxt.buffer.bytes_mut(),
                    &mut pending,
                    status,
                    avail_frames,
                    delay_frames,
                    data_callback,
                ) {
                    Ok(should_wait) => {
                        if !should_wait {
                            reported_error = false;
                        }
                        should_wait
                    }
                    Err(err) => {
                        if !reported_error {
                            error_callback(err.into());
                            reported_error = true;
                        }
                        true
                    }
                };
                if should_wait && wait_for_retry(&rx) {
                    return;
                }
            }
        }
    }
}

// Some plugins report readiness even when readi/writei return EAGAIN or
// zero. Back off without hiding the termination pipe from stream shutdown.
fn wait_for_retry(rx: &TriggerReceiver) -> bool {
    let mut descriptor = [libc::pollfd {
        fd: rx.0,
        events: libc::POLLIN,
        revents: 0,
    }];
    if alsa::poll::poll(&mut descriptor, 5).is_ok() && descriptor[0].revents != 0 {
        rx.clear_pipe();
        return true;
    }
    false
}

enum PollDescriptorsFlow {
    Continue,
    Return,
    Disconnected,
    Ready {
        stream_type: StreamType,
        status: alsa::pcm::Status,
        avail_frames: usize,
        delay_frames: usize,
    },
    XRun,
}

// This block is shared between both input and output stream worker functions.
fn poll_descriptors_and_prepare_buffer(
    rx: &TriggerReceiver,
    stream: &StreamInner,
    ctxt: &mut StreamWorkerContext,
    pending_output: bool,
) -> Result<PollDescriptorsFlow, BackendSpecificError> {
    let StreamWorkerContext {
        ref mut descriptors,
        ref mut buffer,
        ref poll_timeout,
    } = *ctxt;

    descriptors.clear();

    // Add the self-pipe for signaling termination.
    descriptors.push(libc::pollfd {
        fd: rx.0,
        events: libc::POLLIN,
        revents: 0,
    });

    // Add ALSA polling fds.
    let len = descriptors.len();
    descriptors.resize(
        stream.num_descriptors + len,
        libc::pollfd {
            fd: 0,
            events: 0,
            revents: 0,
        },
    );
    let filled = if let Some(input) = &stream.input_start {
        match input
            .read_if_running(|| stream.channel().fill(&mut descriptors[len..]))
            .map_err(|_| BackendSpecificError {
                description: "ALSA input state is poisoned".into(),
            })? {
            Some(result) => result?,
            None => return Ok(PollDescriptorsFlow::Continue),
        }
    } else {
        stream.channel().fill(&mut descriptors[len..])?
    };
    debug_assert_eq!(filled, stream.num_descriptors);

    // Don't timeout, wait forever.
    let res = alsa::poll::poll(descriptors, *poll_timeout)?;
    if res == 0 {
        let description = String::from("`alsa::poll()` spuriously returned");
        return Err(BackendSpecificError { description });
    }

    if descriptors[0].revents != 0 {
        // The stream has been requested to be destroyed.
        rx.clear_pipe();
        return Ok(PollDescriptorsFlow::Return);
    }

    // Poll itself must not hold the state lock: pause and shutdown must be
    // able to proceed while the worker sleeps. Once it wakes, serialize the
    // state-dependent ALSA queries with pause, recovery and retirement.
    if let Some(input) = &stream.input_start {
        return input
            .read_if_running(|| inspect_ready_descriptors(stream, &descriptors[1..], buffer, false))
            .map_err(|_| BackendSpecificError {
                description: "ALSA input state is poisoned".into(),
            })?
            .unwrap_or(Ok(PollDescriptorsFlow::Continue));
    }
    inspect_ready_descriptors(stream, &descriptors[1..], buffer, pending_output)
}

fn inspect_ready_descriptors(
    stream: &StreamInner,
    descriptors: &[libc::pollfd],
    buffer: &mut stream_buffer::StreamBuffer,
    pending_output: bool,
) -> Result<PollDescriptorsFlow, BackendSpecificError> {
    let revents = stream.channel().revents(descriptors)?;
    if revents.intersects(alsa::poll::Flags::HUP | alsa::poll::Flags::NVAL) {
        return Ok(PollDescriptorsFlow::Disconnected);
    }
    if revents.contains(alsa::poll::Flags::ERR) {
        // ALSA can signal an XRUN or device removal before avail() is queried.
        let state = stream.channel().state_raw();
        if state == alsa::pcm::State::Disconnected as libc::c_int {
            return Ok(PollDescriptorsFlow::Disconnected);
        }
        if state == alsa::pcm::State::XRun as libc::c_int {
            return Ok(PollDescriptorsFlow::XRun);
        }
        let description = String::from("`alsa::poll()` returned POLLERR");
        return Err(BackendSpecificError { description });
    }
    let stream_type = match revents {
        alsa::poll::Flags::OUT => StreamType::Output,
        alsa::poll::Flags::IN => StreamType::Input,
        _ => {
            // Nothing to process, poll again
            return Ok(PollDescriptorsFlow::Continue);
        }
    };

    let status = stream.channel().status()?;
    let native_avail = match stream.channel().avail() {
        Err(err) if err.errno() == libc::EPIPE => return Ok(PollDescriptorsFlow::XRun),
        res => res,
    }?;
    let avail_frames = usize::try_from(native_avail).map_err(|_| BackendSpecificError {
        description: "ALSA returned a negative available frame count".to_owned(),
    })?;
    let delay_frames = match status.get_delay() {
        // Buffer underrun. TODO: Notify the user.
        d if d < 0 => 0,
        d => d as usize,
    };
    let available_samples = avail_frames
        .checked_mul(stream.conf.channels as usize)
        .ok_or_else(|| BackendSpecificError {
            description: "ALSA input/output sample count overflow".to_owned(),
        })?;

    // A pending suffix may be shorter than a period. Do not replace the
    // callback buffer while any of its frames are still unwritten.
    if available_samples == 0 || (!pending_output && available_samples < stream.period_len) {
        return Ok(PollDescriptorsFlow::Continue);
    }

    if !pending_output {
        let buffer_size = stream
            .sample_format
            .sample_size()
            .checked_mul(available_samples)
            .ok_or_else(|| BackendSpecificError {
                description: "ALSA input/output buffer size overflow".to_owned(),
            })?;
        buffer
            .resize(buffer_size)
            .ok_or_else(|| BackendSpecificError {
                description: "ALSA input/output buffer size overflow".to_owned(),
            })?;
    }

    Ok(PollDescriptorsFlow::Ready {
        stream_type,
        status,
        avail_frames,
        delay_frames,
    })
}

enum InputReadFlow {
    Continue,
    Retry,
    XRun,
}

// Read input data from ALSA and deliver it to the user.
fn process_input(
    stream: &StreamInner,
    buffer: &mut [u8],
    status: alsa::pcm::Status,
    delay_frames: usize,
    data_callback: &mut (dyn FnMut(&Data, &InputCallbackInfo) + Send + 'static),
) -> Result<InputReadFlow, BackendSpecificError> {
    let input = stream.input_start.as_ref().expect("capture start gate");
    let read = input
        .read_if_running(|| stream.channel().io_bytes().readi(buffer))
        .map_err(|_| BackendSpecificError {
            description: "ALSA input state is poisoned".into(),
        })?;
    let Some(read) = read else {
        return Ok(InputReadFlow::Continue);
    };
    let frames_read = match read {
        // The PCM is nonblocking. Readiness can change between poll and read,
        // and a signal may interrupt a read without losing samples.
        Err(err) if err.errno() == libc::EAGAIN || err.errno() == libc::EINTR => {
            return Ok(InputReadFlow::Retry)
        }
        Err(err) if err.errno() == libc::EPIPE => return Ok(InputReadFlow::XRun),
        result => result?,
    };
    let sample_format = stream.sample_format;
    let len = stream_buffer::sample_count(
        frames_read,
        stream.conf.channels as usize,
        sample_format.sample_size(),
        buffer.len(),
    )
    .ok_or_else(|| BackendSpecificError {
        description: "ALSA input returned an invalid frame count".to_owned(),
    })?;
    if len == 0 {
        return Ok(InputReadFlow::Retry);
    }
    let data = buffer.as_mut_ptr() as *mut ();
    let data = unsafe { Data::from_parts(data, len, sample_format) };
    let callback = stream_timestamp(&status, stream.creation_instant)?;
    let delay_duration = frames_to_duration(delay_frames, stream.conf.sample_rate);
    let capture = callback
        .sub(delay_duration)
        .expect("`capture` is earlier than representation supported by `StreamInstant`");
    let timestamp = crate::InputStreamTimestamp { callback, capture };
    let info = crate::InputCallbackInfo { timestamp };
    data_callback(&data, &info);

    Ok(InputReadFlow::Continue)
}

// Return true when a transient failure needs a termination-aware backoff.
fn process_output(
    stream: &StreamInner,
    buffer: &mut [u8],
    pending: &mut Option<output_pending::PendingOutput>,
    status: alsa::pcm::Status,
    available_frames: usize,
    delay_frames: usize,
    data_callback: &mut (dyn FnMut(&mut Data, &OutputCallbackInfo) + Send + 'static),
) -> Result<bool, BackendSpecificError> {
    if pending.is_none() {
        let sample_format = stream.sample_format;
        let frame_bytes = sample_format
            .sample_size()
            .checked_mul(stream.conf.channels as usize)
            .ok_or_else(|| BackendSpecificError {
                description: "ALSA output frame size overflow".to_owned(),
            })?;
        let next_pending = output_pending::PendingOutput::new(buffer.len(), frame_bytes)
            .ok_or_else(|| BackendSpecificError {
                description: "Invalid ALSA output buffer geometry".to_owned(),
            })?;
        let data = buffer.as_mut_ptr() as *mut ();
        let len = buffer.len() / sample_format.sample_size();
        let mut data = unsafe { Data::from_parts(data, len, sample_format) };
        let callback = stream_timestamp(&status, stream.creation_instant)?;
        let delay_duration = frames_to_duration(delay_frames, stream.conf.sample_rate);
        let playback = callback
            .add(delay_duration)
            .expect("`playback` occurs beyond representation supported by `StreamInstant`");
        let timestamp = crate::OutputStreamTimestamp { callback, playback };
        let info = crate::OutputCallbackInfo { timestamp };
        data_callback(&mut data, &info);
        *pending = Some(next_pending);
    }

    let remaining = pending.as_mut().expect("pending output was initialized");
    let range = remaining.request(available_frames);
    let requested_bytes = range.len();
    if requested_bytes == 0 {
        return Ok(true);
    }
    match stream.channel().io_bytes().writei(&buffer[range]) {
        Err(err) if err.errno() == libc::EAGAIN || err.errno() == libc::EINTR => Ok(true),
        Err(err) if err.errno() == libc::EPIPE => {
            stream.channel().try_recover(err, false)?;
            Ok(true)
        }
        Err(err) => Err(err.into()),
        Ok(written) => {
            let complete = remaining.advance(requested_bytes, written).ok_or_else(|| {
                BackendSpecificError {
                    description: "ALSA output returned an invalid frame count".to_owned(),
                }
            })?;
            if complete {
                *pending = None;
            }
            Ok(written == 0)
        }
    }
}

// Use the elapsed duration since the start of the stream.
//
// This ensures positive values that are compatible with our `StreamInstant` representation.
fn stream_timestamp(
    status: &alsa::pcm::Status,
    creation_instant: Option<std::time::Instant>,
) -> Result<crate::StreamInstant, BackendSpecificError> {
    match creation_instant {
        None => {
            let trigger_ts = status.get_trigger_htstamp();
            let ts = status.get_htstamp();
            let nanos = timespec_diff_nanos(ts, trigger_ts);
            if nanos < 0 {
                panic!(
                    "get_htstamp `{}.{}` was earlier than get_trigger_htstamp `{}.{}`",
                    ts.tv_sec, ts.tv_nsec, trigger_ts.tv_sec, trigger_ts.tv_nsec
                );
            }
            Ok(crate::StreamInstant::from_nanos(nanos))
        }
        Some(creation) => {
            let now = std::time::Instant::now();
            let duration = now.duration_since(creation);
            let instant = crate::StreamInstant::from_nanos_i128(duration.as_nanos() as i128)
                .expect("stream duration has exceeded `StreamInstant` representation");
            Ok(instant)
        }
    }
}

// Adapted from `timestamp2ns` here:
// https://fossies.org/linux/alsa-lib/test/audio_time.c
fn timespec_to_nanos(ts: libc::timespec) -> i64 {
    ts.tv_sec as i64 * 1_000_000_000 + ts.tv_nsec as i64
}

// Adapted from `timediff` here:
// https://fossies.org/linux/alsa-lib/test/audio_time.c
fn timespec_diff_nanos(a: libc::timespec, b: libc::timespec) -> i64 {
    timespec_to_nanos(a) - timespec_to_nanos(b)
}

// Convert the given duration in frames at the given sample rate to a `std::time::Duration`.
fn frames_to_duration(frames: usize, rate: crate::SampleRate) -> std::time::Duration {
    let secsf = frames as f64 / rate.0 as f64;
    let secs = secsf as u64;
    let nanos = ((secsf - secs as f64) * 1_000_000_000.0) as u32;
    std::time::Duration::new(secs, nanos)
}

impl Stream {
    fn new_input<D, E>(
        inner: Arc<StreamInner>,
        mut data_callback: D,
        mut error_callback: E,
        timeout: Option<Duration>,
    ) -> Stream
    where
        D: FnMut(&Data, &InputCallbackInfo) + Send + 'static,
        E: FnMut(StreamError) + Send + 'static,
    {
        let (tx, rx) = trigger();
        // Clone the handle for passing into worker thread.
        let stream = inner.clone();
        let thread = thread::Builder::new()
            .name("cpal_alsa_in".to_owned())
            .spawn(move || {
                if !stream
                    .input_start
                    .as_ref()
                    .expect("capture start gate")
                    .wait_until_started()
                {
                    return;
                }
                input_stream_worker(
                    rx,
                    &stream,
                    &mut data_callback,
                    &mut error_callback,
                    timeout,
                );
            })
            .unwrap();
        Stream {
            thread: Some(thread),
            inner,
            trigger: tx,
            is_input: true,
            worker_failed: false,
            input_close: InputCloseState::Open,
            capture_slot: Some(input_probe::CaptureSlot::claim()),
        }
    }

    fn new_output<D, E>(
        inner: Arc<StreamInner>,
        mut data_callback: D,
        mut error_callback: E,
        timeout: Option<Duration>,
    ) -> Stream
    where
        D: FnMut(&mut Data, &OutputCallbackInfo) + Send + 'static,
        E: FnMut(StreamError) + Send + 'static,
    {
        let (tx, rx) = trigger();
        // Clone the handle for passing into worker thread.
        let stream = inner.clone();
        let thread = thread::Builder::new()
            .name("cpal_alsa_out".to_owned())
            .spawn(move || {
                output_stream_worker(
                    rx,
                    &stream,
                    &mut data_callback,
                    &mut error_callback,
                    timeout,
                );
            })
            .unwrap();
        Stream {
            thread: Some(thread),
            inner,
            trigger: tx,
            is_input: false,
            worker_failed: false,
            input_close: InputCloseState::Open,
            capture_slot: None,
        }
    }

    /// Whether this input can pause in hardware without stopping the stream.
    pub fn can_pause_input(&self) -> bool {
        self.is_input && self.inner.can_pause
    }

    /// Pause capture only after every admitted read has finished delivery.
    /// Do not call this from, or wait for it inside, the input callback.
    pub fn pause_input_and_drain(&self) -> Result<(), PauseStreamError> {
        if self.thread.is_none() || !self.is_input {
            return Err(BackendSpecificError {
                description: "ALSA input stream has been retired or is not an input".into(),
            }
            .into());
        }
        if !self.inner.can_pause {
            return Err(BackendSpecificError {
                description: "ALSA input device does not support hardware pause".into(),
            }
            .into());
        }
        self.inner
            .input_start
            .as_ref()
            .expect("capture start gate")
            .pause_draining(|| {
                self.inner
                    .channel()
                    .pause(true)
                    .map_err(|error| error.to_string())
            })
            .map_err(|description| BackendSpecificError { description }.into())
    }

    /// True when the capture worker ended by panicking.
    ///
    /// A panic here is the consumer's failure and it reaches the recorder as an
    /// incomplete recording. It is not evidence that the device is still held:
    /// see `stop_input_for_release`, which still confirms release.
    pub fn capture_worker_failed(&self) -> bool {
        self.worker_failed
    }

    /// Permanently retire the capture worker, then stop the PCM with a
    /// checked result. Pending device-buffered frames are discarded. Call
    /// only after the consumer has retired its callbacks and sealed samples;
    /// never call it from the worker's callbacks. On failure the caller must
    /// retain this stream and may retry the stop.
    ///
    /// `Ok` means the device is no longer held, so a retry can never release
    /// anything further. A retried stop therefore also reports `Ok` once the
    /// PCM is closed, and a panicked worker does not turn a confirmed release
    /// into an error: reporting one would strand the recorder on a handle it
    /// can never release. Query `capture_worker_failed` for that failure.
    pub fn stop_input_for_release(&mut self) -> Result<(), String> {
        if !self.is_input {
            return Err("ALSA stream is not an input stream".into());
        }
        match self.input_close {
            InputCloseState::Uncertain => return Err("ALSA capture close is uncertain".into()),
            InputCloseState::Closed => return Ok(()),
            InputCloseState::Open => {}
        }
        self.inner
            .input_start
            .as_ref()
            .expect("capture start gate")
            .retire()
            .map_err(|_| "ALSA input start state is poisoned")?;
        if self.thread.is_some() {
            if let Err(error) = self.trigger.wakeup() {
                // A closed read end means the worker already exited, so it is
                // safe to join. Other failures do not prove it will exit.
                if error.kind() != std::io::ErrorKind::BrokenPipe {
                    return Err(format!("failed to wake ALSA capture worker: {error}"));
                }
            }
            let worker = self.thread.take().expect("worker present");
            input_start::join_capture_worker(worker, &mut self.worker_failed);
        }
        let inner =
            Arc::get_mut(&mut self.inner).ok_or("ALSA capture worker still owns the PCM")?;
        inner
            .channel()
            .drop()
            .map_err(|error| format!("failed to stop ALSA capture: {error}"))?;
        // Serialize a failed close with probe and build admission. Even when
        // a previous cleanup is uncertain, an owned stream must still close.
        let _cleanup_gate = CAPTURE_GATE.lock_for_cleanup();
        // The device is released as soon as close begins, so discovery may
        // probe again even though this object may be dropped later.
        self.capture_slot = None;
        let channel = inner.channel.take().ok_or("ALSA PCM is missing")?;
        // Close may invalidate the handle even on failure. Never retry it or
        // expose the handle after beginning close.
        self.input_close = InputCloseState::Uncertain;
        if let Err(error) = channel.close_checked() {
            CAPTURE_GATE.mark_uncertain();
            return Err(format!("failed to close ALSA capture: {error}"));
        }
        self.input_close = InputCloseState::Closed;
        // The close is confirmed, so this stream no longer holds the device even
        // if the worker panicked. Returning an error here left the recorder
        // retaining a handle whose retry always failed, which refused every
        // later recording until the app restarted. The panic is reported by
        // `capture_worker_failed` and by the consumer's own failure flag.
        Ok(())
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        if let Some(gate) = &self.inner.input_start {
            gate.retire_on_drop();
        }
        if let Some(thread) = self.thread.take() {
            // If signaling fails, joining may block, but abandoning a live
            // worker would allow the PCM to outlive its owner unnoticed.
            let _ = self.trigger.wakeup();
            // A panicking worker already reported itself. Unwrapping the join
            // result would panic inside `drop`, which aborts the process when
            // this drop runs during an unwind.
            input_start::join_capture_worker(thread, &mut self.worker_failed);
        }
    }
}

impl StreamTrait for Stream {
    fn play(&self) -> Result<(), PlayStreamError> {
        if self.thread.is_none() {
            return Err(BackendSpecificError {
                description: "ALSA stream has been retired".into(),
            }
            .into());
        }
        if let Some(gate) = &self.inner.input_start {
            let first_start = gate
                .start(|| {
                    self.inner
                        .channel()
                        .start()
                        .map_err(|error| error.to_string())
                })
                .map_err(|description| BackendSpecificError { description })?;
            if first_start {
                return Ok(());
            }
            return gate
                .resume(|| {
                    self.inner
                        .channel()
                        .pause(false)
                        .map_err(|error| error.to_string())
                })
                .map_err(|description| BackendSpecificError { description }.into());
        }
        self.inner.channel().pause(false).ok();
        Ok(())
    }
    fn pause(&self) -> Result<(), PauseStreamError> {
        if self.thread.is_none() {
            return Err(BackendSpecificError {
                description: "ALSA stream has been retired".into(),
            }
            .into());
        }
        if let Some(gate) = &self.inner.input_start {
            if !self.inner.can_pause {
                return Err(BackendSpecificError {
                    description: "ALSA input device does not support hardware pause".into(),
                }
                .into());
            }
            return gate
                .pause(|| {
                    self.inner
                        .channel()
                        .pause(true)
                        .map_err(|error| error.to_string())
                })
                .map_err(|description| BackendSpecificError { description }.into());
        }
        self.inner.channel().pause(true).ok();
        Ok(())
    }
}

fn set_hw_params_from_format(
    pcm_handle: &alsa::pcm::PCM,
    config: &StreamConfig,
    sample_format: SampleFormat,
) -> Result<bool, BackendSpecificError> {
    let hw_params = alsa::pcm::HwParams::any(pcm_handle)?;
    hw_params.set_access(alsa::pcm::Access::RWInterleaved)?;

    let sample_format = alsa_format_for_sample(sample_format, cfg!(target_endian = "big"))
        .ok_or_else(|| BackendSpecificError {
            description: format!(
                "Sample format '{}' is not supported by this backend",
                sample_format
            ),
        })?;

    hw_params.set_format(sample_format)?;
    hw_params.set_rate(config.sample_rate.0, alsa::ValueOr::Nearest)?;
    hw_params.set_channels(config.channels as u32)?;

    match config.buffer_size {
        BufferSize::Fixed(v) => {
            hw_params.set_period_size_near((v / 4) as alsa::pcm::Frames, alsa::ValueOr::Nearest)?;
            hw_params.set_buffer_size(v as alsa::pcm::Frames)?;
        }
        BufferSize::Default => {
            // These values together represent a moderate latency and wakeup interval.
            // Without them, we are at the mercy of the device
            hw_params.set_period_time_near(25_000, alsa::ValueOr::Nearest)?;
            hw_params.set_buffer_time_near(100_000, alsa::ValueOr::Nearest)?;
        }
    }

    pcm_handle.hw_params(&hw_params)?;

    Ok(hw_params.can_pause())
}

fn set_sw_params_from_format(
    pcm_handle: &alsa::pcm::PCM,
    config: &StreamConfig,
    stream_type: alsa::Direction,
) -> Result<usize, BackendSpecificError> {
    let sw_params = pcm_handle.sw_params_current()?;

    let period_len = {
        let (buffer, period) = pcm_handle.get_params()?;
        if buffer == 0 {
            return Err(BackendSpecificError {
                description: "initialization resulted in a null buffer".to_string(),
            });
        }
        sw_params.set_avail_min(period as alsa::pcm::Frames)?;

        let start_threshold = match stream_type {
            alsa::Direction::Playback => buffer - period,

            // For capture streams, the start threshold is irrelevant and ignored,
            // because build_stream_inner() starts the stream before process_input()
            // reads from it. Set it anyway I guess, since it's better than leaving
            // it at an unspecified default value.
            alsa::Direction::Capture => 1,
        };
        sw_params.set_start_threshold(start_threshold.try_into().unwrap())?;

        period as usize * config.channels as usize
    };

    sw_params.set_tstamp_mode(true)?;
    sw_params.set_tstamp_type(alsa::pcm::TstampType::MonotonicRaw)?;

    // tstamp_type param cannot be changed after the device is opened.
    // The default tstamp_type value on most Linux systems is "monotonic",
    // let's try to use it if setting the tstamp_type fails.
    if pcm_handle.sw_params(&sw_params).is_err() {
        sw_params.set_tstamp_type(alsa::pcm::TstampType::Monotonic)?;
        pcm_handle.sw_params(&sw_params)?;
    }

    Ok(period_len)
}

impl From<alsa::Error> for BackendSpecificError {
    fn from(err: alsa::Error) -> Self {
        BackendSpecificError {
            description: err.to_string(),
        }
    }
}

impl From<alsa::Error> for BuildStreamError {
    fn from(err: alsa::Error) -> Self {
        let err: BackendSpecificError = err.into();
        err.into()
    }
}

impl From<alsa::Error> for SupportedStreamConfigsError {
    fn from(err: alsa::Error) -> Self {
        let err: BackendSpecificError = err.into();
        err.into()
    }
}

impl From<alsa::Error> for PlayStreamError {
    fn from(err: alsa::Error) -> Self {
        let err: BackendSpecificError = err.into();
        err.into()
    }
}

impl From<alsa::Error> for PauseStreamError {
    fn from(err: alsa::Error) -> Self {
        let err: BackendSpecificError = err.into();
        err.into()
    }
}

impl From<alsa::Error> for StreamError {
    fn from(err: alsa::Error) -> Self {
        let err: BackendSpecificError = err.into();
        err.into()
    }
}

#[cfg(test)]
mod sample_format_tests {
    use super::*;

    #[test]
    fn discovery_uses_the_requested_native_byte_order() {
        let little: Vec<_> = formats_for_discovery(false).collect();
        let big: Vec<_> = formats_for_discovery(true).collect();
        assert_eq!(little.len(), 8);
        assert_eq!(big.len(), 8);
        for (sample, little_format, big_format) in [
            (
                SampleFormat::I8,
                alsa::pcm::Format::S8,
                alsa::pcm::Format::S8,
            ),
            (
                SampleFormat::U8,
                alsa::pcm::Format::U8,
                alsa::pcm::Format::U8,
            ),
            (
                SampleFormat::I16,
                alsa::pcm::Format::S16LE,
                alsa::pcm::Format::S16BE,
            ),
            (
                SampleFormat::U16,
                alsa::pcm::Format::U16LE,
                alsa::pcm::Format::U16BE,
            ),
            (
                SampleFormat::I32,
                alsa::pcm::Format::S32LE,
                alsa::pcm::Format::S32BE,
            ),
            (
                SampleFormat::U32,
                alsa::pcm::Format::U32LE,
                alsa::pcm::Format::U32BE,
            ),
            (
                SampleFormat::F32,
                alsa::pcm::Format::FloatLE,
                alsa::pcm::Format::FloatBE,
            ),
            (
                SampleFormat::F64,
                alsa::pcm::Format::Float64LE,
                alsa::pcm::Format::Float64BE,
            ),
        ] {
            assert!(little.contains(&(sample, little_format)));
            assert!(big.contains(&(sample, big_format)));
            assert_eq!(alsa_format_for_sample(sample, false), Some(little_format));
            assert_eq!(alsa_format_for_sample(sample, true), Some(big_format));
        }
        for sample in [SampleFormat::I64, SampleFormat::U64] {
            assert_eq!(alsa_format_for_sample(sample, false), None);
            assert_eq!(alsa_format_for_sample(sample, true), None);
        }
    }
}
