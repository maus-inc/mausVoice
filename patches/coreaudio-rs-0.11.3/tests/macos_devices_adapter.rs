//! Portable tests of device queries against a simulated CoreAudio API.
#![allow(non_snake_case, non_upper_case_globals, dead_code)]
use std::sync::Mutex;

#[derive(Debug)]
pub enum ListenerError {
    Unspecified,
    Unknown(i32),
}
#[derive(Clone, Copy)]
pub enum Scope {
    Global,
    Input,
    Output,
    Other,
}

pub mod listener_sys {
    use std::ffi::c_void;
    use std::sync::Mutex;
    pub type AudioDeviceID = u32;
    pub const kAudioHardwareNoError: u32 = 0;
    pub const kAudioHardwarePropertyDefaultInputDevice: u32 = 1;
    pub const kAudioHardwarePropertyDefaultOutputDevice: u32 = 2;
    pub const kAudioHardwarePropertyDevices: u32 = 3;
    pub const kAudioObjectPropertyElementMaster: u32 = 4;
    pub const kAudioObjectPropertyScopeGlobal: u32 = 5;
    pub const kAudioObjectPropertyScopeInput: u32 = 6;
    pub const kAudioObjectPropertyScopeOutput: u32 = 7;
    pub const kAudioObjectSystemObject: u32 = 8;
    pub struct AudioObjectPropertyAddress {
        pub mSelector: u32,
        pub mScope: u32,
        pub mElement: u32,
    }
    pub struct Fixture {
        pub queried: u32,
        pub returned: u32,
        pub status: i32,
        pub query_status: i32,
        pub values: Vec<u32>,
        pub scope: u32,
        pub selector: u32,
        pub reads: u32,
    }
    pub static FIXTURE: Mutex<Fixture> = Mutex::new(Fixture {
        queried: 0,
        returned: 0,
        status: 0,
        query_status: 0,
        values: Vec::new(),
        scope: 0,
        selector: 0,
        reads: 0,
    });
    pub unsafe fn AudioObjectGetPropertyDataSize(
        _: u32,
        addr: *const AudioObjectPropertyAddress,
        _: u32,
        _: *const c_void,
        size: *mut u32,
    ) -> i32 {
        let mut f = FIXTURE.lock().unwrap();
        f.scope = (*addr).mScope;
        f.selector = (*addr).mSelector;
        *size = f.queried;
        f.query_status
    }
    pub unsafe fn AudioObjectGetPropertyData(
        _: u32,
        addr: *const AudioObjectPropertyAddress,
        _: u32,
        _: *const c_void,
        size: *mut u32,
        output: *mut c_void,
    ) -> i32 {
        let mut f = FIXTURE.lock().unwrap();
        f.scope = (*addr).mScope;
        f.selector = (*addr).mSelector;
        f.reads += 1;
        let capacity = *size as usize / std::mem::size_of::<u32>();
        for (index, value) in f.values.iter().copied().take(capacity).enumerate() {
            *(output as *mut u32).add(index) = value;
        }
        *size = f.returned;
        f.status
    }
}

#[path = "../src/audio_unit/macos_devices.rs"]
mod macos_devices;
// Each adapter is also compiled independently as a portable test.
#[allow(clippy::duplicate_mod)]
#[path = "../src/audio_unit/macos_property_limits.rs"]
mod macos_property_limits;

#[cfg(test)]
mod tests {
    use super::{listener_sys as sys, macos_devices::*, Mutex, Scope};
    static TEST_LOCK: Mutex<()> = Mutex::new(());
    fn fixture(queried: u32, returned: u32, status: i32, values: &[u32]) {
        let mut f = sys::FIXTURE.lock().unwrap();
        f.queried = queried;
        f.returned = returned;
        f.status = status;
        f.query_status = 0;
        f.values = values.to_vec();
        f.reads = 0;
    }
    #[test]
    fn source_does_not_create_uninitialized_ids_or_mutate_shared_references() {
        let source = include_str!("../src/audio_unit/macos_devices.rs");
        assert!(!source.contains("set_len("));
        assert!(!source.contains("as *const _ as *mut _"));
    }
    #[test]
    fn respects_shrinking_device_list_and_scope() {
        let _guard = TEST_LOCK.lock().unwrap();
        fixture(8, 4, 0, &[41, 42]);
        assert_eq!(
            get_audio_device_ids_for_scope(Scope::Input).unwrap(),
            vec![41]
        );
        assert_eq!(
            sys::FIXTURE.lock().unwrap().scope,
            sys::kAudioObjectPropertyScopeInput
        );
        fixture(8, 8, 0, &[41, 42]);
        assert_eq!(
            get_audio_device_ids_for_scope(Scope::Output).unwrap(),
            vec![41, 42]
        );
        assert_eq!(
            sys::FIXTURE.lock().unwrap().scope,
            sys::kAudioObjectPropertyScopeOutput
        );
    }
    #[test]
    fn rejects_invalid_or_growing_lengths_and_native_errors() {
        let _guard = TEST_LOCK.lock().unwrap();
        fixture(3, 3, 0, &[]);
        assert!(get_audio_device_ids().is_err());
        assert_eq!(sys::FIXTURE.lock().unwrap().reads, 0);
        fixture(8, 3, 0, &[1, 2]);
        assert!(get_audio_device_ids().is_err());
        fixture(8, 12, 0, &[1, 2]);
        assert!(get_audio_device_ids().is_err());
        fixture(8, 8, -7, &[1, 2]);
        assert!(get_audio_device_ids().is_err());
        fixture(8, 8, 0, &[1, 2]);
        sys::FIXTURE.lock().unwrap().query_status = -9;
        assert!(get_audio_device_ids().is_err());
        assert_eq!(sys::FIXTURE.lock().unwrap().reads, 0);
    }
    #[test]
    fn rejects_oversized_device_lists_before_reading() {
        let _guard = TEST_LOCK.lock().unwrap();
        fixture(1024 * 1024 + 4, 0, 0, &[]);
        assert!(matches!(
            get_audio_device_ids(),
            Err(super::ListenerError::Unspecified)
        ));
        assert_eq!(sys::FIXTURE.lock().unwrap().reads, 0);
    }
    #[test]
    fn default_id_requires_a_complete_successful_response() {
        let _guard = TEST_LOCK.lock().unwrap();
        fixture(4, 4, 0, &[99]);
        assert_eq!(get_default_device_id(true), Some(99));
        assert_eq!(
            sys::FIXTURE.lock().unwrap().selector,
            sys::kAudioHardwarePropertyDefaultInputDevice
        );
        fixture(4, 0, 0, &[99]);
        assert_eq!(get_default_device_id(false), None);
        assert_eq!(
            sys::FIXTURE.lock().unwrap().selector,
            sys::kAudioHardwarePropertyDefaultOutputDevice
        );
        fixture(4, 4, -1, &[99]);
        assert_eq!(get_default_device_id(false), None);
    }
    #[test]
    fn empty_device_list_is_safe() {
        let _guard = TEST_LOCK.lock().unwrap();
        fixture(0, 0, 0, &[]);
        assert!(get_audio_device_ids().unwrap().is_empty());
    }
}
