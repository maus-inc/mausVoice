extern crate coreaudio;

use self::coreaudio::sys::{
    kAudioFormatFlagIsFloat, kAudioFormatFlagIsPacked, kAudioFormatFlagIsSignedInteger,
    kAudioFormatLinearPCM, AudioStreamBasicDescription, OSStatus,
};

use crate::DefaultStreamConfigError;
use crate::{BuildStreamError, SupportedStreamConfigsError};

use crate::{BackendSpecificError, SampleFormat, StreamConfig};

mod stream_format;
use stream_format::asbd_from_config;

#[cfg(target_os = "ios")]
mod ios;
#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "ios")]
pub use self::ios::{
    enumerate::{Devices, SupportedInputConfigs, SupportedOutputConfigs},
    Device, Host, Stream,
};

#[cfg(target_os = "macos")]
pub use self::macos::{
    enumerate::{Devices, SupportedInputConfigs, SupportedOutputConfigs},
    Device, Host, Stream,
};

/// Common helper methods used by both macOS and iOS

fn check_os_status(os_status: OSStatus) -> Result<(), BackendSpecificError> {
    match coreaudio::Error::from_os_status(os_status) {
        Ok(()) => Ok(()),
        Err(err) => {
            let description = err.to_string();
            Err(BackendSpecificError { description })
        }
    }
}

fn host_time_to_stream_instant(
    m_host_time: u64,
) -> Result<crate::StreamInstant, BackendSpecificError> {
    let mut info: mach2::mach_time::mach_timebase_info = Default::default();
    let res = unsafe { mach2::mach_time::mach_timebase_info(&mut info) };
    check_os_status(res)?;
    let nanos = m_host_time * info.numer as u64 / info.denom as u64;
    let secs = nanos / 1_000_000_000;
    let subsec_nanos = nanos - secs * 1_000_000_000;
    Ok(crate::StreamInstant::new(secs as i64, subsec_nanos as u32))
}

// Convert the given duration in frames at the given sample rate to a `std::time::Duration`.
fn frames_to_duration(frames: usize, rate: crate::SampleRate) -> std::time::Duration {
    let secsf = frames as f64 / rate.0 as f64;
    let secs = secsf as u64;
    let nanos = ((secsf - secs as f64) * 1_000_000_000.0) as u32;
    std::time::Duration::new(secs, nanos)
}

// TODO need stronger error identification
impl From<coreaudio::Error> for BuildStreamError {
    fn from(err: coreaudio::Error) -> BuildStreamError {
        match err {
            coreaudio::Error::InitializationCleanupUncertain { .. } => {
                BuildStreamError::CleanupUncertain {
                    err: BackendSpecificError {
                        description: err.to_string(),
                    },
                }
            }
            coreaudio::Error::RenderCallbackBufferFormatDoesNotMatchAudioUnitStreamFormat
            | coreaudio::Error::NoKnownSubtype
            | coreaudio::Error::AudioUnit(coreaudio::error::AudioUnitError::FormatNotSupported)
            | coreaudio::Error::AudioCodec(_)
            | coreaudio::Error::AudioFormat(_) => BuildStreamError::StreamConfigNotSupported,
            _ => BuildStreamError::DeviceNotAvailable,
        }
    }
}

impl From<coreaudio::Error> for SupportedStreamConfigsError {
    fn from(err: coreaudio::Error) -> SupportedStreamConfigsError {
        let description = format!("{}", err);
        let err = BackendSpecificError { description };
        // Check for possible DeviceNotAvailable variant
        SupportedStreamConfigsError::BackendSpecific { err }
    }
}

impl From<coreaudio::Error> for DefaultStreamConfigError {
    fn from(err: coreaudio::Error) -> DefaultStreamConfigError {
        let description = format!("{}", err);
        let err = BackendSpecificError { description };
        // Check for possible DeviceNotAvailable variant
        DefaultStreamConfigError::BackendSpecific { err }
    }
}
