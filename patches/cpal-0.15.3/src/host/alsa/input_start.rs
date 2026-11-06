//! Serialize capture start, pause, read, recovery and retirement.
use std::sync::{Condvar, Mutex};

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Prepared,
    Started,
    Pausing,
    Paused,
    Failed,
    Retired,
}

struct Inner {
    state: State,
    cycle_active: bool,
    generation: u64,
}

pub(super) struct InputStart {
    state: Mutex<Inner>,
    changed: Condvar,
}

struct NotifyOnDrop<'a>(&'a Condvar);

impl Drop for NotifyOnDrop<'_> {
    fn drop(&mut self) {
        self.0.notify_all();
    }
}

/// Join a retired capture worker, recording a panic instead of propagating it.
///
/// The worker runs the consumer's data callback, so a panic there is that
/// consumer's failure to report, not a reason to abort the process from
/// `drop`. The checked stop and the drop path both call this, so a panicked
/// worker is recorded the same way in each.
pub(super) fn join_capture_worker(thread: std::thread::JoinHandle<()>, worker_failed: &mut bool) {
    if thread.join().is_err() {
        *worker_failed = true;
    }
}

/// Covers a worker read through delivery or error handling, not just readi.
pub(super) struct InputCycle<'a>(&'a InputStart);

impl Drop for InputCycle<'_> {
    fn drop(&mut self) {
        let mut inner = self
            .0
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        inner.cycle_active = false;
        if std::thread::panicking() && inner.state != State::Retired {
            inner.state = State::Failed;
        }
        self.0.changed.notify_all();
    }
}

impl InputStart {
    pub(super) fn new() -> Self {
        Self {
            state: Mutex::new(Inner {
                state: State::Prepared,
                cycle_active: false,
                generation: 0,
            }),
            changed: Condvar::new(),
        }
    }

    /// The first start happens before the worker can read from the device.
    pub(super) fn start(&self, start: impl FnOnce() -> Result<(), String>) -> Result<bool, String> {
        let mut inner = self
            .state
            .lock()
            .map_err(|_| "ALSA input state is poisoned")?;
        match inner.state {
            State::Prepared => {
                inner.state = State::Failed;
                let _notify = NotifyOnDrop(&self.changed);
                let result = start();
                if result.is_ok() {
                    inner.state = State::Started;
                }
                self.changed.notify_all();
                result.map(|()| true)
            }
            State::Started | State::Paused => Ok(false),
            State::Pausing => Err("ALSA input is pausing".into()),
            State::Failed => Err("ALSA input state is uncertain and must be retired".into()),
            State::Retired => Err("ALSA input has been retired".into()),
        }
    }

    pub(super) fn pause(&self, pause: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
        self.pause_impl(false, pause)
    }

    /// Prevent another read and wait for the current read's callback to finish.
    /// Callers must not invoke this from, or wait on it inside, that callback.
    pub(super) fn pause_draining(
        &self,
        pause: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        self.pause_impl(true, pause)
    }

    fn pause_impl(
        &self,
        drain: bool,
        pause: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let mut inner = self
            .state
            .lock()
            .map_err(|_| "ALSA input state is poisoned")?;
        match inner.state {
            State::Started => {
                // A readiness result from before this pause must never drive
                // a read or XRUN recovery after a later resume.
                inner.generation = match inner.generation.checked_add(1) {
                    Some(next) => next,
                    None => {
                        inner.state = State::Failed;
                        self.changed.notify_all();
                        return Err("ALSA input generation exhausted".into());
                    }
                };
                if drain {
                    inner.state = State::Pausing;
                    inner = self
                        .changed
                        .wait_while(inner, |inner| {
                            inner.state == State::Pausing && inner.cycle_active
                        })
                        .map_err(|_| "ALSA input state is poisoned")?;
                    if inner.state != State::Pausing {
                        return Err("ALSA input changed while pausing".into());
                    }
                }
                // A failed native call is not proof that the state did not change.
                inner.state = State::Failed;
                let _notify = NotifyOnDrop(&self.changed);
                let result = pause();
                if result.is_ok() {
                    inner.state = State::Paused;
                }
                self.changed.notify_all();
                result
            }
            State::Paused if drain => {
                inner = self
                    .changed
                    .wait_while(inner, |inner| {
                        inner.state == State::Paused && inner.cycle_active
                    })
                    .map_err(|_| "ALSA input state is poisoned")?;
                if inner.state == State::Paused {
                    Ok(())
                } else {
                    Err("ALSA input changed while draining".into())
                }
            }
            State::Paused => Ok(()),
            State::Pausing => Err("ALSA input is pausing".into()),
            State::Prepared => Err("ALSA input has not started".into()),
            State::Failed => Err("ALSA input state is uncertain and must be retired".into()),
            State::Retired => Err("ALSA input has been retired".into()),
        }
    }

    pub(super) fn resume(&self, resume: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
        let mut inner = self
            .state
            .lock()
            .map_err(|_| "ALSA input state is poisoned")?;
        match inner.state {
            State::Paused => {
                inner.state = State::Failed;
                let _notify = NotifyOnDrop(&self.changed);
                let result = resume();
                if result.is_ok() {
                    inner.state = State::Started;
                }
                self.changed.notify_all();
                result
            }
            State::Started => Ok(()),
            State::Pausing => Err("ALSA input is pausing".into()),
            State::Prepared => Err("ALSA input has not started".into()),
            State::Failed => Err("ALSA input state is uncertain and must be retired".into()),
            State::Retired => Err("ALSA input has been retired".into()),
        }
    }

    pub(super) fn running_generation(&self) -> Result<Option<u64>, ()> {
        let inner = self.state.lock().map_err(|_| ())?;
        Ok((inner.state == State::Started).then_some(inner.generation))
    }

    pub(super) fn begin_cycle(&self, generation: u64) -> Result<Option<InputCycle<'_>>, ()> {
        let mut inner = self.state.lock().map_err(|_| ())?;
        if inner.state != State::Started || inner.generation != generation {
            return Ok(None);
        }
        if inner.cycle_active {
            return Err(());
        }
        inner.cycle_active = true;
        Ok(Some(InputCycle(self)))
    }

    /// Serialize the native read with pause and retirement, but never hold this
    /// lock while invoking the consumer's callback.
    pub(super) fn read_if_running<T>(&self, read: impl FnOnce() -> T) -> Result<Option<T>, ()> {
        let inner = self.state.lock().map_err(|_| ())?;
        Ok(if inner.state == State::Started {
            Some(read())
        } else {
            None
        })
    }

    /// Recovery must not restart a stream after pause or retirement.
    pub(super) fn recover(
        &self,
        recover: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let mut inner = self
            .state
            .lock()
            .map_err(|_| "ALSA input state is poisoned")?;
        if inner.state != State::Started {
            return Ok(());
        }
        inner.state = State::Failed;
        recover()?;
        inner.state = State::Started;
        Ok(())
    }

    pub(super) fn wait_until_started(&self) -> bool {
        let inner = match self.state.lock() {
            Ok(inner) => inner,
            Err(_) => return false,
        };
        let inner = self.changed.wait_while(inner, |inner| {
            matches!(
                inner.state,
                State::Prepared | State::Pausing | State::Paused
            )
        });
        matches!(inner, Ok(inner) if inner.state == State::Started)
    }

    pub(super) fn retire(&self) -> Result<(), ()> {
        // A poisoned lock means a panic happened while the state was held, not
        // that the device must stay reserved. Refusing to retire would make the
        // caller retain a stream it can never release, so the state is retired
        // through the poison guard the way `retire_on_drop` already does.
        let mut inner = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        inner.state = State::Retired;
        self.changed.notify_all();
        Ok(())
    }

    pub(super) fn retire_on_drop(&self) {
        let mut inner = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        inner.state = State::Retired;
        self.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::{join_capture_worker, InputStart};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    /// A worker panic must not become a panic in `drop`, which aborts the
    /// process when the drop runs during an unwind.
    #[test]
    fn a_panicked_worker_is_recorded_rather_than_rethrown() {
        let mut worker_failed = false;
        join_capture_worker(
            std::thread::spawn(|| panic!("capture worker")),
            &mut worker_failed,
        );
        assert!(
            worker_failed,
            "a panicked capture worker must mark the stream failed"
        );

        worker_failed = false;
        join_capture_worker(std::thread::spawn(|| ()), &mut worker_failed);
        assert!(
            !worker_failed,
            "a worker that exited cleanly must not mark the stream failed"
        );
    }

    #[test]
    fn worker_waits_until_success_and_never_restarts() {
        let gate = Arc::new(InputStart::new());
        let (tx, rx) = mpsc::channel();
        let worker_gate = Arc::clone(&gate);
        let worker = std::thread::spawn(move || tx.send(worker_gate.wait_until_started()).unwrap());
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        assert!(gate.start(|| Ok(())).unwrap());
        assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap());
        assert!(!gate.start(|| panic!("cannot restart")).unwrap());
        worker.join().unwrap();
        gate.retire().unwrap();
        assert!(gate.start(|| Ok(())).is_err());
    }

    #[test]
    fn failed_or_panicked_start_never_admits_worker_and_can_be_retired() {
        for panic in [false, true] {
            let gate = Arc::new(InputStart::new());
            let (tx, rx) = mpsc::channel();
            let worker_gate = Arc::clone(&gate);
            let worker =
                std::thread::spawn(move || tx.send(worker_gate.wait_until_started()).unwrap());
            let attempt = std::panic::catch_unwind(|| {
                gate.start(|| {
                    if panic {
                        panic!("driver panic");
                    }
                    Err("driver error".into())
                })
            });
            if panic {
                assert!(attempt.is_err());
                gate.retire_on_drop();
            } else {
                assert!(attempt.unwrap().is_err());
                assert!(gate.start(|| Ok(())).is_err());
                gate.retire().unwrap();
            }
            assert!(!rx.recv_timeout(Duration::from_secs(1)).unwrap());
            worker.join().unwrap();
        }
    }

    #[test]
    fn a_poisoned_state_still_retires_so_the_device_can_be_released() {
        // The stop path retires before dropping the PCM. An error here made the
        // recorder keep a stream it could never release, so a panic that left
        // the state lock poisoned must not strand the microphone.
        let gate = Arc::new(InputStart::new());
        let poisoned = Arc::clone(&gate);
        let attempt = std::panic::catch_unwind(move || {
            let _held = poisoned.state.lock().unwrap();
            panic!("panic while the capture state is held");
        });
        assert!(attempt.is_err());
        assert!(gate.state.is_poisoned());
        gate.retire().expect("a poisoned state must still retire");
        assert!(gate.start(|| Ok(())).is_err());
    }

    #[test]
    fn pause_serializes_with_reads_and_blocks_recovery_until_resume() {
        let gate = Arc::new(InputStart::new());
        gate.start(|| Ok(())).unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker_gate = Arc::clone(&gate);
        let worker = std::thread::spawn(move || {
            worker_gate
                .read_if_running(|| {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                })
                .unwrap()
        });
        entered_rx.recv().unwrap();
        let paused_gate = Arc::clone(&gate);
        let (paused_tx, paused_rx) = mpsc::channel();
        let pause = std::thread::spawn(move || {
            paused_gate.pause(|| Ok(())).unwrap();
            paused_tx.send(()).unwrap();
        });
        assert!(paused_rx.recv_timeout(Duration::from_millis(30)).is_err());
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        paused_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        pause.join().unwrap();
        assert!(gate
            .read_if_running(|| panic!("read while paused"))
            .unwrap()
            .is_none());
        gate.recover(|| panic!("recovered while paused")).unwrap();
        gate.resume(|| Ok(())).unwrap();
        assert_eq!(gate.read_if_running(|| 42).unwrap(), Some(42));
        gate.retire().unwrap();
        gate.recover(|| panic!("recovered after retirement"))
            .unwrap();
    }

    #[test]
    fn failed_resume_wakes_a_paused_worker() {
        let gate = Arc::new(InputStart::new());
        gate.start(|| Ok(())).unwrap();
        gate.pause(|| Ok(())).unwrap();
        let (tx, rx) = mpsc::channel();
        let worker_gate = Arc::clone(&gate);
        let worker = std::thread::spawn(move || tx.send(worker_gate.wait_until_started()).unwrap());
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        assert!(gate.resume(|| Err("resume failed".into())).is_err());
        assert!(!rx.recv_timeout(Duration::from_secs(1)).unwrap());
        worker.join().unwrap();
    }

    #[test]
    fn recovery_finishes_before_pause_or_retirement_and_cannot_restart_afterward() {
        for retire in [false, true] {
            let gate = Arc::new(InputStart::new());
            gate.start(|| Ok(())).unwrap();
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let recovery_gate = Arc::clone(&gate);
            let recovery = std::thread::spawn(move || {
                recovery_gate
                    .recover(|| {
                        entered_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(())
                    })
                    .unwrap()
            });
            entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            let (finished_tx, finished_rx) = mpsc::channel();
            let transition_gate = Arc::clone(&gate);
            let transition = std::thread::spawn(move || {
                if retire {
                    transition_gate.retire().unwrap();
                } else {
                    transition_gate.pause(|| Ok(())).unwrap();
                }
                finished_tx.send(()).unwrap();
            });
            assert!(finished_rx.recv_timeout(Duration::from_millis(30)).is_err());
            release_tx.send(()).unwrap();
            recovery.join().unwrap();
            finished_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            transition.join().unwrap();
            gate.recover(|| panic!("cannot restart after pause or retirement"))
                .unwrap();
        }
    }

    fn wait_for_pausing(gate: &InputStart) {
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        loop {
            if gate.state.lock().unwrap().state == super::State::Pausing {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "pause did not enter drain"
            );
            std::thread::yield_now();
        }
    }

    #[test]
    fn readiness_observed_before_pause_cannot_drive_a_later_cycle() {
        let gate = InputStart::new();
        gate.start(|| Ok(())).unwrap();
        // The worker snapshots this before blocking in poll, then may be
        // delayed after it has obtained readiness or an XRUN result.
        let before_poll = gate.running_generation().unwrap().unwrap();
        gate.pause_draining(|| Ok(())).unwrap();
        gate.resume(|| Ok(())).unwrap();
        assert!(gate.begin_cycle(before_poll).unwrap().is_none());
        let after_resume = gate.running_generation().unwrap().unwrap();
        assert_ne!(before_poll, after_resume);
        assert!(gate.begin_cycle(after_resume).unwrap().is_some());
    }

    #[test]
    fn draining_pause_waits_for_a_read_delayed_before_delivery() {
        let gate = Arc::new(InputStart::new());
        gate.start(|| Ok(())).unwrap();
        assert_eq!(gate.running_generation().unwrap(), Some(0));
        let samples = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (read_tx, read_rx) = mpsc::channel();
        let (deliver_tx, deliver_rx) = mpsc::channel();
        let worker = {
            let gate = Arc::clone(&gate);
            let samples = Arc::clone(&samples);
            std::thread::spawn(move || {
                let _cycle = gate.begin_cycle(0).unwrap().unwrap();
                let sample = gate.read_if_running(|| 1).unwrap().unwrap();
                read_tx.send(()).unwrap();
                deliver_rx.recv().unwrap();
                samples.lock().unwrap().push(sample);
            })
        };
        read_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let (paused_tx, paused_rx) = mpsc::channel();
        let pause = {
            let gate = Arc::clone(&gate);
            let samples = Arc::clone(&samples);
            std::thread::spawn(move || {
                gate.pause_draining(|| {
                    assert_eq!(*samples.lock().unwrap(), vec![1]);
                    paused_tx.send(()).unwrap();
                    Ok(())
                })
                .unwrap();
            })
        };
        wait_for_pausing(&gate);
        assert!(gate.begin_cycle(0).unwrap().is_none());
        assert!(paused_rx.try_recv().is_err());
        deliver_tx.send(()).unwrap();
        worker.join().unwrap();
        paused_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        pause.join().unwrap();
        assert_eq!(gate.running_generation().unwrap(), None);
        gate.resume(|| Ok(())).unwrap();
        assert_eq!(gate.running_generation().unwrap(), Some(1));
        assert!(gate.begin_cycle(0).unwrap().is_none());
        let cycle = gate.begin_cycle(1).unwrap().unwrap();
        samples
            .lock()
            .unwrap()
            .push(gate.read_if_running(|| 2).unwrap().unwrap());
        drop(cycle);
        assert_eq!(*samples.lock().unwrap(), vec![1, 2]);
    }

    #[test]
    fn draining_an_already_paused_stream_still_waits_for_old_delivery() {
        let gate = Arc::new(InputStart::new());
        gate.start(|| Ok(())).unwrap();
        let cycle = gate.begin_cycle(0).unwrap().unwrap();
        gate.pause(|| Ok(())).unwrap();
        let (done_tx, done_rx) = mpsc::channel();
        let drain = {
            let gate = Arc::clone(&gate);
            std::thread::spawn(move || {
                gate.pause_draining(|| panic!("paused device called again"))
                    .unwrap();
                done_tx.send(()).unwrap();
            })
        };
        assert!(done_rx.recv_timeout(Duration::from_millis(30)).is_err());
        drop(cycle);
        done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        drain.join().unwrap();
    }

    #[test]
    fn retirement_interrupts_a_draining_pause_without_touching_the_device() {
        let gate = Arc::new(InputStart::new());
        gate.start(|| Ok(())).unwrap();
        let cycle = gate.begin_cycle(0).unwrap().unwrap();
        let pause = {
            let gate = Arc::clone(&gate);
            std::thread::spawn(move || gate.pause_draining(|| panic!("retired device touched")))
        };
        wait_for_pausing(&gate);
        gate.retire().unwrap();
        assert!(pause.join().unwrap().is_err());
        drop(cycle);
        assert!(!gate.wait_until_started());
    }

    #[test]
    fn panicked_delivery_cannot_complete_a_draining_pause() {
        let gate = Arc::new(InputStart::new());
        gate.start(|| Ok(())).unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (panic_tx, panic_rx) = mpsc::channel();
        let worker = {
            let gate = Arc::clone(&gate);
            std::thread::spawn(move || {
                let _cycle = gate.begin_cycle(0).unwrap().unwrap();
                ready_tx.send(()).unwrap();
                panic_rx.recv().unwrap();
                panic!("simulated callback failure");
            })
        };
        ready_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let pause = {
            let gate = Arc::clone(&gate);
            std::thread::spawn(move || gate.pause_draining(|| panic!("failed worker paused")))
        };
        wait_for_pausing(&gate);
        panic_tx.send(()).unwrap();
        assert!(worker.join().is_err());
        assert!(pause.join().unwrap().is_err());
        assert!(!gate.wait_until_started());
    }

    #[test]
    fn failed_pause_or_resume_blocks_reads_and_restarts() {
        for resume in [false, true] {
            let gate = InputStart::new();
            gate.start(|| Ok(())).unwrap();
            if resume {
                gate.pause(|| Ok(())).unwrap();
            }
            let error = if resume {
                gate.resume(|| Err("error".into()))
            } else {
                gate.pause(|| Err("error".into()))
            };
            assert!(error.is_err());
            assert!(gate
                .read_if_running(|| panic!("read after failure"))
                .unwrap()
                .is_none());
            gate.recover(|| panic!("recovery after failure")).unwrap();
            assert!(gate.start(|| Ok(())).is_err());
        }
    }
}
