//! CoreAudio property listeners whose callback identities outlive movable handles.
use super::{listener_registry, listener_sys as sys, ListenerError as Error};
use std::any::Any;
use std::collections::VecDeque;
use std::ffi::c_void;
use std::mem;
use std::ops::Deref;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr::null;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use sys::{
    kAudioDevicePropertyDeviceIsAlive, kAudioDevicePropertyNominalSampleRate,
    kAudioObjectPropertyElementMaster, kAudioObjectPropertyScopeGlobal, AudioDeviceID,
    AudioObjectID, AudioObjectPropertyAddress, OSStatus,
};

type Handler = unsafe extern "C" fn(
    AudioObjectID,
    u32,
    *const AudioObjectPropertyAddress,
    *mut c_void,
) -> OSStatus;

struct Registration {
    device: AudioDeviceID,
    address: AudioObjectPropertyAddress,
    handler: Handler,
    token: Option<usize>,
}

impl Registration {
    fn new(device: AudioDeviceID, selector: u32, handler: Handler) -> Self {
        Self {
            device,
            address: AudioObjectPropertyAddress {
                mSelector: selector,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMaster,
            },
            handler,
            token: None,
        }
    }

    fn register<T: Any + Send + Sync>(&mut self, state: Arc<T>) -> Result<(), Error> {
        if self.token.is_some() {
            return Ok(());
        }
        let token = listener_registry::insert(state).ok_or(Error::Unspecified)?;
        let result = unsafe {
            Error::from_os_status(sys::AudioObjectAddPropertyListener(
                self.device,
                &self.address,
                Some(self.handler),
                token as *mut c_void,
            ))
        };
        if let Err(error) = result {
            listener_registry::remove(token);
            return Err(error);
        }
        self.token = Some(token);
        Ok(())
    }

    fn unregister(&mut self) -> Result<(), Error> {
        if let Some(token) = self.token.take() {
            // A callback dispatched before or after native removal looks up an
            // identity, never a pointer to this movable listener. An in-flight
            // lookup owns its state; later lookups see a retired token.
            listener_registry::remove(token);
            let status = unsafe {
                sys::AudioObjectRemovePropertyListener(
                    self.device,
                    &self.address,
                    Some(self.handler),
                    token as *mut c_void,
                )
            };
            // Failed removal has uncertain effects. Do not retry this token;
            // any later callback remains harmless because it is retired.
            Error::from_os_status(status)?;
        }
        Ok(())
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        let _ = self.unregister();
    }
}

/// Shared callback state exposed through `RateListener` for queue access.
pub struct RateListenerState {
    /// Queue used when no sender is supplied. It can also be read directly.
    pub queue: Mutex<VecDeque<f64>>,
    sender: Option<Sender<f64>>,
}

/// Receive sample-rate changes after registering with CoreAudio.
pub struct RateListener {
    state: Arc<RateListenerState>,
    registration: Registration,
}

impl Deref for RateListener {
    type Target = RateListenerState;

    fn deref(&self) -> &Self::Target {
        &self.state
    }
}

impl RateListener {
    /// Create an unregistered listener for the device.
    pub fn new(device_id: AudioDeviceID, sync_channel: Option<Sender<f64>>) -> Self {
        Self {
            state: Arc::new(RateListenerState {
                queue: Mutex::new(VecDeque::new()),
                sender: sync_channel,
            }),
            registration: Registration::new(
                device_id,
                kAudioDevicePropertyNominalSampleRate,
                rate_callback,
            ),
        }
    }

    /// Register once; repeated registration leaves the original listener intact.
    pub fn register(&mut self) -> Result<(), Error> {
        self.registration.register(Arc::clone(&self.state))
    }

    /// Retire the callback identity and ask CoreAudio to remove the listener.
    pub fn unregister(&mut self) -> Result<(), Error> {
        self.registration.unregister()
    }

    /// Number of queued values when no sender was supplied.
    pub fn get_nbr_values(&self) -> usize {
        self.queue
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }

    /// Copy queued values without clearing them.
    pub fn copy_values(&self) -> Vec<f64> {
        self.queue
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .copied()
            .collect()
    }

    /// Return and clear queued values.
    pub fn drain_values(&mut self) -> Vec<f64> {
        self.queue
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain(..)
            .collect()
    }
}

unsafe extern "C" fn rate_callback(
    device: AudioObjectID,
    _: u32,
    _: *const AudioObjectPropertyAddress,
    token: *mut c_void,
) -> OSStatus {
    catch_unwind(AssertUnwindSafe(|| {
        let Some(state) = listener_registry::get::<RateListenerState>(token as usize) else {
            return 0;
        };
        let address = AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMaster,
        };
        let mut rate = 0.0_f64;
        let mut size = mem::size_of::<f64>() as u32;
        let status = unsafe {
            sys::AudioObjectGetPropertyData(
                device,
                &address,
                0,
                null(),
                &mut size,
                &mut rate as *mut _ as *mut c_void,
            )
        };
        if status != 0 {
            return status;
        }
        if size != mem::size_of::<f64>() as u32 {
            return Error::Unspecified.as_os_status();
        }
        if let Some(sender) = &state.sender {
            let _ = sender.send(rate);
        } else {
            state
                .queue
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push_back(rate);
        }
        0
    }))
    .unwrap_or_else(|_| Error::Unspecified.as_os_status())
}

/// Receive device-alive changes after registering with CoreAudio.
pub struct AliveListener {
    alive: Arc<AtomicBool>,
    registration: Registration,
}

impl AliveListener {
    /// Create an unregistered listener for the device.
    pub fn new(device_id: AudioDeviceID) -> Self {
        Self {
            alive: Arc::new(AtomicBool::new(true)),
            registration: Registration::new(
                device_id,
                kAudioDevicePropertyDeviceIsAlive,
                alive_callback,
            ),
        }
    }

    /// Register once; repeated registration leaves the original listener intact.
    pub fn register(&mut self) -> Result<(), Error> {
        self.registration.register(Arc::clone(&self.alive))
    }

    /// Retire the callback identity and ask CoreAudio to remove the listener.
    pub fn unregister(&mut self) -> Result<(), Error> {
        self.registration.unregister()
    }

    /// The last successfully reported device-alive state.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

unsafe extern "C" fn alive_callback(
    device: AudioObjectID,
    _: u32,
    _: *const AudioObjectPropertyAddress,
    token: *mut c_void,
) -> OSStatus {
    catch_unwind(AssertUnwindSafe(|| {
        let Some(alive) = listener_registry::get::<AtomicBool>(token as usize) else {
            return 0;
        };
        let address = AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyDeviceIsAlive,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMaster,
        };
        let mut value = 0_u32;
        let mut size = mem::size_of::<u32>() as u32;
        let status = unsafe {
            sys::AudioObjectGetPropertyData(
                device,
                &address,
                0,
                null(),
                &mut size,
                &mut value as *mut _ as *mut c_void,
            )
        };
        if status != 0 {
            return status;
        }
        if size != mem::size_of::<u32>() as u32 {
            return Error::Unspecified.as_os_status();
        }
        alive.store(value != 0, Ordering::SeqCst);
        0
    }))
    .unwrap_or_else(|_| Error::Unspecified.as_os_status())
}
