use std::sync::{Arc, Condvar, Mutex};

type Job = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct Pending {
    job: Option<Job>,
    closed: bool,
}

/// Delivers replaceable state updates in order without allowing a stalled sink
/// to block producers or build an unbounded queue. One job may be executing and
/// only the latest waiting job is retained.
pub struct LatestDispatcher {
    shared: Arc<(Mutex<Pending>, Condvar)>,
    running: bool,
}

impl LatestDispatcher {
    pub fn new(name: &str) -> Self {
        let shared = Arc::new((Mutex::new(Pending::default()), Condvar::new()));
        let worker_shared = Arc::clone(&shared);
        let running = std::thread::Builder::new()
            .name(name.into())
            .spawn(move || loop {
                let job = {
                    let (lock, wake) = &*worker_shared;
                    let mut state = lock.lock().unwrap_or_else(|error| error.into_inner());
                    while state.job.is_none() && !state.closed {
                        state = wake.wait(state).unwrap_or_else(|error| error.into_inner());
                    }
                    if state.closed {
                        return;
                    }
                    state.job.take()
                };
                if let Some(job) = job {
                    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)).is_err() {
                        log::error!("state event delivery panicked");
                    }
                }
            })
            .is_ok();
        Self { shared, running }
    }

    pub fn submit(&self, job: Job) -> bool {
        if !self.running {
            return false;
        }
        let (lock, wake) = &*self.shared;
        let mut state = lock.lock().unwrap_or_else(|error| error.into_inner());
        if state.closed {
            return false;
        }
        state.job = Some(job);
        wake.notify_one();
        true
    }
}

impl Drop for LatestDispatcher {
    fn drop(&mut self) {
        let (lock, wake) = &*self.shared;
        let mut state = lock.lock().unwrap_or_else(|error| error.into_inner());
        state.closed = true;
        state.job = None;
        wake.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::LatestDispatcher;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn a_blocked_sink_keeps_only_the_latest_pending_update() {
        let dispatcher = LatestDispatcher::new("latest-dispatch-test");
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (delivered_tx, delivered_rx) = mpsc::channel();
        let first_tx = delivered_tx.clone();
        assert!(dispatcher.submit(Box::new(move || {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            first_tx.send(1).unwrap();
        })));
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let second_tx = delivered_tx.clone();
        assert!(dispatcher.submit(Box::new(move || second_tx.send(2).unwrap())));
        assert!(dispatcher.submit(Box::new(move || delivered_tx.send(3).unwrap())));
        release_tx.send(()).unwrap();
        assert_eq!(
            delivered_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            1
        );
        assert_eq!(
            delivered_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            3
        );
        assert!(delivered_rx.try_recv().is_err());
    }
}
