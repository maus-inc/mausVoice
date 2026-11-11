//! Callback-scoped access to CoreAudio render action flags.
use super::{action_flags::ActionFlags, flags_sys as sys};
use std::{fmt, marker::PhantomData};

/// An exclusive handle to the flags of one CoreAudio callback invocation.
///
/// A callback cannot retain its handle beyond the invocation:
/// ```compile_fail
/// use coreaudio::audio_unit::render_callback::action_flags::Handle;
/// fn register<F: for<'a> FnMut(Handle<'a>)>(_: F) {}
/// let mut saved: Option<Handle<'static>> = None;
/// register(|flags| saved = Some(flags));
/// ```
pub struct Handle<'a> {
    ptr: *mut sys::AudioUnitRenderActionFlags,
    lifetime: PhantomData<&'a mut sys::AudioUnitRenderActionFlags>,
}

impl fmt::Debug for Handle<'_> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        unsafe { write!(f, "{:?}", *self.ptr) }
    }
}

impl<'a> Handle<'a> {
    /// Wrap a native callback's action flags.
    ///
    /// # Safety
    /// `ptr` must be non-null, aligned, and valid for exclusive access for the
    /// entire lifetime `'a`. It must refer to initialized flags, and no other
    /// thread or handle may access them during that lifetime.
    pub unsafe fn from_ptr(ptr: *mut sys::AudioUnitRenderActionFlags) -> Self {
        Self {
            ptr,
            lifetime: PhantomData,
        }
    }

    /// Retrieve the current state, including flags not yet named by this crate.
    pub fn get(&self) -> ActionFlags {
        // ActionFlags wraps a u32 supplied by CoreAudio. Unknown bits are valid
        // native flags and must survive round trips through this handle.
        unsafe { ActionFlags::from_bits_unchecked(*self.ptr) }
    }
    fn set(&mut self, flags: ActionFlags) {
        unsafe { *self.ptr = flags.bits() }
    }
    /// The raw value of the flags currently stored.
    pub fn bits(&self) -> u32 {
        self.get().bits()
    }
    /// Returns true if no flags are stored.
    pub fn is_empty(&self) -> bool {
        self.get().is_empty()
    }
    /// Returns true if all flags are stored.
    pub fn is_all(&self) -> bool {
        self.get().is_all()
    }
    /// Returns true if both sets have a flag in common.
    pub fn intersects(&self, other: ActionFlags) -> bool {
        self.get().intersects(other)
    }
    /// Returns true if all flags in `other` are present.
    pub fn contains(&self, other: ActionFlags) -> bool {
        self.get().contains(other)
    }
    /// Insert the specified flags.
    pub fn insert(&mut self, other: ActionFlags) {
        let mut flags = self.get();
        flags.insert(other);
        self.set(flags);
    }
    /// Remove the specified flags.
    pub fn remove(&mut self, other: ActionFlags) {
        let mut flags = self.get();
        flags.remove(other);
        self.set(flags);
    }
    /// Toggle the specified flags.
    pub fn toggle(&mut self, other: ActionFlags) {
        let mut flags = self.get();
        flags.toggle(other);
        self.set(flags);
    }
}
