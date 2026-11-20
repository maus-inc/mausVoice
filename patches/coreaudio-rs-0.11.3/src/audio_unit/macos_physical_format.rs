//! CoreAudio physical stream-format property operations.
use super::macos_property_limits::MAX_PROPERTY_BYTES;
use super::{listener_sys as sys, ListenerError as Error};
use std::mem;
use std::ptr::null;
use std::thread;
use std::time::{Duration, Instant};
use sys::{
    kAudioObjectPropertyElementMaster, kAudioObjectPropertyScopeGlobal,
    kAudioStreamPropertyAvailablePhysicalFormats, kAudioStreamPropertyPhysicalFormat,
    AudioDeviceID, AudioObjectPropertyAddress, AudioStreamBasicDescription,
    AudioStreamRangedDescription, AudioValueRange,
};

fn empty_format() -> AudioStreamBasicDescription {
    AudioStreamBasicDescription {
        mSampleRate: 0.0,
        mFormatID: 0,
        mFormatFlags: 0,
        mBytesPerPacket: 0,
        mFramesPerPacket: 0,
        mBytesPerFrame: 0,
        mChannelsPerFrame: 0,
        mBitsPerChannel: 0,
        mReserved: 0,
    }
}

fn read_format(
    device_id: AudioDeviceID,
    address: &AudioObjectPropertyAddress,
) -> Result<AudioStreamBasicDescription, Error> {
    let mut format = empty_format();
    let mut size = mem::size_of::<AudioStreamBasicDescription>() as u32;
    let status = unsafe {
        sys::AudioObjectGetPropertyData(
            device_id,
            address,
            0,
            null(),
            &mut size,
            (&mut format as *mut AudioStreamBasicDescription).cast(),
        )
    };
    Error::from_os_status(status)?;
    if size != mem::size_of::<AudioStreamBasicDescription>() as u32 {
        return Err(Error::Unspecified);
    }
    Ok(format)
}

/// Change the physical stream format (sample rate and format) of a device.
pub fn set_device_physical_stream_format(
    device_id: AudioDeviceID,
    new_asbd: AudioStreamBasicDescription,
) -> Result<(), Error> {
    let address = AudioObjectPropertyAddress {
        mSelector: kAudioStreamPropertyPhysicalFormat,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };
    if asbds_are_equal(&read_format(device_id, &address)?, &new_asbd) {
        return Ok(());
    }
    let status = unsafe {
        sys::AudioObjectSetPropertyData(
            device_id,
            &address,
            0,
            null(),
            mem::size_of::<AudioStreamBasicDescription>() as u32,
            (&new_asbd as *const AudioStreamBasicDescription).cast(),
        )
    };
    Error::from_os_status(status)?;
    let timer = Instant::now();
    loop {
        if asbds_are_equal(&read_format(device_id, &address)?, &new_asbd) {
            return Ok(());
        }
        if timer.elapsed() >= Duration::from_secs(2) {
            return Err(Error::UnsupportedStreamFormat);
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn asbds_are_equal(
    left: &AudioStreamBasicDescription,
    right: &AudioStreamBasicDescription,
) -> bool {
    left.mSampleRate == right.mSampleRate
        && left.mFormatID == right.mFormatID
        && left.mFormatFlags == right.mFormatFlags
        && left.mBytesPerPacket == right.mBytesPerPacket
        && left.mFramesPerPacket == right.mFramesPerPacket
        && left.mBytesPerFrame == right.mBytesPerFrame
        && left.mChannelsPerFrame == right.mChannelsPerFrame
        && left.mBitsPerChannel == right.mBitsPerChannel
}

/// Get all supported physical formats as ranged descriptions.
pub fn get_supported_physical_stream_formats(
    device_id: AudioDeviceID,
) -> Result<Vec<AudioStreamRangedDescription>, Error> {
    let address = AudioObjectPropertyAddress {
        mSelector: kAudioStreamPropertyAvailablePhysicalFormats,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };
    let mut size = 0_u32;
    let status =
        unsafe { sys::AudioObjectGetPropertyDataSize(device_id, &address, 0, null(), &mut size) };
    Error::from_os_status(status)?;
    let item_size = mem::size_of::<AudioStreamRangedDescription>() as u32;
    if size as usize > MAX_PROPERTY_BYTES || size % item_size != 0 {
        return Err(Error::Unspecified);
    }
    if size == 0 {
        return Ok(Vec::new());
    }
    let capacity = size;
    let count = (size / item_size) as usize;
    let mut formats = Vec::new();
    formats
        .try_reserve_exact(count)
        .map_err(|_| Error::Unspecified)?;
    formats.resize_with(count, || AudioStreamRangedDescription {
        mFormat: empty_format(),
        mSampleRateRange: AudioValueRange {
            mMinimum: 0.0,
            mMaximum: 0.0,
        },
    });
    let status = unsafe {
        sys::AudioObjectGetPropertyData(
            device_id,
            &address,
            0,
            null(),
            &mut size,
            formats.as_mut_ptr().cast(),
        )
    };
    Error::from_os_status(status)?;
    if size > capacity || size % item_size != 0 {
        return Err(Error::Unspecified);
    }
    formats.truncate((size / item_size) as usize);
    Ok(formats)
}
