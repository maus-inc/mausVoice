//! Bounded CoreAudio stream-configuration reads.
use super::macos_property_limits::MAX_PROPERTY_BYTES;
use super::{listener_sys as sys, ListenerError as Error, Scope};
use std::{mem, ptr};
use sys::{
    kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyElementWildcard,
    kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyScopeInput,
    kAudioObjectPropertyScopeOutput, AudioBuffer, AudioBufferList, AudioDeviceID,
    AudioObjectPropertyAddress, AudioObjectPropertyScope,
};

/// Does this device support input/output on the requested scope?
pub fn get_audio_device_supports_scope(
    device_id: AudioDeviceID,
    scope: Scope,
) -> Result<bool, Error> {
    let dev_scope: AudioObjectPropertyScope = match scope {
        Scope::Input => kAudioObjectPropertyScopeInput,
        Scope::Output => kAudioObjectPropertyScopeOutput,
        _ => kAudioObjectPropertyScopeGlobal,
    };
    let address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: dev_scope,
        mElement: kAudioObjectPropertyElementWildcard,
    };
    let mut size = 0_u32;
    let status = unsafe {
        sys::AudioObjectGetPropertyDataSize(device_id, &address, 0, ptr::null(), &mut size)
    };
    Error::from_os_status(status)?;

    // `AudioBufferList` has a variable-length trailing array. Allocate initialized
    // native-word storage, and ensure that its alignment satisfies the ABI before
    // handing it to CoreAudio. Do not construct Rust references to the list or to
    // the flexible array: parse only the checked integer fields from the bytes.
    if mem::align_of::<usize>() < mem::align_of::<AudioBufferList>() {
        return Err(Error::Unspecified);
    }
    let header = mem::offset_of!(AudioBufferList, mBuffers);
    let capacity = size as usize;
    if capacity < header || capacity > MAX_PROPERTY_BYTES {
        return Err(Error::Unspecified);
    }
    let word_size = mem::size_of::<usize>();
    let words = capacity
        .checked_add(word_size - 1)
        .ok_or(Error::Unspecified)?
        / word_size;
    let mut storage = Vec::<usize>::new();
    storage
        .try_reserve_exact(words)
        .map_err(|_| Error::Unspecified)?;
    storage.resize(words, 0);
    let status = unsafe {
        sys::AudioObjectGetPropertyData(
            device_id,
            &address,
            0,
            ptr::null(),
            &mut size,
            storage.as_mut_ptr().cast(),
        )
    };
    Error::from_os_status(status)?;
    let returned = size as usize;
    if returned > capacity || returned < header {
        return Err(Error::Unspecified);
    }
    let bytes = storage.as_ptr().cast::<u8>();
    let count_offset = mem::offset_of!(AudioBufferList, mNumberBuffers);
    let count = unsafe { ptr::read_unaligned(bytes.add(count_offset).cast::<u32>()) } as usize;
    let required = count
        .checked_mul(mem::size_of::<AudioBuffer>())
        .and_then(|n| header.checked_add(n))
        .ok_or(Error::Unspecified)?;
    if required > returned {
        return Err(Error::Unspecified);
    }
    let channel_offset = mem::offset_of!(AudioBuffer, mNumberChannels);
    for index in 0..count {
        let offset = header + index * mem::size_of::<AudioBuffer>() + channel_offset;
        let channels = unsafe { ptr::read_unaligned(bytes.add(offset).cast::<u32>()) };
        if channels > 0 {
            return Ok(true);
        }
    }
    Ok(false)
}
