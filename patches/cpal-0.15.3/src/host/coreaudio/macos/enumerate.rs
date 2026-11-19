extern crate coreaudio;

use self::coreaudio::sys::{
    kAudioHardwareNoError, kAudioHardwarePropertyDefaultInputDevice,
    kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDevices,
    kAudioObjectPropertyElementMaster, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    AudioDeviceID, AudioObjectGetPropertyData, AudioObjectPropertyAddress,
};
use super::Device;
use crate::{BackendSpecificError, DevicesError, SupportedStreamConfigRange};
use std::mem;
use std::ptr::null;
use std::vec::IntoIter as VecIntoIter;

unsafe fn audio_devices() -> Result<Vec<AudioDeviceID>, BackendSpecificError> {
    let property_address = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };
    // AudioDeviceID is a C integer and every bit pattern is valid.
    super::read_property_array(kAudioObjectSystemObject, &property_address)
}

pub struct Devices(VecIntoIter<AudioDeviceID>);

impl Devices {
    pub fn new() -> Result<Self, DevicesError> {
        let devices = unsafe {
            match audio_devices() {
                Ok(devices) => devices,
                Err(error) => return Err(error.into()),
            }
        };
        Ok(Devices(devices.into_iter()))
    }
}

unsafe impl Send for Devices {}
unsafe impl Sync for Devices {}

impl Iterator for Devices {
    type Item = Device;
    fn next(&mut self) -> Option<Device> {
        self.0.next().map(|id| Device {
            audio_device_id: id,
            is_default: false,
        })
    }
}

fn default_device(selector: u32) -> Option<Device> {
    let property_address = AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };
    let mut audio_device_id: AudioDeviceID = 0;
    let mut data_size = mem::size_of::<AudioDeviceID>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject,
            &property_address,
            0,
            null(),
            &mut data_size,
            (&mut audio_device_id as *mut AudioDeviceID).cast(),
        )
    };
    if status != kAudioHardwareNoError as i32
        || data_size as usize != mem::size_of::<AudioDeviceID>()
    {
        return None;
    }
    Some(Device {
        audio_device_id,
        is_default: true,
    })
}

pub fn default_input_device() -> Option<Device> {
    default_device(kAudioHardwarePropertyDefaultInputDevice)
}

pub fn default_output_device() -> Option<Device> {
    default_device(kAudioHardwarePropertyDefaultOutputDevice)
}

pub type SupportedInputConfigs = VecIntoIter<SupportedStreamConfigRange>;
pub type SupportedOutputConfigs = VecIntoIter<SupportedStreamConfigRange>;
