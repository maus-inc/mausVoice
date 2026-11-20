/// This is a collection of helper functions for performing common tasks on macOS.
/// These functions are only implemented for macOS, not iOS.
use crate::error::Error;
use sys::{
    kAudioOutputUnitProperty_CurrentDevice, kAudioOutputUnitProperty_EnableIO, AudioDeviceID,
    AudioStreamBasicDescription,
};

use crate::audio_unit::audio_format::{AudioFormat, LinearPcmFlags};
use crate::audio_unit::sample_format::SampleFormat;
use crate::audio_unit::stream_format::StreamFormat;
use crate::audio_unit::{AudioUnit, Element, IOType, Scope};

pub use super::macos_devices::{
    get_audio_device_ids, get_audio_device_ids_for_scope, get_default_device_id,
};

/// Find the device id for a device name.
pub fn get_device_id_from_name(name: &str) -> Option<AudioDeviceID> {
    if let Ok(all_ids) = get_audio_device_ids() {
        return all_ids
            .iter()
            .find(|id| get_device_name(**id).unwrap_or_else(|_| "".to_string()) == name)
            .copied();
    }
    None
}

/// Create an AudioUnit instance from a device id.
pub fn audio_unit_from_device_id(
    device_id: AudioDeviceID,
    input: bool,
) -> Result<AudioUnit, Error> {
    let mut audio_unit = AudioUnit::new(IOType::HalOutput)?;

    if input {
        // Enable input processing.
        let enable_input = 1u32;
        audio_unit.set_property(
            kAudioOutputUnitProperty_EnableIO,
            Scope::Input,
            Element::Input,
            Some(&enable_input),
        )?;

        // Disable output processing.
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
        Some(&device_id),
    )?;

    Ok(audio_unit)
}

#[test]
fn test_get_audio_device_ids() {
    let _ = get_audio_device_ids().expect("Failed to get audio device ids");
}

#[test]
fn test_get_audio_device_ids_for_scope() {
    for scope in &[
        Scope::Global,
        Scope::Input,
        Scope::Output,
        Scope::Group,
        Scope::Part,
        Scope::Note,
        Scope::Layer,
        Scope::LayerItem,
    ] {
        let _ = get_audio_device_ids_for_scope(*scope).expect("Failed to get audio device ids");
    }
}

pub use super::macos_device_scope::get_audio_device_supports_scope;

pub use super::macos_device_name::get_device_name;

pub use super::macos_sample_rate::set_device_sample_rate;

/// Find the closest match of the physical formats to the provided `StreamFormat`.
/// This function will pick the first format it finds that supports the provided sample format, rate and number of channels.
/// The provided format flags in the `StreamFormat` are ignored.
pub fn find_matching_physical_format(
    device_id: AudioDeviceID,
    stream_format: StreamFormat,
) -> Option<AudioStreamBasicDescription> {
    if let Ok(all_formats) = get_supported_physical_stream_formats(device_id) {
        let requested_samplerate = stream_format.sample_rate as usize;
        let requested_bits = stream_format.sample_format.size_in_bits();
        let requested_float = stream_format.sample_format == SampleFormat::F32;
        let requested_channels = stream_format.channels;
        for fmt in all_formats {
            let min_rate = fmt.mSampleRateRange.mMinimum as usize;
            let max_rate = fmt.mSampleRateRange.mMaximum as usize;
            let rate = fmt.mFormat.mSampleRate as usize;
            let channels = fmt.mFormat.mChannelsPerFrame;
            if let Some(AudioFormat::LinearPCM(flags)) = AudioFormat::from_format_and_flag(
                fmt.mFormat.mFormatID,
                Some(fmt.mFormat.mFormatFlags),
            ) {
                let is_float = flags.contains(LinearPcmFlags::IS_FLOAT);
                let is_int = flags.contains(LinearPcmFlags::IS_SIGNED_INTEGER);
                if is_int && is_float {
                    // Probably never occurs, check just in case
                    continue;
                }
                if requested_float && !is_float {
                    // Wrong number type
                    continue;
                }
                if !requested_float && !is_int {
                    // Wrong number type
                    continue;
                }
                if requested_bits != fmt.mFormat.mBitsPerChannel {
                    // Wrong number of bits
                    continue;
                }
                if requested_channels > channels {
                    // Too few channels
                    continue;
                }
                if rate == requested_samplerate
                    || (requested_samplerate >= min_rate && requested_samplerate <= max_rate)
                {
                    return Some(fmt.mFormat);
                }
            }
        }
    }
    None
}

pub use super::macos_physical_format::{
    get_supported_physical_stream_formats, set_device_physical_stream_format,
};

pub use super::macos_listeners::{AliveListener, RateListener, RateListenerState};

pub use super::macos_hog::{get_hogging_pid, toggle_hog_mode};
