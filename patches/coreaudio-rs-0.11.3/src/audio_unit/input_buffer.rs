//! Storage owned by an input callback, independently of CoreAudio's byte count.

use std::convert::TryFrom;

pub(super) fn buffer_byte_size(frames: u32, sample_bytes: usize, channels: u32) -> Option<u32> {
    let bytes = u32::try_from(sample_bytes).ok()?;
    frames.checked_mul(bytes)?.checked_mul(channels)
}

pub(super) struct InputBuffer {
    bytes: Vec<u8>,
}

impl InputBuffer {
    pub(super) fn new(len: usize) -> Self {
        Self {
            bytes: vec![0; len],
        }
    }

    pub(super) fn resize(&mut self, len: usize) {
        self.bytes.resize(len, 0);
    }

    pub(super) fn as_mut_ptr(&mut self) -> *mut u8 {
        self.bytes.as_mut_ptr()
    }
}

#[cfg(test)]
mod tests {
    use super::{buffer_byte_size, InputBuffer};

    #[test]
    fn byte_size_rejects_overflow_before_allocating() {
        assert_eq!(buffer_byte_size(0, 4, 2), Some(0));
        assert_eq!(buffer_byte_size(128, 4, 2), Some(1024));
        assert_eq!(buffer_byte_size(u32::MAX, 1, 1), Some(u32::MAX));
        assert_eq!(buffer_byte_size(u32::MAX, 2, 1), None);
        assert_eq!(buffer_byte_size(u32::MAX, 1, 2), None);
        #[cfg(target_pointer_width = "64")]
        assert_eq!(buffer_byte_size(1, u32::MAX as usize + 1, 1), None);
    }

    #[test]
    fn grows_and_shrinks_without_reconstructing_allocation_metadata() {
        let mut buffer = InputBuffer::new(5);
        unsafe { *buffer.as_mut_ptr() = 7 };
        buffer.resize(113);
        assert_eq!(buffer.bytes.len(), 113);
        assert_eq!(buffer.bytes[0], 7);
        assert!(buffer.bytes[5..].iter().all(|byte| *byte == 0));
        buffer.resize(2);
        buffer.resize(19);
        assert_eq!(buffer.bytes[0], 7);
        assert!(buffer.bytes[2..].iter().all(|byte| *byte == 0));
        // The Vec retains its real capacity, even if native reports a different
        // mDataByteSize; dropping it must not invent a deallocation layout.
        assert!(buffer.bytes.capacity() >= 19);
    }

    #[test]
    fn zero_length_can_grow_and_be_dropped() {
        let mut buffer = InputBuffer::new(0);
        buffer.resize(32);
        assert_eq!(buffer.bytes, vec![0; 32]);
        buffer.resize(0);
    }
}
