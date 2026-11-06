# Holding the microphone open is opt-in, and the pre-roll is never what keeps it open

Date: 2026-11-06
Status: accepted

## Context

The delay between pressing the dictation key and the first captured sample is
dominated by opening the capture device. Measured on the development machines,
a cold start costs 5,260 ms end to end in the worst case and hundreds of
milliseconds typically, while a press that reuses an already-running stream
costs 43 ms. Users experience that difference as the pill feeling heavy: they
press, nothing happens, and the first word is gone.

Three things could close that gap, and they are not the same:

1. Keep a stream open between dictations, so a press only changes who receives
   the samples.
2. Keep it open for a few seconds after a recording stops, so a second press in
   the same thought is instant.
3. Resolve and score the device ahead of time, without opening it at all.

They differ in cost and in what the user sees. Option 1 keeps the operating
system's microphone-in-use indicator lit for the whole session, which reads to
a user as "this app is listening to me". Option 2 does the same for a few
seconds after each recording, so the indicator lingers after a dictation for
reasons the user did not ask for. Option 3 shows nothing at all, because
nothing captures.

There is also a separate question that got conflated with the first one during
development: how much audio from *before* the press to keep, so a word that
starts as the user presses is not clipped. That is a buffer length, not a
policy about whether a device stays open.

## Decision

**Holding the device open is opt-in and is a single number.**

`linger_ms` is the whole policy. `0` closes the device at stop and is the
default, because it is the only value with no microphone indicator between
dictations and so the only one that needs no consent. A finite value is a
window that starts at stop and closes the stream when it expires. `u64::MAX` is
the sentinel for "hold until released", which is what the keep-ready preference
sends. A sentinel rather than a separate boolean means every reader interprets
one value instead of two that can disagree.

**The post-recording window is a separate, independently settable choice.**

`set_microphone_linger` sets `linger_ms` without opening anything, and the stop
path reads it when a recording ends. It defaults to `0`, so a user who never
touches it gets no indicator between dictations. Turning it on keeps the stream
from the recording that just finished open for the window, so a second dictation
in the same thought is instant. It is disabled in the settings while the keep-ready
preference is on, because that preference already holds the device indefinitely
and the window would have nothing to add.

**The pre-roll never decides whether a device stays open.**

`microphonePrerollSeconds` is a buffer length, bounded to 0-2 seconds. It does
not keep a stream open and its absence does not close one. Keeping audio from
before a press is only meaningful while a stream is running, but a stream is not
required by it, and a zero-second pre-roll on a held device is a supported and
useful configuration.

**A cold start prepends nothing.**

`cold_start_seed()` returns an empty seed and a zero-capacity stand-in ring. The
shared ring is filled by the warm stream's callback, so a cold start that
drained it put the same half second of speech into two consecutive recordings.
Only adopting a warm stream, or an explicit linger, leaves audio behind for the
next recording.

**One stream, whose consumer is swapped.**

`SinkMode` is `Discard`, `Warm { preroll }` or
`Recording { buffer, level, chunk }`, and a press changes which one the capture
callback feeds. A stream per recording would pay the device open every time,
which is the cost being removed.

**One owner on the frontend.**

`MicrophoneReadinessSideEffects` is the only caller of `warmMicrophone` and
`closeMicrophone`. It holds when the preference is on and nothing blocks it, and
releases when the preference goes off, a recording starts, permission is
revoked, or a local-data clear is requested. A second owner would be a second
place that could leave a device open.

**Preparing is always on.**

Resolving and scoring the device ahead of a press opens nothing, so it runs
regardless of the preference.

## Consequences

- A user who never touches the preference gets the cold path and sees no
  microphone indicator. They also get no benefit, which is the honest trade.
- A user who turns it on sees the indicator for the whole session. The copy in
  the dialog says so before the switch is flipped, not after.
- A stream stopped while paused is resumed before it is left warm. Leaving it
  paused would make the next press adopt a stream that delivers nothing, pay the
  staleness window, and then reopen cold, which is worse than the cold start the
  hold was meant to avoid.
- A paused or stopped sink reports no silence figure. Conflating either with a
  dead device reopened the device on a stop-then-start pair and lost the press
  that was already in flight.
- Changing the preferred device closes the held stream and reopens on the new
  one, rather than silently dropping the hold while the preference still says it
  is on.
- The measurement is part of the feature, not an afterthought: every start
  publishes `[audio-startup] total_ms=… reused=… <stage>=<us>…`, so a regression
  shows up as a number rather than as a feeling.
