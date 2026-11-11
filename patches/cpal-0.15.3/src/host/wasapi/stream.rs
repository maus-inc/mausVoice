use super::windows_err_to_cpal_err;
use crate::traits::StreamTrait;
use crate::{
    BackendSpecificError, Data, InputCallbackInfo, OutputCallbackInfo, PauseStreamError,
    PlayStreamError, SampleFormat, StreamError,
};
use std::mem;
use std::ptr;
use std::sync::mpsc::{channel, Receiver, SendError, Sender};
use std::thread::{self, JoinHandle};
use windows::Win32::Foundation;
use windows::Win32::Foundation::WAIT_OBJECT_0;
use windows::Win32::Media::Audio;
use windows::Win32::System::SystemServices;
use windows::Win32::System::Threading;

#[path = "thread_priority.rs"]
mod thread_priority;
use thread_priority::boost_current_thread_priority;

pub struct Stream {
    /// The audio processing thread calling callbacks. Priority boost is best-effort.
    /// Option used for moving out in destructor.
    thread: Option<JoinHandle<()>>,

    // Commands processed by the `run()` method that is currently running.
    // `pending_scheduled_event` must be signalled whenever a command is added here, so that it
    // will get picked up.
    commands: Sender<Command>,

    // This event is signalled after a new entry is added to `commands`, so that the `run()`
    // method can be notified.
    pending_scheduled_event: Foundation::HANDLE,
}

struct RunContext {
    // Streams that have been created in this event loop.
    stream: StreamInner,

    // Handles corresponding to the `event` field of each element of `voices`. Must always be in
    // sync with `voices`, except that the first element is always `pending_scheduled_event`.
    handles: Vec<Foundation::HANDLE>,

    commands: Receiver<Command>,
}

// Once we start running the eventloop, the RunContext will not be moved.
unsafe impl Send for RunContext {}

/// A message for the worker thread that owns the native stream.
///
/// Every transition carries a reply channel, so `play` and `pause` return only
/// after the worker has applied the native call. Without the acknowledgement a
/// caller could publish a pause before `IAudioClient::Stop` had run, and a
/// packet captured before the pause could be delivered after a later resume.
pub enum Command {
    PlayStream(Sender<Result<(), BackendSpecificError>>),
    PauseStream(Sender<Result<(), BackendSpecificError>>),
    Terminate,
}

pub enum AudioClientFlow {
    Render {
        render_client: Audio::IAudioRenderClient,
    },
    Capture {
        capture_client: Audio::IAudioCaptureClient,
    },
}

pub struct StreamInner {
    pub audio_client: Audio::IAudioClient,
    pub audio_clock: Audio::IAudioClock,
    pub client_flow: AudioClientFlow,
    // Event that is signalled by WASAPI whenever audio data must be written.
    pub event: Foundation::HANDLE,
    // True if the stream is currently playing. False if paused.
    pub playing: bool,
    // Number of frames of audio data in the underlying buffer allocated by WASAPI.
    pub max_frames_in_buffer: u32,
    // Number of bytes that each frame occupies.
    pub bytes_per_frame: u16,
    // The configuration with which the stream was created.
    pub config: crate::StreamConfig,
    // The sample format with which the stream was created.
    pub sample_format: SampleFormat,
}

impl Stream {
    pub(crate) fn new_input<D, E>(
        stream_inner: StreamInner,
        mut data_callback: D,
        mut error_callback: E,
    ) -> Stream
    where
        D: FnMut(&Data, &InputCallbackInfo) + Send + 'static,
        E: FnMut(StreamError) + Send + 'static,
    {
        let pending_scheduled_event = unsafe {
            Threading::CreateEventA(None, false, false, windows::core::PCSTR(ptr::null()))
        }
        .expect("cpal: could not create input stream event");
        let (tx, rx) = channel();

        let run_context = RunContext {
            handles: vec![pending_scheduled_event, stream_inner.event],
            stream: stream_inner,
            commands: rx,
        };

        let thread = thread::Builder::new()
            .name("cpal_wasapi_in".to_owned())
            .spawn(move || run_input(run_context, &mut data_callback, &mut error_callback))
            .unwrap();

        Stream {
            thread: Some(thread),
            commands: tx,
            pending_scheduled_event,
        }
    }

    pub(crate) fn new_output<D, E>(
        stream_inner: StreamInner,
        mut data_callback: D,
        mut error_callback: E,
    ) -> Stream
    where
        D: FnMut(&mut Data, &OutputCallbackInfo) + Send + 'static,
        E: FnMut(StreamError) + Send + 'static,
    {
        let pending_scheduled_event = unsafe {
            Threading::CreateEventA(None, false, false, windows::core::PCSTR(ptr::null()))
        }
        .expect("cpal: could not create output stream event");
        let (tx, rx) = channel();

        let run_context = RunContext {
            handles: vec![pending_scheduled_event, stream_inner.event],
            stream: stream_inner,
            commands: rx,
        };

        let thread = thread::Builder::new()
            .name("cpal_wasapi_out".to_owned())
            .spawn(move || run_output(run_context, &mut data_callback, &mut error_callback))
            .unwrap();

        Stream {
            thread: Some(thread),
            commands: tx,
            pending_scheduled_event,
        }
    }

    #[inline]
    fn push_command(&self, command: Command) -> Result<(), SendError<Command>> {
        self.commands.send(command)?;
        unsafe {
            Threading::SetEvent(self.pending_scheduled_event).unwrap();
        }
        Ok(())
    }

    /// Queue a transition and wait for the worker to apply it.
    ///
    /// Blocking here is deliberate: the caller must not report a pause before
    /// the native stream has stopped, nor a resume before it has started. Call
    /// it from a control thread only. Calling it from the data callback would
    /// wait for the thread that has to answer.
    fn request(
        &self,
        command: impl FnOnce(Sender<Result<(), BackendSpecificError>>) -> Command,
    ) -> Result<(), BackendSpecificError> {
        let (reply_tx, reply_rx) = channel();
        if self.push_command(command(reply_tx)).is_err() {
            return Err(BackendSpecificError {
                description: "the WASAPI stream worker has exited".into(),
            });
        }
        reply_rx.recv().unwrap_or_else(|_| {
            Err(BackendSpecificError {
                description: "the WASAPI stream worker exited before acknowledging the command"
                    .into(),
            })
        })
    }
}

impl Drop for Stream {
    #[inline]
    fn drop(&mut self) {
        // A disconnected command receiver does not mean the worker's teardown
        // has finished. Always join before reporting that the stream is gone.
        let _ = self.push_command(Command::Terminate);
        let worker = self.thread.take();
        unsafe {
            let _ = Foundation::CloseHandle(self.pending_scheduled_event);
        }
        // A panicking worker already reported itself, and both checked
        // transitions return an error while it is dead, so a caller never
        // claims a successful release. Unwrapping the join here would panic
        // inside `drop`, which aborts the process when the drop runs during an
        // unwind.
        if let Some(worker) = worker {
            let _ = worker.join();
        }
    }
}

impl Stream {
    /// Pause capture after the worker has delivered every packet the device had
    /// already captured.
    ///
    /// Draining before and after the native stop is what keeps a packet that
    /// was captured before the pause from surfacing after a later resume. The
    /// caller must retire its own callback gate only after this returns; it
    /// must never call it from, or wait for it inside, the data callback.
    pub fn pause_input_and_drain(&self) -> Result<(), PauseStreamError> {
        self.request(Command::PauseStream)
            .map_err(|err| PauseStreamError::BackendSpecific { err })
    }
}

impl StreamTrait for Stream {
    fn play(&self) -> Result<(), PlayStreamError> {
        self.request(Command::PlayStream)
            .map_err(|err| PlayStreamError::BackendSpecific { err })
    }
    fn pause(&self) -> Result<(), PauseStreamError> {
        // Capture pauses drain pending packets first; render pauses just stop
        // the endpoint. The worker knows which flow it owns.
        self.pause_input_and_drain()
    }
}

impl Drop for StreamInner {
    #[inline]
    fn drop(&mut self) {
        unsafe {
            let _ = Foundation::CloseHandle(self.event);
        }
    }
}

// The result of processing one batch of queued commands.
enum CommandFlow {
    Continue,
    // A pause was dequeued. The worker loop owns the data callback needed to
    // drain capture packets, so it finishes the transition and replies.
    Pause(Sender<Result<(), BackendSpecificError>>),
    Break,
}

// Process any pending commands that are queued within the `RunContext`.
fn process_commands(run_context: &mut RunContext) -> Result<CommandFlow, StreamError> {
    // Process the pending commands.
    for command in run_context.commands.try_iter() {
        match command {
            Command::PlayStream(reply) => {
                if run_context.stream.playing {
                    let _ = reply.send(Ok(()));
                    continue;
                }
                match unsafe { run_context.stream.audio_client.Start() } {
                    Ok(()) => {
                        run_context.stream.playing = true;
                        let _ = reply.send(Ok(()));
                    }
                    Err(error) => {
                        // Report the failure to the caller that asked for the
                        // transition and to the error callback that ends the
                        // stream, without retrying a failed native call.
                        let error: StreamError = windows_err_to_cpal_err(error);
                        let _ = reply.send(Err(BackendSpecificError {
                            description: error.to_string(),
                        }));
                        return Err(error);
                    }
                }
            }
            Command::PauseStream(reply) => return Ok(CommandFlow::Pause(reply)),
            Command::Terminate => return Ok(CommandFlow::Break),
        }
    }

    Ok(CommandFlow::Continue)
}
// Wait for any of the given handles to be signalled.
//
// Returns the index of the `handle` that was signalled, or an `Err` if
// `WaitForMultipleObjectsEx` fails.
//
// This is called when the `run` thread is ready to wait for the next event. The
// next event might be some command submitted by the user (the first handle) or
// might indicate that one of the streams is ready to deliver or receive audio.
fn wait_for_handle_signal(handles: &[Foundation::HANDLE]) -> Result<usize, BackendSpecificError> {
    debug_assert!(handles.len() <= SystemServices::MAXIMUM_WAIT_OBJECTS as usize);
    let result = unsafe {
        Threading::WaitForMultipleObjectsEx(
            handles,
            false,               // Don't wait for all, just wait for the first
            Threading::INFINITE, // TODO: allow setting a timeout
            false,               // irrelevant parameter here
        )
    };
    if result == Foundation::WAIT_FAILED {
        let err = unsafe { Foundation::GetLastError() };
        let description = format!("`WaitForMultipleObjectsEx failed: {:?}", err);
        let err = BackendSpecificError { description };
        return Err(err);
    }
    // Notifying the corresponding task handler.
    let handle_idx = (result.0 - WAIT_OBJECT_0.0) as usize;
    if handle_idx >= handles.len() {
        let description =
            format!("`WaitForMultipleObjectsEx` returned an unknown handle index: {result:?}");
        let err = BackendSpecificError { description };
        return Err(err);
    }
    Ok(handle_idx)
}

// Get the number of available frames that are available for writing/reading.
fn get_available_frames(stream: &StreamInner) -> Result<u32, StreamError> {
    unsafe {
        let padding = stream
            .audio_client
            .GetCurrentPadding()
            .map_err(windows_err_to_cpal_err::<StreamError>)?;
        // A driver is allowed to report more padding than the size CPAL
        // recorded, and wrapping in that case would ask for a huge buffer.
        Ok(stream.max_frames_in_buffer.saturating_sub(padding))
    }
}

fn run_input(
    mut run_ctxt: RunContext,
    data_callback: &mut dyn FnMut(&Data, &InputCallbackInfo),
    error_callback: &mut dyn FnMut(StreamError),
) {
    boost_current_thread_priority();
    // Scratch storage for packets the driver reports as silent. It is reused
    // across packets so a silent period never allocates on the audio thread.
    let mut silence: Vec<u64> = Vec::new();

    loop {
        match process_commands_and_await_signal(&mut run_ctxt, error_callback) {
            Some(CommandFlow::Break) => break,
            Some(CommandFlow::Continue) => continue,
            Some(CommandFlow::Pause(reply)) => {
                pause_input(
                    &mut run_ctxt.stream,
                    data_callback,
                    error_callback,
                    &mut silence,
                    reply,
                );
                continue;
            }
            None => (),
        }
        if !run_ctxt.stream.playing {
            // The device event can still be signalled for a packet that was
            // captured before the native stop. A paused stream must not deliver
            // callbacks, or the pause boundary would leak.
            continue;
        }
        let capture_client = match run_ctxt.stream.client_flow {
            AudioClientFlow::Capture { ref capture_client } => capture_client.clone(),
            _ => unreachable!(),
        };
        match process_input(
            &run_ctxt.stream,
            &capture_client,
            data_callback,
            error_callback,
            &mut silence,
        ) {
            ControlFlow::Break => break,
            ControlFlow::Continue => continue,
        }
    }
}

fn run_output(
    mut run_ctxt: RunContext,
    data_callback: &mut dyn FnMut(&mut Data, &OutputCallbackInfo),
    error_callback: &mut dyn FnMut(StreamError),
) {
    boost_current_thread_priority();

    loop {
        match process_commands_and_await_signal(&mut run_ctxt, error_callback) {
            Some(CommandFlow::Break) => break,
            Some(CommandFlow::Continue) => continue,
            Some(CommandFlow::Pause(reply)) => {
                pause_output(&mut run_ctxt.stream, reply);
                continue;
            }
            None => (),
        }
        if !run_ctxt.stream.playing {
            continue;
        }
        let render_client = match run_ctxt.stream.client_flow {
            AudioClientFlow::Render { ref render_client } => render_client.clone(),
            _ => unreachable!(),
        };
        match process_output(
            &run_ctxt.stream,
            render_client,
            data_callback,
            error_callback,
        ) {
            ControlFlow::Break => break,
            ControlFlow::Continue => continue,
        }
    }
}

enum ControlFlow {
    Break,
    Continue,
}

fn process_commands_and_await_signal(
    run_context: &mut RunContext,
    error_callback: &mut dyn FnMut(StreamError),
) -> Option<CommandFlow> {
    // Process queued commands.
    match process_commands(run_context) {
        Ok(CommandFlow::Continue) => (),
        Ok(CommandFlow::Pause(reply)) => return Some(CommandFlow::Pause(reply)),
        Ok(CommandFlow::Break) => return Some(CommandFlow::Break),
        Err(err) => {
            error_callback(err);
            return Some(CommandFlow::Break);
        }
    };

    // Wait for any of the handles to be signalled. While the stream is paused,
    // only the command event is interesting: the device handle can stay
    // signalled by a packet that was captured before the stop, and waiting on
    // it would spin instead of blocking until the next transition.
    let handles = if run_context.stream.playing {
        &run_context.handles[..]
    } else {
        &run_context.handles[..1]
    };
    let handle_idx = match wait_for_handle_signal(handles) {
        Ok(idx) => idx,
        Err(err) => {
            error_callback(err.into());
            return Some(CommandFlow::Break);
        }
    };

    // If `handle_idx` is 0, then it's `pending_scheduled_event` that was signalled in
    // order for us to pick up the pending commands. Otherwise, a stream needs data.
    if handle_idx == 0 {
        return Some(CommandFlow::Continue);
    }

    None
}

// What one call to the capture client produced.
enum PacketFlow {
    /// No packet was pending, so nothing was acquired.
    Empty,
    /// A packet was delivered to the callback and released.
    Delivered,
    /// The capture client failed. The caller reports the error and stops.
    Failed(StreamError),
}

/// Take at most one packet from the capture client and hand it to the callback.
///
/// Every acquired packet is released on every path after `GetBuffer` succeeds.
/// A capture client that still holds a packet rejects later calls with
/// `AUDCLNT_E_OUT_OF_ORDER`, so returning early without releasing would wedge
/// the stream instead of reporting one error.
fn capture_next_packet(
    stream: &StreamInner,
    capture_client: &Audio::IAudioCaptureClient,
    data_callback: &mut dyn FnMut(&Data, &InputCallbackInfo),
    silence: &mut Vec<u64>,
) -> PacketFlow {
    unsafe {
        match capture_client.GetNextPacketSize() {
            Ok(0) => return PacketFlow::Empty,
            Ok(_) => (),
            Err(error) => return PacketFlow::Failed(windows_err_to_cpal_err(error)),
        }

        // `GetBuffer` can succeed with `AUDCLNT_S_BUFFER_EMPTY`, which leaves
        // both outputs unwritten. Reset them before every call and decide from
        // the values only after the call returned success.
        let mut buffer: *mut u8 = ptr::null_mut();
        let mut frames_available: u32 = 0;
        let mut flags: u32 = 0;
        let mut qpc_position: u64 = 0;
        if let Err(error) = capture_client.GetBuffer(
            &mut buffer,
            &mut frames_available,
            &mut flags,
            None,
            Some(&mut qpc_position),
        ) {
            return PacketFlow::Failed(windows_err_to_cpal_err(error));
        }

        if frames_available == 0 {
            // Nothing was acquired, so there is nothing to release.
            return PacketFlow::Empty;
        }
        if buffer.is_null() {
            return PacketFlow::Failed(
                BackendSpecificError {
                    description: format!(
                        "WASAPI capture returned {frames_available} frames without a buffer"
                    ),
                }
                .into(),
            );
        }

        let sample_format = stream.sample_format;
        let sample_size = sample_format.sample_size();
        let silent = flags & Audio::AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
        let timestamp_valid = flags & Audio::AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 == 0;

        // A silent packet holds undefined data, so the driver's memory must not
        // reach the callback. The scratch storage is 8-byte aligned, which
        // covers every sample format, and is filled with the format's silence
        // value rather than zero: `u8` silence is 128, not 0.
        let (data_ptr, data_len) = if silent {
            let bytes = frames_available as usize * stream.bytes_per_frame as usize;
            let words = bytes.div_ceil(mem::size_of::<u64>());
            silence.clear();
            silence.resize(words, 0);
            let scratch = std::slice::from_raw_parts_mut(
                silence.as_mut_ptr() as *mut u8,
                words * mem::size_of::<u64>(),
            );
            match sample_format {
                SampleFormat::U8 => scratch.fill(128),
                _ => scratch.fill(0),
            }
            (silence.as_mut_ptr() as *mut (), bytes / sample_size)
        } else {
            (
                buffer as *mut (),
                frames_available as usize * stream.bytes_per_frame as usize / sample_size,
            )
        };
        let data = Data::from_parts(data_ptr, data_len, sample_format);

        // `qpc_position` is in 100 nanosecond units and is meaningless when the
        // packet reports a timestamp error.
        let timestamp = match input_timestamp(stream, timestamp_valid.then_some(qpc_position)) {
            Ok(timestamp) => timestamp,
            Err(error) => {
                let release = capture_client.ReleaseBuffer(frames_available);
                return PacketFlow::Failed(match release {
                    Ok(()) => error,
                    Err(release_error) => windows_err_to_cpal_err(release_error),
                });
            }
        };
        let info = InputCallbackInfo { timestamp };
        data_callback(&data, &info);

        if let Err(error) = capture_client.ReleaseBuffer(frames_available) {
            return PacketFlow::Failed(windows_err_to_cpal_err(error));
        }
        PacketFlow::Delivered
    }
}

/// Deliver every packet the capture client already holds.
///
/// Bounded by the buffer size, because a driver that keeps reporting work must
/// not be able to wedge a pause. One buffer cannot hold more packets than
/// frames, and every packet carries at least one frame.
fn drain_capture(
    stream: &StreamInner,
    capture_client: &Audio::IAudioCaptureClient,
    data_callback: &mut dyn FnMut(&Data, &InputCallbackInfo),
    silence: &mut Vec<u64>,
) -> Option<StreamError> {
    for _ in 0..stream.max_frames_in_buffer.max(1) {
        match capture_next_packet(stream, capture_client, data_callback, silence) {
            PacketFlow::Delivered => continue,
            PacketFlow::Empty => return None,
            PacketFlow::Failed(error) => return Some(error),
        }
    }
    None
}

/// Apply a queued pause to a capture stream.
///
/// Pending packets are delivered before the stop and again after it, so a
/// packet the device captured before the pause cannot reach the callback after
/// a later resume. The reply is sent only once the native call has finished.
fn pause_input(
    stream: &mut StreamInner,
    data_callback: &mut dyn FnMut(&Data, &InputCallbackInfo),
    error_callback: &mut dyn FnMut(StreamError),
    silence: &mut Vec<u64>,
    reply: Sender<Result<(), BackendSpecificError>>,
) {
    if !stream.playing {
        let _ = reply.send(Ok(()));
        return;
    }

    let capture_client = match stream.client_flow {
        AudioClientFlow::Capture { ref capture_client } => capture_client.clone(),
        AudioClientFlow::Render { .. } => {
            let _ = reply.send(Err(BackendSpecificError {
                description: "WASAPI capture pause reached a render stream".into(),
            }));
            return;
        }
    };

    let mut failure = drain_capture(stream, &capture_client, data_callback, silence);
    match unsafe { stream.audio_client.Stop() } {
        Ok(()) => {
            stream.playing = false;
            // The engine can capture one more packet between the first drain
            // and the stop. Take it now, while the caller still treats the
            // stream as running.
            if failure.is_none() {
                failure = drain_capture(stream, &capture_client, data_callback, silence);
            }
        }
        Err(error) => {
            // A failed stop may still have changed device state, so the stream
            // stays marked as playing and the caller decides how to recover.
            let error: StreamError = windows_err_to_cpal_err(error);
            if failure.is_none() {
                failure = Some(error);
            }
        }
    }

    match failure {
        None => {
            let _ = reply.send(Ok(()));
        }
        Some(error) => {
            let reply_error = BackendSpecificError {
                description: error.to_string(),
            };
            error_callback(error);
            let _ = reply.send(Err(reply_error));
        }
    }
}

/// Apply a queued pause to a render stream. Audio already handed to the engine
/// stays with the engine; the position freezes until the next start.
fn pause_output(stream: &mut StreamInner, reply: Sender<Result<(), BackendSpecificError>>) {
    if !stream.playing {
        let _ = reply.send(Ok(()));
        return;
    }
    match unsafe { stream.audio_client.Stop() } {
        Ok(()) => {
            stream.playing = false;
            let _ = reply.send(Ok(()));
        }
        Err(error) => {
            let error: StreamError = windows_err_to_cpal_err(error);
            let _ = reply.send(Err(BackendSpecificError {
                description: error.to_string(),
            }));
        }
    }
}

// The loop for processing pending input data.
fn process_input(
    stream: &StreamInner,
    capture_client: &Audio::IAudioCaptureClient,
    data_callback: &mut dyn FnMut(&Data, &InputCallbackInfo),
    error_callback: &mut dyn FnMut(StreamError),
    silence: &mut Vec<u64>,
) -> ControlFlow {
    loop {
        match capture_next_packet(stream, capture_client, data_callback, silence) {
            PacketFlow::Delivered => continue,
            PacketFlow::Empty => return ControlFlow::Continue,
            PacketFlow::Failed(error) => {
                error_callback(error);
                return ControlFlow::Break;
            }
        }
    }
}

// The loop for writing output data.
fn process_output(
    stream: &StreamInner,
    render_client: Audio::IAudioRenderClient,
    data_callback: &mut dyn FnMut(&mut Data, &OutputCallbackInfo),
    error_callback: &mut dyn FnMut(StreamError),
) -> ControlFlow {
    // The number of frames available for writing.
    let frames_available = match get_available_frames(stream) {
        Ok(0) => return ControlFlow::Continue, // TODO: Can this happen?
        Ok(n) => n,
        Err(err) => {
            error_callback(err);
            return ControlFlow::Break;
        }
    };

    // Silence is the only safe release for a buffer the callback never filled.
    let silent = Audio::AUDCLNT_BUFFERFLAGS_SILENT.0 as u32;

    unsafe {
        let buffer = match render_client.GetBuffer(frames_available) {
            Ok(b) => b,
            Err(e) => {
                error_callback(windows_err_to_cpal_err(e));
                return ControlFlow::Break;
            }
        };

        if buffer.is_null() {
            // Release the acquired buffer as silence rather than leaving the
            // render client holding a packet, which would reject every later
            // call with `AUDCLNT_E_OUT_OF_ORDER`.
            let release = render_client.ReleaseBuffer(frames_available, silent);
            let error: StreamError = BackendSpecificError {
                description: "WASAPI render returned a null buffer".into(),
            }
            .into();
            error_callback(match release {
                Ok(()) => error,
                Err(release_error) => windows_err_to_cpal_err(release_error),
            });
            return ControlFlow::Break;
        }

        let data = buffer as *mut ();
        let len = frames_available as usize * stream.bytes_per_frame as usize
            / stream.sample_format.sample_size();
        let mut data = Data::from_parts(data, len, stream.sample_format);
        let sample_rate = stream.config.sample_rate;
        let timestamp = match output_timestamp(stream, frames_available, sample_rate) {
            Ok(ts) => ts,
            Err(err) => {
                // Release before reporting: the packet has not been filled, so
                // the engine must play silence instead of stale memory.
                let release = render_client.ReleaseBuffer(frames_available, silent);
                error_callback(match release {
                    Ok(()) => err,
                    Err(release_error) => windows_err_to_cpal_err(release_error),
                });
                return ControlFlow::Break;
            }
        };
        let info = OutputCallbackInfo { timestamp };
        data_callback(&mut data, &info);

        if let Err(err) = render_client.ReleaseBuffer(frames_available, 0) {
            error_callback(windows_err_to_cpal_err(err));
            return ControlFlow::Break;
        }
    }

    ControlFlow::Continue
}

/// Convert the given duration in frames at the given sample rate to a `std::time::Duration`.
fn frames_to_duration(frames: u32, rate: crate::SampleRate) -> std::time::Duration {
    let secsf = frames as f64 / rate.0 as f64;
    let secs = secsf as u64;
    let nanos = ((secsf - secs as f64) * 1_000_000_000.0) as u32;
    std::time::Duration::new(secs, nanos)
}

/// Use the stream's `IAudioClock` to produce the current stream instant.
///
/// Uses the QPC position produced via the `GetPosition` method.
fn stream_instant(stream: &StreamInner) -> Result<crate::StreamInstant, StreamError> {
    let mut position: u64 = 0;
    let mut qpc_position: u64 = 0;
    unsafe {
        stream
            .audio_clock
            .GetPosition(&mut position, Some(&mut qpc_position))
            .map_err(windows_err_to_cpal_err::<StreamError>)?;
    };
    // The `qpc_position` is in 100 nanosecond units. Convert it to nanoseconds.
    let qpc_nanos = qpc_position as i128 * 100;
    // A driver can return a position outside the representable range. Reporting
    // that as an error keeps a panic out of the audio thread.
    let instant =
        crate::StreamInstant::from_nanos_i128(qpc_nanos).ok_or_else(|| BackendSpecificError {
            description: "WASAPI clock position is outside the `StreamInstant` range".into(),
        })?;
    Ok(instant)
}

/// Produce the input stream timestamp.
///
/// `buffer_qpc_position` is the `qpc_position` returned via the `GetBuffer` call on the capture
/// client. It represents the instant at which the first sample of the retrieved buffer was
/// captured. It is `None` when the packet reported `AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR`, which
/// makes that position meaningless.
fn input_timestamp(
    stream: &StreamInner,
    buffer_qpc_position: Option<u64>,
) -> Result<crate::InputStreamTimestamp, StreamError> {
    let callback = stream_instant(stream)?;
    let capture = match buffer_qpc_position {
        Some(buffer_qpc_position) => {
            // The `qpc_position` is in 100 nanosecond units. Convert it to nanoseconds.
            let qpc_nanos = buffer_qpc_position as i128 * 100;
            crate::StreamInstant::from_nanos_i128(qpc_nanos).ok_or_else(|| {
                BackendSpecificError {
                    description: "WASAPI buffer position is outside the `StreamInstant` range"
                        .into(),
                }
            })?
        }
        // Fall back to the clock rather than timestamping the packet with a
        // position the driver has already told us is wrong.
        None => callback,
    };
    Ok(crate::InputStreamTimestamp { capture, callback })
}

/// Produce the output stream timestamp.
///
/// `frames_available` is the number of frames available for writing as reported by subtracting the
/// result of `GetCurrentPadding` from the maximum buffer size.
///
/// `sample_rate` is the rate at which audio frames are processed by the device.
///
/// TODO: The returned `playback` is an estimate that assumes audio is delivered immediately after
/// `frames_available` are consumed. The reality is that there is likely a tiny amount of latency
/// after this, but not sure how to determine this.
fn output_timestamp(
    stream: &StreamInner,
    frames_available: u32,
    sample_rate: crate::SampleRate,
) -> Result<crate::OutputStreamTimestamp, StreamError> {
    let callback = stream_instant(stream)?;
    let buffer_duration = frames_to_duration(frames_available, sample_rate);
    let playback = callback
        .add(buffer_duration)
        .ok_or_else(|| BackendSpecificError {
            description: "WASAPI playback instant is outside the `StreamInstant` range".into(),
        })?;
    Ok(crate::OutputStreamTimestamp { callback, playback })
}
