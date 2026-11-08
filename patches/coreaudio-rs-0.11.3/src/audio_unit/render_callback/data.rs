//! Callback-scoped typed views of CoreAudio buffers.
use super::{
    data_sys as sys, DataLinearPcmFlags as LinearPcmFlags, DataSample as Sample,
    DataStreamFormat as StreamFormat,
};
use std::{marker::PhantomData, mem, ptr::NonNull, slice};

/// A callback data format and the view constructed for one invocation.
///
/// # Safety
/// Implementations must ensure that `Buffer<'a>` does not provide safe access
/// to native callback storage after `'a`, and that its safe operations cannot
/// create invalid or overlapping Rust references. The constructor must return
/// `None` instead of constructing an invalid view.
pub unsafe trait Data {
    /// The data made available during one callback.
    type Buffer<'a>;
    /// Whether this data format matches the negotiated stream format.
    fn does_stream_format_match(stream_format: &StreamFormat) -> bool;
    /// Build the callback view, optionally clearing typed output first.
    ///
    /// # Safety
    /// The list and its declared buffer entries must be valid for `'a` and
    /// exclusively accessible. Each declared data allocation must be writable
    /// for its reported byte count and initialized unless `clear_output` is
    /// true. Those allocations must not overlap other live callback arguments.
    /// The list must not change for the duration of the view.
    unsafe fn from_input_proc_args<'a>(
        num_frames: u32,
        io_data: *mut sys::AudioBufferList,
        clear_output: bool,
    ) -> Option<Self::Buffer<'a>>;
}

/// A raw pointer to callback data. Dereferencing it requires unsafe code.
#[derive(Debug)]
pub struct Raw {
    pub data: *mut sys::AudioBufferList,
}
unsafe impl Data for Raw {
    type Buffer<'a> = Raw;
    fn does_stream_format_match(_: &StreamFormat) -> bool {
        true
    }
    unsafe fn from_input_proc_args<'a>(
        _: u32,
        io_data: *mut sys::AudioBufferList,
        _: bool,
    ) -> Option<Self::Buffer<'a>> {
        Some(Raw { data: io_data })
    }
}

/// Select interleaved PCM samples of type `S`.
pub struct Interleaved<S>(PhantomData<S>);
/// Select interleaved PCM as bytes for sample type `S`.
pub struct InterleavedBytes<S>(PhantomData<S>);
/// Select non-interleaved PCM samples of type `S`.
pub struct NonInterleaved<S>(PhantomData<S>);

/// Interleaved samples borrowed for the current callback only.
///
/// A safe callback cannot retain this buffer beyond an invocation:
/// ```compile_fail
/// use coreaudio::audio_unit::render_callback::data::{Data, Interleaved};
/// fn register<F: for<'a> FnMut(<Interleaved<f32> as Data>::Buffer<'a>)>(_: F) {}
/// let mut saved: Option<&'static mut [f32]> = None;
/// register(|data| saved = Some(data.buffer));
/// ```
pub struct InterleavedBuffer<'a, S> {
    pub buffer: &'a mut [S],
    pub channels: usize,
}
/// Interleaved sample bytes borrowed for the current callback only.
pub struct InterleavedBytesBuffer<'a> {
    pub buffer: &'a mut [u8],
    pub channels: usize,
}
/// Non-interleaved sample buffers borrowed for the current callback only.
pub struct NonInterleavedBuffer<'a, S> {
    buffers: &'a mut [sys::AudioBuffer],
    frames: usize,
    sample_format: PhantomData<S>,
}
/// Iterator over channel slices.
pub struct Channels<'a, S> {
    buffers: slice::Iter<'a, sys::AudioBuffer>,
    frames: usize,
    sample_format: PhantomData<S>,
}
/// Iterator over mutable channel slices.
pub struct ChannelsMut<'a, S> {
    buffers: slice::IterMut<'a, sys::AudioBuffer>,
    frames: usize,
    sample_format: PhantomData<S>,
}

// The constructor validates the complete list, including pairwise disjoint
// data ranges. Empty buffers use an aligned dangling pointer, as Rust requires.
fn sample_ptr<S>(buffer: &sys::AudioBuffer, frames: usize) -> (*mut S, usize) {
    let count = frames * buffer.mNumberChannels as usize;
    let ptr = if count == 0 {
        NonNull::<S>::dangling().as_ptr()
    } else {
        buffer.mData.cast::<S>()
    };
    (ptr, count)
}
impl<'a, S: 'a> Iterator for Channels<'a, S> {
    type Item = &'a [S];
    fn next(&mut self) -> Option<Self::Item> {
        self.buffers.next().map(|buffer| {
            let (ptr, count) = sample_ptr::<S>(buffer, self.frames);
            unsafe { slice::from_raw_parts(ptr, count) }
        })
    }
}
impl<'a, S: 'a> Iterator for ChannelsMut<'a, S> {
    type Item = &'a mut [S];
    fn next(&mut self) -> Option<Self::Item> {
        self.buffers.next().map(|buffer| {
            let (ptr, count) = sample_ptr::<S>(buffer, self.frames);
            unsafe { slice::from_raw_parts_mut(ptr, count) }
        })
    }
}
impl<S> NonInterleavedBuffer<'_, S> {
    /// Iterate over channel data.
    pub fn channels(&self) -> Channels<'_, S> {
        Channels {
            buffers: self.buffers.iter(),
            frames: self.frames,
            sample_format: PhantomData,
        }
    }
    /// Iterate over mutable channel data.
    pub fn channels_mut(&mut self) -> ChannelsMut<'_, S> {
        ChannelsMut {
            buffers: self.buffers.iter_mut(),
            frames: self.frames,
            sample_format: PhantomData,
        }
    }
}

fn valid_format<S: Sample>(stream: &StreamFormat, non_interleaved: bool) -> bool {
    stream.flags.contains(LinearPcmFlags::IS_NON_INTERLEAVED) == non_interleaved
        && stream.sample_format == S::sample_format()
        && S::sample_format().does_match_flags(stream.flags)
        && mem::size_of::<S>() == S::sample_format().size_in_bytes()
}

// Typed numeric samples use the target's native byte order. Byte views do not
// interpret the data and can expose either order.
fn native_endian<S: Sample>(stream: &StreamFormat) -> bool {
    mem::size_of::<S>() == 1
        || stream.flags.contains(LinearPcmFlags::IS_BIG_ENDIAN) == cfg!(target_endian = "big")
}

// `io_data` is trusted to contain the native-declared number of entries; the
// callback API does not supply the list allocation length. All data lengths,
// alignments, and ranges are checked before creating sample references.
unsafe fn checked_buffers<'a, S: Sample>(
    io_data: *mut sys::AudioBufferList,
    frames: u32,
    one: bool,
    align: usize,
) -> Option<&'a mut [sys::AudioBuffer]> {
    if io_data.is_null()
        || (io_data as usize) % mem::align_of::<sys::AudioBufferList>() != 0
        || mem::size_of::<S>() == 0
    {
        return None;
    }
    let count = (*io_data).mNumberBuffers as usize;
    if one && count != 1 {
        return None;
    }
    let header = mem::offset_of!(sys::AudioBufferList, mBuffers);
    let list_bytes = count
        .checked_mul(mem::size_of::<sys::AudioBuffer>())?
        .checked_add(header)?;
    if list_bytes > isize::MAX as usize {
        return None;
    }
    let list_start = io_data as usize;
    let list_end = list_start.checked_add(list_bytes)?;
    let first = std::ptr::addr_of_mut!((*io_data).mBuffers).cast::<sys::AudioBuffer>();
    let buffers = slice::from_raw_parts_mut(first, count);
    for (i, buffer) in buffers.iter().enumerate() {
        if buffer.mNumberChannels == 0 {
            return None;
        }
        let count = (frames as usize).checked_mul(buffer.mNumberChannels as usize)?;
        let bytes = count.checked_mul(mem::size_of::<S>())?;
        if bytes > isize::MAX as usize || bytes != buffer.mDataByteSize as usize {
            return None;
        }
        if bytes == 0 {
            continue;
        }
        let start = buffer.mData as usize;
        if start == 0 || start % align != 0 {
            return None;
        }
        let end = start.checked_add(bytes)?;
        if start < list_end && list_start < end {
            return None;
        }
        for prior in &buffers[..i] {
            let prior_size = prior.mDataByteSize as usize;
            if prior_size > 0 {
                let a = prior.mData as usize;
                let b = a.checked_add(prior_size)?;
                if start < b && a < end {
                    return None;
                }
            }
        }
    }
    Some(buffers)
}
unsafe fn clear_buffers(buffers: &mut [sys::AudioBuffer]) {
    for buffer in buffers {
        if buffer.mDataByteSize > 0 {
            std::ptr::write_bytes(buffer.mData.cast::<u8>(), 0, buffer.mDataByteSize as usize);
        }
    }
}

unsafe impl<S: Sample> Data for Interleaved<S> {
    type Buffer<'a> = InterleavedBuffer<'a, S>;
    fn does_stream_format_match(stream: &StreamFormat) -> bool {
        valid_format::<S>(stream, false) && native_endian::<S>(stream)
    }
    unsafe fn from_input_proc_args<'a>(
        frames: u32,
        io_data: *mut sys::AudioBufferList,
        clear_output: bool,
    ) -> Option<Self::Buffer<'a>> {
        let buffers = checked_buffers::<S>(io_data, frames, true, mem::align_of::<S>())?;
        if clear_output {
            clear_buffers(buffers);
        }
        let channels = buffers[0].mNumberChannels as usize;
        let (ptr, count) = sample_ptr::<S>(&buffers[0], frames as usize);
        Some(InterleavedBuffer {
            buffer: slice::from_raw_parts_mut(ptr, count),
            channels,
        })
    }
}
unsafe impl<S: Sample> Data for InterleavedBytes<S> {
    type Buffer<'a> = InterleavedBytesBuffer<'a>;
    fn does_stream_format_match(stream: &StreamFormat) -> bool {
        valid_format::<S>(stream, false)
    }
    unsafe fn from_input_proc_args<'a>(
        frames: u32,
        io_data: *mut sys::AudioBufferList,
        clear_output: bool,
    ) -> Option<Self::Buffer<'a>> {
        let buffers = checked_buffers::<S>(io_data, frames, true, 1)?;
        if clear_output {
            clear_buffers(buffers);
        }
        let buffer = &buffers[0];
        let count = buffer.mDataByteSize as usize;
        let ptr = if count == 0 {
            NonNull::<u8>::dangling().as_ptr()
        } else {
            buffer.mData.cast::<u8>()
        };
        Some(InterleavedBytesBuffer {
            buffer: slice::from_raw_parts_mut(ptr, count),
            channels: buffer.mNumberChannels as usize,
        })
    }
}
unsafe impl<S: Sample> Data for NonInterleaved<S> {
    type Buffer<'a> = NonInterleavedBuffer<'a, S>;
    fn does_stream_format_match(stream: &StreamFormat) -> bool {
        valid_format::<S>(stream, true) && native_endian::<S>(stream)
    }
    unsafe fn from_input_proc_args<'a>(
        frames: u32,
        io_data: *mut sys::AudioBufferList,
        clear_output: bool,
    ) -> Option<Self::Buffer<'a>> {
        let buffers = checked_buffers::<S>(io_data, frames, false, mem::align_of::<S>())?;
        if clear_output {
            clear_buffers(buffers);
        }
        Some(NonInterleavedBuffer {
            buffers,
            frames: frames as usize,
            sample_format: PhantomData,
        })
    }
}
