use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

pub const FLOATING_WINDOW_LABEL_PREFIX: &str = "floating-";

pub struct FloatingWindowState {
    counter: AtomicU64,
    pending_composer_text: Mutex<HashMap<String, String>>,
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

    pub fn register_composer_text(&self, request_id: String, text: String) -> Result<(), String> {
        let mut pending = self
            .pending_composer_text
            .lock()
            .map_err(|_| "composer text state lock poisoned".to_string())?;
        pending.insert(request_id, text);
        Ok(())
    }

    pub fn take_composer_text(&self, request_id: &str) -> Result<Option<String>, String> {
        let mut pending = self
            .pending_composer_text
            .lock()
            .map_err(|_| "composer text state lock poisoned".to_string())?;
        Ok(pending.remove(request_id))
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
