//! Portable tests of hog-mode helpers with a simulated CoreAudio API.
#![allow(
    non_snake_case,
    non_upper_case_globals,
    non_camel_case_types,
    dead_code
)]
use std::sync::Mutex;
#[derive(Debug, PartialEq)]
pub enum ListenerError {
    Unspecified,
    Unknown(i32),
}
impl ListenerError {
    pub fn from_os_status(status: i32) -> Result<(), Self> {
        if status == 0 {
            Ok(())
        } else {
            Err(Self::Unknown(status))
        }
    }
}
pub mod listener_sys {
    use std::{ffi::c_void, sync::Mutex};
    pub type pid_t = i32;
    pub type AudioDeviceID = u32;
    pub const kAudioDevicePropertyHogMode: u32 = 1;
    pub const kAudioObjectPropertyScopeGlobal: u32 = 2;
    pub const kAudioObjectPropertyElementMaster: u32 = 3;
    pub struct AudioObjectPropertyAddress {
        pub mSelector: u32,
        pub mScope: u32,
        pub mElement: u32,
    }
    pub struct Fixture {
        pub pid: pid_t,
        pub returned: u32,
        pub get_status: i32,
        pub set_status: i32,
        pub get_count: usize,
        pub set_count: usize,
        pub set_size: u32,
        pub set_value: pid_t,
        pub next: pid_t,
    }
    pub static FIXTURE: Mutex<Fixture> = Mutex::new(Fixture {
        pid: -1,
        returned: 4,
        get_status: 0,
        set_status: 0,
        get_count: 0,
        set_count: 0,
        set_size: 0,
        set_value: 0,
        next: 123,
    });
    pub unsafe fn AudioObjectGetPropertyData(
        _: u32,
        _: *const AudioObjectPropertyAddress,
        _: u32,
        _: *const c_void,
        size: *mut u32,
        out: *mut c_void,
    ) -> i32 {
        let mut f = FIXTURE.lock().unwrap();
        f.get_count += 1;
        if f.get_status != 0 {
            return f.get_status;
        }
        *(out as *mut pid_t) = f.pid;
        *size = f.returned;
        0
    }
    pub unsafe fn AudioObjectSetPropertyData(
        _: u32,
        _: *const AudioObjectPropertyAddress,
        _: u32,
        _: *const c_void,
        size: u32,
        data: *const c_void,
    ) -> i32 {
        let mut f = FIXTURE.lock().unwrap();
        f.set_count += 1;
        f.set_size = size;
        f.set_value = *(data as *const pid_t);
        if f.set_status != 0 {
            return f.set_status;
        }
        f.pid = f.next;
        0
    }
}
#[path = "../src/audio_unit/macos_hog.rs"]
mod macos_hog;
#[cfg(test)]
mod tests {
    use super::{listener_sys as sys, Mutex};
    static LOCK: Mutex<()> = Mutex::new(());
    fn reset() {
        let mut f = sys::FIXTURE.lock().unwrap();
        f.pid = -1;
        f.returned = std::mem::size_of::<sys::pid_t>() as u32;
        f.get_status = 0;
        f.set_status = 0;
        f.get_count = 0;
        f.set_count = 0;
        f.set_size = 0;
        f.set_value = 0;
        f.next = 123;
    }
    #[test]
    fn source_routes_through_checked_hog_adapter() {
        let src = include_str!("../src/audio_unit/macos_helpers.rs");
        assert!(src.contains("pub use super::macos_hog::{get_hogging_pid, toggle_hog_mode}"));
    }
    #[test]
    fn reads_and_toggles_with_correct_size() {
        let _guard = LOCK.lock().unwrap();
        reset();
        assert_eq!(super::macos_hog::get_hogging_pid(1), Ok(-1));
        assert_eq!(super::macos_hog::toggle_hog_mode(1), Ok(123));
        let f = sys::FIXTURE.lock().unwrap();
        assert_eq!(f.get_count, 2);
        assert_eq!(f.set_count, 1);
        assert_eq!(f.set_value, -1);
        assert_eq!(f.set_size, std::mem::size_of::<sys::pid_t>() as u32);
    }
    #[test]
    fn rejects_incorrect_returned_lengths() {
        let _guard = LOCK.lock().unwrap();
        for size in [0, 3, 5] {
            reset();
            sys::FIXTURE.lock().unwrap().returned = size;
            assert_eq!(
                super::macos_hog::get_hogging_pid(1),
                Err(super::ListenerError::Unspecified)
            );
            assert_eq!(
                super::macos_hog::toggle_hog_mode(1),
                Err(super::ListenerError::Unspecified)
            );
        }
    }
    #[test]
    fn propagates_errors_and_does_not_read_after_failed_set() {
        let _guard = LOCK.lock().unwrap();
        reset();
        sys::FIXTURE.lock().unwrap().get_status = -5;
        assert_eq!(
            super::macos_hog::get_hogging_pid(1),
            Err(super::ListenerError::Unknown(-5))
        );
        reset();
        sys::FIXTURE.lock().unwrap().set_status = -6;
        assert_eq!(
            super::macos_hog::toggle_hog_mode(1),
            Err(super::ListenerError::Unknown(-6))
        );
        assert_eq!(sys::FIXTURE.lock().unwrap().get_count, 0);
    }
}
