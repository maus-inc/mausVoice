//! What to do about an error the capture callback reported.
//!
//! A cpal input stream reports errors asynchronously, on a thread of the host's
//! choosing, through the callback passed to `build_input_stream`. cpal 0.15 does
//! not say whether the stream is still alive when that callback runs, and it
//! differs by backend: an ALSA `poll()` timeout or an xrun is routine and cpal
//! keeps polling, while a device that went away ends the stream.
//!
//! The two mistakes this module exists to prevent, both of which appear in
//! real projects:
//!
//! - **Treating every error as fatal.** The stream is rebuilt on an error that
//!   was never fatal. On PipeWire's ALSA plugin the spurious-poll message
//!   arrives several times a second, so the capture thread rebuilds in a loop
//!   and never delivers a frame.
//! - **Treating every error as harmless.** The error is logged and the stream is
//!   left to deliver nothing. The recording then completes with silence and is
//!   reported as a success.
//!
//! So the classification has three outcomes rather than two: continue, retire
//! the stream and reopen, or fail. Matching is on the message text because cpal
//! 0.15 exposes no error kind — the string is what reaches the callback — and
//! each marker below is one of cpal's own renderings, read from the vendored
//! 0.15.3 source rather than recalled.

/// What the capture path should do after an error callback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamFault {
    /// The stream is still running; keep recording. Logged, not surfaced.
    Transient,
    /// The stream is gone. Retire it so the next press reopens rather than
    /// adopting a stream that will never deliver again.
    Fatal,
}

impl StreamFault {
    /// A short machine-stable token, for logs and for the status line.
    pub fn as_str(self) -> &'static str {
        match self {
            StreamFault::Transient => "transient",
            StreamFault::Fatal => "fatal",
        }
    }
}

/// Messages that mean the stream is still running.
///
/// Every one of these is a condition the host recovers from on its own and
/// reopens for. Rebuilding on them is the loop described in the module comment.
const TRANSIENT_MARKERS: &[&str] = &[
    // cpal's ALSA backend wording when `alsa::poll()` returns without an event.
    // Routine on PipeWire's ALSA plugin, and cpal maps it to "keep polling".
    //
    // The marker is the fragment cpal actually writes, and it deliberately
    // stops short of the backticks around `alsa::poll()`: writing the sentence
    // out in full means typing those backticks, and a list that has to contain
    // punctuation is one edit away from the bug this test caught — the marker
    // lost its backticks, no longer matched, and every spurious poll fell
    // through to the fatal default. That is a capture thread that rebuilds the
    // stream several times a second and delivers nothing.
    "spuriously returned",
    // The errno behind a temporary resource shortage, e.g. EAGAIN.
    "resource temporarily unavailable",
    // An xrun: the device overran or underran. The host has already recovered;
    // cpal's own documentation calls these non-terminal.
    "underrun",
    "overrun",
    "xrun",
    // cpal's own ALSA wording for a recoverable stream state.
    "broken pipe",
];

/// Messages that mean the stream is gone.
///
/// These are the cases the user notices: the device was unplugged, Bluetooth
/// dropped, the machine slept and woke, or the audio server restarted. The
/// prefixes are cpal's `StreamError`, `PlayStreamError` and `BuildStreamError`
/// renderings, which share wording.
const FATAL_MARKERS: &[&str] = &[
    // "The requested device is no longer available. For example, it has been
    // unplugged." and the `PlayStreamError` variant of the same.
    "no longer available",
    "not available",
    "invalidated",
    "unplugged",
    "disconnected",
    "device not found",
    "no such device",
];

/// Decides what an error callback means.
///
/// Transient is checked first, because an xrun message can also mention the
/// device ("device underrun") and reading it as fatal is the loop that breaks
/// capture on PipeWire. An unrecognised message is fatal: a rebuild that was not
/// needed costs one device open, and a stream that was never retired keeps
/// recording silence, which is the failure that reaches the user as a lost
/// dictation.
pub fn classify_stream_fault(message: &str) -> StreamFault {
    let haystack = message.to_ascii_lowercase();
    if TRANSIENT_MARKERS
        .iter()
        .any(|marker| haystack.contains(&marker.to_ascii_lowercase()))
    {
        return StreamFault::Transient;
    }
    if FATAL_MARKERS
        .iter()
        .any(|marker| haystack.contains(&marker.to_ascii_lowercase()))
    {
        return StreamFault::Fatal;
    }
    // Unknown text is fatal on purpose. See the doc comment.
    let _ = &haystack;
    StreamFault::Fatal
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_alsa_poll_timeout_does_not_retire_the_stream() {
        // The loop this module exists for: PipeWire's ALSA plugin produces this
        // several times a second, and treating it as fatal rebuilds the stream
        // continuously and captures nothing.
        assert_eq!(
            // The real wording, backticks included: this is what cpal's ALSA
            // backend puts in the error, and an earlier version of this test
            // used a tidy version without them, which passed while the marker
            // failed to match the message it existed for.
            classify_stream_fault("`alsa::poll()` spuriously returned"),
            StreamFault::Transient
        );
    }

    #[test]
    fn eagain_is_transient() {
        assert_eq!(
            classify_stream_fault("Resource temporarily unavailable (os error 11)"),
            StreamFault::Transient
        );
    }

    #[test]
    fn an_xrun_is_transient() {
        for message in [
            "input underrun",
            "buffer overrun detected",
            "ALSA xrun",
            "Broken pipe (os error 32)",
        ] {
            assert_eq!(
                classify_stream_fault(message),
                StreamFault::Transient,
                "{message} should be transient"
            );
        }
    }

    #[test]
    fn an_xrun_message_that_mentions_the_device_is_still_transient() {
        // Ordering, stated as a case: this message matches both lists if the
        // device wording is checked first, and reading it as fatal is the loop.
        assert_eq!(
            classify_stream_fault("device not available after underrun"),
            StreamFault::Transient
        );
    }

    #[test]
    fn cpal_device_loss_wording_is_fatal() {
        // Verbatim from cpal 0.15.3's Display impl for StreamError.
        assert_eq!(
            classify_stream_fault(
                "The requested device is no longer available. For example, it has been unplugged."
            ),
            StreamFault::Fatal
        );
        assert_eq!(
            classify_stream_fault("the device associated with the stream is no longer available"),
            StreamFault::Fatal
        );
    }

    #[test]
    fn invalidation_and_disconnection_are_fatal() {
        for message in [
            "stream invalidated",
            "device disconnected",
            "no such device",
            "device not found",
        ] {
            assert_eq!(
                classify_stream_fault(message),
                StreamFault::Fatal,
                "{message} should be fatal"
            );
        }
    }

    #[test]
    fn an_unrecognised_message_is_fatal_not_transient() {
        // The asymmetry is deliberate and is the opposite of the other
        // classifier in this crate: there, a wrong guess sends the user to close
        // an application that is not running. Here, a wrong "transient" leaves a
        // dead stream recording silence, so the unknown case has to retire.
        assert_eq!(
            classify_stream_fault("something the backend invented"),
            StreamFault::Fatal
        );
        assert_eq!(classify_stream_fault(""), StreamFault::Fatal);
    }

    #[test]
    fn the_message_as_cpal_renders_it_is_what_is_matched() {
        // cpal does not hand the callback the bare description: a
        // `BackendSpecificError` is displayed as "A backend-specific error has
        // occurred: {description}", and `&err.to_string()` is what the sink
        // receives. A marker tested only against the tidied-up description is a
        // marker that may not match anything at all, which already happened once
        // here.
        assert_eq!(
            classify_stream_fault(
                "A backend-specific error has occurred: `alsa::poll()` spuriously returned"
            ),
            StreamFault::Transient
        );
        assert_eq!(
            classify_stream_fault(
                "A backend-specific error has occurred: \"alsa::poll()\" returned POLLERR"
            ),
            StreamFault::Fatal,
            "POLLERR is a device that will not come back; only the timeout is routine"
        );
        assert_eq!(
            classify_stream_fault(
                "The requested device is no longer available. For example, it has been unplugged."
            ),
            StreamFault::Fatal
        );
    }

    #[test]
    fn matching_is_case_insensitive() {
        assert_eq!(
            classify_stream_fault("ALSA::POLL() SPURIOUSLY RETURNED"),
            StreamFault::Transient
        );
        assert_eq!(
            classify_stream_fault("Stream Invalidated"),
            StreamFault::Fatal
        );
    }

    #[test]
    fn tokens_are_stable() {
        assert_eq!(StreamFault::Transient.as_str(), "transient");
        assert_eq!(StreamFault::Fatal.as_str(), "fatal");
    }
}
