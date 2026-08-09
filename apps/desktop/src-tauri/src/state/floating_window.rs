use std::sync::atomic::{AtomicU64, Ordering};

pub const FLOATING_WINDOW_LABEL_PREFIX: &str = "floating-";

pub struct FloatingWindowState {
    counter: AtomicU64,
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
        }
    }

    pub fn next_label(&self) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        format!("{FLOATING_WINDOW_LABEL_PREFIX}{n}")
    }
}
