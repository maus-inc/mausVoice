use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;
use uuid::Uuid;

use crate::models::WhisperModel;

/// A session that stops receiving chunks is almost certainly a crashed or
/// disconnected client — it will never be finalized, so its audio buffer must
/// not sit in memory forever. Ten minutes of no activity marks it stale.
const SESSION_IDLE_TTL: Duration = Duration::from_secs(10 * 60);

/// How often the background sweeper evicts stale sessions. Runs independently
/// of `finalize`/`remove` so dropped clients cannot leak buffered samples.
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct BufferedTranscriptionSession {
    pub model: WhisperModel,
    pub sample_rate: u32,
    pub language: Option<String>,
    pub initial_prompt: Option<String>,
    pub device_id: Option<String>,
    pub samples: Vec<f32>,
    /// Last time the session was created or received samples. Drives TTL
    /// eviction; deliberately not refreshed by reads until the buffer is taken.
    pub last_activity: Instant,
}

#[derive(Debug, Clone)]
pub struct BufferedTranscriptionSessionInput {
    pub model: WhisperModel,
    pub sample_rate: u32,
    pub language: Option<String>,
    pub initial_prompt: Option<String>,
    pub device_id: Option<String>,
}

#[derive(Default)]
struct SessionStore {
    sessions: HashMap<Uuid, BufferedTranscriptionSession>,
    /// Last time any eviction pass ran. The periodic sweeper owns cleanup;
    /// session creation only evicts opportunistically, and at most once per
    /// [`SWEEP_INTERVAL`] so a creation burst doesn't pay for a full map scan
    /// on every call while still capping how much abandoned state can pile up
    /// between sweeper ticks.
    last_eviction: Option<Instant>,
}

impl SessionStore {
    fn evict_stale(&mut self) -> usize {
        let now = Instant::now();
        let before = self.sessions.len();
        self.sessions
            .retain(|_, session| now.duration_since(session.last_activity) < SESSION_IDLE_TTL);
        self.last_eviction = Some(now);
        before - self.sessions.len()
    }

    fn evict_stale_at_most_once_per_interval(&mut self) {
        let due = self
            .last_eviction
            .map(|last| last.elapsed() >= SWEEP_INTERVAL)
            .unwrap_or(true);
        if due {
            self.evict_stale();
        }
    }
}

#[derive(Clone, Default)]
pub struct TranscriptionSessionRegistry {
    inner: Arc<Mutex<SessionStore>>,
}

impl TranscriptionSessionRegistry {
    pub async fn create(&self, input: BufferedTranscriptionSessionInput) -> Uuid {
        let session_id = Uuid::new_v4();
        let session = BufferedTranscriptionSession {
            model: input.model,
            sample_rate: input.sample_rate,
            language: input.language,
            initial_prompt: input.initial_prompt,
            device_id: input.device_id,
            samples: Vec::new(),
            last_activity: Instant::now(),
        };

        let mut store = self.inner.lock().await;
        // Opportunistic eviction while we already hold the lock — gated to at
        // most one pass per sweep interval so creation bursts don't scan the
        // whole registry on every call; the periodic sweeper owns cleanup.
        store.evict_stale_at_most_once_per_interval();
        store.sessions.insert(session_id, session);
        session_id
    }

    pub async fn append_samples(&self, session_id: Uuid, samples: Vec<f32>) -> Option<usize> {
        let mut store = self.inner.lock().await;
        let session = store.sessions.get_mut(&session_id)?;
        session.samples.extend(samples);
        session.last_activity = Instant::now();
        Some(session.samples.len())
    }

    pub async fn take(&self, session_id: Uuid) -> Option<BufferedTranscriptionSession> {
        let mut store = self.inner.lock().await;
        store.sessions.remove(&session_id)
    }

    pub async fn remove(&self, session_id: Uuid) -> bool {
        let mut store = self.inner.lock().await;
        store.sessions.remove(&session_id).is_some()
    }

    /// Evict sessions that have been idle past [`SESSION_IDLE_TTL`], returning
    /// how many were dropped.
    pub async fn sweep_stale(&self) -> usize {
        let mut store = self.inner.lock().await;
        store.evict_stale()
    }

    /// Periodic stale-session eviction. Call once from a Tokio runtime context
    /// (the sidecar server); the task lives for the process lifetime.
    pub fn spawn_sweeper(&self) {
        let registry = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(SWEEP_INTERVAL);
            // The first tick fires immediately; skip it so startup work isn't
            // sweep-shaped noise.
            interval.tick().await;
            loop {
                interval.tick().await;
                let evicted = registry.sweep_stale().await;
                if evicted > 0 {
                    tracing::info!(
                        evicted,
                        "evicted stale transcription sessions after idle TTL"
                    );
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_input() -> BufferedTranscriptionSessionInput {
        BufferedTranscriptionSessionInput {
            model: WhisperModel::Tiny,
            sample_rate: 16_000,
            language: None,
            initial_prompt: None,
            device_id: None,
        }
    }

    #[tokio::test]
    async fn stale_sessions_are_evicted_on_sweep() {
        let registry = TranscriptionSessionRegistry::default();
        let fresh_id = registry.create(dummy_input()).await;

        let stale_id = Uuid::new_v4();
        {
            let mut store = registry.inner.lock().await;
            store.sessions.insert(
                stale_id,
                BufferedTranscriptionSession {
                    model: WhisperModel::Tiny,
                    sample_rate: 16_000,
                    language: None,
                    initial_prompt: None,
                    device_id: None,
                    samples: Vec::new(),
                    last_activity: Instant::now()
                        - (SESSION_IDLE_TTL + Duration::from_secs(1)),
                },
            );
        }

        assert_eq!(registry.sweep_stale().await, 1);
        assert!(registry.take(fresh_id).await.is_some());
        assert!(registry.take(stale_id).await.is_none());
    }

    #[tokio::test]
    async fn append_refreshes_activity() {
        let registry = TranscriptionSessionRegistry::default();
        let session_id = registry.create(dummy_input()).await;
        {
            let mut store = registry.inner.lock().await;
            if let Some(session) = store.sessions.get_mut(&session_id) {
                session.last_activity =
                    Instant::now() - (SESSION_IDLE_TTL - Duration::from_secs(5));
            }
        }
        assert!(registry
            .append_samples(session_id, vec![0.0, 0.0])
            .await
            .is_some());
        assert_eq!(registry.sweep_stale().await, 0);
        assert!(registry.take(session_id).await.is_some());
    }
}
