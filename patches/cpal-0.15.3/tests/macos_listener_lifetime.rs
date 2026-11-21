//! Platform-independent contract tests for the macOS listener adapter.
#![allow(non_snake_case)]

mod coreaudio {
    pub use super::{sys, Error};
}

#[derive(Debug)]
pub struct BackendSpecificError {
    pub description: String,
}
#[derive(Debug)]
pub struct BuildStreamError;
impl From<BackendSpecificError> for BuildStreamError {
    fn from(error: BackendSpecificError) -> Self {
        drop(error.description);
        Self
    }
}
#[derive(Debug)]
pub struct Error;
impl Error {
    pub fn from_os_status(status: i32) -> Result<(), Self> {
        if status == 0 {
            Ok(())
        } else {
            Err(Self)
        }
    }
}
impl From<Error> for BuildStreamError {
    fn from(_: Error) -> Self {
        Self
    }
}

pub mod sys {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;
    pub type AudioObjectID = u32;
    pub type OSStatus = i32;
    #[derive(Clone, Copy)]
    pub struct AudioObjectPropertyAddress;
    pub type Handler = unsafe extern "C" fn(
        AudioObjectID,
        u32,
        *const AudioObjectPropertyAddress,
        *mut c_void,
    ) -> OSStatus;
    pub static TOKEN: AtomicUsize = AtomicUsize::new(0);
    pub static FAIL_ADD: AtomicBool = AtomicBool::new(false);
    pub static FAIL_REMOVE: AtomicBool = AtomicBool::new(false);
    pub static REMOVE_CALLS: AtomicUsize = AtomicUsize::new(0);
    static HANDLER: Mutex<Option<Handler>> = Mutex::new(None);
    pub unsafe fn AudioObjectAddPropertyListener(
        _: AudioObjectID,
        _: *const AudioObjectPropertyAddress,
        handler: Option<Handler>,
        token: *mut c_void,
    ) -> OSStatus {
        TOKEN.store(token as usize, Ordering::SeqCst);
        *HANDLER.lock().unwrap() = handler;
        if FAIL_ADD.load(Ordering::SeqCst) {
            -1
        } else {
            0
        }
    }
    pub fn dispatch(token: usize) {
        let handler = HANDLER.lock().unwrap().unwrap();
        unsafe { handler(1, 0, std::ptr::null(), token as *mut c_void) };
    }
    pub unsafe fn AudioObjectRemovePropertyListener(
        _: AudioObjectID,
        _: *const AudioObjectPropertyAddress,
        _: Option<Handler>,
        _: *mut c_void,
    ) -> OSStatus {
        REMOVE_CALLS.fetch_add(1, Ordering::SeqCst);
        if FAIL_REMOVE.load(Ordering::SeqCst) {
            -1
        } else {
            0
        }
    }
}

#[path = "../src/host/coreaudio/macos/listener_gate.rs"]
mod listener_gate;
#[path = "../src/host/coreaudio/macos/listener_registry.rs"]
mod listener_registry;
#[path = "../src/host/coreaudio/macos/property_listener.rs"]
mod property_listener;

#[test]
fn callback_inner_reference_does_not_own_the_listener() {
    use std::sync::{mpsc, Arc};
    struct Notifies(mpsc::Sender<()>);
    impl Drop for Notifies {
        fn drop(&mut self) {
            self.0.send(()).unwrap();
        }
    }
    struct Stream {
        listener: Arc<Option<Notifies>>,
        inner: Arc<Notifies>,
    }
    let (listener_tx, listener_rx) = mpsc::channel();
    let (inner_tx, inner_rx) = mpsc::channel();
    let stream = Stream {
        listener: Arc::new(Some(Notifies(listener_tx))),
        inner: Arc::new(Notifies(inner_tx)),
    };
    let other = Stream {
        listener: Arc::clone(&stream.listener),
        inner: Arc::clone(&stream.inner),
    };
    let callback = Arc::clone(&stream.inner);
    drop(stream);
    assert!(listener_rx.try_recv().is_err());
    drop(other);
    listener_rx.recv().unwrap();
    assert!(inner_rx.try_recv().is_err());
    drop(callback);
    inner_rx.recv().unwrap();
}

#[test]
fn unregister_failure_retires_the_token_without_freeing_a_live_callback_pointer() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&calls);
    let listener = property_listener::AudioObjectPropertyListener::new(
        1,
        sys::AudioObjectPropertyAddress,
        move || {
            observed.fetch_add(1, Ordering::SeqCst);
        },
    )
    .unwrap();
    let token = sys::TOKEN.load(Ordering::SeqCst);
    sys::dispatch(token);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    sys::FAIL_REMOVE.store(true, Ordering::SeqCst);
    let before = sys::REMOVE_CALLS.load(Ordering::SeqCst);
    assert!(listener.remove().is_err());
    assert_eq!(sys::REMOVE_CALLS.load(Ordering::SeqCst), before + 1);
    sys::FAIL_REMOVE.store(false, Ordering::SeqCst);
    sys::dispatch(token);
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    sys::FAIL_ADD.store(true, Ordering::SeqCst);
    let observed = Arc::clone(&calls);
    let failed = property_listener::AudioObjectPropertyListener::new(
        1,
        sys::AudioObjectPropertyAddress,
        move || {
            observed.fetch_add(1, Ordering::SeqCst);
        },
    );
    assert!(failed.is_err());
    let failed_token = sys::TOKEN.load(Ordering::SeqCst);
    sys::FAIL_ADD.store(false, Ordering::SeqCst);
    sys::dispatch(failed_token);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
