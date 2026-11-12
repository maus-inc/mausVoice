//! CoreAudio device-name property reads.
use super::macos_property_limits::MAX_PROPERTY_BYTES;
use super::{listener_sys as sys, name_cf as cf, ListenerError as Error};
use cf::{kCFStringEncodingUTF8, CFStringRef};
use std::{convert::TryFrom, ffi::CStr, mem, ptr};
use sys::{
    kAudioDevicePropertyDeviceNameCFString, kAudioDevicePropertyScopeOutput,
    kAudioObjectPropertyElementMaster, AudioDeviceID, AudioObjectPropertyAddress,
};

struct OwnedName(CFStringRef);
impl Drop for OwnedName {
    fn drop(&mut self) {
        unsafe { cf::CFRelease(self.0.cast()) }
    }
}

/// Get the name of a device.
pub fn get_device_name(device_id: AudioDeviceID) -> Result<String, Error> {
    let address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyDeviceNameCFString,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMaster,
    };
    let mut name: CFStringRef = ptr::null();
    let mut size = mem::size_of::<CFStringRef>() as u32;
    let status = unsafe {
        sys::AudioObjectGetPropertyData(
            device_id,
            &address,
            0,
            ptr::null(),
            &mut size,
            (&mut name as *mut CFStringRef).cast(),
        )
    };
    Error::from_os_status(status)?;
    if size != mem::size_of::<CFStringRef>() as u32 || name.is_null() {
        return Err(Error::Unspecified);
    }
    let _owned = OwnedName(name);
    let length = unsafe { cf::CFStringGetLength(name) };
    if length < 0 {
        return Err(Error::Unspecified);
    }
    let max = unsafe { cf::CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) };
    let capacity = usize::try_from(max)
        .ok()
        .and_then(|n| n.checked_add(1))
        .filter(|&n| n <= MAX_PROPERTY_BYTES)
        .ok_or(Error::Unspecified)?;
    let direct = unsafe { cf::CFStringGetCStringPtr(name, kCFStringEncodingUTF8) };
    if !direct.is_null() {
        return Ok(unsafe { CStr::from_ptr(direct) }
            .to_string_lossy()
            .into_owned());
    }
    let cf_capacity = isize::try_from(capacity).map_err(|_| Error::Unspecified)?;
    let mut buffer = Vec::<u8>::new();
    buffer
        .try_reserve_exact(capacity)
        .map_err(|_| Error::Unspecified)?;
    buffer.resize(capacity, 0);
    let converted = unsafe {
        cf::CFStringGetCString(
            name,
            buffer.as_mut_ptr().cast(),
            cf_capacity,
            kCFStringEncodingUTF8,
        )
    };
    if converted == 0 {
        return Err(Error::Unspecified);
    }
    let value = CStr::from_bytes_until_nul(&buffer).map_err(|_| Error::Unspecified)?;
    Ok(value.to_string_lossy().into_owned())
}
