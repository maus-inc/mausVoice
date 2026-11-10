use std::sync::mpsc::{self, SyncSender};
use std::sync::Arc;

use super::recording_ownership::RecordingAdmission;
use super::{ChunkCallback, LevelCallback};

/// A single bounded worker for callbacks that must not stall audio capture.
/// A blocked delivery consumes one thread and leaves at most `capacity` jobs
/// queued; callers must independently bound the size of each job.
pub struct EventDispatcher {
    sender: Option<SyncSender<Box<dyn FnOnce() + Send>>>,
}

impl EventDispatcher {
    pub fn new(name: &str, capacity: usize) -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Box<dyn FnOnce() + Send>>(capacity);
        let worker = std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                while let Ok(job) = receiver.recv() {
                    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)).is_err() {
                        log::error!("audio event delivery panicked");
                    }
                }
            });
        Self {
            sender: worker.ok().map(|_| sender),
        }
    }

    /// Returns false when the worker is unavailable or its queue is full.
    pub fn try_dispatch(&self, job: Box<dyn FnOnce() + Send>) -> bool {
        self.sender
            .as_ref()
            .is_some_and(|sender| sender.try_send(job).is_ok())
    }
}

/// Keep event delivery off the CPAL thread. The offset is never renumbered
/// when a job is dropped, allowing consumers to reject incomplete live audio.
pub fn bounded_chunk_callback(
    dispatcher: Arc<EventDispatcher>,
    deliver: ChunkCallback,
    max_samples: usize,
) -> ChunkCallback {
    Arc::new(move |samples, offset| {
        if samples.len() <= max_samples {
            let deliver = Arc::clone(&deliver);
            // A failed enqueue intentionally leaves a gap. Do not log on the
            // capture thread: log sinks themselves can block.
            let _ = dispatcher.try_dispatch(Box::new(move || deliver(samples, offset)));
        }
    })
}

/// Levels are replaceable visual data. Admission is checked both before
/// enqueueing and before delivery, but an already-running IPC cannot be
/// retracted after a handoff; receivers need an owner epoch for that case.
pub fn bounded_level_callback(
    dispatcher: Arc<EventDispatcher>,
    admission: Arc<RecordingAdmission>,
    deliver: LevelCallback,
) -> LevelCallback {
    Arc::new(move |levels| {
        if levels.len() > 64 {
            return;
        }
        admission.with_active_level_callback(|| {
            let admission = Arc::clone(&admission);
            let deliver = Arc::clone(&deliver);
            let _ = dispatcher.try_dispatch(Box::new(move || {
                if admission.level_callback_is_active() {
                    deliver(levels);
                }
            }));
        });
    })
}

#[cfg(test)]
mod tests {
    use super::{bounded_chunk_callback, bounded_level_callback, EventDispatcher};
    use crate::platform::recording_ownership::{
        start_idle_admission, RecordingOwnership, StartControl,
    };
    use std::sync::atomic::AtomicBool;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    #[test]
    fn stalled_delivery_is_bounded_and_does_not_block_the_producer() {
        let dispatcher = EventDispatcher::new("event-dispatch-test", 1);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (delivered_tx, delivered_rx) = mpsc::channel();
        assert!(dispatcher.try_dispatch(Box::new(move || {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            delivered_tx.send(1).unwrap();
        })));
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let (next_tx, next_rx) = mpsc::channel();
        assert!(dispatcher.try_dispatch(Box::new(move || next_tx.send(2).unwrap())));
        assert!(!dispatcher.try_dispatch(Box::new(|| panic!("overflow was queued"))));
        release_tx.send(()).unwrap();
        assert_eq!(
            delivered_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            1
        );
        assert_eq!(next_rx.recv_timeout(Duration::from_secs(1)).unwrap(), 2);
    }

    #[test]
    fn chunk_callback_never_blocks_and_preserves_offsets_on_overflow() {
        let dispatcher = Arc::new(EventDispatcher::new("chunk-callback-test", 1));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = std::sync::Mutex::new(release_rx);
        let (delivered_tx, delivered_rx) = mpsc::channel();
        let callback = bounded_chunk_callback(
            dispatcher,
            Arc::new(move |samples, offset| {
                if offset == 0 {
                    entered_tx.send(()).unwrap();
                    release_rx.lock().unwrap().recv().unwrap();
                }
                delivered_tx.send((samples, offset)).unwrap();
            }),
            2,
        );
        callback(vec![1.0], 0);
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        callback(vec![2.0], 1);
        callback(vec![3.0], 2); // Queue full.
        callback(vec![9.0; 3], 3); // Per-job size limit.
        release_tx.send(()).unwrap();
        assert_eq!(
            delivered_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            (vec![1.0], 0)
        );
        assert_eq!(
            delivered_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            (vec![2.0], 1)
        );
        assert!(delivered_rx.try_recv().is_err());
    }

    #[test]
    fn blocked_level_delivery_does_not_hold_recording_ownership() {
        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(17);
        let generation = coordinator.reserve("old", &window).unwrap();
        let admission = start_idle_admission(&coordinator, "old", &window, generation);
        let dispatcher = Arc::new(EventDispatcher::new("level-callback-test", 1));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = std::sync::Mutex::new(release_rx);
        let (delivered_tx, delivered_rx) = mpsc::channel();
        let callback = bounded_level_callback(
            Arc::clone(&dispatcher),
            admission,
            Arc::new(move |levels| {
                if levels == [1.0] {
                    entered_tx.send(()).unwrap();
                    release_rx.lock().unwrap().recv().unwrap();
                }
                delivered_tx.send(levels).unwrap();
            }),
        );
        callback(vec![1.0]);
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        callback(vec![2.0]);
        // The worker is still blocked, but release and a successor start can
        // proceed; the queued old-owner level will be discarded on dequeue.
        let (stopped_tx, stopped_rx) = mpsc::channel();
        let stop_coordinator = Arc::clone(&coordinator);
        let stopper = std::thread::spawn(move || {
            stop_coordinator.stop("old", || (Ok(()), false)).unwrap();
            stopped_tx.send(()).unwrap();
        });
        if stopped_rx.recv_timeout(Duration::from_secs(1)).is_err() {
            release_tx.send(()).unwrap();
            stopper.join().unwrap();
            panic!("level delivery blocked recorder release");
        }
        stopper.join().unwrap();
        let next_generation = coordinator.reserve("next", &window).unwrap();
        let next = coordinator
            .claim_admission("next", &window, next_generation)
            .unwrap();
        coordinator
            .start(
                "next",
                &window,
                next_generation,
                StartControl {
                    cancelled: &AtomicBool::new(false),
                    admission: Some(&next),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                || true,
            )
            .unwrap();
        release_tx.send(()).unwrap();
        assert_eq!(
            delivered_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            vec![1.0]
        );
        // A barrier behind the queued callback proves it was inspected.
        let (barrier_tx, barrier_rx) = mpsc::channel();
        dispatcher
            .sender
            .as_ref()
            .unwrap()
            .send(Box::new(move || barrier_tx.send(()).unwrap()))
            .unwrap();
        barrier_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(delivered_rx.try_recv().is_err());
    }

    #[test]
    fn a_panicking_delivery_does_not_kill_the_worker() {
        let dispatcher = EventDispatcher::new("event-panic-test", 1);
        let (entered_tx, entered_rx) = mpsc::channel();
        assert!(dispatcher.try_dispatch(Box::new(move || {
            entered_tx.send(()).unwrap();
            panic!("simulated delivery panic");
        })));
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let (next_tx, next_rx) = mpsc::channel();
        assert!(dispatcher.try_dispatch(Box::new(move || next_tx.send(()).unwrap())));
        next_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    }
}
