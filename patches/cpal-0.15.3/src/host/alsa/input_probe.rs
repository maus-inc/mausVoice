//! Serialize ALSA capture probes with stream construction and latch uncertain cleanup.
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

pub(super) struct CaptureGate {
    lock: Mutex<()>,
    uncertain: AtomicBool,
}

impl CaptureGate {
    pub(super) const fn new() -> Self {
        Self {
            lock: Mutex::new(()),
            uncertain: AtomicBool::new(false),
        }
    }

    pub(super) fn enter(&self) -> Result<CaptureGuard<'_>, ()> {
        let lock = self.lock.lock().map_err(|_| {
            self.uncertain.store(true, Ordering::SeqCst);
        })?;
        if self.uncertain.load(Ordering::SeqCst) {
            return Err(());
        }
        Ok(CaptureGuard {
            gate: self,
            _lock: lock,
            armed: false,
        })
    }

    pub(super) fn lock_for_cleanup(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|error| {
            self.mark_uncertain();
            error.into_inner()
        })
    }

    pub(super) fn is_uncertain(&self) -> bool {
        self.uncertain.load(Ordering::SeqCst)
    }

    pub(super) fn mark_uncertain(&self) {
        self.uncertain.store(true, Ordering::SeqCst);
    }
}

pub(super) struct CaptureGuard<'a> {
    gate: &'a CaptureGate,
    _lock: MutexGuard<'a, ()>,
    armed: bool,
}

impl CaptureGuard<'_> {
    /// Mark the period in which unwinding would leave cleanup unconfirmed.
    pub(super) fn arm(&mut self) {
        self.armed = true;
    }

    /// Call only after a checked close or transfer to an owned stream.
    pub(super) fn confirmed(&mut self) {
        self.armed = false;
    }

    pub(super) fn uncertain(&mut self) {
        self.gate.uncertain.store(true, Ordering::SeqCst);
        self.armed = false;
    }
}

impl Drop for CaptureGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.gate.uncertain.store(true, Ordering::SeqCst);
        }
    }
}

/// Number of capture streams this process currently owns.
///
/// Probing a capture device opens and closes a PCM. Doing that while a stream
/// is live contends for the device, can fail with `EBUSY` on hardware, and a
/// probe whose close fails poisons the gate that admits every later capture.
/// Device discovery therefore reports that capabilities are unavailable
/// instead of opening a device another live stream owns.
static LIVE_CAPTURE_STREAMS: AtomicUsize = AtomicUsize::new(0);

/// Device names a capture probe or an admitted stream has already opened.
static CAPTURE_CAPABLE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn capable_names() -> &'static Mutex<HashSet<String>> {
    CAPTURE_CAPABLE.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Whether any capture stream currently owns a device in this process.
pub(super) fn capture_stream_is_live() -> bool {
    LIVE_CAPTURE_STREAMS.load(Ordering::Acquire) > 0
}

/// Remember that `name` accepted a capture open.
pub(super) fn record_capture_capable(name: &str) {
    if let Ok(mut names) = capable_names().lock() {
        names.insert(name.to_owned());
    }
}

/// Forget a capability when a checked capture open reports a missing device.
///
/// The cache is only a previous observation: transient open failures and
/// failures after opening do not disprove it. Enumeration can probe again
/// once no capture stream is live.
pub(super) fn forget_capture_capable(name: &str) {
    if let Ok(mut names) = capable_names().lock() {
        names.remove(name);
    }
}

/// Whether a previous probe or stream already proved `name` can capture.
///
/// Enumeration uses this while a stream is live so a capture-only device stays
/// listed without opening it again.
pub(super) fn is_known_capture_capable(name: &str) -> bool {
    capable_names()
        .lock()
        .map(|names| names.contains(name))
        .unwrap_or(false)
}

/// Claimed by an owned capture stream for as long as it can hold the device.
pub(super) struct CaptureSlot(());

impl CaptureSlot {
    pub(super) fn claim() -> Self {
        LIVE_CAPTURE_STREAMS.fetch_add(1, Ordering::AcqRel);
        Self(())
    }
}

impl Drop for CaptureSlot {
    fn drop(&mut self) {
        // A slot is dropped exactly once, so this cannot underflow, but a
        // wrap-around would silently re-enable probing.
        let _ = LIVE_CAPTURE_STREAMS.fetch_update(Ordering::AcqRel, Ordering::Acquire, |live| {
            live.checked_sub(1)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{
        capture_stream_is_live, forget_capture_capable, is_known_capture_capable,
        record_capture_capable, CaptureGate, CaptureSlot,
    };
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    #[test]
    fn uncertain_cleanup_and_unwind_permanently_block_admission() {
        for panic in [false, true] {
            let gate = CaptureGate::new();
            let result = std::panic::catch_unwind(|| {
                let mut guard = gate.enter().unwrap();
                guard.arm();
                if panic {
                    panic!("probe panic");
                }
                guard.uncertain();
            });
            assert_eq!(result.is_err(), panic);
            assert!(gate.is_uncertain());
            assert!(gate.enter().is_err());
        }
    }

    #[test]
    fn checked_release_allows_the_next_admission() {
        let gate = CaptureGate::new();
        let mut guard = gate.enter().unwrap();
        guard.arm();
        guard.confirmed();
        drop(guard);
        assert!(!gate.is_uncertain());
        assert!(gate.enter().is_ok());
    }

    #[test]
    fn failure_from_an_active_stream_blocks_later_admission() {
        let gate = CaptureGate::new();
        let cleanup = gate.lock_for_cleanup();
        gate.mark_uncertain();
        drop(cleanup);
        assert!(gate.is_uncertain());
        assert!(gate.enter().is_err());
    }

    #[test]
    fn opening_waits_until_a_probe_has_finished_closing() {
        let gate = Arc::new(CaptureGate::new());
        let mut guard = gate.enter().unwrap();
        guard.arm();
        let (attempt_tx, attempt_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let other = Arc::clone(&gate);
        let worker = std::thread::spawn(move || {
            attempt_tx.send(()).unwrap();
            let accepted = other.enter().is_ok();
            done_tx.send(accepted).unwrap();
        });
        attempt_rx.recv().unwrap();
        assert!(done_rx.recv_timeout(Duration::from_millis(30)).is_err());
        guard.uncertain();
        drop(guard);
        assert!(!done_rx.recv_timeout(Duration::from_secs(1)).unwrap());
        worker.join().unwrap();
    }

    #[test]
    fn a_live_capture_stream_is_visible_until_the_last_claim_is_dropped() {
        assert!(!capture_stream_is_live());
        let first = CaptureSlot::claim();
        assert!(capture_stream_is_live());
        let second = CaptureSlot::claim();
        drop(first);
        assert!(capture_stream_is_live());
        drop(second);
        assert!(!capture_stream_is_live());
    }

    #[test]
    fn a_recorded_capability_survives_without_a_live_stream() {
        assert!(!is_known_capture_capable("maus-test-never-opened"));
        record_capture_capable("maus-test-never-opened");
        assert!(is_known_capture_capable("maus-test-never-opened"));
    }

    /// Explicit invalidation removes the observation used during recording.
    #[test]
    fn a_failed_open_forgets_a_recorded_capability() {
        record_capture_capable("maus-test-opened-then-failed");
        assert!(is_known_capture_capable("maus-test-opened-then-failed"));
        forget_capture_capable("maus-test-opened-then-failed");
        assert!(!is_known_capture_capable("maus-test-opened-then-failed"));
        // Forgetting an unknown name is a no-op.
        forget_capture_capable("maus-test-opened-then-failed");
        assert!(!is_known_capture_capable("maus-test-opened-then-failed"));
    }
}
