//! Best-effort worker priority on Windows.
use super::Threading;

pub(super) fn boost_current_thread_priority() {
    unsafe {
        // This pseudo-handle denotes the calling worker and must not be closed.
        // Raising priority remains best-effort, as it was before this fix.
        let _ = Threading::SetThreadPriority(
            Threading::GetCurrentThread(),
            Threading::THREAD_PRIORITY_TIME_CRITICAL,
        );
    }
}
