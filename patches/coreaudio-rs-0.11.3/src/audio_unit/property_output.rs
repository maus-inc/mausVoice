//! Checked output storage shared by generic CoreAudio property reads.
use super::Error;
use std::{convert::TryFrom, ffi::c_void, mem::MaybeUninit};

/// Read one property value through the native getter.
///
/// # Safety
/// The caller must ensure the selected property has the exact representation
/// and ownership semantics of `T`, and a successful full write produces a
/// valid `T`. The getter must respect the supplied output capacity.
pub(super) unsafe fn read<T>(
    getter: impl FnOnce(*mut c_void, *mut u32) -> i32,
) -> Result<T, Error> {
    let expected = u32::try_from(std::mem::size_of::<T>()).map_err(|_| Error::Unspecified)?;
    if expected == 0 {
        return Err(Error::Unspecified);
    }
    let mut size = expected;
    let mut output = MaybeUninit::<T>::uninit();
    let status = getter(output.as_mut_ptr().cast(), &mut size);
    Error::from_os_status(status)?;
    if size != expected {
        return Err(Error::Unspecified);
    }
    Ok(output.assume_init())
}
