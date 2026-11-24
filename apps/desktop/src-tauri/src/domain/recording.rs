use serde::Serialize;
use std::time::Duration;

pub const EVT_REC_LEVEL: &str = "recording_level";
pub const EVT_AUDIO_CHUNK: &str = "audio_chunk";

#[derive(Clone, Debug)]
pub struct RecordingMetrics {
    /// Duration of the audio that was actually captured.
    ///
    /// Derived from the sample count, not from the wall clock, so it shrinks when
    /// the stream dies early. That is the point: it is what the recording
    /// contains, and `expected_duration` beside it is what it should have
    /// contained, so the difference is visible rather than rounded away.
    ///
    /// Two things stop that being true in every case, and both are deliberate.
    /// When the capture produced no live samples there is no sample-derived
    /// length, so this falls back to the wall clock and the two figures are equal
    /// even though nothing was captured after the press. A zero here would read
    /// as a recording that lasted no time rather than a failure; capture status
    /// and any reported fault distinguish those cases. Audio captured before the
    /// press is never credited toward the measured duration.
    pub duration: Duration,
    /// Whether `duration` measures live PCM rather than the elapsed fallback.
    pub has_live_samples: bool,
    /// How long the recorder believed it was recording.
    ///
    /// Equal to `live_duration()` on a healthy capture. A large gap means the stream
    /// stopped delivering partway through, which is the case that otherwise
    /// produces a silently short dictation with no indication that anything went
    /// wrong.
    pub expected_duration: Duration,
    pub size_bytes: u64,
    /// The capture fault that ended the stream, token form (`fatal`), if one was
    /// reported by the host. `None` means no fault was reported, which is not
    /// the same as "everything was fine": a stream can also go quiet without
    /// saying so, and `expected_duration` covers that.
    pub capture_fault: Option<String>,
}

impl RecordingMetrics {
    /// Live PCM duration, without the elapsed fallback used in diagnostics.
    pub fn live_duration(&self) -> Duration {
        if self.has_live_samples {
            self.duration
        } else {
            Duration::ZERO
        }
    }
}

#[derive(Clone, Debug)]
pub struct RecordedAudio {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

#[derive(Clone, Debug)]
pub struct RecordingResult {
    pub metrics: RecordingMetrics,
    pub audio: RecordedAudio,
    /// The captured prefix is available, but capture or physical release could
    /// not be confirmed. Consumers must not present it as a complete recording.
    pub capture_failed: bool,
}

#[derive(Clone, Serialize)]
pub struct RecordingLevelPayload {
    pub levels: Vec<f32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioChunkPayload {
    pub owner_id: String,
    pub generation: u64,
    pub samples: Vec<f32>,
    /// Index of the first sample in the recording, so listeners that attach
    /// after capture starts can align chunks with the final recording.
    /// Consumers need it to place the batch on an absolute timeline, and to
    /// detect a gap rather than silently renumbering a discontinuous stream as
    /// contiguous.
    pub offset: u64,
}
