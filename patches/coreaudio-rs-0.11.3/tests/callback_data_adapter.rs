//! Portable tests for CoreAudio typed callback data.
#![allow(dead_code, non_snake_case, non_camel_case_types)]
pub mod data_sys {
    use std::ffi::c_void;
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
}
#[derive(Clone, Copy, PartialEq)]
pub enum SampleFormat {
    F32,
    I16,
}
impl SampleFormat {
    pub fn size_in_bytes(self) -> usize {
        match self {
            Self::F32 => 4,
            Self::I16 => 2,
        }
    }
    pub fn does_match_flags(self, _: DataLinearPcmFlags) -> bool {
        true
    }
}
#[derive(Clone, Copy)]
pub struct DataLinearPcmFlags(pub bool);
impl DataLinearPcmFlags {
    pub const IS_NON_INTERLEAVED: Self = Self(true);
    pub fn contains(self, other: Self) -> bool {
        self.0 && other.0
    }
}
pub struct DataStreamFormat {
    pub flags: DataLinearPcmFlags,
    pub sample_format: SampleFormat,
}
/// Simulated plain sample type.
///
/// # Safety
/// All bit patterns must be valid and match the selected format.
pub unsafe trait DataSample: Copy + 'static {
    fn sample_format() -> SampleFormat;
}
unsafe impl DataSample for f32 {
    fn sample_format() -> SampleFormat {
        SampleFormat::F32
    }
}
unsafe impl DataSample for i16 {
    fn sample_format() -> SampleFormat {
        SampleFormat::I16
    }
}
#[path = "../src/audio_unit/render_callback/data.rs"]
mod data;

#[cfg(test)]
mod tests {
    #[test]
    fn typed_buffers_are_not_static_and_callbacks_use_lifetime_views() {
        let render = include_str!("../src/audio_unit/render_callback.rs");
        assert!(render.contains("pub data: D::Buffer<'a>"));
        assert!(!render.contains("&'static mut ["));
        assert!(render.contains("for<'a> FnMut(Args<'a, D>)"));
    }
    use super::{
        data::{self, Data},
        data_sys as sys, DataLinearPcmFlags, DataStreamFormat, SampleFormat,
    };
    fn list(data: *mut std::ffi::c_void, bytes: u32, channels: u32) -> sys::AudioBufferList {
        sys::AudioBufferList {
            mNumberBuffers: 1,
            mBuffers: [sys::AudioBuffer {
                mNumberChannels: channels,
                mDataByteSize: bytes,
                mData: data,
            }],
        }
    }
    #[repr(C)]
    struct Pair {
        count: u32,
        buffers: [sys::AudioBuffer; 2],
    }
    #[test]
    fn interleaved_output_is_cleared_and_input_preserved() {
        let mut samples = [3.0_f32, 4.0, 5.0, 6.0];
        let mut list = list(samples.as_mut_ptr().cast(), 16, 2);
        let input =
            unsafe { data::Interleaved::<f32>::from_input_proc_args(2, &mut list, false) }.unwrap();
        assert_eq!(input.buffer, &[3.0, 4.0, 5.0, 6.0]);
        let output =
            unsafe { data::Interleaved::<f32>::from_input_proc_args(2, &mut list, true) }.unwrap();
        assert_eq!(output.buffer, &[0.0, 0.0, 0.0, 0.0]);
        output.buffer[2] = 7.0;
        assert_eq!(samples[2], 7.0);
    }
    #[test]
    fn validates_format_size_alignment_and_empty_buffers() {
        let mut samples = [0_f32; 2];
        let mut list = list(samples.as_mut_ptr().cast(), 8, 1);
        let stream = DataStreamFormat {
            flags: DataLinearPcmFlags(false),
            sample_format: SampleFormat::F32,
        };
        assert!(data::Interleaved::<f32>::does_stream_format_match(&stream));
        assert!(!data::Interleaved::<i16>::does_stream_format_match(&stream));
        assert!(
            unsafe { data::Interleaved::<f32>::from_input_proc_args(1, &mut list, false) }
                .is_none()
        );
        list.mBuffers[0].mData = unsafe { samples.as_mut_ptr().cast::<u8>().add(1).cast() };
        assert!(
            unsafe { data::Interleaved::<f32>::from_input_proc_args(2, &mut list, false) }
                .is_none()
        );
        list.mBuffers[0].mData = std::ptr::null_mut();
        list.mBuffers[0].mDataByteSize = 0;
        assert_eq!(
            unsafe { data::Interleaved::<f32>::from_input_proc_args(0, &mut list, false) }
                .unwrap()
                .buffer
                .len(),
            0
        );
        assert!(
            unsafe { data::Interleaved::<f32>::from_input_proc_args(1, &mut list, false) }
                .is_none()
        );
    }
    #[test]
    fn noninterleaved_checks_overlaps_before_exposing_mutable_channels() {
        let mut left = [1_i16, 2];
        let mut right = [3_i16, 4];
        let mut pair = Pair {
            count: 2,
            buffers: [
                sys::AudioBuffer {
                    mNumberChannels: 1,
                    mDataByteSize: 4,
                    mData: left.as_mut_ptr().cast(),
                },
                sys::AudioBuffer {
                    mNumberChannels: 1,
                    mDataByteSize: 4,
                    mData: right.as_mut_ptr().cast(),
                },
            ],
        };
        let ptr = (&mut pair as *mut Pair).cast::<sys::AudioBufferList>();
        let mut view =
            unsafe { data::NonInterleaved::<i16>::from_input_proc_args(2, ptr, false) }.unwrap();
        let mut channels = view.channels_mut();
        let a = channels.next().unwrap();
        let b = channels.next().unwrap();
        a[0] = 8;
        b[0] = 9;
        assert_eq!(left[0], 8);
        assert_eq!(right[0], 9);
        pair.buffers[1].mData = pair.buffers[0].mData;
        assert!(
            unsafe { data::NonInterleaved::<i16>::from_input_proc_args(2, ptr, false) }.is_none()
        );
        pair.buffers[1].mData = ptr.cast();
        assert!(
            unsafe { data::NonInterleaved::<i16>::from_input_proc_args(2, ptr, false) }.is_none()
        );
    }
    #[test]
    fn bytes_view_accepts_unaligned_data_and_raw_does_not_clear() {
        let mut samples = [1_u8, 2, 3, 4, 5];
        let mut list = list(unsafe { samples.as_mut_ptr().add(1) }.cast(), 4, 1);
        let raw = unsafe { data::Raw::from_input_proc_args(1, &mut list, true) }.unwrap();
        assert_eq!(raw.data, &mut list as *mut _);
        assert_eq!(samples, [1, 2, 3, 4, 5]);
        let bytes =
            unsafe { data::InterleavedBytes::<f32>::from_input_proc_args(1, &mut list, true) }
                .unwrap();
        assert_eq!(bytes.buffer, &[0, 0, 0, 0]);
    }
    #[test]
    fn rejects_invalid_shapes_before_clearing_or_exposing_data() {
        let mut samples = [9_i16, 8];
        let mut list = list(samples.as_mut_ptr().cast(), 4, 1);
        list.mNumberBuffers = 0;
        assert!(
            unsafe { data::Interleaved::<i16>::from_input_proc_args(2, &mut list, true) }.is_none()
        );
        assert_eq!(samples, [9, 8]);
        list.mNumberBuffers = 1;
        list.mBuffers[0].mNumberChannels = u32::MAX;
        assert!(unsafe {
            data::Interleaved::<i16>::from_input_proc_args(u32::MAX, &mut list, true)
        }
        .is_none());
        assert_eq!(samples, [9, 8]);
        list.mBuffers[0].mNumberChannels = 0;
        assert!(
            unsafe { data::Interleaved::<i16>::from_input_proc_args(2, &mut list, true) }.is_none()
        );
        assert_eq!(samples, [9, 8]);
    }
}
