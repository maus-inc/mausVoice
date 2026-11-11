//! Aligned PCM storage and bounds for interleaved capture.
#[derive(Default)]
pub(super) struct StreamBuffer {
    words: Vec<u64>,
    len: usize,
}

impl StreamBuffer {
    pub(super) fn resize(&mut self, len: usize) -> Option<()> {
        let words = len.checked_add(7)? / 8;
        let previous_len = self.len;
        self.words.resize(words, 0);
        self.len = len;
        if len > previous_len {
            self.bytes_mut()[previous_len..].fill(0);
        }
        Some(())
    }

    pub(super) fn bytes_mut(&mut self) -> &mut [u8] {
        // u64 storage provides alignment for every sample type CPAL accepts.
        // `len` never exceeds the initialized allocation.
        unsafe { std::slice::from_raw_parts_mut(self.words.as_mut_ptr().cast(), self.len) }
    }
}

pub(super) fn sample_count(
    frames: usize,
    channels: usize,
    bytes_per_sample: usize,
    buffer_bytes: usize,
) -> Option<usize> {
    if channels == 0 || bytes_per_sample == 0 {
        return None;
    }
    let samples = frames.checked_mul(channels)?;
    let bytes = samples.checked_mul(bytes_per_sample)?;
    (bytes <= buffer_bytes).then_some(samples)
}

#[cfg(test)]
mod tests {
    use super::{sample_count, StreamBuffer};

    #[test]
    fn storage_stays_aligned_and_clears_newly_exposed_bytes() {
        let mut buffer = StreamBuffer::default();
        for len in [0, 1, 5, 8, 9, 32, 3, 6, 17] {
            let previous = buffer.bytes_mut().to_vec();
            buffer.resize(len).unwrap();
            let bytes = buffer.bytes_mut();
            assert_eq!(bytes.as_ptr() as usize % std::mem::align_of::<u64>(), 0);
            assert_eq!(
                &bytes[..previous.len().min(len)],
                &previous[..previous.len().min(len)]
            );
            assert!(bytes[previous.len().min(len)..]
                .iter()
                .all(|byte| *byte == 0));
            bytes.fill(0xa5);
        }
        assert!(buffer.resize(usize::MAX).is_none());
    }

    #[test]
    fn counts_only_returned_interleaved_frames() {
        assert_eq!(sample_count(3, 2, 4, 80), Some(6));
        assert_eq!(sample_count(10, 2, 4, 80), Some(20));
        assert_eq!(sample_count(0, 2, 4, 80), Some(0));
    }

    #[test]
    fn rejects_out_of_bounds_or_invalid_frames() {
        assert_eq!(sample_count(11, 2, 4, 80), None);
        assert_eq!(sample_count(1, 0, 4, 80), None);
        assert_eq!(sample_count(1, 1, 0, 80), None);
        assert_eq!(sample_count(usize::MAX, 2, 1, usize::MAX), None);
        assert_eq!(sample_count(usize::MAX, 1, 2, usize::MAX), None);
    }
}
