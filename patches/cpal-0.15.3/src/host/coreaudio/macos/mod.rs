extern crate core_foundation_sys;
extern crate coreaudio;

use super::{asbd_from_config, check_os_status, frames_to_duration, host_time_to_stream_instant};

use self::core_foundation_sys::base::CFRelease;
use self::core_foundation_sys::string::{
    CFStringGetCString, CFStringGetCStringPtr, CFStringGetLength,
    CFStringGetMaximumSizeForEncoding, CFStringRef,
};
use self::coreaudio::audio_unit::render_callback::{self, data};
use self::coreaudio::audio_unit::{AudioUnit, Element, Scope};
use self::coreaudio::sys::{
    kAudioDevicePropertyAvailableNominalSampleRates, kAudioDevicePropertyBufferFrameSize,
    kAudioDevicePropertyBufferFrameSizeRange, kAudioDevicePropertyDeviceIsAlive,
    kAudioDevicePropertyDeviceNameCFString, kAudioDevicePropertyNominalSampleRate,
    kAudioDevicePropertyScopeOutput, kAudioDevicePropertyStreamConfiguration,
    kAudioDevicePropertyStreamFormat, kAudioObjectPropertyElementMaster,
    kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyScopeInput,
    kAudioObjectPropertyScopeOutput, kAudioOutputUnitProperty_CurrentDevice,
    kAudioOutputUnitProperty_EnableIO, kAudioUnitProperty_StreamFormat, kCFStringEncodingUTF8,
    AudioBuffer, AudioBufferList, AudioDeviceID, AudioObjectGetPropertyData,
    AudioObjectGetPropertyDataSize, AudioObjectID, AudioObjectPropertyAddress,
    AudioObjectPropertyScope, AudioObjectSetPropertyData, AudioStreamBasicDescription,
    AudioValueRange, OSStatus,
};
use crate::traits::{DeviceTrait, HostTrait, StreamTrait};
use crate::{
    BackendSpecificError, BufferSize, BuildStreamError, ChannelCount, Data,
    DefaultStreamConfigError, DeviceNameError, DevicesError, InputCallbackInfo, OutputCallbackInfo,
    PauseStreamError, PlayStreamError, SampleFormat, SampleRate, StreamConfig, StreamError,
    SupportedBufferSize, SupportedStreamConfig, SupportedStreamConfigRange,
    SupportedStreamConfigsError,
};
use std::ffi::CStr;
use std::fmt;
use std::mem;
use std::os::raw::c_char;
use std::ptr::null;
use std::slice;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub use self::enumerate::{
    default_input_device, default_output_device, Devices, SupportedInputConfigs,
    SupportedOutputConfigs,
};

use property_listener::AudioObjectPropertyListener;

pub mod enumerate;
mod input_build;
mod input_callback;
mod input_render;
mod listener_gate;
mod listener_registry;
mod property_data;
mod property_listener;

/// Coreaudio host, the default host on macOS.
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
        // Assume coreaudio is always available
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
        config: &StreamConfig,
        sample_format: SampleFormat,
        data_callback: D,
        error_callback: E,
        timeout: Option<Duration>,
    ) -> Result<Self::Stream, BuildStreamError>
    where
        D: FnMut(&Data, &InputCallbackInfo) + Send + 'static,
        E: FnMut(StreamError) + Send + 'static,
    {
        Device::build_input_stream_raw(
            self,
            config,
            sample_format,
            data_callback,
            error_callback,
            timeout,
        )
    }

    fn build_output_stream_raw<D, E>(
        &self,
        config: &StreamConfig,
        sample_format: SampleFormat,
        data_callback: D,
        error_callback: E,
        timeout: Option<Duration>,
    ) -> Result<Self::Stream, BuildStreamError>
    where
        D: FnMut(&mut Data, &OutputCallbackInfo) + Send + 'static,
        E: FnMut(StreamError) + Send + 'static,
    {
        Device::build_output_stream_raw(
            self,
            config,
            sample_format,
            data_callback,
            error_callback,
            timeout,
        )
    }
}

fn invalid_property_buffer() -> BackendSpecificError {
    BackendSpecificError {
        description: "invalid CoreAudio property buffer size".into(),
    }
}

// T must be a C-compatible type for which every bit pattern is valid, and the
// requested property must contain an array of T values.
unsafe fn read_property_array<T: Copy + Default>(
    object: AudioObjectID,
    address: &AudioObjectPropertyAddress,
) -> Result<Vec<T>, BackendSpecificError> {
    let mut size = 0u32;
    check_os_status(AudioObjectGetPropertyDataSize(
        object,
        address,
        0,
        null(),
        &mut size,
    ))?;
    let capacity = size as usize;
    let count = property_data::element_count(capacity, capacity, mem::size_of::<T>())
        .ok_or_else(invalid_property_buffer)?;
    if count == 0 {
        return Ok(Vec::new());
    }
    let mut values = Vec::new();
    values
        .try_reserve_exact(count)
        .map_err(|_| invalid_property_buffer())?;
    values.resize(count, T::default());
    check_os_status(AudioObjectGetPropertyData(
        object,
        address,
        0,
        null(),
        &mut size,
        values.as_mut_ptr().cast(),
    ))?;
    let count = property_data::element_count(size as usize, capacity, mem::size_of::<T>())
        .ok_or_else(invalid_property_buffer)?;
    values.truncate(count);
    Ok(values)
}

unsafe fn read_channel_count(
    object: AudioObjectID,
    address: &AudioObjectPropertyAddress,
) -> Result<usize, BackendSpecificError> {
    let mut size = 0u32;
    check_os_status(AudioObjectGetPropertyDataSize(
        object,
        address,
        0,
        null(),
        &mut size,
    ))?;
    let capacity = size as usize;
    if capacity == 0 {
        return Ok(0);
    }
    if capacity < mem::size_of::<u32>() || mem::align_of::<AudioBuffer>() > mem::align_of::<u64>() {
        return Err(invalid_property_buffer());
    }
    let words = capacity
        .checked_add(7)
        .ok_or_else(invalid_property_buffer)?
        / 8;
    let mut storage = Vec::<u64>::new();
    storage
        .try_reserve_exact(words)
        .map_err(|_| invalid_property_buffer())?;
    storage.resize(words, 0);
    check_os_status(AudioObjectGetPropertyData(
        object,
        address,
        0,
        null(),
        &mut size,
        storage.as_mut_ptr().cast(),
    ))?;
    let returned = size as usize;
    if returned > capacity || returned < mem::size_of::<u32>() {
        return Err(invalid_property_buffer());
    }
    let count = storage.as_ptr().cast::<u32>().read() as usize;
    if count == 0 {
        return Ok(0);
    }
    let offset = mem::offset_of!(AudioBufferList, mBuffers);
    if !property_data::buffer_list_fits(returned, offset, mem::size_of::<AudioBuffer>(), count) {
        return Err(invalid_property_buffer());
    }
    let first = storage
        .as_ptr()
        .cast::<u8>()
        .add(offset)
        .cast::<AudioBuffer>();
    let buffers = slice::from_raw_parts(first, count);
    buffers.iter().try_fold(0usize, |channels, buffer| {
        channels
            .checked_add(buffer.mNumberChannels as usize)
            .ok_or_else(invalid_property_buffer)
    })
}

#[derive(Clone, PartialEq, Eq)]
pub struct Device {
    pub(crate) audio_device_id: AudioDeviceID,
    is_default: bool,
}

impl Device {
    fn name(&self) -> Result<String, DeviceNameError> {
        let property_address = AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyDeviceNameCFString,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMaster,
        };
        let mut device_name: CFStringRef = null();
        let mut data_size = mem::size_of::<CFStringRef>() as u32;
        unsafe {
            let status = AudioObjectGetPropertyData(
                self.audio_device_id,
                &property_address,
                0,
                null(),
                &mut data_size,
                (&mut device_name as *mut CFStringRef).cast(),
            );
            check_os_status(status)?;
            if data_size as usize != mem::size_of::<CFStringRef>() || device_name.is_null() {
                return Err(invalid_property_buffer().into());
            }
            struct OwnedString(CFStringRef);
            impl Drop for OwnedString {
                fn drop(&mut self) {
                    unsafe { CFRelease(self.0.cast()) }
                }
            }
            let _owned = OwnedString(device_name);
            let c_string: *const c_char = CFStringGetCStringPtr(device_name, kCFStringEncodingUTF8);
            if !c_string.is_null() {
                return Ok(CStr::from_ptr(c_string).to_string_lossy().into_owned());
            }
            let max = CFStringGetMaximumSizeForEncoding(
                CFStringGetLength(device_name),
                kCFStringEncodingUTF8,
            );
            let size = usize::try_from(max)
                .ok()
                .and_then(|value| value.checked_add(1))
                .ok_or_else(invalid_property_buffer)?;
            let cf_size = isize::try_from(size).map_err(|_| invalid_property_buffer())?;
            let mut buffer = Vec::<c_char>::new();
            buffer
                .try_reserve_exact(size)
                .map_err(|_| invalid_property_buffer())?;
            buffer.resize(size, 0);
            if CFStringGetCString(
                device_name,
                buffer.as_mut_ptr(),
                cf_size,
                kCFStringEncodingUTF8,
            ) == 0
            {
                return Err(BackendSpecificError {
                    description: "CoreFoundation could not convert device name".into(),
                }
                .into());
            }
            Ok(CStr::from_ptr(buffer.as_ptr())
                .to_string_lossy()
                .into_owned())
        }
    }

    // Logic re-used between `supported_input_configs` and `supported_output_configs`.
    #[allow(clippy::cast_ptr_alignment)]
    fn supported_configs(
        &self,
        scope: AudioObjectPropertyScope,
    ) -> Result<SupportedOutputConfigs, SupportedStreamConfigsError> {
        let mut property_address = AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMaster,
        };

        unsafe {
            let n_channels = read_channel_count(self.audio_device_id, &property_address)?;
            if n_channels == 0 {
                return Ok(vec![].into_iter());
            }
            let n_channels =
                ChannelCount::try_from(n_channels).map_err(|_| invalid_property_buffer())?;

            // TODO: macOS should support U8, I16, I32, F32 and F64. This should allow for using
            // I16 but just use F32 for now as it's the default anyway.
            let sample_format = SampleFormat::F32;

            property_address.mSelector = kAudioDevicePropertyAvailableNominalSampleRates;
            // AudioValueRange contains only f64 values, for which all bits are valid.
            let ranges: Vec<AudioValueRange> =
                read_property_array(self.audio_device_id, &property_address)?;

            // Enumerating formats must not create an untracked capture unit.
            let buffer_size = get_device_buffer_frame_size_range(self.audio_device_id)?;

            // Collect the supported formats for the device.
            let mut fmts = vec![];
            for range in ranges {
                let fmt = SupportedStreamConfigRange {
                    channels: n_channels,
                    min_sample_rate: SampleRate(range.mMinimum as _),
                    max_sample_rate: SampleRate(range.mMaximum as _),
                    buffer_size,
                    sample_format,
                };
                fmts.push(fmt);
            }

            Ok(fmts.into_iter())
        }
    }

    fn supported_input_configs(
        &self,
    ) -> Result<SupportedOutputConfigs, SupportedStreamConfigsError> {
        self.supported_configs(kAudioObjectPropertyScopeInput)
    }

    fn supported_output_configs(
        &self,
    ) -> Result<SupportedOutputConfigs, SupportedStreamConfigsError> {
        self.supported_configs(kAudioObjectPropertyScopeOutput)
    }

    fn default_config(
        &self,
        scope: AudioObjectPropertyScope,
    ) -> Result<SupportedStreamConfig, DefaultStreamConfigError> {
        fn default_config_error_from_os_status(
            status: OSStatus,
        ) -> Result<(), DefaultStreamConfigError> {
            let err = match coreaudio::Error::from_os_status(status) {
                Err(err) => err,
                Ok(_) => return Ok(()),
            };
            match err {
                coreaudio::Error::AudioUnit(
                    coreaudio::error::AudioUnitError::FormatNotSupported,
                )
                | coreaudio::Error::AudioCodec(_)
                | coreaudio::Error::AudioFormat(_) => {
                    Err(DefaultStreamConfigError::StreamTypeNotSupported)
                }
                coreaudio::Error::AudioUnit(coreaudio::error::AudioUnitError::NoConnection) => {
                    Err(DefaultStreamConfigError::DeviceNotAvailable)
                }
                err => {
                    let description = format!("{}", err);
                    let err = BackendSpecificError { description };
                    Err(err.into())
                }
            }
        }

        let property_address = AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyStreamFormat,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMaster,
        };

        unsafe {
            let mut asbd: AudioStreamBasicDescription = mem::zeroed();
            let mut data_size = mem::size_of::<AudioStreamBasicDescription>() as u32;
            let status = AudioObjectGetPropertyData(
                self.audio_device_id,
                &property_address as *const _,
                0,
                null(),
                &mut data_size,
                (&mut asbd as *mut AudioStreamBasicDescription).cast(),
            );
            default_config_error_from_os_status(status)?;
            if data_size as usize != mem::size_of::<AudioStreamBasicDescription>() {
                return Err(invalid_property_buffer().into());
            }

            let sample_format = {
                let audio_format = coreaudio::audio_unit::AudioFormat::from_format_and_flag(
                    asbd.mFormatID,
                    Some(asbd.mFormatFlags),
                );
                let flags = match audio_format {
                    Some(coreaudio::audio_unit::AudioFormat::LinearPCM(flags)) => flags,
                    _ => return Err(DefaultStreamConfigError::StreamTypeNotSupported),
                };
                let maybe_sample_format =
                    coreaudio::audio_unit::SampleFormat::from_flags_and_bits_per_sample(
                        flags,
                        asbd.mBitsPerChannel,
                    );
                match maybe_sample_format {
                    Some(coreaudio::audio_unit::SampleFormat::F32) => SampleFormat::F32,
                    Some(coreaudio::audio_unit::SampleFormat::I16) => SampleFormat::I16,
                    _ => return Err(DefaultStreamConfigError::StreamTypeNotSupported),
                }
            };

            // Enumerating formats must not create an untracked capture unit.
            let buffer_size = get_device_buffer_frame_size_range(self.audio_device_id)?;

            let config = SupportedStreamConfig {
                sample_rate: SampleRate(asbd.mSampleRate as _),
                channels: asbd.mChannelsPerFrame as _,
                buffer_size,
                sample_format,
            };
            Ok(config)
        }
    }

    fn default_input_config(&self) -> Result<SupportedStreamConfig, DefaultStreamConfigError> {
        self.default_config(kAudioObjectPropertyScopeInput)
    }

    fn default_output_config(&self) -> Result<SupportedStreamConfig, DefaultStreamConfigError> {
        self.default_config(kAudioObjectPropertyScopeOutput)
    }
}

impl fmt::Debug for Device {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.debug_struct("Device")
            .field("audio_device_id", &self.audio_device_id)
            .field("name", &self.name())
            .finish()
    }
}

struct StreamInner {
    playing: bool,
    // A failed start can leave hardware activity uncertain. A subsequent pause
    // must call stop even when start returned an error.
    start_attempted: bool,
    // Once checked disposal begins, the native handle must never be used again.
    close_attempted: bool,
    input_retired: bool,
    input_callback: Option<Arc<input_callback::InputCallback>>,
    audio_unit: AudioUnit,
    // Track the device with which the audio unit was spawned.
    //
    // We must do this so that we can avoid changing the device sample rate if there is already
    // a stream associated with the device.
    #[allow(dead_code)]
    device_id: AudioDeviceID,
}

impl StreamInner {
    fn play(&mut self) -> Result<(), PlayStreamError> {
        if self.close_attempted || self.input_retired {
            return Err(BackendSpecificError {
                description: "CoreAudio stream has been retired".into(),
            }
            .into());
        }
        if !self.playing {
            self.start_attempted = true;
            if let Err(e) = self.audio_unit.start() {
                let description = format!("{}", e);
                let err = BackendSpecificError { description };
                return Err(err.into());
            }
            self.playing = true;
        }
        Ok(())
    }

    fn pause(&mut self) -> Result<(), PauseStreamError> {
        if self.close_attempted {
            return Err(BackendSpecificError {
                description: "CoreAudio stream has been retired".into(),
            }
            .into());
        }
        if self.playing || self.start_attempted {
            if let Err(e) = self.audio_unit.stop() {
                let description = format!("{}", e);
                let err = BackendSpecificError { description };
                return Err(err.into());
            }
            self.playing = false;
            self.start_attempted = false;
        }
        Ok(())
    }
}

fn retire_input_callback(inner: &Mutex<StreamInner>) -> Result<bool, &'static str> {
    let callback = {
        let mut inner = inner
            .lock()
            .map_err(|_| "CoreAudio stream state is poisoned")?;
        let callback = inner.input_callback.clone();
        if callback.is_some() {
            inner.input_retired = true;
        }
        callback
    };
    if let Some(callback) = callback {
        callback
            .retire()
            .map_err(|_| "CoreAudio input callback state is poisoned")?;
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Register the on-disconnect callback.
/// This will both stop the stream and call the error callback with DeviceNotAvailable.
/// This function should only be called once per stream.
fn add_disconnect_listener<E>(
    stream: &mut Stream,
    error_callback: Arc<Mutex<E>>,
) -> Result<(), BuildStreamError>
where
    E: FnMut(StreamError) + Send + 'static,
{
    let stream_inner_weak = Arc::downgrade(&stream.inner);
    let listener_gate = Arc::clone(&stream.listener_gate);
    let device_id = stream.inner.lock().unwrap().device_id;
    let listener = AudioObjectPropertyListener::new(
        device_id,
        AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyDeviceIsAlive,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMaster,
        },
        move || {
            listener_gate.run(|| {
                if let Some(stream_inner_strong) = stream_inner_weak.upgrade() {
                    // Stop admitting input renders before calling the native stop.
                    // Do not hold the stream mutex while callbacks drain.
                    let _ = retire_input_callback(&stream_inner_strong);
                    let mut stream_inner = stream_inner_strong.lock().unwrap();
                    let _ = stream_inner.pause();
                    (error_callback.lock().unwrap())(StreamError::DeviceNotAvailable);
                }
            });
        },
    )?;
    *Arc::get_mut(&mut stream.disconnect_listener)
        .expect("listener is installed before the stream is shared") = Some(listener);
    Ok(())
}

fn fail_input_build<R>(
    resource: R,
    error: BuildStreamError,
    cleanup: impl FnOnce(&mut R) -> Result<(), String>,
) -> BuildStreamError {
    match input_build::cleanup_failed_build(resource, error, cleanup) {
        Ok(error) => error,
        Err((error, cleanup_error)) => BuildStreamError::CleanupUncertain {
            err: BackendSpecificError {
                description: format!(
                    "CoreAudio input setup failed: {error}; cleanup failed: {cleanup_error}"
                ),
            },
        },
    }
}

fn configure_audio_unit(
    audio_unit: &mut AudioUnit,
    device: &Device,
    input: bool,
) -> Result<(), coreaudio::Error> {
    if input {
        let enable_input = 1u32;
        audio_unit.set_property(
            kAudioOutputUnitProperty_EnableIO,
            Scope::Input,
            Element::Input,
            Some(&enable_input),
        )?;
        let disable_output = 0u32;
        audio_unit.set_property(
            kAudioOutputUnitProperty_EnableIO,
            Scope::Output,
            Element::Output,
            Some(&disable_output),
        )?;
    }
    audio_unit.set_property(
        kAudioOutputUnitProperty_CurrentDevice,
        Scope::Global,
        Element::Output,
        Some(&device.audio_device_id),
    )
}

fn output_unit_from_device(device: &Device) -> Result<AudioUnit, coreaudio::Error> {
    let output_type = if device.is_default {
        coreaudio::audio_unit::IOType::DefaultOutput
    } else {
        coreaudio::audio_unit::IOType::HalOutput
    };
    let mut audio_unit = AudioUnit::new(output_type)?;
    configure_audio_unit(&mut audio_unit, device, false)?;
    Ok(audio_unit)
}

fn input_unit_for_build(device: &Device) -> Result<AudioUnit, BuildStreamError> {
    let mut audio_unit = AudioUnit::new(coreaudio::audio_unit::IOType::HalOutput)?;
    if let Err(error) = configure_audio_unit(&mut audio_unit, device, true) {
        return Err(fail_input_build(audio_unit, error.into(), |unit| {
            // The newly created input has not been started and has no callbacks.
            unsafe { unit.close_stopped() }
        }));
    }
    Ok(audio_unit)
}

impl Device {
    #[allow(clippy::cast_ptr_alignment)]
    #[allow(clippy::while_immutable_condition)]
    #[allow(clippy::float_cmp)]
    fn build_input_stream_raw<D, E>(
        &self,
        config: &StreamConfig,
        sample_format: SampleFormat,
        mut data_callback: D,
        error_callback: E,
        _timeout: Option<Duration>,
    ) -> Result<Stream, BuildStreamError>
    where
        D: FnMut(&Data, &InputCallbackInfo) + Send + 'static,
        E: FnMut(StreamError) + Send + 'static,
    {
        // The scope and element for working with a device's input stream.
        let scope = Scope::Output;
        let element = Element::Input;

        // Potentially change the device sample rate to match the config.
        set_sample_rate(self.audio_device_id, config.sample_rate)?;

        let mut audio_unit = input_unit_for_build(self)?;
        let mut input_callback = None;
        let setup = (|| -> Result<Arc<Mutex<E>>, BuildStreamError> {
            // Set the stream in interleaved mode.
            let asbd = asbd_from_config(config, sample_format);
            audio_unit.set_property(
                kAudioUnitProperty_StreamFormat,
                scope,
                element,
                Some(&asbd),
            )?;

            // Set the buffersize
            match config.buffer_size {
                BufferSize::Fixed(v) => {
                    let buffer_size_range = get_io_buffer_frame_size_range(&audio_unit)?;
                    match buffer_size_range {
                        SupportedBufferSize::Range { min, max } => {
                            if v >= min && v <= max {
                                audio_unit.set_property(
                                    kAudioDevicePropertyBufferFrameSize,
                                    scope,
                                    element,
                                    Some(&v),
                                )?
                            } else {
                                return Err(BuildStreamError::StreamConfigNotSupported);
                            }
                        }
                        SupportedBufferSize::Unknown => (),
                    }
                }
                BufferSize::Default => (),
            }

            let error_callback = Arc::new(Mutex::new(error_callback));
            let error_callback_disconnect = error_callback.clone();
            let error_callback_render = error_callback.clone();

            // Register the callback that is being called by coreaudio whenever it needs data to be
            // fed to the audio buffer.
            let bytes_per_channel = sample_format.sample_size();
            let sample_rate = config.sample_rate;
            type Args = render_callback::Args<data::Raw>;
            let mut handle_input = move |args: Args| unsafe {
                let ptr = (*args.data.data).mBuffers.as_ptr();
                let len = (*args.data.data).mNumberBuffers as usize;
                let buffers: &[AudioBuffer] = slice::from_raw_parts(ptr, len);

                // TODO: Perhaps loop over all buffers instead?
                let AudioBuffer {
                    mNumberChannels: channels,
                    mDataByteSize: data_byte_size,
                    mData: data,
                } = buffers[0];

                let data = data as *mut ();
                let len = data_byte_size as usize / bytes_per_channel;
                let data = Data::from_parts(data, len, sample_format);

                // TODO: Need a better way to get delay, for now we assume a double-buffer offset.
                let callback = match host_time_to_stream_instant(args.time_stamp.mHostTime) {
                    Err(err) => {
                        (error_callback.lock().unwrap())(err.into());
                        return Err(());
                    }
                    Ok(cb) => cb,
                };
                let buffer_frames = len / channels as usize;
                let delay = frames_to_duration(buffer_frames, sample_rate);
                let capture = callback
                    .sub(delay)
                    .expect("`capture` occurs before origin of alsa `StreamInstant`");
                let timestamp = crate::InputStreamTimestamp { callback, capture };

                let info = InputCallbackInfo { timestamp };
                data_callback(&data, &info);
                Ok(())
            };

            // CoreAudio's stream-format property returns an AudioStreamBasicDescription.
            let actual: AudioStreamBasicDescription = unsafe {
                audio_unit.get_property(kAudioUnitProperty_StreamFormat, scope, element)?
            };
            let actual_format = coreaudio::audio_unit::StreamFormat::from_asbd(actual)?;
            let expected_format = match sample_format {
                SampleFormat::F32 => coreaudio::audio_unit::SampleFormat::F32,
                SampleFormat::I32 => coreaudio::audio_unit::SampleFormat::I32,
                SampleFormat::I16 => coreaudio::audio_unit::SampleFormat::I16,
                SampleFormat::I8 => coreaudio::audio_unit::SampleFormat::I8,
                _ => return Err(BuildStreamError::StreamConfigNotSupported),
            };
            if actual_format.sample_format != expected_format
                || !actual_format
                    .sample_format
                    .does_match_flags(actual_format.flags)
                || actual.mSampleRate != config.sample_rate.0 as f64
                || actual.mChannelsPerFrame != config.channels as u32
                || actual.mBytesPerFrame != asbd.mBytesPerFrame
                || actual.mBytesPerPacket != asbd.mBytesPerPacket
                || actual.mFramesPerPacket != 1
                || actual.mBitsPerChannel != asbd.mBitsPerChannel
                || actual.mFormatID != asbd.mFormatID
                || actual.mFormatFlags & coreaudio::sys::kAudioFormatFlagIsBigEndian != 0
                || actual.mFormatFlags & coreaudio::sys::kAudioFormatFlagIsNonInterleaved != 0
            {
                return Err(BuildStreamError::StreamConfigNotSupported);
            }
            // The buffer-frame-size property is a u32.
            let buffer_frames: u32 = unsafe {
                audio_unit.get_property(
                    kAudioDevicePropertyBufferFrameSize,
                    Scope::Global,
                    Element::Output,
                )?
            };
            // The callback registry serializes access to this pointer and drains
            // every admitted render before checked disposal begins.
            let native_unit = unsafe { audio_unit.raw_instance() };
            let mut render = input_render::InputRender::new(
                native_unit,
                config.channels as u32,
                bytes_per_channel,
                buffer_frames,
            )
            .ok_or_else(|| BackendSpecificError {
                description: "invalid CoreAudio input buffer size".into(),
            })?;
            let callback =
                input_callback::InputCallback::new(move |flags, timestamp, bus, frames, _| {
                    match unsafe {
                        // CoreAudio supplies the callback pointers. The registry
                        // serializes renders and drains them before unit teardown.
                        render.render(flags, timestamp, bus, frames)
                    } {
                        Ok(args) => match handle_input(args) {
                            Ok(()) => 0,
                            Err(()) => -1500,
                        },
                        Err(status) => {
                            if let Ok(mut callback) = error_callback_render.lock() {
                                callback(
                                    BackendSpecificError {
                                        description: format!(
                                            "CoreAudio input render failed: {status}"
                                        ),
                                    }
                                    .into(),
                                );
                            }
                            status
                        }
                    }
                })
                .ok_or_else(|| BackendSpecificError {
                    description: "CoreAudio input callback tokens exhausted".into(),
                })?;
            input_callback = Some(Arc::new(callback));
            let native_callback = coreaudio::sys::AURenderCallbackStruct {
                inputProc: Some(input_callback::trampoline),
                inputProcRefCon: input_callback
                    .as_ref()
                    .expect("input callback registered")
                    .refcon(),
            };
            audio_unit.set_property(
                coreaudio::sys::kAudioOutputUnitProperty_SetInputCallback,
                Scope::Global,
                Element::Output,
                Some(&native_callback),
            )?;
            Ok(error_callback_disconnect)
        })();
        let error_callback_disconnect = match setup {
            Ok(callback) => callback,
            Err(error) => {
                return Err(fail_input_build(audio_unit, error, |unit| {
                    if let Some(callback) = input_callback.take() {
                        callback.retire().map_err(|_| {
                            "CoreAudio input callback state is poisoned".to_string()
                        })?;
                    }
                    // Input was not started, and any installed callback is retired and drained.
                    unsafe { unit.close_stopped() }
                }));
            }
        };
        let input_callback = input_callback.expect("successful input setup installs a callback");

        let mut stream = Stream::new(StreamInner {
            playing: false,
            start_attempted: false,
            close_attempted: false,
            input_retired: false,
            input_callback: Some(input_callback),
            audio_unit,
            device_id: self.audio_device_id,
        });

        // If we didn't request the default device, stop the stream if the
        // device disconnects.
        if !self.is_default {
            if let Err(error) = add_disconnect_listener(&mut stream, error_callback_disconnect) {
                return Err(fail_input_build(stream, error, |stream| {
                    stream.close_paused_input()
                }));
            }
        }

        // Return the handle before starting capture, so a failed start can be
        // stopped and retained by the owner rather than discarded by build.
        Ok(stream)
    }

    fn build_output_stream_raw<D, E>(
        &self,
        config: &StreamConfig,
        sample_format: SampleFormat,
        mut data_callback: D,
        error_callback: E,
        _timeout: Option<Duration>,
    ) -> Result<Stream, BuildStreamError>
    where
        D: FnMut(&mut Data, &OutputCallbackInfo) + Send + 'static,
        E: FnMut(StreamError) + Send + 'static,
    {
        let mut audio_unit = output_unit_from_device(self)?;

        // The scope and element for working with a device's output stream.
        let scope = Scope::Input;
        let element = Element::Output;

        // Set the stream in interleaved mode.
        let asbd = asbd_from_config(config, sample_format);
        audio_unit.set_property(kAudioUnitProperty_StreamFormat, scope, element, Some(&asbd))?;

        // Set the buffersize
        match config.buffer_size {
            BufferSize::Fixed(v) => {
                let buffer_size_range = get_io_buffer_frame_size_range(&audio_unit)?;
                match buffer_size_range {
                    SupportedBufferSize::Range { min, max } => {
                        if v >= min && v <= max {
                            audio_unit.set_property(
                                kAudioDevicePropertyBufferFrameSize,
                                scope,
                                element,
                                Some(&v),
                            )?
                        } else {
                            return Err(BuildStreamError::StreamConfigNotSupported);
                        }
                    }
                    SupportedBufferSize::Unknown => (),
                }
            }
            BufferSize::Default => (),
        }

        let error_callback = Arc::new(Mutex::new(error_callback));
        let error_callback_disconnect = error_callback.clone();

        // Register the callback that is being called by coreaudio whenever it needs data to be
        // fed to the audio buffer.
        let bytes_per_channel = sample_format.sample_size();
        let sample_rate = config.sample_rate;
        type Args = render_callback::Args<data::Raw>;
        audio_unit.set_render_callback(move |args: Args| unsafe {
            // If `run()` is currently running, then a callback will be available from this list.
            // Otherwise, we just fill the buffer with zeroes and return.

            let AudioBuffer {
                mNumberChannels: channels,
                mDataByteSize: data_byte_size,
                mData: data,
            } = (*args.data.data).mBuffers[0];

            let data = data as *mut ();
            let len = data_byte_size as usize / bytes_per_channel;
            let mut data = Data::from_parts(data, len, sample_format);

            let callback = match host_time_to_stream_instant(args.time_stamp.mHostTime) {
                Err(err) => {
                    (error_callback.lock().unwrap())(err.into());
                    return Err(());
                }
                Ok(cb) => cb,
            };
            // TODO: Need a better way to get delay, for now we assume a double-buffer offset.
            let buffer_frames = len / channels as usize;
            let delay = frames_to_duration(buffer_frames, sample_rate);
            let playback = callback
                .add(delay)
                .expect("`playback` occurs beyond representation supported by `StreamInstant`");
            let timestamp = crate::OutputStreamTimestamp { callback, playback };

            let info = OutputCallbackInfo { timestamp };
            data_callback(&mut data, &info);
            Ok(())
        })?;

        let mut stream = Stream::new(StreamInner {
            playing: true,
            start_attempted: true,
            close_attempted: false,
            input_retired: false,
            input_callback: None,
            audio_unit,
            device_id: self.audio_device_id,
        });

        // If we didn't request the default device, stop the stream if the
        // device disconnects.
        if !self.is_default {
            add_disconnect_listener(&mut stream, error_callback_disconnect)?;
        }

        stream.inner.lock().unwrap().audio_unit.start()?;

        Ok(stream)
    }
}

/// Attempt to set the device sample rate to the provided rate.
/// Return an error if the requested sample rate is not supported by the device.
fn set_sample_rate(
    audio_device_id: AudioObjectID,
    target_sample_rate: SampleRate,
) -> Result<(), BuildStreamError> {
    // Get the current sample rate.
    let mut property_address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyNominalSampleRate,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };
    let mut sample_rate: f64 = 0.0;
    let mut data_size = mem::size_of::<f64>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            audio_device_id,
            &property_address as *const _,
            0,
            null(),
            &mut data_size,
            (&mut sample_rate as *mut f64).cast(),
        )
    };
    coreaudio::Error::from_os_status(status)?;
    if data_size as usize != mem::size_of::<f64>() {
        return Err(invalid_property_buffer().into());
    }

    // If the requested sample rate is different to the device sample rate, update the device.
    if sample_rate != f64::from(target_sample_rate.0) {
        // Get available sample rate ranges.
        property_address.mSelector = kAudioDevicePropertyAvailableNominalSampleRates;
        // AudioValueRange contains only f64 values, for which all bits are valid.
        let ranges: Vec<AudioValueRange> =
            unsafe { read_property_array(audio_device_id, &property_address)? };
        let requested_rate = f64::from(target_sample_rate.0);
        if !ranges.iter().any(|range| {
            property_data::supports_rate(range.mMinimum, range.mMaximum, target_sample_rate.0)
        }) {
            return Err(BuildStreamError::StreamConfigNotSupported);
        }

        let (send, recv) = channel::<Result<f64, coreaudio::Error>>();
        let sample_rate_address = AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMaster,
        };
        // Send sample rate updates back on a channel.
        let sample_rate_handler = move || {
            let mut rate: f64 = 0.0;
            let mut size = mem::size_of::<f64>() as u32;
            let result = unsafe {
                AudioObjectGetPropertyData(
                    audio_device_id,
                    &sample_rate_address,
                    0,
                    null(),
                    &mut size,
                    (&mut rate as *mut f64).cast(),
                )
            };
            let result = coreaudio::Error::from_os_status(result).and_then(|_| {
                if size as usize == mem::size_of::<f64>() {
                    Ok(rate)
                } else {
                    Err(coreaudio::Error::Unspecified)
                }
            });
            let _ = send.send(result);
        };

        let listener = AudioObjectPropertyListener::new(
            audio_device_id,
            sample_rate_address,
            sample_rate_handler,
        )?;

        // Finally, set the sample rate.
        property_address.mSelector = kAudioDevicePropertyNominalSampleRate;
        let status = unsafe {
            AudioObjectSetPropertyData(
                audio_device_id,
                &property_address as *const _,
                0,
                null(),
                mem::size_of::<f64>() as u32,
                (&requested_rate as *const f64).cast(),
            )
        };
        coreaudio::Error::from_os_status(status)?;

        // Wait for the reported_rate to change.
        //
        // This should not take longer than a few ms, but we timeout after 1 sec just in case.
        // We loop over potentially several events from the channel to ensure
        // that we catch the expected change in sample rate.
        let mut timeout = Duration::from_secs(1);
        let start = Instant::now();

        loop {
            match recv.recv_timeout(timeout) {
                Err(err) => {
                    let description = match err {
                        RecvTimeoutError::Disconnected => {
                            "sample rate listener channel disconnected unexpectedly"
                        }
                        RecvTimeoutError::Timeout => {
                            "timeout waiting for sample rate update for device"
                        }
                    }
                    .to_string();
                    return Err(BackendSpecificError { description }.into());
                }
                Ok(Ok(reported_sample_rate)) => {
                    if reported_sample_rate == target_sample_rate.0 as f64 {
                        break;
                    }
                }
                Ok(Err(_)) => {
                    // TODO: should we consider collecting this error?
                }
            };
            timeout = Duration::from_secs(1).saturating_sub(start.elapsed());
        }
        listener.remove()?;
    }
    Ok(())
}

#[derive(Clone)]
pub struct Stream {
    // Listener lifetime belongs to public stream handles, not to the inner
    // Arc a notification can temporarily upgrade. Unregistering a listener
    // from inside its own callback can deadlock on CoreAudio.
    disconnect_listener: Arc<Option<AudioObjectPropertyListener>>,
    listener_gate: Arc<listener_gate::ListenerGate>,
    inner: Arc<Mutex<StreamInner>>,
}

impl Stream {
    fn new(inner: StreamInner) -> Self {
        Self {
            disconnect_listener: Arc::new(None),
            listener_gate: Arc::new(listener_gate::ListenerGate::new()),
            inner: Arc::new(Mutex::new(inner)),
        }
    }

    /// Prevent further disconnect callbacks and wait for an already-running
    /// callback to finish. Call only when the stream is no longer needed, and
    /// never from its disconnect callback (which would wait for itself).
    pub fn quiesce_disconnect_listener(&self) -> Result<(), &'static str> {
        self.listener_gate
            .retire()
            .map_err(|_| "CoreAudio disconnect callback state is poisoned")
    }

    /// Disable input callbacks and wait for admitted renders to finish.
    /// This permanently retires input and must not be called from a callback.
    pub fn quiesce_input(&self) -> Result<(), &'static str> {
        if retire_input_callback(&self.inner)? {
            Ok(())
        } else {
            Err("CoreAudio stream is not an input stream")
        }
    }

    /// Close an already paused input stream and report uncertain teardown.
    /// Do not call from either callback or race this with play or pause.
    pub fn close_paused_input(&self) -> Result<(), String> {
        self.quiesce_disconnect_listener().map_err(str::to_string)?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "CoreAudio stream state is poisoned".to_string())?;
        if inner.close_attempted {
            return Err("CoreAudio stream close was already attempted".into());
        }
        if inner.playing || inner.start_attempted {
            return Err("CoreAudio stream is not paused".into());
        }
        let callback = inner
            .input_callback
            .as_ref()
            .cloned()
            .ok_or_else(|| "CoreAudio stream is not an input stream".to_string())?;
        // Even a failed close can invalidate the native handle. Prevent every
        // later play or pause before calling any native teardown function.
        inner.close_attempted = true;
        drop(inner);
        // Do not hold the stream lock while waiting for user callback code.
        callback
            .retire()
            .map_err(|_| "CoreAudio input callback state is poisoned".to_string())?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "CoreAudio stream state is poisoned".to_string())?;
        // SAFETY: The input callback token is retired and its in-flight work
        // has drained. The disconnect listener is also retired. close_attempted
        // prevents all later native operations through this stream.
        unsafe { inner.audio_unit.close_stopped() }
    }
}

impl StreamTrait for Stream {
    fn play(&self) -> Result<(), PlayStreamError> {
        let mut stream = self.inner.lock().unwrap();

        stream.play()
    }

    fn pause(&self) -> Result<(), PauseStreamError> {
        let mut stream = self.inner.lock().unwrap();

        stream.pause()
    }
}

// Apple documents this device property and the AUHAL property as equivalent.
// Querying the device avoids constructing an input unit during enumeration.
fn get_device_buffer_frame_size_range(
    device: AudioDeviceID,
) -> Result<SupportedBufferSize, BackendSpecificError> {
    let address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyBufferFrameSizeRange,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };
    let mut range = AudioValueRange::default();
    let mut size = mem::size_of::<AudioValueRange>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            device,
            &address,
            0,
            null(),
            &mut size,
            (&mut range as *mut AudioValueRange).cast(),
        )
    };
    check_os_status(status)?;
    if size as usize != mem::size_of::<AudioValueRange>() {
        return Err(invalid_property_buffer());
    }
    Ok(SupportedBufferSize::Range {
        min: range.mMinimum as u32,
        max: range.mMaximum as u32,
    })
}

fn get_io_buffer_frame_size_range(
    audio_unit: &AudioUnit,
) -> Result<SupportedBufferSize, coreaudio::Error> {
    // The frame-size-range property is an AudioValueRange.
    let buffer_size_range: AudioValueRange = unsafe {
        audio_unit.get_property(
            kAudioDevicePropertyBufferFrameSizeRange,
            Scope::Global,
            Element::Output,
        )?
    };

    Ok(SupportedBufferSize::Range {
        min: buffer_size_range.mMinimum as u32,
        max: buffer_size_range.mMaximum as u32,
    })
}
