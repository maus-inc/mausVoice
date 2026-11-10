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

**The pre-roll applies to a cold press too, and the copy says so.**

`set_microphone_preroll` is a policy-only command in the same shape as
`set_microphone_linger`: it opens nothing and applies to whichever path opens
next, so a press that has to open the device still honours the slider. The
dialog briefly carried a caveat saying the opposite -- that pre-roll "only
applies while the microphone is already open" -- written before that command
existed and left behind after it landed. A caption that tells a user their
setting does nothing is worse than no caption, because it is a claim about the
code that a later change can quietly falsify. The rule that follows: a caveat
must name the unit it is about (the device, the window, the buffer), and any
commit that changes that unit has to revisit every sentence describing it.

**Holding a Bluetooth microphone is a different bargain, and the dialog says so.**

On the built-in microphone the only cost of a hold is the operating system's
indicator. On a Bluetooth headset it is larger and invisible: the link is shared
and half-duplex, so while anything captures, macOS moves the headset from A2DP
to the hands-free profile. Playback drops to call quality and the headset's
battery drains for as long as the hold lasts. The switch's own copy promises the
indicator, which is true and not the whole cost, so a separate warning appears
under the switch whenever the selected device's name looks like a headset.

The descriptor carries a `bluetooth` flag alongside `caution`, and they are not
the same verdict. `caution` is a *ranking* judgement -- this device will sound
worse than an alternative, so prefer another -- and the selector renders it as
"May provide lower audio quality". `bluetooth` is a *cost* judgement about the
device the user has already chosen. A device can be the right one to pick and
still carry the hold cost, so one flag could not carry both.

It is still a name heuristic underneath, because cpal exposes no transport and
CoreAudio, ALSA and WASAPI each spell the same headset differently. That is why
it only ever *adds* a sentence and never changes behaviour: a false positive
costs a line of copy, and a false negative costs an unexplained battery drain.

Two corrections came out of building it. The keyword list lived inside the cpal
module, so the PulseAudio lister could not reach it and built every Linux
descriptor with `caution: false` and no Bluetooth flag at all -- on the platform
where a headset is the common case. It is hoisted to the module now and both
listers use it. And the frontend keeps a label-based fallback for the one case
the flag cannot answer: the preference stores a label, and the device it names
may be unplugged, so there is no descriptor to read.

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
`closeMicrophone`, and only in the main window. `Root` renders it in every
window, so the component returns before deciding anything when
`isMainLocalDataWindow()` is false: a floating window would otherwise release the
stream the main window holds, on mount or on a re-render that changes its own
copy of the decision. Every other window reads the state back through
`microphoneReady`.

It holds when the preference is on and nothing blocks it, and releases when the
preference goes off, permission is revoked, or a local-data clear is requested. A second owner would be a second place that could leave a
device open.

A recording does not release it. `start_recording` adopts the held stream, and
this component returns before deciding anything while `isRecording` is true, so
the device stays open and the stop path decides what becomes of it. Releasing on
record was tried and is wrong twice over: it closed the stream the press had
just adopted, and `closeMicrophone` also zeroes the linger window the stop path
reads, so every dictation paid the device open that keep-ready exists to avoid
and the indicator blinked for the whole cycle. The rule is that the stream has
one owner at a time: the component while idle, the recording while capturing.

**Preparing is always on.**

Resolving and scoring the device ahead of a press opens nothing, so it runs
regardless of the preference.

**A hold is only ready when it has delivered a block.**

Opening a device and calling `play` does not prove a microphone works; only a
block arriving does. A stream that has delivered nothing within 250 ms of
opening is treated as broken and retired, so the press records cold rather than
recording silence, and `microphone_ready` reports the truth rather than the
existence of an object.

**The pre-roll is collected by cold starts too.**

A recording sizes the shared ring from its own device rate before its stream
starts capturing, whatever opened it. Sizing only on the warm path left the ring
at capacity zero for every cold start, which made the pre-roll do nothing for the
default configuration. The ring rounds its capacity up so a whole device buffer
fits, because it is filled one callback at a time and a capacity a fraction
short drops a block rather than a sample.

**Failure is visible once.**

The setting promises an instant press. When the hold cannot open, the user is
told once, and told again only after a success in between, because a device that
stays unplugged must not produce a message on every focus. A blocked permission
is called out with the fix in it, because it is the one failure the user can
resolve and the one that is otherwise completely silent.

**One device, many windows.**

Only the main window retries on focus and only the main window broadcasts; every
window re-reads the preference on focus and when the broadcast arrives. A window
that closed its own device because its copy of the preference said off, while
another window said on, was worse than a stale caption.

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
