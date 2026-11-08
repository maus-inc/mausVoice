//! Portable tests of device-name reads with simulated CoreAudio and CoreFoundation.
#![allow(non_snake_case, non_upper_case_globals, dead_code)]
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
    pub type AudioDeviceID = u32;
    pub const kAudioDevicePropertyDeviceNameCFString: u32 = 1;
    pub const kAudioDevicePropertyScopeOutput: u32 = 2;
    pub const kAudioObjectPropertyElementMaster: u32 = 3;
    pub struct AudioObjectPropertyAddress {
        pub mSelector: u32,
        pub mScope: u32,
        pub mElement: u32,
    }
    pub struct Fixture {
        pub returned: u32,
        pub status: i32,
        pub null: bool,
        pub calls: usize,
    }
    pub static FIXTURE: Mutex<Fixture> = Mutex::new(Fixture {
        returned: 0,
        status: 0,
        null: false,
        calls: 0,
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
        f.calls += 1;
        if f.status != 0 {
            return f.status;
        }
        *(out as *mut *const c_void) = if f.null {
            std::ptr::null()
        } else {
            std::ptr::dangling::<c_void>()
        };
        *size = f.returned;
        0
    }
}
pub mod name_cf {
    use std::{
        ffi::{c_char, c_void},
        sync::Mutex,
    };
    pub type CFStringRef = *const c_void;
    pub const kCFStringEncodingUTF8: u32 = 1;
    pub struct Fixture {
        pub bytes: Vec<u8>,
        pub fast: bool,
        pub max: isize,
        pub length: isize,
        pub convert: bool,
        pub terminate: bool,
        pub releases: usize,
    }
    pub static FIXTURE: Mutex<Fixture> = Mutex::new(Fixture {
        bytes: Vec::new(),
        fast: false,
        max: 0,
        length: 0,
        convert: true,
        terminate: true,
        releases: 0,
    });
    pub unsafe fn CFRelease(_: *const c_void) {
        FIXTURE.lock().unwrap().releases += 1;
    }
    pub unsafe fn CFStringGetCStringPtr(_: CFStringRef, _: u32) -> *const c_char {
        let f = FIXTURE.lock().unwrap();
        if f.fast {
            f.bytes.as_ptr().cast()
        } else {
            std::ptr::null()
        }
    }
    pub unsafe fn CFStringGetLength(_: CFStringRef) -> isize {
        FIXTURE.lock().unwrap().length
    }
    pub unsafe fn CFStringGetMaximumSizeForEncoding(_: isize, _: u32) -> isize {
        FIXTURE.lock().unwrap().max
    }
    pub unsafe fn CFStringGetCString(_: CFStringRef, out: *mut c_char, size: isize, _: u32) -> u8 {
        let f = FIXTURE.lock().unwrap();
        if !f.convert {
            return 0;
        }
        let n = usize::min(f.bytes.len(), size as usize);
        std::ptr::copy_nonoverlapping(f.bytes.as_ptr(), out.cast(), n);
        if !f.terminate {
            for i in 0..size as usize {
                if *out.add(i) == 0 {
                    *out.add(i) = b'x' as c_char;
                }
            }
        }
        1
    }
}
#[path = "../src/audio_unit/macos_device_name.rs"]
mod macos_device_name;
#[cfg(test)]
mod tests {
    use super::{listener_sys as sys, name_cf as cf, Mutex};
    static LOCK: Mutex<()> = Mutex::new(());
    fn reset() {
        let mut s = sys::FIXTURE.lock().unwrap();
        s.returned = std::mem::size_of::<cf::CFStringRef>() as u32;
        s.status = 0;
        s.null = false;
        s.calls = 0;
        drop(s);
        let mut f = cf::FIXTURE.lock().unwrap();
        f.bytes = b"Microphone\0".to_vec();
        f.fast = false;
        f.max = 10;
        f.length = 10;
        f.convert = true;
        f.terminate = true;
        f.releases = 0;
    }
    #[test]
    fn source_routes_through_checked_name_adapter() {
        let src = include_str!("../src/audio_unit/macos_helpers.rs");
        assert!(src.contains("pub use super::macos_device_name::get_device_name"));
    }
    #[test]
    fn reads_direct_name_and_releases_once() {
        let _guard = LOCK.lock().unwrap();
        reset();
        cf::FIXTURE.lock().unwrap().fast = true;
        assert_eq!(
            super::macos_device_name::get_device_name(1),
            Ok("Microphone".to_owned())
        );
        assert_eq!(cf::FIXTURE.lock().unwrap().releases, 1);
        assert_eq!(sys::FIXTURE.lock().unwrap().calls, 1);
    }
    #[test]
    fn converts_long_utf8_without_a_second_property_query() {
        let _guard = LOCK.lock().unwrap();
        reset();
        let text = "Mic 🎙️".repeat(100);
        {
            let mut f = cf::FIXTURE.lock().unwrap();
            f.bytes = text.as_bytes().iter().copied().chain([0]).collect();
            f.length = text.encode_utf16().count() as isize;
            f.max = text.len() as isize;
        }
        assert_eq!(super::macos_device_name::get_device_name(1), Ok(text));
        assert_eq!(cf::FIXTURE.lock().unwrap().releases, 1);
        assert_eq!(sys::FIXTURE.lock().unwrap().calls, 1);
    }
    #[test]
    fn rejects_null_bad_size_and_native_error() {
        let _guard = LOCK.lock().unwrap();
        reset();
        sys::FIXTURE.lock().unwrap().null = true;
        assert_eq!(
            super::macos_device_name::get_device_name(1),
            Err(super::ListenerError::Unspecified)
        );
        reset();
        sys::FIXTURE.lock().unwrap().returned = 1;
        assert_eq!(
            super::macos_device_name::get_device_name(1),
            Err(super::ListenerError::Unspecified)
        );
        reset();
        sys::FIXTURE.lock().unwrap().status = -6;
        assert_eq!(
            super::macos_device_name::get_device_name(1),
            Err(super::ListenerError::Unknown(-6))
        );
    }
    #[test]
    fn releases_name_when_conversion_fails_or_has_no_terminator() {
        let _guard = LOCK.lock().unwrap();
        for mode in 0..5 {
            reset();
            {
                let mut f = cf::FIXTURE.lock().unwrap();
                match mode {
                    0 => f.length = -1,
                    1 => f.max = -1,
                    2 => f.max = isize::MAX,
                    3 => f.convert = false,
                    _ => f.terminate = false,
                }
            }
            assert_eq!(
                super::macos_device_name::get_device_name(1),
                Err(super::ListenerError::Unspecified)
            );
            assert_eq!(cf::FIXTURE.lock().unwrap().releases, 1);
        }
    }
}
