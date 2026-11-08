//! Portable tests of CoreAudio stream-description validation.
#![allow(dead_code, non_snake_case)]
pub mod stream_sys {
    #[derive(Debug, Clone, Copy)]
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
}
pub mod stream_error {
    pub mod audio_unit {
        #[derive(Debug, PartialEq, Eq, Clone, Copy)]
        pub enum Error {
            FormatNotSupported,
        }
    }
    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    pub enum Error {
        AudioUnit(audio_unit::Error),
    }
}
pub mod audio_format {
    #[derive(Debug, Clone, Copy)]
    pub struct LinearPcmFlags(pub u32);
    impl LinearPcmFlags {
        pub const IS_FLOAT: Self = Self(1);
        pub const IS_SIGNED_INTEGER: Self = Self(2);
        pub const IS_PACKED: Self = Self(4);
        pub const IS_NON_INTERLEAVED: Self = Self(8);
        pub fn contains(self, other: Self) -> bool {
            self.0 & other.0 == other.0
        }
    }
    impl std::ops::BitOr for LinearPcmFlags {
        type Output = Self;
        fn bitor(self, other: Self) -> Self {
            Self(self.0 | other.0)
        }
    }
    pub enum AudioFormat {
        LinearPCM(LinearPcmFlags),
        Other,
    }
    impl AudioFormat {
        pub fn from_format_and_flag(id: u32, flags: Option<u32>) -> Option<Self> {
            if id == 42 {
                Some(Self::LinearPCM(LinearPcmFlags(flags?)))
            } else {
                Some(Self::Other)
            }
        }
        pub fn as_format_and_flag(&self) -> (u32, Option<u32>) {
            match self {
                Self::LinearPCM(flags) => (42, Some(flags.0)),
                Self::Other => (43, None),
            }
        }
    }
}
#[path = "../src/audio_unit/sample_format.rs"]
mod sample_format;
pub use sample_format::SampleFormat;
#[path = "../src/audio_unit/stream_format.rs"]
mod stream_format;

#[cfg(test)]
mod tests {
    use super::{
        audio_format::LinearPcmFlags as F, stream_format::StreamFormat,
        stream_sys::AudioStreamBasicDescription as ASBD, SampleFormat,
    };
    fn packed(channels: u32, non_interleaved: bool) -> ASBD {
        let flags = F::IS_SIGNED_INTEGER
            | F::IS_PACKED
            | if non_interleaved {
                F::IS_NON_INTERLEAVED
            } else {
                F(0)
            };
        let bytes = if non_interleaved { 3 } else { channels * 3 };
        ASBD {
            mSampleRate: 48_000.0,
            mFormatID: 42,
            mFormatFlags: flags.0,
            mBytesPerPacket: bytes,
            mFramesPerPacket: 1,
            mBytesPerFrame: bytes,
            mChannelsPerFrame: channels,
            mBitsPerChannel: 24,
            mReserved: 0,
        }
    }
    #[test]
    fn accepts_valid_packed_layouts_and_round_trips() {
        for interleaved in [false, true] {
            let original = packed(2, interleaved);
            let f = StreamFormat::from_asbd(original).unwrap();
            assert_eq!(f.sample_format, SampleFormat::I24);
            let again = f.to_asbd();
            assert_eq!(again.mBytesPerFrame, original.mBytesPerFrame);
            assert_eq!(again.mBytesPerPacket, original.mBytesPerPacket);
            assert_eq!(again.mFramesPerPacket, 1);
        }
    }
    #[test]
    fn rejects_mismatched_frame_and_packet_sizes() {
        let valid = packed(2, false);
        let malformed = [
            ASBD {
                mBytesPerFrame: 8,
                ..valid
            },
            ASBD {
                mBytesPerPacket: 8,
                ..valid
            },
            ASBD {
                mFramesPerPacket: 2,
                ..valid
            },
            ASBD {
                mChannelsPerFrame: 0,
                ..valid
            },
            ASBD {
                mChannelsPerFrame: u32::MAX,
                ..valid
            },
        ];
        for item in malformed {
            assert!(
                StreamFormat::from_asbd(item).is_err(),
                "{}",
                format_args!("{item:?}")
            );
        }
    }
    #[test]
    fn rejects_invalid_rates_and_conflicting_numeric_flags() {
        let valid = packed(2, false);
        for rate in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(StreamFormat::from_asbd(ASBD {
                mSampleRate: rate,
                ..valid
            })
            .is_err());
        }
        assert!(StreamFormat::from_asbd(ASBD {
            mFormatFlags: (F::IS_FLOAT | F::IS_SIGNED_INTEGER | F::IS_PACKED).0,
            mBitsPerChannel: 32,
            mBytesPerFrame: 8,
            mBytesPerPacket: 8,
            ..valid
        })
        .is_err());
    }
    #[test]
    fn round_trips_float_and_signed_formats() {
        for (sample, flags) in [
            (SampleFormat::F32, F::IS_FLOAT | F::IS_PACKED),
            (SampleFormat::I16, F::IS_SIGNED_INTEGER | F::IS_PACKED),
        ] {
            for non_interleaved in [false, true] {
                let flags = if non_interleaved {
                    flags | F::IS_NON_INTERLEAVED
                } else {
                    flags
                };
                let input = StreamFormat {
                    sample_rate: 44_100.0,
                    sample_format: sample,
                    flags,
                    channels: 2,
                };
                let parsed = StreamFormat::from_asbd(input.to_asbd()).unwrap();
                assert_eq!(parsed.sample_format, sample);
                assert_eq!(parsed.channels, 2);
            }
        }
    }
    #[test]
    fn safe_setter_uses_checked_asbd_conversion() {
        let source = include_str!("../src/audio_unit/mod.rs");
        let format = include_str!("../src/audio_unit/stream_format.rs");
        assert!(source.contains("stream_format.try_to_asbd()?"));
        assert!(format.contains("pub fn try_to_asbd("));
    }
    #[test]
    fn checked_conversion_rejects_invalid_stream_formats() {
        let valid = StreamFormat {
            sample_rate: 48_000.0,
            sample_format: SampleFormat::I24,
            flags: F::IS_SIGNED_INTEGER,
            channels: 2,
        };
        let asbd = valid.try_to_asbd().unwrap();
        assert_eq!(asbd.mBytesPerFrame, 6);
        for invalid in [
            StreamFormat {
                channels: 0,
                ..valid
            },
            StreamFormat {
                channels: u32::MAX,
                ..valid
            },
            StreamFormat {
                sample_rate: f64::NAN,
                ..valid
            },
            StreamFormat {
                sample_rate: 0.0,
                ..valid
            },
            StreamFormat {
                flags: F::IS_FLOAT,
                ..valid
            },
        ] {
            assert!(invalid.try_to_asbd().is_err());
        }
        let non_interleaved = StreamFormat {
            channels: u32::MAX,
            flags: F::IS_SIGNED_INTEGER | F::IS_NON_INTERLEAVED,
            ..valid
        };
        assert_eq!(non_interleaved.try_to_asbd().unwrap().mBytesPerFrame, 3);
    }
    #[test]
    fn rejects_unpacked_24_bit_pcm() {
        let flags = F::IS_SIGNED_INTEGER;
        assert_eq!(
            SampleFormat::from_flags_and_bits_per_sample(flags, 24),
            None
        );
        assert!(!SampleFormat::I24.does_match_flags(flags));
    }
    #[test]
    fn accepts_matching_packed_24_bit_pcm() {
        let flags = F::IS_SIGNED_INTEGER | F::IS_PACKED;
        assert_eq!(
            SampleFormat::from_flags_and_bits_per_sample(flags, 24),
            Some(SampleFormat::I24)
        );
        assert!(SampleFormat::I24.does_match_flags(flags));
        assert_eq!(SampleFormat::I24.size_in_bytes(), 3);
    }
    #[test]
    fn preserves_other_packed_formats() {
        assert_eq!(
            SampleFormat::from_flags_and_bits_per_sample(F::IS_FLOAT | F::IS_PACKED, 32),
            Some(SampleFormat::F32)
        );
        assert_eq!(
            SampleFormat::from_flags_and_bits_per_sample(F::IS_SIGNED_INTEGER | F::IS_PACKED, 16),
            Some(SampleFormat::I16)
        );
        assert_eq!(
            SampleFormat::from_flags_and_bits_per_sample(F::IS_SIGNED_INTEGER, 16),
            None
        );
    }
    #[test]
    fn rejects_conflicting_numeric_format_flags() {
        let flags = F::IS_FLOAT | F::IS_SIGNED_INTEGER | F::IS_PACKED;
        assert_eq!(
            SampleFormat::from_flags_and_bits_per_sample(flags, 32),
            None
        );
        assert!(!SampleFormat::F32.does_match_flags(flags));
    }
}
