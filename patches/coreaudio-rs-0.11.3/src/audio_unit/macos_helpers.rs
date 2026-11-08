/// This is a collection of helper functions for performing common tasks on macOS.
/// These functions are only implemented for macOS, not iOS.
use crate::error::Error;
use std::ffi::CStr;
use std::os::raw::c_char;
use std::ptr::null;
use std::time::Duration;
use std::{mem, thread};

use core_foundation_sys::string::{CFStringGetCString, CFStringGetCStringPtr, CFStringRef};
use sys;
use sys::pid_t;
use sys::{
    kAudioDevicePropertyDeviceNameCFString, kAudioDevicePropertyHogMode,
    kAudioDevicePropertyScopeOutput, kAudioDevicePropertyStreamConfiguration,
    kAudioHardwareNoError, kAudioObjectPropertyElementMaster, kAudioObjectPropertyElementWildcard,
    kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyScopeInput,
    kAudioObjectPropertyScopeOutput, kAudioOutputUnitProperty_CurrentDevice,
    kAudioOutputUnitProperty_EnableIO, kAudioStreamPropertyAvailablePhysicalFormats,
    kAudioStreamPropertyPhysicalFormat, kCFStringEncodingUTF8, AudioDeviceID,
    AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectPropertyAddress,
    AudioObjectPropertyScope, AudioObjectSetPropertyData, AudioStreamBasicDescription,
    AudioStreamRangedDescription,
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

/// does this device support input / ouptut?
pub fn get_audio_device_supports_scope(devid: AudioDeviceID, scope: Scope) -> Result<bool, Error> {
    let dev_scope: AudioObjectPropertyScope = match scope {
        Scope::Input => kAudioObjectPropertyScopeInput,
        Scope::Output => kAudioObjectPropertyScopeOutput,
        _ => kAudioObjectPropertyScopeGlobal,
    };
    let property_address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: dev_scope,
        mElement: kAudioObjectPropertyElementWildcard,
    };

    macro_rules! try_status_or_return {
        ($status:expr) => {
            if $status != kAudioHardwareNoError as i32 {
                return Err(Error::Unknown($status));
            }
        };
    }

    let data_size = 0u32;
    let status = unsafe {
        AudioObjectGetPropertyDataSize(
            devid,
            &property_address as *const _,
            0,
            null(),
            &data_size as *const _ as *mut _,
        )
    };
    try_status_or_return!(status);

    let mut bfrs: Vec<u8> = Vec::with_capacity(data_size as usize);
    let buffers = bfrs.as_mut_ptr() as *mut sys::AudioBufferList;
    unsafe {
        let status = AudioObjectGetPropertyData(
            devid,
            &property_address as *const _,
            0,
            null(),
            &data_size as *const _ as *mut _,
            buffers as *mut _,
        );
        if status != kAudioHardwareNoError as i32 {
            return Err(Error::Unknown(status));
        }

        for i in 0..(*buffers).mNumberBuffers {
            let buf = (*buffers).mBuffers[i as usize];
            if buf.mNumberChannels > 0 {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Get the device name for a device id.
pub fn get_device_name(device_id: AudioDeviceID) -> Result<String, Error> {
    let property_address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyDeviceNameCFString,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMaster,
    };

    macro_rules! try_status_or_return {
        ($status:expr) => {
            if $status != kAudioHardwareNoError as i32 {
                return Err(Error::Unknown($status));
            }
        };
    }

    let device_name: CFStringRef = null();
    let data_size = mem::size_of::<CFStringRef>();
    let c_str = unsafe {
        let status = AudioObjectGetPropertyData(
            device_id,
            &property_address as *const _,
            0,
            null(),
            &data_size as *const _ as *mut _,
            &device_name as *const _ as *mut _,
        );
        try_status_or_return!(status);

        let c_string: *const c_char = CFStringGetCStringPtr(device_name, kCFStringEncodingUTF8);
        if c_string.is_null() {
            let status = AudioObjectGetPropertyData(
                device_id,
                &property_address as *const _,
                0,
                null(),
                &data_size as *const _ as *mut _,
                &device_name as *const _ as *mut _,
            );
            try_status_or_return!(status);
            let mut buf: [i8; 255] = [0; 255];
            let result = CFStringGetCString(
                device_name,
                buf.as_mut_ptr(),
                buf.len() as _,
                kCFStringEncodingUTF8,
            );
            if result == 0 {
                return Err(Error::Unknown(result as i32));
            }
            let name: &CStr = CStr::from_ptr(buf.as_ptr());
            return Ok(name.to_str().unwrap().to_owned());
        }
        CStr::from_ptr(c_string as *mut _)
    };
    Ok(c_str.to_string_lossy().into_owned())
}

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

/// Change the physical stream format (sample rate and format) of a device.
pub fn set_device_physical_stream_format(
    device_id: AudioDeviceID,
    new_asbd: AudioStreamBasicDescription,
) -> Result<(), Error> {
    unsafe {
        // Get the current format.
        let property_address = AudioObjectPropertyAddress {
            mSelector: kAudioStreamPropertyPhysicalFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMaster,
        };
        let maybe_asbd: mem::MaybeUninit<AudioStreamBasicDescription> = mem::MaybeUninit::zeroed();
        let data_size = mem::size_of::<AudioStreamBasicDescription>() as u32;
        let status = AudioObjectGetPropertyData(
            device_id,
            &property_address as *const _,
            0,
            null(),
            &data_size as *const _ as *mut _,
            &maybe_asbd as *const _ as *mut _,
        );
        Error::from_os_status(status)?;
        let asbd = maybe_asbd.assume_init();

        if !asbds_are_equal(&asbd, &new_asbd) {
            let property_address = AudioObjectPropertyAddress {
                mSelector: kAudioStreamPropertyPhysicalFormat,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMaster,
            };

            let reported_asbd: mem::MaybeUninit<AudioStreamBasicDescription> =
                mem::MaybeUninit::zeroed();
            let reported_asbd = reported_asbd.assume_init();

            let status = AudioObjectSetPropertyData(
                device_id,
                &property_address as *const _,
                0,
                null(),
                data_size,
                &new_asbd as *const _ as *const _,
            );
            Error::from_os_status(status)?;

            // Wait for the reported format to change.
            // This can take up to half a second, but we timeout after 2 sec just in case.
            let timer = ::std::time::Instant::now();
            loop {
                let status = AudioObjectGetPropertyData(
                    device_id,
                    &property_address as *const _,
                    0,
                    null(),
                    &data_size as *const _ as *mut _,
                    &reported_asbd as *const _ as *mut _,
                );
                Error::from_os_status(status)?;
                if asbds_are_equal(&reported_asbd, &new_asbd) {
                    break;
                }
                thread::sleep(Duration::from_millis(5));
                if timer.elapsed() > Duration::from_secs(2) {
                    return Err(Error::UnsupportedStreamFormat);
                }
            }
        }
        Ok(())
    }
}

/// Helper to check if two ASBDs are equal.
fn asbds_are_equal(
    left: &AudioStreamBasicDescription,
    right: &AudioStreamBasicDescription,
) -> bool {
    left.mSampleRate as u32 == right.mSampleRate as u32
        && left.mFormatID == right.mFormatID
        && left.mFormatFlags == right.mFormatFlags
        && left.mBytesPerPacket == right.mBytesPerPacket
        && left.mFramesPerPacket == right.mFramesPerPacket
        && left.mBytesPerFrame == right.mBytesPerFrame
        && left.mChannelsPerFrame == right.mChannelsPerFrame
        && left.mBitsPerChannel == right.mBitsPerChannel
}

/// Get a vector with all supported physical formats as AudioBasicRangedDescriptions.
pub fn get_supported_physical_stream_formats(
    device_id: AudioDeviceID,
) -> Result<Vec<AudioStreamRangedDescription>, Error> {
    // Get available formats.
    let mut property_address = AudioObjectPropertyAddress {
        mSelector: kAudioStreamPropertyPhysicalFormat,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };
    let allformats = unsafe {
        property_address.mSelector = kAudioStreamPropertyAvailablePhysicalFormats;
        let mut data_size = 0u32;
        let status = AudioObjectGetPropertyDataSize(
            device_id,
            &property_address as *const _,
            0,
            null(),
            &mut data_size as *mut _,
        );
        Error::from_os_status(status)?;
        let n_formats = data_size as usize / mem::size_of::<AudioStreamRangedDescription>();
        let mut formats: Vec<AudioStreamRangedDescription> = vec![];
        formats.reserve_exact(n_formats as usize);
        formats.set_len(n_formats);

        let status = AudioObjectGetPropertyData(
            device_id,
            &property_address as *const _,
            0,
            null(),
            &data_size as *const _ as *mut _,
            formats.as_mut_ptr() as *mut _,
        );
        Error::from_os_status(status)?;
        formats
    };
    Ok(allformats)
}

pub use super::macos_listeners::{AliveListener, RateListener, RateListenerState};

/// Helper for hog mode (exclusive access).
/// Get the pid of the process that currently owns exclusive access to a device.
/// A pid value of -1 means no process owns exclusive access.
pub fn get_hogging_pid(device_id: AudioDeviceID) -> Result<pid_t, Error> {
    let property_address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyHogMode,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };
    let pid = unsafe {
        let temp_pid: pid_t = 0;
        let data_size = mem::size_of::<pid_t>();
        let status = AudioObjectGetPropertyData(
            device_id,
            &property_address as *const _,
            0,
            null(),
            &data_size as *const _ as *mut _,
            &temp_pid as *const _ as *mut _,
        );
        Error::from_os_status(status)?;
        temp_pid
    };
    Ok(pid)
}

/// Helper for hog mode (exclusive access).
/// Toggle hog mode for a device.
/// If no process owns exclusive access, then the calling process takes ownership.
/// If the calling process already has ownership, this is released.
/// If another process owns access, then nothing will happen.
/// Returns the pid of the new owning process.
/// A pid value of -1 means no process owns exclusive access.
pub fn toggle_hog_mode(device_id: AudioDeviceID) -> Result<pid_t, Error> {
    let property_address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyHogMode,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };
    let pid = unsafe {
        let temp_pid: pid_t = -1;
        let data_size = mem::size_of::<pid_t>();
        let status = AudioObjectSetPropertyData(
            device_id,
            &property_address as *const _,
            0,
            null(),
            data_size as u32,
            &temp_pid as *const _ as *mut _,
        );
        Error::from_os_status(status)?;
        let status = AudioObjectGetPropertyData(
            device_id,
            &property_address as *const _,
            0,
            null(),
            &data_size as *const _ as *mut _,
            &temp_pid as *const _ as *mut _,
        );
        Error::from_os_status(status)?;
        temp_pid
    };
    Ok(pid)
}
