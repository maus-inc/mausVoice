//! Exercise the actual WASAPI priority adapter with mock and native Win32 calls.
#![allow(
    non_snake_case,
    non_upper_case_globals,
    dead_code,
    clippy::upper_case_acronyms
)]

#[cfg(not(target_os = "windows"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct HANDLE(isize);

#[cfg(not(target_os = "windows"))]
mod Threading {
    use super::HANDLE;
    use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicUsize, Ordering};

    pub const THREAD_PRIORITY_TIME_CRITICAL: i32 = 15;
    pub const CURRENT_THREAD: HANDLE = HANDLE(-2);
    pub static CALLS: AtomicUsize = AtomicUsize::new(0);
    pub static HANDLE_USED: AtomicIsize = AtomicIsize::new(0);
    pub static PRIORITY_USED: AtomicIsize = AtomicIsize::new(0);
    pub static FAIL: AtomicBool = AtomicBool::new(false);

    pub unsafe fn GetCurrentThreadId() -> u32 {
        1234
    }
    pub unsafe fn GetCurrentThread() -> HANDLE {
        CURRENT_THREAD
    }
    pub unsafe fn SetThreadPriority(handle: HANDLE, priority: i32) -> Result<(), ()> {
        HANDLE_USED.store(handle.0, Ordering::SeqCst);
        PRIORITY_USED.store(priority as isize, Ordering::SeqCst);
        CALLS.fetch_add(1, Ordering::SeqCst);
        if FAIL.load(Ordering::SeqCst) {
            Err(())
        } else {
            Ok(())
        }
    }
}

#[cfg(target_os = "windows")]
mod Threading {
    use std::ffi::c_void;
    pub const THREAD_PRIORITY_TIME_CRITICAL: i32 = 15;
    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetCurrentThread() -> *mut c_void;
        pub fn SetThreadPriority(thread: *mut c_void, priority: i32) -> i32;
        pub fn GetThreadPriority(thread: *mut c_void) -> i32;
    }
}

#[path = "../src/host/wasapi/thread_priority.rs"]
mod thread_priority;

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::{thread_priority, Threading};
    use std::sync::atomic::Ordering;

    #[test]
    fn passes_the_current_thread_handle_and_keeps_failure_best_effort() {
        for fail in [false, true] {
            Threading::CALLS.store(0, Ordering::SeqCst);
            Threading::FAIL.store(fail, Ordering::SeqCst);
            thread_priority::boost_current_thread_priority();
            assert_eq!(Threading::CALLS.load(Ordering::SeqCst), 1);
            assert_eq!(
                Threading::HANDLE_USED.load(Ordering::SeqCst),
                Threading::CURRENT_THREAD.0
            );
            assert_eq!(Threading::PRIORITY_USED.load(Ordering::SeqCst), 15);
        }
    }
}

#[cfg(all(test, target_os = "windows"))]
mod native_tests {
    use super::{thread_priority, Threading};

    #[test]
    fn boosts_the_running_thread_and_restores_its_priority() {
        std::thread::spawn(|| unsafe {
            let handle = Threading::GetCurrentThread();
            let old_priority = Threading::GetThreadPriority(handle);
            assert_ne!(old_priority, i32::MAX, "GetThreadPriority failed");
            struct Restore(i32);
            impl Drop for Restore {
                fn drop(&mut self) {
                    unsafe {
                        Threading::SetThreadPriority(Threading::GetCurrentThread(), self.0);
                    }
                }
            }
            let _restore = Restore(old_priority);
            thread_priority::boost_current_thread_priority();
            assert_eq!(
                Threading::GetThreadPriority(handle),
                Threading::THREAD_PRIORITY_TIME_CRITICAL
            );
        })
        .join()
        .unwrap();
    }
}
