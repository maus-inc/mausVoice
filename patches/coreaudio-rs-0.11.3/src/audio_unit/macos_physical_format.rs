//! CoreAudio physical stream-format property operations.
use super::macos_property_limits::MAX_PROPERTY_BYTES;
use super::{listener_sys as sys, ListenerError as Error};
use std::mem;
use std::ptr::null;
use std::thread;
use std::time::{Duration, Instant};
use sys::{
    kAudioDevicePropertyStreams, kAudioObjectPropertyElementMaster,
    kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyScopeInput,
    kAudioObjectPropertyScopeOutput, kAudioStreamPropertyAvailablePhysicalFormats,
    kAudioStreamPropertyPhysicalFormat, AudioDeviceID, AudioObjectPropertyAddress,
    AudioStreamBasicDescription, AudioStreamID, AudioStreamRangedDescription, AudioValueRange,
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
    let streams = device_streams(device_id)?;
    let stream_id = match streams.as_slice() {
        [only] => *only,
        streams => {
            let mut matched = None;
            for &stream in streams {
                if stream_formats(stream)?.iter().any(|fmt| {
                    let mut candidate = fmt.mFormat;
                    if new_asbd.mSampleRate >= fmt.mSampleRateRange.mMinimum
                        && new_asbd.mSampleRate <= fmt.mSampleRateRange.mMaximum
                    {
                        candidate.mSampleRate = new_asbd.mSampleRate;
                    }
                    asbds_are_equal(&candidate, &new_asbd)
                }) {
                    // The device API cannot disambiguate otherwise identical streams.
                    if matched.replace(stream).is_some() {
                        return Err(Error::UnsupportedStreamFormat);
                    }
                }
            }
            matched.ok_or(Error::UnsupportedStreamFormat)?
        }
    };
    let address = property(kAudioStreamPropertyPhysicalFormat);
    if asbds_are_equal(&read_format(stream_id, &address)?, &new_asbd) {
        return Ok(());
    }
    let status = unsafe {
        sys::AudioObjectSetPropertyData(
            stream_id,
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
        if asbds_are_equal(&read_format(stream_id, &address)?, &new_asbd) {
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

fn property(selector: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    }
}

fn device_streams(device_id: AudioDeviceID) -> Result<Vec<AudioStreamID>, Error> {
    let mut streams = Vec::new();
    for scope in [
        kAudioObjectPropertyScopeInput,
        kAudioObjectPropertyScopeOutput,
    ] {
        let address = AudioObjectPropertyAddress {
            mScope: scope,
            ..property(kAudioDevicePropertyStreams)
        };
        if unsafe { sys::AudioObjectHasProperty(device_id, &address) } != 0 {
            streams.extend(property_items(device_id, address, || 0)?);
        }
    }
    streams.sort_unstable();
    streams.dedup();
    Ok(streams)
}

fn stream_formats(stream_id: AudioStreamID) -> Result<Vec<AudioStreamRangedDescription>, Error> {
    property_items(
        stream_id,
        property(kAudioStreamPropertyAvailablePhysicalFormats),
        || AudioStreamRangedDescription {
            mFormat: empty_format(),
            mSampleRateRange: AudioValueRange {
                mMinimum: 0.0,
                mMaximum: 0.0,
            },
        },
    )
}

/// Get supported physical formats from the device's AudioStream objects.
pub fn get_supported_physical_stream_formats(
    device_id: AudioDeviceID,
) -> Result<Vec<AudioStreamRangedDescription>, Error> {
    let mut formats = Vec::new();
    for stream in device_streams(device_id)? {
        let supported = stream_formats(stream)?;
        let limit = MAX_PROPERTY_BYTES / mem::size_of::<AudioStreamRangedDescription>();
        if supported.len() > limit.saturating_sub(formats.len()) {
            return Err(Error::Unspecified);
        }
        formats
            .try_reserve(supported.len())
            .map_err(|_| Error::Unspecified)?;
        formats.extend(supported);
    }
    Ok(formats)
}

fn property_items<T>(
    object_id: u32,
    address: AudioObjectPropertyAddress,
    empty: impl FnMut() -> T,
) -> Result<Vec<T>, Error> {
    let mut size = 0_u32;
    let status =
        unsafe { sys::AudioObjectGetPropertyDataSize(object_id, &address, 0, null(), &mut size) };
    Error::from_os_status(status)?;
    let item_size = mem::size_of::<T>() as u32;
    if size as usize > MAX_PROPERTY_BYTES || size % item_size != 0 {
        return Err(Error::Unspecified);
    }
    if size == 0 {
        return Ok(Vec::new());
    }
    let capacity = size;
    let count = (size / item_size) as usize;
    let mut items = Vec::new();
    items
        .try_reserve_exact(count)
        .map_err(|_| Error::Unspecified)?;
    items.resize_with(count, empty);
    let status = unsafe {
        sys::AudioObjectGetPropertyData(
            object_id,
            &address,
            0,
            null(),
            &mut size,
            items.as_mut_ptr().cast(),
        )
    };
    Error::from_os_status(status)?;
    if size > capacity || size % item_size != 0 {
        return Err(Error::Unspecified);
    }
    items.truncate((size / item_size) as usize);
    Ok(items)
}
