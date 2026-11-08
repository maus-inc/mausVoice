//! Portable tests of stream-configuration reads through a simulated CoreAudio API.
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
#[derive(Clone, Copy)]
pub enum Scope {
    Input,
    Output,
    Global,
}

pub mod listener_sys {
    use std::ffi::c_void;
    use std::sync::Mutex;
    pub type AudioDeviceID = u32;
    pub type AudioObjectPropertyScope = u32;
    pub const kAudioDevicePropertyStreamConfiguration: u32 = 1;
    pub const kAudioObjectPropertyScopeInput: u32 = 2;
    pub const kAudioObjectPropertyScopeOutput: u32 = 3;
    pub const kAudioObjectPropertyScopeGlobal: u32 = 4;
    pub const kAudioObjectPropertyElementWildcard: u32 = 5;
    pub struct AudioObjectPropertyAddress {
        pub mSelector: u32,
        pub mScope: u32,
        pub mElement: u32,
    }
    #[repr(C)]
    pub struct AudioBuffer {
        pub mNumberChannels: u32,
        pub mDataByteSize: u32,
        pub mData: *mut c_void,
    }
    #[repr(C)]
    pub struct AudioBufferList {
        pub mNumberBuffers: u32,
        pub mBuffers: [AudioBuffer; 1],
    }
    pub struct Fixture {
        pub query_size: u32,
        pub returned_size: u32,
        pub declared_count: u32,
        pub channels: Vec<u32>,
        pub size_status: i32,
        pub get_status: i32,
        pub observed_scope: u32,
        pub aligned: bool,
        pub gets: usize,
    }
    pub static FIXTURE: Mutex<Fixture> = Mutex::new(Fixture {
        query_size: 0,
        returned_size: 0,
        declared_count: 0,
        channels: Vec::new(),
        size_status: 0,
        get_status: 0,
        observed_scope: 0,
        aligned: false,
        gets: 0,
    });
    pub unsafe fn AudioObjectGetPropertyDataSize(
        _: u32,
        address: *const AudioObjectPropertyAddress,
        _: u32,
        _: *const c_void,
        size: *mut u32,
    ) -> i32 {
        let mut f = FIXTURE.lock().unwrap();
        f.observed_scope = (*address).mScope;
        *size = f.query_size;
        f.size_status
    }
    pub unsafe fn AudioObjectGetPropertyData(
        _: u32,
        address: *const AudioObjectPropertyAddress,
        _: u32,
        _: *const c_void,
        size: *mut u32,
        out: *mut c_void,
    ) -> i32 {
        let mut f = FIXTURE.lock().unwrap();
        f.gets += 1;
        f.observed_scope = (*address).mScope;
        f.aligned = (out as usize) % std::mem::align_of::<AudioBufferList>() == 0;
        if f.get_status != 0 {
            return f.get_status;
        }
        let capacity = *size as usize;
        let bytes = out as *mut u8;
        if capacity >= std::mem::size_of::<u32>() {
            std::ptr::write_unaligned(bytes.cast::<u32>(), f.declared_count);
        }
        let offset = std::mem::offset_of!(AudioBufferList, mBuffers)
            + std::mem::offset_of!(AudioBuffer, mNumberChannels);
        for (i, channel) in f.channels.iter().enumerate() {
            let pos = offset + i * std::mem::size_of::<AudioBuffer>();
            if pos + std::mem::size_of::<u32>() <= capacity {
                std::ptr::write_unaligned(bytes.add(pos).cast::<u32>(), *channel);
            }
        }
        *size = f.returned_size;
        0
    }
}

#[path = "../src/audio_unit/macos_device_scope.rs"]
mod macos_device_scope;

#[cfg(test)]
mod tests {
    use super::{listener_sys as sys, ListenerError, Mutex, Scope};
    static LOCK: Mutex<()> = Mutex::new(());
    fn reset() {
        let header = std::mem::offset_of!(sys::AudioBufferList, mBuffers);
        let item = std::mem::size_of::<sys::AudioBuffer>();
        let mut f = sys::FIXTURE.lock().unwrap();
        f.query_size = (header + 2 * item) as u32;
        f.returned_size = f.query_size;
        f.declared_count = 2;
        f.channels = vec![0, 2];
        f.size_status = 0;
        f.get_status = 0;
        f.observed_scope = 0;
        f.aligned = false;
        f.gets = 0;
    }
    #[test]
    fn source_routes_through_bounded_adapter() {
        let src = include_str!("../src/audio_unit/macos_helpers.rs");
        assert!(src.contains("pub use super::macos_device_scope::get_audio_device_supports_scope"));
    }
    #[test]
    fn reads_all_buffers_with_correct_scope_and_alignment() {
        let _guard = LOCK.lock().unwrap();
        reset();
        assert_eq!(
            super::macos_device_scope::get_audio_device_supports_scope(1, Scope::Input),
            Ok(true)
        );
        {
            let f = sys::FIXTURE.lock().unwrap();
            assert!(f.aligned);
            assert_eq!(f.observed_scope, sys::kAudioObjectPropertyScopeInput);
        }
        sys::FIXTURE.lock().unwrap().channels = vec![0, 0];
        assert_eq!(
            super::macos_device_scope::get_audio_device_supports_scope(1, Scope::Output),
            Ok(false)
        );
        assert_eq!(
            sys::FIXTURE.lock().unwrap().observed_scope,
            sys::kAudioObjectPropertyScopeOutput
        );
        assert_eq!(
            super::macos_device_scope::get_audio_device_supports_scope(1, Scope::Global),
            Ok(false)
        );
        assert_eq!(
            sys::FIXTURE.lock().unwrap().observed_scope,
            sys::kAudioObjectPropertyScopeGlobal
        );
    }
    #[test]
    fn accepts_header_only_empty_list_and_valid_shrinking_output() {
        let _guard = LOCK.lock().unwrap();
        reset();
        let header = std::mem::offset_of!(sys::AudioBufferList, mBuffers) as u32;
        let item = std::mem::size_of::<sys::AudioBuffer>() as u32;
        {
            let mut f = sys::FIXTURE.lock().unwrap();
            f.returned_size = header;
            f.declared_count = 0;
        }
        assert_eq!(
            super::macos_device_scope::get_audio_device_supports_scope(1, Scope::Input),
            Ok(false)
        );
        {
            let mut f = sys::FIXTURE.lock().unwrap();
            f.returned_size = header + item;
            f.declared_count = 1;
            f.channels = vec![1];
        }
        assert_eq!(
            super::macos_device_scope::get_audio_device_supports_scope(1, Scope::Input),
            Ok(true)
        );
    }
    #[test]
    fn rejects_invalid_sizes_and_buffer_counts() {
        let _guard = LOCK.lock().unwrap();
        let header = std::mem::offset_of!(sys::AudioBufferList, mBuffers) as u32;
        let item = std::mem::size_of::<sys::AudioBuffer>() as u32;
        for (query, returned, count) in [
            (0, 0, 0),
            (header - 1, header - 1, 0),
            (header, header - 1, 0),
            (header, header + 1, 0),
            (header + item, header + item - 1, 1),
            (header + item, header + item, u32::MAX),
        ] {
            reset();
            {
                let mut f = sys::FIXTURE.lock().unwrap();
                f.query_size = query;
                f.returned_size = returned;
                f.declared_count = count;
            }
            assert_eq!(
                super::macos_device_scope::get_audio_device_supports_scope(1, Scope::Input),
                Err(ListenerError::Unspecified),
                "{query} {returned} {count}"
            );
        }
    }
    #[test]
    fn propagates_native_errors() {
        let _guard = LOCK.lock().unwrap();
        reset();
        sys::FIXTURE.lock().unwrap().size_status = -7;
        assert_eq!(
            super::macos_device_scope::get_audio_device_supports_scope(1, Scope::Input),
            Err(ListenerError::Unknown(-7))
        );
        assert_eq!(sys::FIXTURE.lock().unwrap().gets, 0);
        reset();
        sys::FIXTURE.lock().unwrap().get_status = -8;
        assert_eq!(
            super::macos_device_scope::get_audio_device_supports_scope(1, Scope::Input),
            Err(ListenerError::Unknown(-8))
        );
    }
}
