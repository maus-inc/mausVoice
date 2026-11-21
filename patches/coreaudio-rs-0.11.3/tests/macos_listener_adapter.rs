//! Portable tests of the real listener adapter with a simulated CoreAudio API.
#![allow(non_snake_case, non_upper_case_globals, dead_code)]
use std::sync::Arc;

#[derive(Debug)]
pub enum ListenerError {
    Unspecified,
    Native(i32),
}
impl ListenerError {
    fn from_os_status(status: i32) -> Result<(), Self> {
        if status == 0 {
            Ok(())
        } else {
            Err(Self::Native(status))
        }
    }
    fn as_os_status(&self) -> i32 {
        -1500
    }
}

pub mod listener_sys {
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::{Arc, Barrier, Mutex, OnceLock};

    pub type AudioDeviceID = u32;
    pub type AudioObjectID = u32;
    pub type OSStatus = i32;
    pub const kAudioDevicePropertyDeviceIsAlive: u32 = 1;
    pub const kAudioDevicePropertyNominalSampleRate: u32 = 2;
    pub const kAudioObjectPropertyScopeGlobal: u32 = 3;
    pub const kAudioObjectPropertyElementMaster: u32 = 4;
    #[derive(Clone, Copy)]
    pub struct AudioObjectPropertyAddress {
        pub mSelector: u32,
        pub mScope: u32,
        pub mElement: u32,
    }
    pub type Handler =
        unsafe extern "C" fn(u32, u32, *const AudioObjectPropertyAddress, *mut c_void) -> i32;
    #[derive(Clone, Copy)]
    pub struct Entry {
        pub handler: Handler,
        pub token: usize,
    }
    #[derive(Default)]
    struct Device {
        current: Option<Entry>,
        additions: usize,
        removals: usize,
        fail_add: bool,
        fail_remove: bool,
        fail_read: bool,
        short_read: bool,
        alive: u32,
        rate: f64,
    }
    fn devices() -> &'static Mutex<HashMap<u32, Device>> {
        static DEVICES: OnceLock<Mutex<HashMap<u32, Device>>> = OnceLock::new();
        DEVICES.get_or_init(|| Mutex::new(HashMap::new()))
    }
    type Barriers = (Barrier, Barrier);
    fn blockers() -> &'static Mutex<HashMap<u32, Arc<Barriers>>> {
        static BLOCKERS: OnceLock<Mutex<HashMap<u32, Arc<Barriers>>>> = OnceLock::new();
        BLOCKERS.get_or_init(|| Mutex::new(HashMap::new()))
    }
    pub fn block_read(id: u32) -> Arc<Barriers> {
        let barriers = Arc::new((Barrier::new(2), Barrier::new(2)));
        blockers().lock().unwrap().insert(id, Arc::clone(&barriers));
        barriers
    }
    pub fn configure(
        id: u32,
        fail_add: bool,
        fail_remove: bool,
        fail_read: bool,
        short_read: bool,
    ) {
        let mut map = devices().lock().unwrap();
        let dev = map.entry(id).or_default();
        dev.fail_add = fail_add;
        dev.fail_remove = fail_remove;
        dev.fail_read = fail_read;
        dev.short_read = short_read;
        dev.alive = 0;
        dev.rate = 48_000.0;
    }
    pub fn entry(id: u32) -> Entry {
        devices().lock().unwrap()[&id].current.unwrap()
    }
    pub fn counts(id: u32) -> (usize, usize) {
        let map = devices().lock().unwrap();
        let dev = &map[&id];
        (dev.additions, dev.removals)
    }
    pub fn dispatch(id: u32, entry: Entry) -> i32 {
        unsafe { (entry.handler)(id, 0, std::ptr::null(), entry.token as *mut c_void) }
    }
    pub unsafe fn AudioObjectAddPropertyListener(
        id: u32,
        _: *const AudioObjectPropertyAddress,
        handler: Option<Handler>,
        token: *mut c_void,
    ) -> i32 {
        let mut map = devices().lock().unwrap();
        let dev = map.entry(id).or_default();
        dev.additions += 1;
        dev.current = Some(Entry {
            handler: handler.unwrap(),
            token: token as usize,
        });
        if dev.fail_add {
            -10
        } else {
            0
        }
    }
    pub unsafe fn AudioObjectRemovePropertyListener(
        id: u32,
        _: *const AudioObjectPropertyAddress,
        _: Option<Handler>,
        _: *mut c_void,
    ) -> i32 {
        let mut map = devices().lock().unwrap();
        let dev = map.get_mut(&id).unwrap();
        dev.removals += 1;
        if dev.fail_remove {
            -11
        } else {
            dev.current = None;
            0
        }
    }
    pub unsafe fn AudioObjectGetPropertyData(
        id: u32,
        addr: *const AudioObjectPropertyAddress,
        _: u32,
        _: *const c_void,
        size: *mut u32,
        output: *mut c_void,
    ) -> i32 {
        let blocker = blockers().lock().unwrap().remove(&id);
        if let Some(barriers) = blocker {
            barriers.0.wait();
            barriers.1.wait();
        }
        let map = devices().lock().unwrap();
        let dev = &map[&id];
        if dev.fail_read {
            return -12;
        }
        if dev.short_read {
            *size = 0;
            return 0;
        }
        if (*addr).mSelector == kAudioDevicePropertyNominalSampleRate {
            *(output as *mut f64) = dev.rate;
        } else {
            *(output as *mut u32) = dev.alive;
        }
        0
    }
}

#[path = "../src/audio_unit/listener_registry.rs"]
mod listener_registry;
#[path = "../src/audio_unit/macos_listeners.rs"]
mod macos_listeners;

#[cfg(test)]
mod tests {
    use super::{
        listener_sys as sys,
        macos_listeners::{AliveListener, RateListener},
        Arc,
    };
    use std::sync::mpsc;

    #[test]
    fn moved_listeners_receive_updates_once_and_old_tokens_are_inert() {
        sys::configure(1001, false, false, false, false);
        let mut listener = Box::new(RateListener::new(1001, None));
        listener.register().unwrap();
        listener.register().unwrap();
        let old = sys::entry(1001);
        let mut listener = *listener;
        assert_eq!(sys::dispatch(1001, old), 0);
        assert_eq!(listener.copy_values(), vec![48_000.0]);
        assert_eq!(listener.get_nbr_values(), 1);
        listener.unregister().unwrap();
        assert_eq!(sys::dispatch(1001, old), 0);
        assert_eq!(listener.drain_values(), vec![48_000.0]);
        listener.register().unwrap();
        let next = sys::entry(1001);
        assert_ne!(old.token, next.token);
        sys::dispatch(1001, old);
        assert!(listener.copy_values().is_empty());
        sys::dispatch(1001, next);
        assert_eq!(listener.copy_values(), vec![48_000.0]);
        drop(listener);
        assert_eq!(sys::counts(1001), (2, 2));
    }

    #[test]
    fn alive_callback_survives_move_and_ignores_late_delivery() {
        sys::configure(1002, false, false, false, false);
        let mut listener = Box::new(AliveListener::new(1002));
        listener.register().unwrap();
        let token = sys::entry(1002);
        let mut listener = *listener;
        assert!(listener.is_alive());
        sys::dispatch(1002, token);
        assert!(!listener.is_alive());
        listener.unregister().unwrap();
        drop(listener);
        assert_eq!(sys::dispatch(1002, token), 0);
        assert_eq!(sys::counts(1002), (1, 1));
    }

    #[test]
    fn failed_add_and_remove_retire_the_native_token() {
        sys::configure(1003, true, false, false, false);
        let mut listener = RateListener::new(1003, None);
        assert!(listener.register().is_err());
        let failed_add = sys::entry(1003);
        assert_eq!(sys::dispatch(1003, failed_add), 0);
        assert!(listener.copy_values().is_empty());
        sys::configure(1003, false, false, false, false);
        listener.register().unwrap();
        let retry = sys::entry(1003);
        assert_ne!(failed_add.token, retry.token);
        sys::dispatch(1003, failed_add);
        assert!(listener.copy_values().is_empty());
        sys::dispatch(1003, retry);
        assert_eq!(listener.copy_values(), vec![48_000.0]);
        drop(listener);
        assert_eq!(sys::counts(1003), (2, 1));

        sys::configure(1004, false, true, false, false);
        let mut listener = AliveListener::new(1004);
        listener.register().unwrap();
        let failed_remove = sys::entry(1004);
        assert!(listener.unregister().is_err());
        assert_eq!(sys::dispatch(1004, failed_remove), 0);
        assert!(listener.is_alive());
        drop(listener);
        assert_eq!(sys::counts(1004), (1, 1));
    }

    #[test]
    fn dropped_receiver_and_invalid_reads_do_not_abort_or_emit_values() {
        sys::configure(1005, false, false, false, false);
        let (send, receive) = mpsc::channel();
        drop(receive);
        let mut listener = RateListener::new(1005, Some(send));
        listener.register().unwrap();
        assert_eq!(sys::dispatch(1005, sys::entry(1005)), 0);
        drop(listener);

        for (id, fail_read, short_read) in [(1006, true, false), (1007, false, true)] {
            sys::configure(id, false, false, fail_read, short_read);
            let mut listener = RateListener::new(id, None);
            listener.register().unwrap();
            assert_ne!(sys::dispatch(id, sys::entry(id)), 0);
            assert!(listener.copy_values().is_empty());
        }
    }

    #[test]
    fn poisoned_queue_does_not_panic_across_the_callback_boundary() {
        sys::configure(1009, false, false, false, false);
        let mut listener = RateListener::new(1009, None);
        listener.register().unwrap();
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = listener.queue.lock().unwrap();
            panic!("poison the queue");
        }))
        .is_err());
        assert_eq!(sys::dispatch(1009, sys::entry(1009)), 0);
        assert_eq!(listener.copy_values(), vec![48_000.0]);
    }

    #[test]
    fn in_flight_callback_keeps_its_state_after_unregister_and_drop() {
        sys::configure(1008, false, false, false, false);
        let (send, receive) = mpsc::channel();
        let mut listener = RateListener::new(1008, Some(send));
        listener.register().unwrap();
        let entry = sys::entry(1008);
        let barriers = sys::block_read(1008);
        let worker = std::thread::spawn(move || sys::dispatch(1008, entry));
        barriers.0.wait();
        listener.unregister().unwrap();
        drop(listener);
        barriers.1.wait();
        assert_eq!(worker.join().unwrap(), 0);
        assert_eq!(receive.recv().unwrap(), 48_000.0);
        assert_eq!(sys::dispatch(1008, entry), 0);
        assert!(receive.try_recv().is_err());
    }

    #[test]
    fn inflight_registry_lookup_keeps_state_alive_after_removal() {
        let state = Arc::new(42_u32);
        let token = super::listener_registry::insert(Arc::clone(&state)).unwrap();
        let inflight = super::listener_registry::get::<u32>(token).unwrap();
        super::listener_registry::remove(token);
        drop(state);
        assert_eq!(*inflight, 42);
        assert!(super::listener_registry::get::<u32>(token).is_none());
    }
}
