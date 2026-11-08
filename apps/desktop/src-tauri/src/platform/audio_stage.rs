//! Stage timing for one capture start.
//!
//! A press that feels slow has several possible causes: the command crossing
//! the IPC boundary, the device enumeration and scoring, `build_input_stream`,
//! `Stream::play`, or the wait for the first block to arrive from the driver.
//! Guessing between them is how the wrong thing gets optimised for a release,
//! so each start is timed stage by stage and published as one log line.
//!
//! Two clocks are involved and they must not be confused. The trace origin is
//! when the start entered the backend, so every stage measured against it is
//! time this process spent. The first captured block is measured by the
//! capture callback against the instant the stream was subscribed, because a
//! stream that was reused for this press started long before the trace did and
//! subtracting the two origins would produce a number that is not a duration
//! of anything.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// One measured point in a capture start.
///
/// Ordered by when they happen on a cold start. `StreamReused` replaces
/// `StreamBuilt` and `StreamStarted` on a warm one, because neither of those
/// happened: the device was already open.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum AudioStartupStage {
    /// The start command reached the recording backend.
    CommandEntered,
    /// A device was chosen, by cache hit or by scoring.
    DeviceResolved,
    /// `build_input_stream` returned a stream.
    StreamBuilt,
    /// `Stream::play` returned.
    StreamStarted,
    /// An already-running stream was adopted instead of a new one being built.
    StreamReused,
    /// The first block of audio reached the capture callback, measured on the
    /// callback's own clock and anchored to the stream subscription.
    FirstRawPcm,
}

impl AudioStartupStage {
    /// The name this stage carries in a log line.
    ///
    /// Short and stable, because these lines are read by people comparing two
    /// builds by eye and by the diagnostics export.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CommandEntered => "command",
            Self::DeviceResolved => "device",
            Self::StreamBuilt => "build",
            Self::StreamStarted => "play",
            Self::StreamReused => "reused",
            Self::FirstRawPcm => "first_pcm",
        }
    }
}

/// A stage and the offset from its trace's origin that it was marked at.
#[derive(Clone, Copy, Debug)]
pub struct StageMark {
    pub stage: AudioStartupStage,
    /// Offset from the trace origin.
    pub at: Duration,
    /// Offset from the previous mark, or from the origin for the first one.
    ///
    /// This is the number that answers "where did the time go": the absolute
    /// offsets show the shape of a start, and these show the cost of each step.
    pub since_previous: Duration,
}

/// What one capture start looked like, in a form a caller can read back.
#[derive(Clone, Debug)]
pub struct AudioStartupSummary {
    /// Offset of the last mark, which is the start's total on this clock.
    pub total: Duration,
    pub stages: Vec<StageMark>,
    /// True when this start adopted a stream instead of opening a device.
    pub reused: bool,
    /// The wait for the first block, measured on the callback's clock. Absent
    /// when no block had arrived by the time the start was published.
    pub first_pcm: Option<Duration>,
}

impl AudioStartupSummary {
    /// The offset a stage was marked at, if it was marked at all.
    pub fn stage_at(&self, stage: AudioStartupStage) -> Option<Duration> {
        self.stages
            .iter()
            .find(|mark| mark.stage == stage)
            .map(|mark| mark.at)
    }

    /// The cost of one stage, as the gap between it and the mark before it.
    pub fn stage_cost(&self, stage: AudioStartupStage) -> Option<Duration> {
        self.stages
            .iter()
            .find(|mark| mark.stage == stage)
            .map(|mark| mark.since_previous)
    }

    /// One log line describing the start.
    ///
    /// The absolute offsets are written in microseconds under the stage's own
    /// name, so a reader can paste a line into an issue without a legend, and
    /// the two headline numbers lead: how long the start took in this process,
    /// and whether a device had to be opened for it.
    pub fn log_line(&self, prefix: &str) -> String {
        let mut line = format!(
            "[{prefix}] total_ms={} reused={}",
            millis(self.total),
            self.reused
        );
        for mark in &self.stages {
            line.push_str(&format!(
                " {}_{}us",
                mark.stage.as_str(),
                mark.at.as_micros().min(u128::from(u64::MAX))
            ));
        }
        if let Some(first_pcm) = self.first_pcm {
            line.push_str(&format!(" first_pcm_wait_us={}", micros(first_pcm)));
        }
        line
    }
}

fn millis(duration: Duration) -> String {
    format!("{:.1}", duration.as_secs_f64() * 1_000.0)
}

fn micros(duration: Duration) -> u64 {
    duration.as_micros().min(u128::from(u64::MAX)) as u64
}

/// Collects the stage marks of one capture start.
///
/// A start can finish marking after it has already been published, because the
/// first captured block usually arrives after the command has returned. Marks
/// are therefore accepted out of order, deduplicated by stage, and the summary
/// is computed from whatever is present when it is asked for.
#[derive(Debug)]
pub struct AudioStartupTrace {
    origin: Instant,
    stages: Vec<StageMark>,
    reused: bool,
    /// The callback's own measure of the first block. Kept separate from the
    /// stage offsets because it is on a different clock.
    first_pcm: Arc<Mutex<Option<Duration>>>,
}

/// Shared so the capture callback can publish the first block into the trace of
/// the start that subscribed it, long after that start returned.
pub type SharedAudioStartupTrace = std::sync::Arc<Mutex<AudioStartupTrace>>;

impl AudioStartupTrace {
    /// Starts a trace whose origin is now.
    pub fn begin() -> Self {
        Self::begin_at(Instant::now())
    }

    /// Starts a trace with an explicit origin.
    ///
    /// Tests use this so their stage offsets are exact rather than
    /// approximately zero.
    pub fn begin_at(origin: Instant) -> Self {
        Self {
            origin,
            stages: Vec::new(),
            reused: false,
            first_pcm: Arc::new(Mutex::new(None)),
        }
    }

    /// Marks a stage at the current offset.
    ///
    /// The first mark for a stage wins. A retry after a device failure would
    /// otherwise overwrite the time the first attempt took, and a start that
    /// took two attempts to open is exactly the case worth seeing.
    pub fn mark(&mut self, stage: AudioStartupStage) {
        let at = self.origin.elapsed();
        self.mark_at(stage, at);
    }

    /// Marks a stage at an explicit offset from the trace origin.
    pub fn mark_at(&mut self, stage: AudioStartupStage, at: Duration) {
        if self.stages.iter().any(|mark| mark.stage == stage) {
            return;
        }
        let since_previous = self
            .stages
            .last()
            .map(|previous| at.saturating_sub(previous.at))
            .unwrap_or(at);
        self.stages.push(StageMark {
            stage,
            at,
            since_previous,
        });
    }

    /// Marks a stage relative to another stage instead of to the origin.
    ///
    /// Used for the first captured block, which is measured from the stream
    /// subscription rather than from the start of the command. The reference
    /// stage's offset is added to the supplied measure so the mark still lands
    /// on the same timeline as the rest, and so a reader sees the first block
    /// arriving just after `play` rather than at a negative offset.
    ///
    /// Returns the offset it settled on, or `None` when the reference stage was
    /// never marked, in which case the mark is dropped rather than placed at a
    /// made-up position.
    pub fn mark_relative_to(
        &mut self,
        stage: AudioStartupStage,
        reference: AudioStartupStage,
        offset: Duration,
    ) -> Option<Duration> {
        let reference_at = self.stage_at(reference)?;
        let at = reference_at + offset;
        self.mark_at(stage, at);
        Some(at)
    }

    /// Records that the start adopted an already-running stream.
    pub fn note_reused(&mut self) {
        self.reused = true;
    }

    /// The offset a stage was marked at, if it has been marked yet.
    pub fn stage_at(&self, stage: AudioStartupStage) -> Option<Duration> {
        self.stages
            .iter()
            .find(|mark| mark.stage == stage)
            .map(|mark| mark.at)
    }

    /// Publishes the wait for the first captured block.
    ///
    /// Read from the sink's own signal rather than pushed by the callback: the
    /// callback already records when its first block arrived, and a second
    /// channel into the trace would be a second place for that fact to live.
    /// First one wins, for the same reason a stage does: a start that delivered
    /// its first block late and then a second block quickly is one slow start,
    /// not one fast one.
    pub fn note_first_pcm(&self, wait: Duration) {
        let mut slot = match self.first_pcm.lock() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        };
        if slot.is_none() {
            *slot = Some(wait);
        }
    }

    /// Snapshots the start as it stands.
    pub fn summary(&self) -> AudioStartupSummary {
        let total = self
            .stages
            .iter()
            .map(|mark| mark.at)
            .max()
            .unwrap_or_default();
        let first_pcm = match self.first_pcm.lock() {
            Ok(slot) => *slot,
            Err(poisoned) => *poisoned.into_inner(),
        };
        AudioStartupSummary {
            total,
            stages: self.stages.clone(),
            reused: self.reused,
            first_pcm,
        }
    }
}

use std::sync::Arc;

/// Fires once per recording, reporting how long after a reference point the
/// first block arrived.
///
/// The reference point is set by [`FirstPcmSignal::reset`], which the code calls
/// at the moment it wants measured: stream subscription for the device-open
/// cost, recording start for the press latency. The two are deliberately the
/// same type rather than two ad-hoc booleans, because "which clock am I on" is
/// the mistake that makes these numbers meaningless.
#[derive(Debug)]
pub struct FirstPcmSignal {
    fired: AtomicBool,
    at_us: AtomicU64,
}

impl Default for FirstPcmSignal {
    fn default() -> Self {
        Self::new()
    }
}

impl FirstPcmSignal {
    pub fn new() -> Self {
        Self {
            fired: AtomicBool::new(false),
            at_us: AtomicU64::new(0),
        }
    }

    /// Restarts the measurement, discarding any previous one.
    pub fn reset(&self) {
        self.fired.store(false, Ordering::Release);
        self.at_us.store(0, Ordering::Release);
    }

    /// Reports a block that arrived `elapsed` after the reference point.
    ///
    /// Returns the offset when this call is the first to report, so the caller
    /// logs it once, and `None` afterwards. The compare-exchange is what makes
    /// it once: two callback threads racing would otherwise both see `false`.
    pub fn fire(&self, elapsed: Duration) -> Option<Duration> {
        if self
            .fired
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return None;
        }
        if let Ok(micros) = u64::try_from(elapsed.as_micros()) {
            self.at_us.store(micros, Ordering::Release);
        }
        Some(elapsed)
    }

    /// The offset that was reported, if one has been.
    pub fn elapsed(&self) -> Option<Duration> {
        if !self.fired.load(Ordering::Acquire) {
            return None;
        }
        Some(Duration::from_micros(self.at_us.load(Ordering::Acquire)))
    }
}

#[cfg(test)]
mod tests {
    use super::{AudioStartupStage, AudioStartupTrace, FirstPcmSignal, StageMark};
    use std::time::{Duration, Instant};

    fn marked(marks: &[(AudioStartupStage, u64)]) -> AudioStartupTrace {
        let base = Instant::now();
        let mut trace = AudioStartupTrace::begin_at(base);
        for (stage, micros) in marks {
            trace.mark_at(*stage, Duration::from_micros(*micros));
        }
        trace
    }

    #[test]
    fn stages_keep_the_order_they_were_marked_in() {
        let trace = marked(&[
            (AudioStartupStage::CommandEntered, 5),
            (AudioStartupStage::DeviceResolved, 120),
            (AudioStartupStage::StreamBuilt, 900),
        ]);

        let stages: Vec<&str> = trace
            .summary()
            .stages
            .iter()
            .map(|mark| mark.stage.as_str())
            .collect();
        assert_eq!(stages, vec!["command", "device", "build"]);
    }

    #[test]
    fn a_stage_marked_twice_keeps_the_first_attempt() {
        let trace = marked(&[
            (AudioStartupStage::StreamBuilt, 900),
            (AudioStartupStage::StreamBuilt, 4_000),
        ]);

        // A retry after a failed device must not hide how long the first
        // attempt took, which is the number worth acting on.
        assert_eq!(
            trace.stage_at(AudioStartupStage::StreamBuilt),
            Some(Duration::from_micros(900))
        );
        assert_eq!(trace.summary().stages.len(), 1);
    }

    #[test]
    fn the_total_is_the_latest_mark_not_the_sum() {
        let trace = marked(&[
            (AudioStartupStage::CommandEntered, 5),
            (AudioStartupStage::DeviceResolved, 120),
            (AudioStartupStage::StreamStarted, 5_260),
        ]);

        // The marks are cumulative offsets on one clock, so a reader comparing
        // total against a wall clock sees the same number.
        assert_eq!(trace.summary().total, Duration::from_micros(5_260));
    }

    #[test]
    fn each_stage_carries_the_gap_from_the_previous_one() {
        let trace = marked(&[
            (AudioStartupStage::CommandEntered, 5),
            (AudioStartupStage::DeviceResolved, 125),
            (AudioStartupStage::StreamStarted, 5_265),
        ]);

        let summary = trace.summary();
        assert_eq!(
            summary.stage_cost(AudioStartupStage::CommandEntered),
            Some(Duration::from_micros(5))
        );
        assert_eq!(
            summary.stage_cost(AudioStartupStage::DeviceResolved),
            Some(Duration::from_micros(120))
        );
        // This gap is the whole point of the trace: 5.14 ms of it went into
        // opening the device, and the rest is everything else.
        assert_eq!(
            summary.stage_cost(AudioStartupStage::StreamStarted),
            Some(Duration::from_micros(5_140))
        );
    }

    #[test]
    fn the_log_line_names_every_stage_in_microseconds() {
        let trace = marked(&[
            (AudioStartupStage::CommandEntered, 5),
            (AudioStartupStage::StreamStarted, 5_260),
        ]);

        let line = trace.summary().log_line("audio-startup");

        assert!(line.starts_with("[audio-startup] total_ms="), "{line}");
        assert!(line.contains("reused=false"), "{line}");
        assert!(line.contains("command_5us"), "{line}");
        assert!(line.contains("play_5260us"), "{line}");
    }

    #[test]
    fn a_reused_start_says_so() {
        let base = Instant::now();
        let mut trace = AudioStartupTrace::begin_at(base);
        trace.note_reused();
        trace.mark_at(AudioStartupStage::StreamReused, Duration::from_micros(43));

        let line = trace.summary().log_line("audio-startup");

        // `reused=true` is the difference between a press that paid for a
        // device open and one that did not, so it leads the line.
        assert!(line.contains("reused=true"), "{line}");
        assert!(line.contains("reused_43us"), "{line}");
    }

    #[test]
    fn a_stage_that_was_never_marked_has_no_offset() {
        let trace = marked(&[(AudioStartupStage::CommandEntered, 5)]);

        assert_eq!(trace.stage_at(AudioStartupStage::StreamBuilt), None);
        assert_eq!(
            trace.summary().stage_cost(AudioStartupStage::StreamBuilt),
            None
        );
    }

    #[test]
    fn the_first_block_wait_is_recorded_once() {
        let trace = marked(&[(AudioStartupStage::StreamStarted, 500)]);

        // The wait is read off the sink and published when the start is
        // summarised, so the only race is two reads: the first must win, or a
        // slow start would be reported as whatever the last read said.
        trace.note_first_pcm(Duration::from_millis(11));
        trace.note_first_pcm(Duration::from_millis(240));

        assert_eq!(trace.summary().first_pcm, Some(Duration::from_millis(11)));
    }

    #[test]
    fn a_late_stage_keeps_the_gap_numbers_a_reader_expects() {
        let base = Instant::now();
        let mut trace = AudioStartupTrace::begin_at(base);
        trace.mark_at(AudioStartupStage::StreamStarted, Duration::from_millis(500));

        // The callback says the first block arrived 12 ms after the stream was
        // started, so the mark belongs at 512 ms, not at 12 ms.
        let at = trace.mark_relative_to(
            AudioStartupStage::FirstRawPcm,
            AudioStartupStage::StreamStarted,
            Duration::from_millis(12),
        );

        assert_eq!(at, Some(Duration::from_millis(512)));
        let summary = trace.summary();
        assert_eq!(
            summary.stage_at(AudioStartupStage::FirstRawPcm),
            Some(Duration::from_millis(512))
        );
        assert_eq!(
            summary.stage_cost(AudioStartupStage::FirstRawPcm),
            Some(Duration::from_millis(12))
        );
    }

    #[test]
    fn a_relative_mark_without_its_reference_is_dropped() {
        let mut trace = AudioStartupTrace::begin();
        trace.mark(AudioStartupStage::CommandEntered);

        // Anchoring to a stage that never happened would place the mark at a
        // position that means nothing, so it is not placed at all.
        assert_eq!(
            trace.mark_relative_to(
                AudioStartupStage::FirstRawPcm,
                AudioStartupStage::StreamStarted,
                Duration::from_millis(12),
            ),
            None
        );
        assert_eq!(trace.stage_at(AudioStartupStage::FirstRawPcm), None);
    }

    #[test]
    fn a_first_block_fires_once_and_reports_its_offset() {
        let signal = FirstPcmSignal::new();

        assert_eq!(signal.elapsed(), None);
        assert_eq!(
            signal.fire(Duration::from_micros(14)),
            Some(Duration::from_micros(14))
        );
        assert_eq!(signal.fire(Duration::from_micros(900)), None);
        assert_eq!(signal.elapsed(), Some(Duration::from_micros(14)));
    }

    #[test]
    fn resetting_a_first_block_signal_allows_a_new_measurement() {
        let signal = FirstPcmSignal::new();
        signal.fire(Duration::from_millis(5));

        signal.reset();

        // The next recording gets its own number instead of inheriting the
        // previous one, which would make a fast start look slow forever.
        assert_eq!(signal.elapsed(), None);
        assert_eq!(
            signal.fire(Duration::from_micros(43)),
            Some(Duration::from_micros(43))
        );
    }

    #[test]
    fn marks_are_ordered_by_stage_not_by_arrival() {
        // A stage marked late still carries its own offset, and the stage list
        // keeps insertion order, so a reader is not shown a sorted lie about
        // which happened first.
        let trace = marked(&[
            (AudioStartupStage::StreamStarted, 500),
            (AudioStartupStage::FirstRawPcm, 512),
        ]);
        let stages: Vec<StageMark> = trace.summary().stages;

        assert_eq!(stages[0].stage, AudioStartupStage::StreamStarted);
        assert_eq!(stages[1].stage, AudioStartupStage::FirstRawPcm);
        assert!(stages[0].at < stages[1].at);
    }
}
