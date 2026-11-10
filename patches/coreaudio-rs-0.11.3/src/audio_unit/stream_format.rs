//! A rustification of the `AudioStreamBasicDescription` type.
//!
//! Find the original `AudioStreamBasicDescription` reference [here](https://developer.apple.com/library/mac/documentation/MusicAudio/Reference/CoreAudioDataTypesRef/#//apple_ref/c/tdef/AudioStreamBasicDescription).

use super::audio_format::AudioFormat;
use super::audio_format::LinearPcmFlags;
use super::stream_error::{self as error, Error};
use super::stream_sys as sys;
use super::SampleFormat;

/// A representation of the AudioStreamBasicDescription specifically for use with the AudioUnit API.
///
/// By using a type specific to the audio unit API, we can remove a lot of unnecessary boilerplate
/// that is normally associated with the AudioStreamBasicDescription.
///
/// Seeing as `LinearPCM` data (the `AudioFormat` used by the `AudioUnit` API) implies a single
/// frame per packet, we can infer many of the fields in an ASBD from the sample type.
///
/// `bytes_per_packet = size_of::<S>()`
/// `bytes_per_frame = size_of::<S>()`
/// `frames_per_packet` = 1
/// `bits_per_channel = size_of::<S>()` / channels_per_frame * 8
///
/// > A *packet* is a collection of one or more contiguous frames. In linear PCM audio, a packet is
/// > always a single frame.
///
/// [from *Core Audio Overview*](https://developer.apple.com/library/ios/documentation/MusicAudio/Conceptual/CoreAudioOverview/WhatisCoreAudio/WhatisCoreAudio.html)
///
/// > The canonical formats in Core Audio are as follows:
/// >
/// > - iOS input and output: Linear PCM with 16-bit integer samples.
/// > - iOS audio units and other audio processing: Noninterleaved linear PCM with 8.24-bit
/// >   fixed-point samples
/// > - Mac input and output: Linear PCM with 32-bit floating point samples.
/// > - Mac audio units and other audio processing: Noninterleaved linear PCM with 32-bit floating
/// >   point samples.
#[derive(Copy, Clone, Debug)]
pub struct StreamFormat {
    /// The number of frames of audio data per second used to represent a signal.
    pub sample_rate: f64,
    /// The sample format used to represent the audio data.
    ///
    /// In OS X, Core Audio expects audio data to be in native-endian, 32-bit floating-point,
    /// linear PCM format.
    ///
    /// iOS uses integer and fixed-point audio data. The result is faster calculations and less
    /// battery drain when processing audio. iOS provides a Converter audio unit and inclues the
    /// interfaces from Audio Converter Services (TODO: look into exposing this).
    pub sample_format: SampleFormat,
    /// The format flags for the given StreamFormat.
    pub flags: super::audio_format::LinearPcmFlags,
    /// The number of channels.
    pub channels: u32,
}

impl StreamFormat {
    /// Convert an AudioStreamBasicDescription into a StreamFormat.
    ///
    /// Note: `audio_unit::StreamFormat` exclusively uses the `LinearPCM` `AudioFormat`. This is as
    /// specified in the documentation:
    ///
    /// > Specify kAudioFormatLinearPCM for the mFormatID field. Audio units use uncompressed audio
    /// > data, so this is the correct format identifier to use whenever you work with audio units.
    ///
    /// [*Audio Unit Hosting Guide for iOS*](https://developer.apple.com/library/ios/documentation/MusicAudio/Conceptual/AudioUnitHostingGuide_iOS/AudioUnitHostingFundamentals/AudioUnitHostingFundamentals.html)
    ///
    /// Returns an `Error` if the `AudioFormat` inferred by the ASBD is not `LinearPCM`.
    ///
    /// Returns an `Error` if the sample format or frame and packet layout cannot
    /// be represented by this packed single-frame-per-packet format.
    #[allow(non_snake_case)]
    pub fn from_asbd(asbd: sys::AudioStreamBasicDescription) -> Result<StreamFormat, Error> {
        const NOT_SUPPORTED: Error = Error::AudioUnit(error::audio_unit::Error::FormatNotSupported);

        let sys::AudioStreamBasicDescription {
            mSampleRate,
            mFormatID,
            mFormatFlags,
            mBytesPerPacket,
            mFramesPerPacket,
            mBytesPerFrame,
            mChannelsPerFrame,
            mBitsPerChannel,
            ..
        } = asbd;

        // Retrieve the LinearPCM flags.
        let flags = match AudioFormat::from_format_and_flag(mFormatID, Some(mFormatFlags)) {
            Some(AudioFormat::LinearPCM(flags)) => flags,
            _ => return Err(NOT_SUPPORTED),
        };

        // Determine the `SampleFormat` to use.
        let sample_format =
            match SampleFormat::from_flags_and_bits_per_sample(flags, mBitsPerChannel) {
                Some(sample_format) => sample_format,
                None => return Err(NOT_SUPPORTED),
            };
        let channels = mChannelsPerFrame;
        if !mSampleRate.is_finite()
            || mSampleRate <= 0.0
            || channels == 0
            || !sample_format.does_match_flags(flags)
            || mFramesPerPacket != 1
        {
            return Err(NOT_SUPPORTED);
        }
        let sample_bytes = sample_format.size_in_bytes() as u32;
        let expected_frame_bytes = if flags.contains(LinearPcmFlags::IS_NON_INTERLEAVED) {
            Some(sample_bytes)
        } else {
            sample_bytes.checked_mul(channels)
        }
        .ok_or(NOT_SUPPORTED)?;
        if mBytesPerFrame != expected_frame_bytes || mBytesPerPacket != expected_frame_bytes {
            return Err(NOT_SUPPORTED);
        }
        Ok(StreamFormat {
            sample_rate: mSampleRate,
            flags,
            sample_format,
            channels,
        })
    }

    /// Convert a StreamFormat into a packed AudioStreamBasicDescription.
    ///
    /// Invalid rates, channels, format flags and sizes that overflow CoreAudio's
    /// 32-bit fields return an error. This method returns a `Result`; callers of
    /// the former unchecked API must handle the conversion failure.
    pub fn to_asbd(self) -> Result<sys::AudioStreamBasicDescription, Error> {
        const NOT_SUPPORTED: Error = Error::AudioUnit(error::audio_unit::Error::FormatNotSupported);
        let StreamFormat {
            sample_rate,
            flags,
            sample_format,
            channels,
        } = self;
        let flags = flags | LinearPcmFlags::IS_PACKED;
        if !sample_rate.is_finite()
            || sample_rate <= 0.0
            || channels == 0
            || !sample_format.does_match_flags(flags)
        {
            return Err(NOT_SUPPORTED);
        }
        let sample_bytes = sample_format.size_in_bytes() as u32;
        let bytes_per_frame = if flags.contains(LinearPcmFlags::IS_NON_INTERLEAVED) {
            sample_bytes
        } else {
            sample_bytes.checked_mul(channels).ok_or(NOT_SUPPORTED)?
        };
        let (format, maybe_flag) = AudioFormat::LinearPCM(flags).as_format_and_flag();
        let flag = maybe_flag.ok_or(NOT_SUPPORTED)?;
        Ok(sys::AudioStreamBasicDescription {
            mSampleRate: sample_rate,
            mFormatID: format,
            mFormatFlags: flag,
            mBytesPerPacket: bytes_per_frame,
            mFramesPerPacket: 1,
            mBytesPerFrame: bytes_per_frame,
            mChannelsPerFrame: channels,
            mBitsPerChannel: sample_format.size_in_bits(),
            mReserved: 0,
        })
    }

    /// Alias for the checked `to_asbd` conversion.
    pub fn try_to_asbd(self) -> Result<sys::AudioStreamBasicDescription, Error> {
        self.to_asbd()
    }
}
