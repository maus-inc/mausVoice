//! Portable physical-format adapter tests with a simulated CoreAudio API.
#![allow(non_snake_case, non_upper_case_globals, dead_code)]
use std::sync::Mutex;
#[derive(Debug, PartialEq)]
pub enum ListenerError {
    Unspecified,
    UnsupportedStreamFormat,
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
    use std::ffi::c_void;
    use std::sync::Mutex;
    pub type AudioDeviceID = u32;
    pub const kAudioStreamPropertyPhysicalFormat: u32 = 1;
    pub const kAudioStreamPropertyAvailablePhysicalFormats: u32 = 2;
    pub const kAudioObjectPropertyElementMaster: u32 = 3;
    pub const kAudioObjectPropertyScopeGlobal: u32 = 4;
    #[derive(Clone, Copy, Default, Debug)]
    pub struct AudioStreamBasicDescription {
        pub mSampleRate: f64,
        pub mFormatID: u32,
        pub mFormatFlags: u32,
        pub mBytesPerPacket: u32,
        pub mFramesPerPacket: u32,
        pub mBytesPerFrame: u32,
        pub mChannelsPerFrame: u32,
        pub mBitsPerChannel: u32,
        pub mReserved: u32,
    }
    #[derive(Clone, Copy, Default, Debug)]
    pub struct AudioValueRange {
        pub mMinimum: f64,
        pub mMaximum: f64,
    }
    #[derive(Clone, Copy, Default, Debug)]
    pub struct AudioStreamRangedDescription {
        pub mFormat: AudioStreamBasicDescription,
        pub mSampleRateRange: AudioValueRange,
    }
    pub struct AudioObjectPropertyAddress {
        pub mSelector: u32,
        pub mScope: u32,
        pub mElement: u32,
    }
    pub struct Fixture {
        pub current: AudioStreamBasicDescription,
        pub ranges: Vec<AudioStreamRangedDescription>,
        pub queried: u32,
        pub returned: u32,
        pub current_size: u32,
        pub size_after_set: Option<u32>,
        pub query_status: i32,
        pub get_status: i32,
        pub set_status: i32,
        pub sets: usize,
        pub set_size: u32,
        pub update: bool,
    }
    pub static FIXTURE: Mutex<Fixture> = Mutex::new(Fixture {
        current: AudioStreamBasicDescription {
            mSampleRate: 44_100.0,
            mFormatID: 1,
            mFormatFlags: 0,
            mBytesPerPacket: 4,
            mFramesPerPacket: 1,
            mBytesPerFrame: 4,
            mChannelsPerFrame: 1,
            mBitsPerChannel: 32,
            mReserved: 0,
        },
        ranges: Vec::new(),
        queried: 0,
        returned: 0,
        current_size: 0,
        size_after_set: None,
        query_status: 0,
        get_status: 0,
        set_status: 0,
        sets: 0,
        set_size: 0,
        update: true,
    });
    pub unsafe fn AudioObjectGetPropertyDataSize(
        _: u32,
        _: *const AudioObjectPropertyAddress,
        _: u32,
        _: *const c_void,
        size: *mut u32,
    ) -> i32 {
        let f = FIXTURE.lock().unwrap();
        *size = f.queried;
        f.query_status
    }
    pub unsafe fn AudioObjectGetPropertyData(
        _: u32,
        addr: *const AudioObjectPropertyAddress,
        _: u32,
        _: *const c_void,
        size: *mut u32,
        out: *mut c_void,
    ) -> i32 {
        let f = FIXTURE.lock().unwrap();
        if f.get_status != 0 {
            return f.get_status;
        }
        if (*addr).mSelector == kAudioStreamPropertyPhysicalFormat {
            *(out as *mut AudioStreamBasicDescription) = f.current;
            *size = f.current_size;
        } else {
            let capacity = *size as usize / std::mem::size_of::<AudioStreamRangedDescription>();
            for (i, v) in f.ranges.iter().copied().take(capacity).enumerate() {
                *(out as *mut AudioStreamRangedDescription).add(i) = v;
            }
            *size = f.returned;
        }
        0
    }
    pub unsafe fn AudioObjectSetPropertyData(
        _: u32,
        addr: *const AudioObjectPropertyAddress,
        _: u32,
        _: *const c_void,
        size: u32,
        data: *const c_void,
    ) -> i32 {
        let mut f = FIXTURE.lock().unwrap();
        f.sets += 1;
        f.set_size = size;
        if (*addr).mSelector != kAudioStreamPropertyPhysicalFormat
            || size != std::mem::size_of::<AudioStreamBasicDescription>() as u32
        {
            return -90;
        }
        if f.set_status != 0 {
            return f.set_status;
        }
        if f.update {
            f.current = *(data as *const AudioStreamBasicDescription);
        }
        if let Some(size) = f.size_after_set {
            f.current_size = size;
        }
        0
    }
}
#[path = "../src/audio_unit/macos_physical_format.rs"]
mod macos_physical_format;
// Each adapter is also compiled independently as a portable test.
#[allow(clippy::duplicate_mod)]
#[path = "../src/audio_unit/macos_property_limits.rs"]
mod macos_property_limits;

#[cfg(test)]
mod tests {
    use super::{listener_sys as sys, macos_physical_format::*, ListenerError, Mutex};
    static LOCK: Mutex<()> = Mutex::new(());
    fn format(rate: f64) -> sys::AudioStreamBasicDescription {
        sys::AudioStreamBasicDescription {
            mSampleRate: rate,
            mFormatID: 1,
            mFormatFlags: 0,
            mBytesPerPacket: 4,
            mFramesPerPacket: 1,
            mBytesPerFrame: 4,
            mChannelsPerFrame: 1,
            mBitsPerChannel: 32,
            mReserved: 0,
        }
    }
    fn reset() {
        let mut f = sys::FIXTURE.lock().unwrap();
        f.current = format(44_100.0);
        f.current_size = std::mem::size_of::<sys::AudioStreamBasicDescription>() as u32;
        f.size_after_set = None;
        f.ranges = vec![
            sys::AudioStreamRangedDescription {
                mFormat: format(44_100.0),
                mSampleRateRange: sys::AudioValueRange {
                    mMinimum: 44_100.0,
                    mMaximum: 48_000.0,
                },
            },
            sys::AudioStreamRangedDescription {
                mFormat: format(96_000.0),
                mSampleRateRange: sys::AudioValueRange {
                    mMinimum: 96_000.0,
                    mMaximum: 96_000.0,
                },
            },
        ];
        f.queried = (2 * std::mem::size_of::<sys::AudioStreamRangedDescription>()) as u32;
        f.returned = f.queried;
        f.query_status = 0;
        f.get_status = 0;
        f.set_status = 0;
        f.sets = 0;
        f.set_size = 0;
        f.update = true;
    }
    #[test]
    fn source_uses_mutable_initialized_storage() {
        let source = include_str!("../src/audio_unit/macos_physical_format.rs");
        assert!(!source.contains("set_len("));
        assert!(!source.contains("as *const _ as *mut _"));
    }
    #[test]
    fn current_and_updated_format_are_checked() {
        let _guard = LOCK.lock().unwrap();
        reset();
        set_device_physical_stream_format(1, format(44_100.0)).unwrap();
        assert_eq!(sys::FIXTURE.lock().unwrap().sets, 0);
        set_device_physical_stream_format(1, format(44_100.5)).unwrap();
        let f = sys::FIXTURE.lock().unwrap();
        assert_eq!(f.sets, 1);
        assert_eq!(
            f.set_size,
            std::mem::size_of::<sys::AudioStreamBasicDescription>() as u32
        );
        assert_eq!(f.current.mSampleRate, 44_100.5);
    }
    #[test]
    fn validates_returned_format_array_lengths() {
        let _guard = LOCK.lock().unwrap();
        reset();
        let size = std::mem::size_of::<sys::AudioStreamRangedDescription>() as u32;
        sys::FIXTURE.lock().unwrap().returned = size;
        let formats = get_supported_physical_stream_formats(1).unwrap();
        assert_eq!(formats.len(), 1);
        assert_eq!(formats[0].mFormat.mSampleRate, 44_100.0);
        for (query, returned) in [(size - 1, size - 1), (size, size - 1), (size, size * 2)] {
            reset();
            {
                let mut f = sys::FIXTURE.lock().unwrap();
                f.queried = query;
                f.returned = returned;
            }
            assert!(get_supported_physical_stream_formats(1).is_err());
        }
        reset();
        {
            let mut f = sys::FIXTURE.lock().unwrap();
            f.queried = 0;
            f.returned = 0;
        }
        assert!(get_supported_physical_stream_formats(1).unwrap().is_empty());
    }
    #[test]
    fn rejects_oversized_physical_format_lists() {
        let _guard = LOCK.lock().unwrap();
        reset();
        let item = std::mem::size_of::<sys::AudioStreamRangedDescription>() as u32;
        sys::FIXTURE.lock().unwrap().queried = (1024 * 1024 / item + 1) * item;
        assert!(matches!(
            get_supported_physical_stream_formats(1),
            Err(ListenerError::Unspecified)
        ));
    }
    #[test]
    fn rejects_short_current_and_propagates_native_failures() {
        let _guard = LOCK.lock().unwrap();
        reset();
        sys::FIXTURE.lock().unwrap().current_size = 4;
        assert!(set_device_physical_stream_format(1, format(48_000.0)).is_err());
        assert_eq!(sys::FIXTURE.lock().unwrap().sets, 0);
        reset();
        sys::FIXTURE.lock().unwrap().size_after_set = Some(4);
        assert!(set_device_physical_stream_format(1, format(48_000.0)).is_err());
        assert_eq!(sys::FIXTURE.lock().unwrap().sets, 1);
        reset();
        sys::FIXTURE.lock().unwrap().set_status = -8;
        assert_eq!(
            set_device_physical_stream_format(1, format(48_000.0)),
            Err(ListenerError::Unknown(-8))
        );
        reset();
        sys::FIXTURE.lock().unwrap().query_status = -7;
        assert_eq!(
            get_supported_physical_stream_formats(1).err(),
            Some(ListenerError::Unknown(-7))
        );
    }
    #[test]
    fn fails_after_unconfirmed_format_change() {
        let _guard = LOCK.lock().unwrap();
        reset();
        sys::FIXTURE.lock().unwrap().update = false;
        assert_eq!(
            set_device_physical_stream_format(1, format(48_000.0)),
            Err(ListenerError::UnsupportedStreamFormat)
        );
    }
}
