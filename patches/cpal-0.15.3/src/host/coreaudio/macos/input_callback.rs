//! Registry for input callbacks whose native refcon may arrive after removal.
use super::coreaudio::sys::{
    AudioBufferList, AudioTimeStamp, AudioUnitRenderActionFlags, OSStatus, UInt32,
};
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

type Callback = dyn FnMut(
        *mut AudioUnitRenderActionFlags,
        *const AudioTimeStamp,
        UInt32,
        UInt32,
        *mut AudioBufferList,
    ) -> OSStatus
    + Send;

struct Entry(Mutex<Option<Box<Callback>>>);

fn registry() -> &'static Mutex<HashMap<usize, Arc<Entry>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<usize, Arc<Entry>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) struct InputCallback {
    token: usize,
    entry: Arc<Entry>,
}

impl InputCallback {
    pub(super) fn new(
        callback: impl FnMut(
                *mut AudioUnitRenderActionFlags,
                *const AudioTimeStamp,
                UInt32,
                UInt32,
                *mut AudioBufferList,
            ) -> OSStatus
            + Send
            + 'static,
    ) -> Option<Self> {
        static NEXT: AtomicUsize = AtomicUsize::new(1);
        let token = NEXT
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .ok()?;
        let entry = Arc::new(Entry(Mutex::new(Some(Box::new(callback)))));
        registry()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(token, Arc::clone(&entry));
        Some(Self { token, entry })
    }

    pub(super) fn refcon(&self) -> *mut c_void {
        self.token as *mut c_void
    }

    fn unregister(&self) {
        let removed = registry()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.token);
        drop(removed);
    }

    /// Remove the token, wait for an admitted callback, and disable callbacks
    /// that acquired the entry before removal but have not run yet.
    pub(super) fn retire(&self) -> Result<(), ()> {
        self.unregister();
        let mut callback = self.entry.0.lock().map_err(|_| ())?;
        let retired = callback.take();
        drop(callback);
        drop(retired);
        Ok(())
    }
}

impl Drop for InputCallback {
    fn drop(&mut self) {
        // Even if a callback panicked, it has unwound before the mutex became
        // available. Removing the token makes late native invocations inert.
        self.unregister();
        let mut callback = self
            .entry
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let retired = callback.take();
        drop(callback);
        drop(retired);
    }
}

/// CoreAudio must supply valid callback arguments for the active unit.
pub(super) unsafe extern "C" fn trampoline(
    refcon: *mut c_void,
    flags: *mut AudioUnitRenderActionFlags,
    timestamp: *const AudioTimeStamp,
    bus: UInt32,
    frames: UInt32,
    data: *mut AudioBufferList,
) -> OSStatus {
    // Never unwind across CoreAudio's C boundary. A poisoned callback remains
    // unconfirmed at retirement, so the recorder keeps ownership reserved.
    std::panic::catch_unwind(|| {
        let entry = registry()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&(refcon as usize))
            .cloned();
        if let Some(entry) = entry {
            match entry.0.lock() {
                Ok(mut callback) => match callback.as_mut() {
                    Some(callback) => callback(flags, timestamp, bus, frames, data),
                    None => 0,
                },
                Err(_) => -1500,
            }
        } else {
            0
        }
    })
    .unwrap_or(-1500)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    fn call(token: usize) -> OSStatus {
        unsafe {
            trampoline(
                token as *mut c_void,
                std::ptr::null_mut(),
                std::ptr::null(),
                0,
                0,
                std::ptr::null_mut(),
            )
        }
    }

    #[test]
    fn retired_tokens_never_invoke_new_callbacks() {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&calls);
        let old = InputCallback::new(move |_, _, _, _, _| {
            observed.fetch_add(1, Ordering::SeqCst);
            17
        })
        .unwrap();
        let old_token = old.token;
        assert_eq!(call(old_token), 17);
        old.retire().unwrap();
        let observed = Arc::clone(&calls);
        let new = InputCallback::new(move |_, _, _, _, _| {
            observed.fetch_add(10, Ordering::SeqCst);
            19
        })
        .unwrap();
        assert_ne!(old_token, new.token);
        assert_eq!(call(old_token), 0);
        assert_eq!(call(new.token), 19);
        assert_eq!(calls.load(Ordering::SeqCst), 11);
    }

    #[test]
    fn retirement_drains_active_callback_and_disables_acquired_entries() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let handle = Arc::new(
            InputCallback::new(move |_, _, _, _, _| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                0
            })
            .unwrap(),
        );
        let token = handle.token;
        let acquired = registry().lock().unwrap().get(&token).unwrap().clone();
        let callback = std::thread::spawn(move || call(token));
        entered_rx.recv().unwrap();
        let retiring = Arc::clone(&handle);
        let (attempt_tx, attempt_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            attempt_tx.send(()).unwrap();
            retiring.retire().unwrap();
            done_tx.send(()).unwrap();
        });
        attempt_rx.recv().unwrap();
        assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());
        release_tx.send(()).unwrap();
        assert_eq!(callback.join().unwrap(), 0);
        thread.join().unwrap();
        done_rx.recv().unwrap();
        assert!(acquired.0.lock().unwrap().is_none());
        assert_eq!(call(token), 0);
    }

    #[test]
    fn callback_destructor_can_retire_again_without_deadlocking() {
        struct Reenter {
            owner: Arc<Mutex<std::sync::Weak<InputCallback>>>,
            done: mpsc::Sender<()>,
        }
        impl Drop for Reenter {
            fn drop(&mut self) {
                if let Some(owner) = self.owner.lock().unwrap().upgrade() {
                    owner.retire().unwrap();
                }
                self.done.send(()).unwrap();
            }
        }
        let owner = Arc::new(Mutex::new(std::sync::Weak::new()));
        let (done_tx, done_rx) = mpsc::channel();
        let cleanup = Reenter {
            owner: Arc::clone(&owner),
            done: done_tx,
        };
        let callback = Arc::new(
            InputCallback::new(move |_, _, _, _, _| {
                let _ = &cleanup;
                0
            })
            .unwrap(),
        );
        *owner.lock().unwrap() = Arc::downgrade(&callback);
        let other = Arc::clone(&callback);
        let thread = std::thread::spawn(move || other.retire().unwrap());
        done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        thread.join().unwrap();
    }

    #[test]
    fn panic_is_caught_and_does_not_confirm_retirement() {
        let handle = InputCallback::new(|_, _, _, _, _| panic!("render callback failed")).unwrap();
        assert_eq!(call(handle.token), -1500);
        assert!(handle.retire().is_err());
        assert_eq!(call(handle.token), 0);
    }
}
