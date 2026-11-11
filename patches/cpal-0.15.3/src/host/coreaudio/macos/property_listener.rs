//! Helper code for registering audio object property listeners.
use super::coreaudio;
use super::coreaudio::sys::{
    AudioObjectAddPropertyListener, AudioObjectID, AudioObjectPropertyAddress,
    AudioObjectRemovePropertyListener, OSStatus,
};
use super::{listener_registry, BackendSpecificError, BuildStreamError};

/// Maintain an audio object property listener.
/// The listener will be removed when this type is dropped.
pub struct AudioObjectPropertyListener {
    token: usize,
    property_address: AudioObjectPropertyAddress,
    audio_object_id: AudioObjectID,
    removed: bool,
}

impl AudioObjectPropertyListener {
    /// Attach the provided callback as a audio object property listener.
    pub fn new<F: FnMut() + Send + 'static>(
        audio_object_id: AudioObjectID,
        property_address: AudioObjectPropertyAddress,
        callback: F,
    ) -> Result<Self, BuildStreamError> {
        let token = listener_registry::insert(callback).ok_or_else(|| BackendSpecificError {
            description: "CoreAudio listener identity exhausted".to_owned(),
        })?;
        let result = unsafe {
            coreaudio::Error::from_os_status(AudioObjectAddPropertyListener(
                audio_object_id,
                &property_address as *const _,
                Some(property_listener_handler_shim),
                token as *mut _,
            ))
        };
        if let Err(error) = result {
            listener_registry::remove(token);
            return Err(error.into());
        }
        Ok(Self {
            token,
            audio_object_id,
            property_address,
            removed: false,
        })
    }

    /// Explicitly remove the property listener.
    /// Use this method if you need to explicitly handle failure to remove
    /// the property listener.
    pub fn remove(mut self) -> Result<(), BuildStreamError> {
        self.remove_inner()
    }

    fn remove_inner(&mut self) -> Result<(), BuildStreamError> {
        // Do not retry an unregister that failed or panicked: its native side
        // effects are uncertain. The retired token makes late callbacks inert.
        self.removed = true;
        // A notification already dispatched by CoreAudio may arrive after
        // removal. Retire its non-reused token before unregistering it.
        listener_registry::remove(self.token);
        unsafe {
            coreaudio::Error::from_os_status(AudioObjectRemovePropertyListener(
                self.audio_object_id,
                &self.property_address as *const _,
                Some(property_listener_handler_shim),
                self.token as *mut _,
            ))?;
        }
        Ok(())
    }
}

impl Drop for AudioObjectPropertyListener {
    fn drop(&mut self) {
        if !self.removed {
            let _ = self.remove_inner();
        }
    }
}

unsafe extern "C" fn property_listener_handler_shim(
    _: AudioObjectID,
    _: u32,
    _: *const AudioObjectPropertyAddress,
    callback: *mut ::std::os::raw::c_void,
) -> OSStatus {
    let _ = std::panic::catch_unwind(|| listener_registry::invoke(callback as usize));
    0
}
