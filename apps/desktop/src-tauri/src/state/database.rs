use std::sync::{Arc, RwLock};

use sqlx::SqlitePool;

#[derive(Clone)]
pub struct OptionKeyDatabase(Arc<RwLock<SqlitePool>>);

impl OptionKeyDatabase {
    pub fn new(pool: SqlitePool) -> Self {
        Self(Arc::new(RwLock::new(pool)))
    }

    pub fn pool(&self) -> SqlitePool {
        self.0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Atomically swaps the active SQLite connection pool and returns the
    /// previous pool so the caller can close it cleanly. Used when a failed
    /// startup Voquill import is retried against an empty freshly-created
    /// database.
    pub fn replace_pool(&self, new_pool: SqlitePool) -> SqlitePool {
        let mut guard = self
            .0
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        std::mem::replace(&mut *guard, new_pool)
    }
}
