use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
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

type PendingComposerText = (String, Instant);

pub struct FloatingWindowState {
    counter: AtomicU64,
    pending_composer_text: Mutex<HashMap<String, PendingComposerText>>,
}

impl Default for FloatingWindowState {
    fn default() -> Self {
        Self::new()
    }
}

impl FloatingWindowState {
    pub fn new() -> Self {
        Self {
            counter: AtomicU64::new(1),
            pending_composer_text: Mutex::new(HashMap::new()),
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
        if pending.len() >= MAX_PENDING_COMPOSER_TEXT {
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
}
