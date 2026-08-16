use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

pub const FLOATING_WINDOW_LABEL_PREFIX: &str = "floating-";
const MAX_PENDING_COMPOSER_TEXT: usize = 32;
const MAX_PENDING_COMPOSER_TEXT_BYTES: usize = 2 * 1024 * 1024;
const PENDING_COMPOSER_TEXT_TTL: Duration = Duration::from_secs(10 * 60);

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

    pub fn take_composer_text(&self, request_id: &str) -> Result<Option<String>, String> {
        let mut pending = self
            .pending_composer_text
            .lock()
            .map_err(|_| "composer text state lock poisoned".to_string())?;
        Self::prune_expired(&mut pending);
        Ok(pending.remove(request_id).map(|(text, _)| text))
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
