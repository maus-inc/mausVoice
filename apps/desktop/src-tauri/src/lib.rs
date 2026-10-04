pub mod app;
pub mod commands;
pub mod db;
pub mod domain;
pub mod errors;
pub mod overlay;
pub mod pill_process;
pub mod platform;
pub mod state;
pub mod system;
pub mod utils;

pub fn run() {
    app::run(tauri::generate_context!()).expect("tauri runtime failure");
}

/// Test-only: the one process environment this test binary has.
///
/// `cargo test` runs a crate's tests on many threads inside ONE process, so a
/// `std::env::set_var` in one test is visible to every other test running at the same
/// moment. Two module-local locks used to guard this -- `PATH_GUARD` in `commands` and
/// `ENV_LOCK` in `platform::linux::launch_env` -- and because neither could exclude the
/// other, the two modules could still interleave. One process has one environment, so it
/// gets one lock.
///
/// This module is LAST in the file because `clippy::items_after_test_module` is right
/// to insist: an item after a `#[cfg(test)] mod` reads as belonging to it.
///
/// Take it in any test that mutates the environment, or that resolves a program through
/// `PATH`. The second half is easy to forget and is the one that bites: a bare
/// `Command::new("mkfifo")` searches `PATH`, so it fails while another test has `PATH`
/// removed -- and `if let Ok(status)` around the result turns that into a silently skipped
/// assertion rather than a red test.
#[cfg(test)]
pub(crate) mod test_env {
    use std::sync::{Mutex, MutexGuard};

    pub(crate) static ENV: Mutex<()> = Mutex::new(());

    /// Take [`ENV`]. A poisoned mutex means some other test panicked while holding it,
    /// which says nothing about this one's precondition, so the state is recovered rather
    /// than propagated as a second, misleading failure.
    pub(crate) fn lock() -> MutexGuard<'static, ()> {
        ENV.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
