use std::sync::{Mutex, MutexGuard};

/// Acquire a mutex lock, recovering from poison.
///
/// A poisoned mutex only means a previous holder panicked while holding the
/// guard; the underlying data is still memory-safe to read (Rust's Mutex
/// invariants are upheld even on panic). Crashing the whole app with
/// `.unwrap()` on a poisoned lock turns one bug into two; callers should
/// treat this like any other lock acquisition. We intentionally keep going
/// and hand back the guard (which exposes the data as it was at panic
/// time). This matches the existing convention used by
/// `platform::keyboard::lock`.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
