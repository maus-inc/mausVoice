use std::ops::Range;

/// A callback buffer remains owned by the worker until ALSA accepts every frame.
pub(super) struct PendingOutput {
    frame_bytes: usize,
    total_frames: usize,
    written_frames: usize,
}

impl PendingOutput {
    pub(super) fn new(buffer_len: usize, frame_bytes: usize) -> Option<Self> {
        if frame_bytes == 0 || buffer_len == 0 || buffer_len % frame_bytes != 0 {
            return None;
        }
        Some(Self {
            frame_bytes,
            total_frames: buffer_len / frame_bytes,
            written_frames: 0,
        })
    }

    pub(super) fn request(&self, available_frames: usize) -> Range<usize> {
        let frames = available_frames.min(self.total_frames - self.written_frames);
        let start = self.written_frames * self.frame_bytes;
        start..start + frames * self.frame_bytes
    }

    /// The requested range is frame-aligned and derived from this pending buffer.
    pub(super) fn advance(&mut self, requested_bytes: usize, written: usize) -> Option<bool> {
        if requested_bytes % self.frame_bytes != 0
            || requested_bytes / self.frame_bytes > self.total_frames - self.written_frames
            || written > requested_bytes / self.frame_bytes
        {
            return None;
        }
        self.written_frames = self.written_frames.checked_add(written)?;
        Some(self.written_frames == self.total_frames)
    }
}

#[cfg(test)]
mod tests {
    use super::PendingOutput;

    #[test]
    fn partial_writes_only_offer_the_unwritten_frames() {
        let mut pending = PendingOutput::new(32, 8).unwrap();
        assert_eq!(pending.request(4), 0..32);
        assert_eq!(pending.advance(32, 1), Some(false));
        assert_eq!(pending.request(1), 8..16);
        assert_eq!(pending.advance(8, 0), Some(false));
        assert_eq!(pending.request(99), 8..32);
        assert_eq!(pending.advance(24, 2), Some(false));
        assert_eq!(pending.request(1), 24..32);
        assert_eq!(pending.advance(8, 1), Some(true));
    }

    #[test]
    fn rejects_invalid_geometry_and_driver_counts() {
        assert!(PendingOutput::new(0, 4).is_none());
        assert!(PendingOutput::new(16, 0).is_none());
        assert!(PendingOutput::new(15, 4).is_none());
        let mut pending = PendingOutput::new(16, 4).unwrap();
        assert_eq!(pending.request(0), 0..0);
        assert_eq!(pending.advance(4, 2), None);
        assert_eq!(pending.request(4), 0..16);
        assert_eq!(pending.advance(3, 0), None);
    }
}
