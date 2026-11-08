//! Portable tests of CoreAudio sample format interpretation.
#![allow(dead_code)]
pub mod audio_format {
    #[derive(Clone, Copy)]
    pub struct LinearPcmFlags(pub u32);
    impl LinearPcmFlags {
        pub const IS_FLOAT: Self = Self(1);
        pub const IS_SIGNED_INTEGER: Self = Self(2);
        pub const IS_PACKED: Self = Self(4);
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
}
#[path = "../src/audio_unit/sample_format.rs"]
mod sample_format;
#[cfg(test)]
mod tests {
    use super::{audio_format::LinearPcmFlags as Flags, sample_format::SampleFormat};
    #[test]
    fn rejects_unpacked_24_bit_pcm() {
        let flags = Flags::IS_SIGNED_INTEGER;
        assert_eq!(
            SampleFormat::from_flags_and_bits_per_sample(flags, 24),
            None
        );
        assert!(!SampleFormat::I24.does_match_flags(flags));
    }
    #[test]
    fn accepts_matching_packed_24_bit_pcm() {
        let flags = Flags::IS_SIGNED_INTEGER | Flags::IS_PACKED;
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
            SampleFormat::from_flags_and_bits_per_sample(Flags::IS_FLOAT | Flags::IS_PACKED, 32),
            Some(SampleFormat::F32)
        );
        assert_eq!(
            SampleFormat::from_flags_and_bits_per_sample(
                Flags::IS_SIGNED_INTEGER | Flags::IS_PACKED,
                16
            ),
            Some(SampleFormat::I16)
        );
        assert_eq!(
            SampleFormat::from_flags_and_bits_per_sample(Flags::IS_SIGNED_INTEGER, 16),
            None
        );
    }
}
