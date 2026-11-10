//! Device ID queries with CoreAudio-owned output lengths.
use super::macos_device_scope::get_audio_device_supports_scope;
use super::macos_property_limits::MAX_PROPERTY_BYTES;
use super::{listener_sys as sys, ListenerError as Error, Scope};
use std::mem;
use std::ptr::null;
use sys::{
    kAudioHardwareNoError, kAudioHardwarePropertyDefaultInputDevice,
    kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDevices,
    kAudioObjectPropertyElementMaster, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    AudioDeviceID, AudioObjectPropertyAddress,
};

/// Get the default input or output device identifier.
pub fn get_default_device_id(input: bool) -> Option<AudioDeviceID> {
    let selector = if input {
        kAudioHardwarePropertyDefaultInputDevice
    } else {
        kAudioHardwarePropertyDefaultOutputDevice
    };
    let address = AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };
    let mut id: AudioDeviceID = 0;
    let mut size = mem::size_of::<AudioDeviceID>() as u32;
    let status = unsafe {
        sys::AudioObjectGetPropertyData(
            kAudioObjectSystemObject,
            &address,
            0,
            null(),
            &mut size,
            &mut id as *mut _ as *mut _,
        )
    };
    if status != kAudioHardwareNoError as i32 || size != mem::size_of::<AudioDeviceID>() as u32 {
        return None;
    }
    Some(id)
}

/// List device identifiers, filtering input or output scopes by device capability.
/// Other scopes return the global list, as before.
pub fn get_audio_device_ids_for_scope(scope: Scope) -> Result<Vec<AudioDeviceID>, Error> {
    // The system object's device-list property is global. Input/output are
    // device scopes, not scopes of the system object's enumeration property.
    let address = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };
    let mut size = 0_u32;
    let status = unsafe {
        sys::AudioObjectGetPropertyDataSize(
            kAudioObjectSystemObject,
            &address,
            0,
            null(),
            &mut size,
        )
    };
    if status != kAudioHardwareNoError as i32 {
        return Err(Error::Unknown(status));
    }
    let item_size = mem::size_of::<AudioDeviceID>() as u32;
    if size as usize > MAX_PROPERTY_BYTES || size % item_size != 0 {
        return Err(Error::Unspecified);
    }
    if size == 0 {
        return Ok(Vec::new());
    }
    let capacity = size;
    let count = (size / item_size) as usize;
    let mut devices: Vec<AudioDeviceID> = Vec::new();
    devices
        .try_reserve_exact(count)
        .map_err(|_| Error::Unspecified)?;
    devices.resize(count, 0);
    let status = unsafe {
        sys::AudioObjectGetPropertyData(
            kAudioObjectSystemObject,
            &address,
            0,
            null(),
            &mut size,
            devices.as_mut_ptr().cast(),
        )
    };
    if status != kAudioHardwareNoError as i32 {
        return Err(Error::Unknown(status));
    }
    if size > capacity || size % item_size != 0 {
        return Err(Error::Unspecified);
    }
    devices.truncate((size / item_size) as usize);
    if matches!(scope, Scope::Input | Scope::Output) {
        let mut scoped = Vec::new();
        for device in devices {
            if get_audio_device_supports_scope(device, scope)? {
                scoped.push(device);
            }
        }
        return Ok(scoped);
    }
    Ok(devices)
}

/// List all audio device identifiers.
pub fn get_audio_device_ids() -> Result<Vec<AudioDeviceID>, Error> {
    get_audio_device_ids_for_scope(Scope::Global)
}
