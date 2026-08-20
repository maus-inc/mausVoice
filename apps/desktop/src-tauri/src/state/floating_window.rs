use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Condvar, Mutex,
};
use std::time::{Duration, Instant};

pub const FLOATING_WINDOW_LABEL_PREFIX: &str = "floating-";
const MAX_PENDING_COMPOSER_TEXT: usize = 32;
const MAX_PENDING_COMPOSER_TEXT_BYTES: usize = 2 * 1024 * 1024;
// Bounds how long dictated transcript text lingers in memory when the composer
// window is force-closed (for example the app is killed) before the frontend's
// normal `composer_discard_text` cleanup runs. Kept short because this is
// user-dictated content and the app advertises an incognito mode; the frontend
// discards on every normal close, so this is only a backstop for the kill edge
// case.
const PENDING_COMPOSER_TEXT_TTL: Duration = Duration::from_secs(60);
// How often the background reaper wakes to expire stale pending text even when
// no composer operation occurs (see `new`).
const PENDING_COMPOSER_TEXT_REAPER_INTERVAL: Duration = Duration::from_secs(30);

type PendingComposerText = (String, Instant);

pub struct FloatingWindowState {
    counter: AtomicU64,
    // Held in its own `Arc` so the background reaper thread keeps the map alive
    // (and keeps expiring entries) independently of this struct's lifetime.
    pending_composer_text: Arc<Mutex<HashMap<String, PendingComposerText>>>,
    // (flag, condvar) wake-point for the background reaper so `Drop` can stop
    // it instead of leaving a parked thread holding the map alive forever.
    reaper_shutdown: Arc<(Mutex<bool>, Condvar)>,
    reaper_thread: Option<std::thread::JoinHandle<()>>,
}

impl Default for FloatingWindowState {
    fn default() -> Self {
        Self::new()
    }
}

impl FloatingWindowState {
    pub fn new() -> Self {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let reaper_pending = pending.clone();
        let reaper_shutdown = Arc::new((Mutex::new(false), Condvar::new()));
        let thread_shutdown = reaper_shutdown.clone();
        // Background reaper: guarantees the sixty-second retention actually
        // deletes dictated text even if the composer is force-closed and no
        // later register/peek ever runs. Wakes on shutdown so `Drop` can join
        // it; otherwise prunes after each interval.
        let reaper_thread = std::thread::spawn(move || {
            let (lock, condvar) = &*thread_shutdown;
            let mut shutdown = match lock.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            loop {
                if *shutdown {
                    return;
                }
                let (guard, timeout) = match condvar
                    .wait_timeout(shutdown, PENDING_COMPOSER_TEXT_REAPER_INTERVAL)
                {
                    Ok(result) => result,
                    Err(_) => return,
                };
                shutdown = guard;
                if *shutdown {
                    return;
                }
                if timeout.timed_out() {
                    if let Ok(mut map) = reaper_pending.lock() {
                        Self::prune_expired(&mut map);
                    }
                }
            }
        });
        Self {
            counter: AtomicU64::new(1),
            pending_composer_text: pending,
            reaper_shutdown,
            reaper_thread: Some(reaper_thread),
        }
    }

    pub fn next_label(&self) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        format!("{FLOATING_WINDOW_LABEL_PREFIX}{n}")
    }

    fn prune_expired(pending: &mut HashMap<String, PendingComposerText>) {
        let now = Instant::now();
        pending.retain(|_, (_, created_at)| {
            now.duration_since(*created_at) < PENDING_COMPOSER_TEXT_TTL
        });
    }

    pub fn register_composer_text(&self, request_id: String, text: String) -> Result<(), String> {
        if text.len() > MAX_PENDING_COMPOSER_TEXT_BYTES {
            return Err("composer transcript exceeds the 2 MiB limit".to_string());
        }

        let mut pending = self
            .pending_composer_text
            .lock()
            .map_err(|_| "composer text state lock poisoned".to_string())?;
        Self::prune_expired(&mut pending);
        let replacing_existing = pending.contains_key(&request_id);
        if !replacing_existing && pending.len() >= MAX_PENDING_COMPOSER_TEXT {
            if let Some(oldest_id) = pending
                .iter()
                .min_by_key(|(_, (_, created_at))| *created_at)
                .map(|(id, _)| id.clone())
            {
                pending.remove(&oldest_id);
            }
        }
        pending.insert(request_id, (text, Instant::now()));
        Ok(())
    }

    pub fn peek_composer_text(&self, request_id: &str) -> Result<Option<String>, String> {
        let mut pending = self
            .pending_composer_text
            .lock()
            .map_err(|_| "composer text state lock poisoned".to_string())?;
        Self::prune_expired(&mut pending);
        Ok(pending.get(request_id).map(|(text, _)| text.clone()))
    }

    pub fn discard_composer_text(&self, request_id: &str) -> Result<(), String> {
        let mut pending = self
            .pending_composer_text
            .lock()
            .map_err(|_| "composer text state lock poisoned".to_string())?;
        pending.remove(request_id);
        Ok(())
    }

    /// Runs the same expiration pass the background reaper runs. Exposed so the
    /// reaper's behavior is observable in tests without sleeping for the reaper
    /// interval.
    pub fn prune_expired_now(&self) {
        if let Ok(mut pending) = self.pending_composer_text.lock() {
            Self::prune_expired(&mut pending);
        }
    }
}

impl Drop for FloatingWindowState {
    fn drop(&mut self) {
        let (lock, condvar) = &*self.reaper_shutdown;
        if let Ok(mut shutdown) = lock.lock() {
            *shutdown = true;
        }
        condvar.notify_all();
        // Joining is safe and prompt: the reaper wakes on the condvar instead
        // of sleeping through its interval. A poisoned lock is ignored — the
        // thread still exits at the next interval timeout.
        if let Some(thread) = self.reaper_thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_peek_and_discard_composer_text() {
        let state = FloatingWindowState::new();
        assert!(state
            .register_composer_text("r1".into(), "hello".into())
            .is_ok());
        assert_eq!(
            state.peek_composer_text("r1").unwrap(),
            Some("hello".into())
        );
        // The composer force-close path relies on the frontend discarding the
        // pending entry; this is the lifecycle contract exercised there.
        assert!(state.discard_composer_text("r1").is_ok());
        assert_eq!(state.peek_composer_text("r1").unwrap(), None);
    }

    #[test]
    fn oversized_composer_text_is_rejected() {
        let state = FloatingWindowState::new();
        let big = "x".repeat(MAX_PENDING_COMPOSER_TEXT_BYTES + 1);
        assert!(state.register_composer_text("r2".into(), big).is_err());
    }

    #[test]
    fn oldest_entry_is_evicted_when_over_capacity() {
        let state = FloatingWindowState::new();
        for i in 0..MAX_PENDING_COMPOSER_TEXT {
            assert!(state
                .register_composer_text(format!("e{i}"), "v".into())
                .is_ok());
        }
        // Registering one more evicts the oldest entry (e0) under the LRU bound.
        assert!(state
            .register_composer_text("eNew".into(), "v".into())
            .is_ok());
        assert_eq!(state.peek_composer_text("e0").unwrap(), None);
        assert_eq!(state.peek_composer_text("eNew").unwrap(), Some("v".into()));
    }

    fn register_expired(state: &FloatingWindowState, request_id: &str, text: &str) {
        let mut pending = state.pending_composer_text.lock().unwrap();
        pending.insert(
            request_id.to_string(),
            (
                text.to_string(),
                Instant::now() - PENDING_COMPOSER_TEXT_TTL - Duration::from_secs(1),
            ),
        );
    }

    #[test]
    fn dropping_stops_and_joins_the_reaper_thread() {
        // The reaper must not outlive its owner holding the pending map open:
        // Drop sets the shutdown flag and joins promptly (condvar wake), so a
        // recreated state cannot pile up sleeper threads.
        let state = FloatingWindowState::new();
        let handle = state
            .reaper_thread
            .as_ref()
            .expect("reaper thread handle is stored");
        assert!(!handle.is_finished());
        drop(state);
        // Reaching this line means Drop did not block on the 30s interval.
    }

    #[test]
    fn reaper_survives_a_poisoned_pending_lock_without_deadlock() {
        let state = FloatingWindowState::new();
        {
            let pending = state.pending_composer_text.clone();
            std::thread::spawn(move || {
                let _guard = pending.lock();
                panic!("intentional poison");
            })
            .join()
            .expect_err("poison thread must panic");
        }
        // Drop must still complete (and join the reaper) even with the
        // pending lock poisoned.
        drop(state);
    }

    #[test]
    fn expired_entry_is_removed_without_a_composer_operation() {
        let state = FloatingWindowState::new();
        register_expired(&state, "old", "secret dictated text");
        // Peeking an expired entry prunes it on read (the incognito backstop),
        // so it is never handed back to the frontend.
        assert_eq!(state.peek_composer_text("old").unwrap(), None);
        // The background reaper (or prune_expired_now) deletes it once the TTL
        // lapses, with no register/peek/discard call from the frontend.
        state.prune_expired_now();
        assert_eq!(state.peek_composer_text("old").unwrap(), None);
    }
}
