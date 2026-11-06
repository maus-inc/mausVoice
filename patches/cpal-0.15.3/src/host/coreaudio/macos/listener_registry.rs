//! Lifetime-safe lookup for callbacks dispatched after a listener is removed.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

struct Callback {
    function: Mutex<Box<dyn FnMut() + Send>>,
    pending: AtomicBool,
}

fn callbacks() -> &'static Mutex<HashMap<usize, Arc<Callback>>> {
    static CALLBACKS: OnceLock<Mutex<HashMap<usize, Arc<Callback>>>> = OnceLock::new();
    CALLBACKS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn insert(callback: impl FnMut() + Send + 'static) -> Option<usize> {
    static NEXT: AtomicUsize = AtomicUsize::new(1);
    let id = NEXT
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .ok()?;
    callbacks()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(
            id,
            Arc::new(Callback {
                function: Mutex::new(Box::new(callback)),
                pending: AtomicBool::new(false),
            }),
        );
    Some(id)
}

pub(super) fn remove(id: usize) {
    let removed = callbacks()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&id);
    drop(removed);
}

pub(super) fn invoke(id: usize) {
    let callback = callbacks()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&id)
        .cloned();
    if let Some(callback) = callback {
        // Coalesce concurrent and reentrant notifications. The registry lock
        // is not held while user code runs, so a callback can retire itself.
        callback.pending.store(true, Ordering::SeqCst);
        loop {
            let Ok(mut function) = callback.function.try_lock() else {
                return;
            };
            while callback.pending.swap(false, Ordering::SeqCst) {
                let called = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    function();
                }));
                if called.is_err() {
                    remove(id);
                    return;
                }
            }
            drop(function);
            if !callback.pending.load(Ordering::SeqCst) {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{insert, invoke, remove};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread;

    #[test]
    fn late_callback_does_not_reach_a_new_listener() {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&calls);
        let old = insert(move || {
            observed.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        remove(old);
        let observed = Arc::clone(&calls);
        let next = insert(move || {
            observed.fetch_add(10, Ordering::SeqCst);
        })
        .unwrap();
        assert_ne!(old, next);
        invoke(old);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        invoke(next);
        assert_eq!(calls.load(Ordering::SeqCst), 10);
        remove(next);
    }

    #[test]
    fn remove_does_not_free_an_inflight_callback() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&calls);
        let id = insert(move || {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            observed.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        let worker = thread::spawn(move || invoke(id));
        entered_rx.recv().unwrap();
        remove(id);
        invoke(id);
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn overlapping_notifications_are_serialized_and_delivered() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&calls);
        let token = insert(move || {
            if observed.fetch_add(1, Ordering::SeqCst) == 0 {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            }
        })
        .unwrap();
        let worker = thread::spawn(move || invoke(token));
        entered_rx.recv().unwrap();
        invoke(token);
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        remove(token);
    }

    #[test]
    fn reentrant_notifications_are_coalesced_without_deadlock() {
        let id = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let observed_id = Arc::clone(&id);
        let observed_calls = Arc::clone(&calls);
        let token = insert(move || {
            if observed_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                invoke(observed_id.load(Ordering::SeqCst));
            }
        })
        .unwrap();
        id.store(token, Ordering::SeqCst);
        invoke(token);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        remove(token);
    }

    #[test]
    fn panicked_callback_is_retired() {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&calls);
        let id = insert(move || {
            observed.fetch_add(1, Ordering::SeqCst);
            panic!("callback failed");
        })
        .unwrap();
        invoke(id);
        invoke(id);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        remove(id);
    }

    #[test]
    fn callback_can_remove_itself_without_deadlock() {
        let id = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&id);
        let token = insert(move || remove(observed.load(Ordering::SeqCst))).unwrap();
        id.store(token, Ordering::SeqCst);
        invoke(token);
        invoke(token);
    }
}
