//! Exercise CPAL's real ASBD conversion against portable CoreAudio type mocks.
#![allow(non_upper_case_globals, non_snake_case, dead_code)]
use cpal::{BufferSize, SampleFormat, SampleRate, StreamConfig};

const kAudioFormatFlagIsFloat: u32 = 1;
const kAudioFormatFlagIsSignedInteger: u32 = 4;
const kAudioFormatFlagIsPacked: u32 = 8;
const kAudioFormatLinearPCM: u32 = 0x6c70_636d;

#[derive(Default)]
struct AudioStreamBasicDescription {
    mSampleRate: f64,
    mFormatID: u32,
    mFormatFlags: u32,
    mBytesPerPacket: u32,
    mFramesPerPacket: u32,
    mBytesPerFrame: u32,
    mChannelsPerFrame: u32,
    mBitsPerChannel: u32,
    mReserved: u32,
}

#[path = "../src/host/coreaudio/stream_format.rs"]
mod stream_format;

#[cfg(test)]
mod tests {
    use super::*;

    fn config(channels: u16) -> StreamConfig {
        StreamConfig {
            channels,
            sample_rate: SampleRate(48_000),
            buffer_size: BufferSize::Default,
        }
    }

    #[test]
    fn signed_integer_formats_set_the_signed_flag() {
        for format in [
            SampleFormat::I8,
            SampleFormat::I16,
            SampleFormat::I32,
            SampleFormat::I64,
        ] {
            let asbd = stream_format::asbd_from_config(&config(2), format);
            assert_eq!(
                asbd.mFormatFlags,
                kAudioFormatFlagIsPacked | kAudioFormatFlagIsSignedInteger,
                "{format:?}"
            );
        }
    }

    #[test]
    fn floating_formats_set_only_the_float_and_packed_flags() {
        for format in [SampleFormat::F32, SampleFormat::F64] {
            let asbd = stream_format::asbd_from_config(&config(2), format);
            assert_eq!(
                asbd.mFormatFlags,
                kAudioFormatFlagIsPacked | kAudioFormatFlagIsFloat,
                "{format:?}"
            );
        }
    }

    #[test]
    fn unsigned_formats_have_neither_signed_nor_float_flags() {
        for format in [
            SampleFormat::U8,
            SampleFormat::U16,
            SampleFormat::U32,
            SampleFormat::U64,
        ] {
            let asbd = stream_format::asbd_from_config(&config(2), format);
            assert_eq!(asbd.mFormatFlags, kAudioFormatFlagIsPacked, "{format:?}");
        }
    }

    #[test]
    fn frame_and_packet_layout_match_actual_cpal_sample_sizes() {
        for format in [
            SampleFormat::I8,
            SampleFormat::I16,
            SampleFormat::I32,
            SampleFormat::I64,
            SampleFormat::U8,
            SampleFormat::U16,
            SampleFormat::U32,
            SampleFormat::U64,
            SampleFormat::F32,
            SampleFormat::F64,
        ] {
            for channels in [1, 2, u16::MAX] {
                let asbd = stream_format::asbd_from_config(&config(channels), format);
                let bytes = format.sample_size() as u32;
                assert_eq!(asbd.mSampleRate, 48_000.0);
                assert_eq!(asbd.mFormatID, kAudioFormatLinearPCM);
                assert_eq!(asbd.mBitsPerChannel, bytes * 8);
                assert_eq!(asbd.mChannelsPerFrame, u32::from(channels));
                assert_eq!(asbd.mBytesPerFrame, bytes * u32::from(channels));
                assert_eq!(asbd.mFramesPerPacket, 1);
                assert_eq!(asbd.mBytesPerPacket, asbd.mBytesPerFrame);
                assert_eq!(asbd.mReserved, 0);
            }
        }
    }
}
