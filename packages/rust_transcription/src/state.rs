use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::config::SidecarConfig;
use crate::downloads::DownloadRegistry;
use crate::models::WhisperModel;
use crate::streaming_sessions::TranscriptionSessionRegistry;
use crate::transcription::TranscriptionEngine;

#[derive(Clone)]
pub struct AppState {
    pub config: SidecarConfig,
    pub downloads: DownloadRegistry,
    model_download_locks: Arc<Mutex<HashMap<WhisperModel, Arc<Mutex<()>>>>>,
    pub transcription_sessions: TranscriptionSessionRegistry,
    pub http_client: reqwest::Client,
    pub transcriber: TranscriptionEngine,
}

impl AppState {
    pub fn new(config: SidecarConfig) -> Result<Self, String> {
        let http_client = reqwest::Client::builder()
            .user_agent("mausvoice-rust-transcription/0.1")
            .build()
            .map_err(|err| format!("failed to initialize http client: {err}"))?;

        Ok(Self {
            transcriber: TranscriptionEngine::new(config.mode),
            config,
            downloads: DownloadRegistry::default(),
            model_download_locks: Arc::new(Mutex::new(HashMap::new())),
            transcription_sessions: TranscriptionSessionRegistry::default(),
            http_client,
        })
    }

    pub async fn model_download_lock(&self, model: WhisperModel) -> Arc<Mutex<()>> {
        let mut locks = self.model_download_locks.lock().await;
        locks
            .entry(model)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub fn model_path(&self, model: WhisperModel) -> PathBuf {
        model.storage_path(&self.config.models_dir)
    }
}
