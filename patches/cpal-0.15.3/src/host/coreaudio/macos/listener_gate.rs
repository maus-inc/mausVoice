//! Quiesce disconnect notifications before releasing a recorder stream.
use std::sync::Mutex;

pub(super) struct ListenerGate(Mutex<bool>);

impl ListenerGate {
    pub(super) fn new() -> Self {
        Self(Mutex::new(false))
    }

    pub(super) fn run(&self, callback: impl FnOnce()) {
        if let Ok(retired) = self.0.lock() {
            if !*retired {
                callback();
            }
        }
    }

    pub(super) fn retire(&self) -> Result<(), ()> {
        let mut retired = self.0.lock().map_err(|_| ())?;
        *retired = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::ListenerGate;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    #[test]
    fn retirement_waits_for_an_inflight_callback_and_rejects_later_callbacks() {
        let gate = Arc::new(ListenerGate::new());
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let callback_gate = Arc::clone(&gate);
        let callback = std::thread::spawn(move || {
            callback_gate.run(|| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            });
        });
        entered_rx.recv().unwrap();
        let (retired_tx, retired_rx) = mpsc::channel();
        let retiring_gate = Arc::clone(&gate);
        let retiring = std::thread::spawn(move || {
            retiring_gate.retire().unwrap();
            retired_tx.send(()).unwrap();
        });
        assert!(retired_rx.recv_timeout(Duration::from_millis(50)).is_err());
        release_tx.send(()).unwrap();
        callback.join().unwrap();
        retiring.join().unwrap();
        retired_rx.recv().unwrap();
        gate.run(|| panic!("retired notification ran"));
    }

    #[test]
    fn panic_leaves_retirement_unconfirmed() {
        let gate = ListenerGate::new();
        assert!(std::panic::catch_unwind(|| gate.run(|| panic!("callback panicked"))).is_err());
        assert!(gate.retire().is_err());
        gate.run(|| panic!("poisoned callback ran"));
    }
}
