# CPAL 0.15.3 recorder teardown fixes

This directory contains the CPAL 0.15.3 crate and its original license. The
crate archive has SHA-256
`873dab07c8f743075e57f524c583985fbaf745602acbe916a01539364369a779`.
The local fork declares Rust 1.77 because its checked CoreAudio buffer parsing
uses `std::mem::offset_of!`; the desktop pins Rust 1.88.

The CoreAudio change backports upstream commit
[02b454c02cc42910192739db03de7b384f50b9cf](https://github.com/RustAudio/cpal/commit/02b454c02cc42910192739db03de7b384f50b9cf),
merged in [PR 869](https://github.com/RustAudio/cpal/pull/869). It changes the
macOS disconnect listener to hold a weak stream reference. CPAL 0.15.3 otherwise
retains the stream, its audio unit, and its callbacks after the application drops
a non-default device stream.

A separate local CoreAudio change makes input stream construction return the
handle before starting capture. Callers use `play` to start it, consistent with
CPAL's cross-platform guidance. If start fails, a later `pause` still attempts to
stop the audio unit rather than assuming that the failed call had no effect.
Output construction is unchanged.

The local CoreAudio listener change replaces the raw callback pointer with a
monotonic token and a synchronized registry. Notifications already dispatched
when a listener is removed can resolve only a still-live callback, and an
in-flight callback retains its own reference. Removal retires the token even
when the system unregister operation fails. Notifications that resolve a
retired token are ignored; a notification that already acquired a callback may
still finish. This addresses the callback-lifetime risk described in
[JUCE PR 24](https://github.com/acondigital/JUCE/pull/24) and
[Cathode issue 129](https://github.com/Rikarin/Cathode/issues/129). The registry
coalesces overlapping or reentrant notifications to avoid concurrent `FnMut`
access and does not hold its map lock while invoking a callback. A separate
listener owner follows the public stream handles rather than the inner stream
reference a notification may temporarily hold. This prevents the final inner
reference alone from unregistering the listener inside its own callback. Before
a recorder stream is released, the desktop retires the listener gate and waits
for any disconnect callback that could hold an inner reference.

A separate macOS input callback registry uses monotonic tokens rather than raw
callback pointers. The recorder's release path and disconnect handler retire
the token and drain admitted callbacks before native stop. Checked close drains
again before disposal. A normal pause leaves the callback available for resume.
Callbacks that looked up the token before retirement but have not started are
disabled too. Input buffers remain owned by the callback
instead of reconstructing a vector from a possibly changed buffer length. The
registry uses mutexes, so a blocked callback or poisoned lock keeps recorder
ownership reserved. CPAL checks uninitialize and dispose through the accompanying
`coreaudio-rs` patch. A failure leaves the handle uncertain and prevents further
native use or retries. When audio unit initialization fails after creation,
the accompanying wrapper disposes the instance and reports an uncertain
cleanup if disposal fails. After a unit has been created, failed input setup
retires any installed callback and checks unit close; failed listener setup
also checks stream close. Uncertain cleanup leaks the resource and reports a
cleanup-uncertain error so the desktop keeps ownership reserved. Panics leave
the worker failed and ownership reserved rather than retrying uncertain native
teardown. The output and iOS backends still have unchecked teardown. Native
runtime and physical microphone testing remain necessary.

macOS format enumeration now queries the documented device buffer-size range
directly instead of creating a temporary input unit. This removes an unchecked
capture-unit teardown during device discovery. CoreAudio property output uses
writable, correctly sized storage; variable-length arrays and buffer lists are
aligned, initialized, and checked against the returned lengths. Device-name
CFStrings are released after copying. Sample-rate changes pass a single `f64`
with its actual size and accept rates inside a reported range. These changes
have portable bounds tests and a macOS cross-check, but have not been tested on
macOS hardware. In particular, a device may report a zero buffer-size range.

The local ALSA change reports input overruns to the stream error callback before
attempting the existing prepare operation. An overrun loses samples even if
recovery succeeds, so the desktop capture marks its retained prefix incomplete
instead of claiming a continuous recording. Recovery now serializes prepare
and explicit restart against pause and retirement. The ignored desktop test
`cpal_alsa_overrun_marks_the_captured_prefix_incomplete` exercises this path
with an ALSA null device and the test-only preload source in
`apps/desktop/src-tauri/tests/fixtures/alsa_xrun.c`. ALSA can also report an
XRUN through `POLLERR` or `readi`; CPAL enters the same recovery path for both.
The isolated `alsa_poll_xrun.c` and `alsa_read_xrun.c` fixtures cover these paths,
including a checked restart after a read overrun. These tests do not exercise a
physical microphone. ALSA capture also delivers only
the frames actually returned by `readi`, ignores transient `EAGAIN`/`EINTR`, and uses aligned worker storage
for typed input and output samples. The ignored short-read test uses
`tests/fixtures/alsa_short_read.c` with an isolated ALSA null device; the
playback alignment test also uses that device. These tests do not cover real
drivers. Capture start is deferred until `play`, after the caller owns the
stream; the worker waits until a successful start. The desktop retires and
joins that worker, then checks `snd_pcm_drop` before releasing ownership. A
failed start is stopped through the same path; an unconfirmed stop retains the
stream for a later retry, while a confirmed close reports `Ok` even when the
capture worker panicked. That panic is the consumer's failure, so it is
reported through `capture_worker_failed` and marks the recording incomplete;
turning it into a stop error made the recorder retain a handle whose retry
always failed, refusing every later recording. Both joins record a panicked
worker as a failure instead of unwrapping the join result, because the drop path
can run while another panic unwinds and unwrapping there aborts the process.
`snd_pcm_drop` discards pending device frames; the desktop has already sealed
its retained prefix at this point. The ALSA
preload tests `alsa_start_failure.c` and `alsa_stop_failure.c` exercise uncertain
start and repeated stop failures against the null device. After confirmed stop,
the local ALSA wrapper consumes the PCM and checks close; a failed close stays
uncertain and is never retried. The isolated `alsa_close_failure.c` fixture
checks this path. If ALSA capture setup fails after the PCM is acquired, CPAL
also checks close and returns a distinct cleanup-uncertain error on failure.
The desktop then reserves ownership because no handle remains to retry. The
`alsa_build_failure.c` fixture covers confirmed and uncertain close, including
the cached-device path. ALSA capture capability probes now close their handles
before returning instead of caching them in device objects. A process-wide gate
serializes probes, stream construction and checked capture close. Failed probe
or stream cleanup permanently blocks new capture and keeps desktop ownership
reserved. The test-only `alsa_probe_close_failure.c` fixture checks probe close
failure and a concurrent build waiting for a probe. These checks use ALSA's null
device, not a physical microphone. A blocked probe can delay stream construction
or close.

A capture stream also records that it owns a device for as long as it can hold
it, and device discovery refuses capture probes while one does. Opening a
second handle on a device a recording already holds contends for it, and a probe
whose close then fails would poison the gate that admits every later capture;
listing microphones during a recording must not be able to end the recording or
block the next one. Discovery reports capabilities as unavailable for that
device instead of opening it, and a device that a previous probe or admitted
stream already observed stays listed: capture-only devices are enumerated from
that observation rather than by reopening them. The ownership record is dropped
when a checked close begins and when an unstarted or abandoned stream is
dropped. A probe therefore runs again as soon as the recording owns no device.
An observation is also forgotten when the device refuses a capture open, from
either an admitted stream or a probe, so an unplugged or reclamed device stops
being listed from a stale observation; enumeration probes it again once no
stream is live.
The `cpal_alsa_discovery_during_recording_leaves_capture_running` test proves
with the probe-close fixture that discovery during a recording opens no capture
handle, leaves the gate confirmed, and lets the recording stop normally. Checked capture open also blocks later capture when a failed open
returns a non-null pointer or a successful open returns null. The test-only
`alsa_open_failure.c` fixture covers the former. A failed open with a null
pointer still relies on ALSA and its plugins to clean up internal resources.
Input pause checks the hardware capability and reports unsupported devices without
changing capture state. An opt-in ALSA draining pause prevents new read cycles and
waits for a previously admitted read and its callback before pausing the PCM. The
desktop uses this before closing its publication gate, so a delayed pre-pause read
cannot arrive after resume. A generation check also prevents a poll result from
before pause from triggering a read or XRUN recovery after resume. Stale XRUN and
disconnection reports still mark capture incomplete. The draining pause must not be
called from, or waited on by, the input callback. A blocked callback can block pause,
and the desktop keeps the owner reserved while the operation is pending. Native
transition failures mark the retained recording incomplete. The `alsa_delayed_callback.c`
fixture holds a read before callback delivery, and `alsa_stale_poll.c` delays a
poll result across pause and resume. Both use an isolated ALSA null device.
They do not replace physical-driver testing, and pause races on macOS and Windows
remain unresolved. The output worker keeps each callback buffer until ALSA
accepts its unwritten frames. It polls between writes and backs off on `EAGAIN`, `EINTR`, or zero
progress while still watching the termination pipe. Underrun recovery cannot
restore samples already lost by the device. The isolated `alsa_short_write.c`
fixture covers partial writes, transient errors, underrun and drop during a
permanent `EAGAIN`. A shared polling change reports `POLLHUP`, `POLLNVAL`,
or a disconnected PCM state once and exits the worker rather than silently
spinning; a failed capture stop still retains the stream for retry. The
`alsa_disconnect.c` fixture exercises both hangup and disconnected-state
capture paths. Capture also backs off on nonblocking reads that return
`EAGAIN`, `EINTR`, or zero, without delaying shutdown; the short-read fixture
covers persistent `EAGAIN` and zero reads. These tests do not cover physical
devices.

The WASAPI change is local: always join the stream thread and close its event
handle even if sending the termination command fails because the receiver has
already disconnected. A disconnected receiver alone does not prove that the
worker thread has finished teardown. The join records a worker panic instead of
re-raising it: both checked transitions already fail while the worker is dead,
so a caller never claims a successful release, and re-raising from `drop` would
abort the process when the drop runs during an unwind.
WASAPI `play` and `pause` now wait for the worker thread to apply the native
call before they return, so a caller cannot publish a transition the endpoint
has not made. Pausing capture delivers the packets the device already captured
to the callback before the stop and again after it, and the loop delivers no
callbacks while the stream is paused. A packet captured before a pause
therefore cannot surface after a later resume, which is the ordering the
desktop publication gate relies on. Transitions must be requested from a
control thread: blocking inside the data callback would wait for the thread
that has to answer. A failed stop leaves the stream marked as playing and
reports the error, because a failed native call can still change device state.

Capture packets are now handled defensively. The backend checks the packet
flags, so a packet marked `AUDCLNT_BUFFERFLAGS_SILENT` is delivered from
aligned scratch storage filled with the format's silence value rather than from
the driver's undefined memory; `u8` silence is 128, not 0. A packet that reports
`AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR` falls back to the audio clock instead of
timestamping with a position the driver said is invalid. `AUDCLNT_S_BUFFER_EMPTY`
is treated as the success it is: `GetBuffer` then leaves the buffer pointer and
frame count unwritten, so both are reset before every call and a packet with no
frames is skipped without a callback or a release. A packet that was acquired is
released on every later failure path, including a timestamp error, because a
capture client that still holds a packet rejects later calls with
`AUDCLNT_E_OUT_OF_ORDER` and would wedge the stream instead of reporting one
error. Render streams release an acquired packet as silence when the callback
cannot be reached, and a padding larger than the recorded buffer size can no
longer wrap the frame count. Position conversions report an error instead of
panicking on an out-of-range driver value.

Upstream tracks the silent-packet defect in [issue 1376](https://github.com/RustAudio/cpal/issues/1376);
[PR 1384](https://github.com/RustAudio/cpal/pull/1384) proposes broader checks but
was closed without merging. None of this is verified on Windows: the changed
code is type-checked for `x86_64-pc-windows-msvc`, and source-contract tests
assert the ordering and release decisions, but no Windows runtime, driver, or
physical device has exercised it.

Remove this patch only after upgrading CPAL and verifying named-device capture,
disconnection, and teardown on macOS and Windows. The desktop crate also receives
CPAL through `rodio`, so the Cargo patch applies to both users of the dependency.
Source-contract tests do not replace platform or physical-device testing.
