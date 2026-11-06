//! Owned input buffer for the token-managed CoreAudio callback.
use super::coreaudio::audio_unit::render_callback::{self, data};
use super::coreaudio::sys::{
    self, AudioBuffer, AudioBufferList, AudioTimeStamp, AudioUnitRenderActionFlags, OSStatus,
    UInt32,
};

pub(super) struct InputRender {
    unit: sys::AudioUnit,
    // CPAL may interpret the bytes as samples up to 64 bits wide.
    samples: Vec<u64>,
    list: AudioBufferList,
    channels: u32,
    bytes_per_frame: usize,
}

// The unit and buffer are only used by one registry callback at a time. The
// owner drains and retires that callback before closing the native unit.
unsafe impl Send for InputRender {}

impl InputRender {
    pub(super) fn new(
        unit: sys::AudioUnit,
        channels: u32,
        bytes_per_sample: usize,
        frames: u32,
    ) -> Option<Self> {
        if channels == 0 {
            return None;
        }
        let bytes_per_frame = (channels as usize).checked_mul(bytes_per_sample)?;
        if bytes_per_frame == 0 {
            return None;
        }
        let bytes = (frames as usize).checked_mul(bytes_per_frame)?;
        u32::try_from(bytes).ok()?;
        let words = bytes.checked_add(7)? / 8;
        Some(Self {
            unit,
            samples: vec![0; words],
            list: AudioBufferList {
                mNumberBuffers: 1,
                mBuffers: [AudioBuffer {
                    mNumberChannels: channels,
                    mDataByteSize: 0,
                    mData: std::ptr::null_mut(),
                }],
            },
            channels,
            bytes_per_frame,
        })
    }

    /// The unit must be live and the non-null pointers must be valid for this
    /// CoreAudio invocation. The caller must serialize rendering with teardown.
    pub(super) unsafe fn render(
        &mut self,
        flags: *mut AudioUnitRenderActionFlags,
        timestamp: *const AudioTimeStamp,
        bus: UInt32,
        frames: UInt32,
    ) -> Result<render_callback::Args<data::Raw>, OSStatus> {
        if flags.is_null() || timestamp.is_null() {
            return Err(-1500);
        }
        let bytes = (frames as usize)
            .checked_mul(self.bytes_per_frame)
            .ok_or(-1500)?;
        let data_size = u32::try_from(bytes).map_err(|_| -1500)?;
        let words = bytes.checked_add(7).ok_or(-1500)? / 8;
        self.samples.resize(words, 0);
        self.list.mNumberBuffers = 1;
        self.list.mBuffers[0] = AudioBuffer {
            mNumberChannels: self.channels,
            mDataByteSize: data_size,
            mData: self.samples.as_mut_ptr().cast(),
        };
        let list = &mut self.list as *mut AudioBufferList;
        let status =
            unsafe { sys::AudioUnitRender(self.unit, flags, timestamp, bus, frames, list) };
        if status != 0 {
            return Err(status);
        }
        let buffer = &self.list.mBuffers[0];
        if self.list.mNumberBuffers != 1
            || buffer.mData != self.samples.as_mut_ptr().cast()
            || buffer.mDataByteSize != data_size
            || buffer.mNumberChannels != self.channels
        {
            return Err(-1500);
        }
        Ok(render_callback::Args {
            data: data::Raw { data: list },
            time_stamp: unsafe { *timestamp },
            flags: render_callback::action_flags::Handle::from_ptr(flags),
            bus_number: bus,
            num_frames: frames as usize,
        })
    }
}
