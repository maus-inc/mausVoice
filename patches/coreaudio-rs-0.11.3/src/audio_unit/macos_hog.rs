//! CoreAudio hog-mode property helpers.
use super::{listener_sys as sys, ListenerError as Error};
use std::{mem, ptr};
use sys::{
    kAudioDevicePropertyHogMode, kAudioObjectPropertyElementMaster,
    kAudioObjectPropertyScopeGlobal, pid_t, AudioDeviceID, AudioObjectPropertyAddress,
};

fn address() -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyHogMode,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    }
}

/// Get the owning PID, or -1 when no process owns exclusive access.
pub fn get_hogging_pid(device_id: AudioDeviceID) -> Result<pid_t, Error> {
    let mut pid: pid_t = -1;
    let mut size = mem::size_of::<pid_t>() as u32;
    let status = unsafe {
        sys::AudioObjectGetPropertyData(
            device_id,
            &address(),
            0,
            ptr::null(),
            &mut size,
            (&mut pid as *mut pid_t).cast(),
        )
    };
    Error::from_os_status(status)?;
    if size != mem::size_of::<pid_t>() as u32 {
        return Err(Error::Unspecified);
    }
    Ok(pid)
}

/// Toggle hog mode and return the PID reported after the change.
/// An unowned device is acquired; ownership by the calling process is released.
/// A device owned by another process remains unchanged. A PID of -1 means
/// that no process owns exclusive access.
pub fn toggle_hog_mode(device_id: AudioDeviceID) -> Result<pid_t, Error> {
    let pid: pid_t = -1;
    let status = unsafe {
        sys::AudioObjectSetPropertyData(
            device_id,
            &address(),
            0,
            ptr::null(),
            mem::size_of::<pid_t>() as u32,
            (&pid as *const pid_t).cast(),
        )
    };
    Error::from_os_status(status)?;
    get_hogging_pid(device_id)
}
