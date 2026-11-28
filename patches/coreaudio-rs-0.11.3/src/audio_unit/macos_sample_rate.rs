//! Nominal device sample-rate updates.
use super::macos_listeners::RateListener;
use super::macos_property_limits::MAX_PROPERTY_BYTES;
use super::{listener_sys as sys, ListenerError as Error};
use std::mem;
use std::ptr::null;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::{Duration, Instant};
use sys::{
    kAudioDevicePropertyAvailableNominalSampleRates, kAudioDevicePropertyNominalSampleRate,
    kAudioObjectPropertyElementMaster, kAudioObjectPropertyScopeGlobal, AudioDeviceID,
    AudioObjectPropertyAddress, AudioValueRange,
};

/// Change a device's nominal sample rate and wait for its notification.
pub fn set_device_sample_rate(device_id: AudioDeviceID, new_rate: f64) -> Result<(), Error> {
    if !new_rate.is_finite() || new_rate <= 0.0 {
        return Err(Error::UnsupportedSampleRate);
    }
    let mut address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyNominalSampleRate,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };
    let mut current = 0.0_f64;
    let mut size = mem::size_of::<f64>() as u32;
    let status = unsafe {
        sys::AudioObjectGetPropertyData(
            device_id,
            &address,
            0,
            null(),
            &mut size,
            &mut current as *mut _ as *mut _,
        )
    };
    Error::from_os_status(status)?;
    if size != mem::size_of::<f64>() as u32 {
        return Err(Error::Unspecified);
    }
    if current == new_rate {
        return Ok(());
    }

    address.mSelector = kAudioDevicePropertyAvailableNominalSampleRates;
    let mut size = 0_u32;
    let status =
        unsafe { sys::AudioObjectGetPropertyDataSize(device_id, &address, 0, null(), &mut size) };
    Error::from_os_status(status)?;
    let item_size = mem::size_of::<AudioValueRange>() as u32;
    if size as usize > MAX_PROPERTY_BYTES || size % item_size != 0 {
        return Err(Error::Unspecified);
    }
    if size == 0 {
        return Err(Error::UnsupportedSampleRate);
    }
    let capacity = size;
    let count = (size / item_size) as usize;
    let mut ranges: Vec<AudioValueRange> = Vec::new();
    ranges
        .try_reserve_exact(count)
        .map_err(|_| Error::Unspecified)?;
    ranges.resize(
        count,
        AudioValueRange {
            mMinimum: 0.0,
            mMaximum: 0.0,
        },
    );
    let status = unsafe {
        sys::AudioObjectGetPropertyData(
            device_id,
            &address,
            0,
            null(),
            &mut size,
            ranges.as_mut_ptr().cast(),
        )
    };
    Error::from_os_status(status)?;
    if size > capacity || size % item_size != 0 {
        return Err(Error::Unspecified);
    }
    ranges.truncate((size / item_size) as usize);
    if !ranges
        .iter()
        .any(|range| range.mMinimum <= new_rate && new_rate <= range.mMaximum)
    {
        return Err(Error::UnsupportedSampleRate);
    }

    address.mSelector = kAudioDevicePropertyNominalSampleRate;
    let (sender, receiver) = channel();
    let mut listener = RateListener::new(device_id, Some(sender));
    listener.register()?;
    let status = unsafe {
        sys::AudioObjectSetPropertyData(
            device_id,
            &address,
            0,
            null(),
            mem::size_of::<f64>() as u32,
            &new_rate as *const _ as *const _,
        )
    };
    Error::from_os_status(status)?;

    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(remaining) {
            Ok(reported) if reported == new_rate => return Ok(()),
            Ok(_) if remaining > Duration::ZERO => {}
            Ok(_) | Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {
                return Err(Error::UnsupportedSampleRate);
            }
        }
    }
}
