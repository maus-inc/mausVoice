//! Portable tests of sample-rate changes with a simulated CoreAudio API.
#![allow(non_snake_case, non_upper_case_globals, dead_code)]
use std::sync::Mutex;

#[derive(Debug, PartialEq)]
pub enum ListenerError {
    Unspecified,
    UnsupportedSampleRate,
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

mod macos_listeners {
    use super::{listener_sys, ListenerError};
    use std::sync::mpsc::Sender;
    pub struct RateListener {
        sender: Option<Sender<f64>>,
    }
    impl RateListener {
        pub fn new(_: u32, sender: Option<Sender<f64>>) -> Self {
            Self { sender }
        }
        pub fn register(&mut self) -> Result<(), ListenerError> {
            let mut f = listener_sys::FIXTURE.lock().unwrap();
            if f.fail_registration {
                return Err(ListenerError::Unknown(-13));
            }
            f.sender = self.sender.take();
            f.registrations += 1;
            Ok(())
        }
    }
    impl Drop for RateListener {
        fn drop(&mut self) {
            listener_sys::FIXTURE.lock().unwrap().sender = None;
        }
    }
}

pub mod listener_sys {
    use std::ffi::c_void;
    use std::sync::{mpsc::Sender, Mutex};
    pub type AudioDeviceID = u32;
    pub const kAudioDevicePropertyNominalSampleRate: u32 = 1;
    pub const kAudioDevicePropertyAvailableNominalSampleRates: u32 = 2;
    pub const kAudioObjectPropertyScopeGlobal: u32 = 3;
    pub const kAudioObjectPropertyElementMaster: u32 = 4;
    #[derive(Clone, Copy)]
    pub struct AudioValueRange {
        pub mMinimum: f64,
        pub mMaximum: f64,
    }
    pub struct AudioObjectPropertyAddress {
        pub mSelector: u32,
        pub mScope: u32,
        pub mElement: u32,
    }
    pub struct Fixture {
        pub current: f64,
        pub current_size: u32,
        pub ranges: Vec<AudioValueRange>,
        pub queried: u32,
        pub returned: u32,
        pub query_status: i32,
        pub get_status: i32,
        pub set_status: i32,
        pub fail_registration: bool,
        pub registrations: usize,
        pub sets: usize,
        pub set_size: u32,
        pub set_value: f64,
        pub notify: bool,
        pub sender: Option<Sender<f64>>,
    }
    pub static FIXTURE: Mutex<Fixture> = Mutex::new(Fixture {
        current: 44_100.0,
        current_size: 8,
        ranges: Vec::new(),
        queried: 0,
        returned: 0,
        query_status: 0,
        get_status: 0,
        set_status: 0,
        fail_registration: false,
        registrations: 0,
        sets: 0,
        set_size: 0,
        set_value: 0.0,
        notify: true,
        sender: None,
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
        output: *mut c_void,
    ) -> i32 {
        let f = FIXTURE.lock().unwrap();
        if f.get_status != 0 {
            return f.get_status;
        }
        if (*addr).mSelector == kAudioDevicePropertyNominalSampleRate {
            *(output as *mut f64) = f.current;
            *size = f.current_size;
        } else {
            let capacity = *size as usize / std::mem::size_of::<AudioValueRange>();
            for (i, range) in f.ranges.iter().copied().take(capacity).enumerate() {
                *(output as *mut AudioValueRange).add(i) = range;
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
        if (*addr).mSelector != kAudioDevicePropertyNominalSampleRate
            || size != std::mem::size_of::<f64>() as u32
        {
            return -90;
        }
        f.set_value = *(data as *const f64);
        if f.set_status != 0 {
            return f.set_status;
        }
        if f.notify {
            if let Some(sender) = &f.sender {
                let _ = sender.send(f.set_value);
            }
        }
        0
    }
}

#[path = "../src/audio_unit/macos_sample_rate.rs"]
mod macos_sample_rate;

#[cfg(test)]
mod tests {
    use super::{
        listener_sys as sys, macos_sample_rate::set_device_sample_rate, ListenerError, Mutex,
    };
    static TEST_LOCK: Mutex<()> = Mutex::new(());
    fn reset() {
        let mut f = sys::FIXTURE.lock().unwrap();
        f.current = 44_100.0;
        f.current_size = 8;
        f.ranges = vec![sys::AudioValueRange {
            mMinimum: 44_100.0,
            mMaximum: 96_000.0,
        }];
        f.queried = 16;
        f.returned = 16;
        f.query_status = 0;
        f.get_status = 0;
        f.set_status = 0;
        f.fail_registration = false;
        f.registrations = 0;
        f.sets = 0;
        f.set_size = 0;
        f.set_value = 0.0;
        f.notify = true;
        f.sender = None;
    }
    #[test]
    fn source_uses_initialized_mutable_property_storage() {
        let source = include_str!("../src/audio_unit/macos_sample_rate.rs");
        assert!(!source.contains("set_len("));
        assert!(!source.contains("as *const _ as *mut _"));
    }
    #[test]
    fn accepts_continuous_range_and_sets_one_f64() {
        let _guard = TEST_LOCK.lock().unwrap();
        reset();
        set_device_sample_rate(1, 48_000.0).unwrap();
        let f = sys::FIXTURE.lock().unwrap();
        assert_eq!(f.registrations, 1);
        assert_eq!(f.sets, 1);
        assert_eq!(f.set_size, 8);
        assert_eq!(f.set_value, 48_000.0);
        assert!(f.sender.is_none());
    }
    #[test]
    fn supports_range_boundaries_and_ignores_unreturned_ranges() {
        let _guard = TEST_LOCK.lock().unwrap();
        reset();
        set_device_sample_rate(1, 96_000.0).unwrap();
        reset();
        {
            let mut f = sys::FIXTURE.lock().unwrap();
            f.ranges = vec![
                sys::AudioValueRange {
                    mMinimum: 44_100.0,
                    mMaximum: 44_100.0,
                },
                sys::AudioValueRange {
                    mMinimum: 48_000.0,
                    mMaximum: 48_000.0,
                },
            ];
            f.queried = 32;
            f.returned = 16;
        }
        assert_eq!(
            set_device_sample_rate(1, 48_000.0),
            Err(ListenerError::UnsupportedSampleRate)
        );
        assert_eq!(sys::FIXTURE.lock().unwrap().sets, 0);
    }
    #[test]
    fn missing_notification_times_out_and_unregisters() {
        let _guard = TEST_LOCK.lock().unwrap();
        reset();
        sys::FIXTURE.lock().unwrap().notify = false;
        assert_eq!(
            set_device_sample_rate(1, 48_000.0),
            Err(ListenerError::UnsupportedSampleRate)
        );
        assert!(sys::FIXTURE.lock().unwrap().sender.is_none());
    }
    #[test]
    fn existing_rate_does_not_register_or_set() {
        let _guard = TEST_LOCK.lock().unwrap();
        reset();
        set_device_sample_rate(1, 44_100.0).unwrap();
        let f = sys::FIXTURE.lock().unwrap();
        assert_eq!(f.registrations, 0);
        assert_eq!(f.sets, 0);
    }
    #[test]
    fn rejects_invalid_rates_and_invalid_lengths() {
        let _guard = TEST_LOCK.lock().unwrap();
        for rate in [0.0, -1.0, f64::NAN, f64::INFINITY, 100_000.0] {
            reset();
            assert!(set_device_sample_rate(1, rate).is_err());
            assert_eq!(sys::FIXTURE.lock().unwrap().sets, 0);
        }
        for (queried, returned) in [(15, 15), (16, 15), (16, 32)] {
            reset();
            {
                let mut f = sys::FIXTURE.lock().unwrap();
                f.queried = queried;
                f.returned = returned;
            }
            assert!(set_device_sample_rate(1, 48_000.0).is_err());
            assert_eq!(sys::FIXTURE.lock().unwrap().sets, 0);
        }
        reset();
        sys::FIXTURE.lock().unwrap().current_size = 4;
        assert!(set_device_sample_rate(1, 48_000.0).is_err());
    }
    #[test]
    fn surfaces_failures_and_unregisters_listener() {
        let _guard = TEST_LOCK.lock().unwrap();
        reset();
        sys::FIXTURE.lock().unwrap().query_status = -7;
        assert_eq!(
            set_device_sample_rate(1, 48_000.0),
            Err(ListenerError::Unknown(-7))
        );
        reset();
        sys::FIXTURE.lock().unwrap().fail_registration = true;
        assert!(set_device_sample_rate(1, 48_000.0).is_err());
        assert_eq!(sys::FIXTURE.lock().unwrap().sets, 0);
        reset();
        sys::FIXTURE.lock().unwrap().set_status = -8;
        assert_eq!(
            set_device_sample_rate(1, 48_000.0),
            Err(ListenerError::Unknown(-8))
        );
        assert!(sys::FIXTURE.lock().unwrap().sender.is_none());
    }
}
