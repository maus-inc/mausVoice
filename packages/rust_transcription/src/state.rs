use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use reqwest::redirect::{Attempt, Policy};

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
            .redirect(Policy::custom(validate_model_redirect))
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

/// Hugging Face serves LFS objects through a small set of HTTPS CDN hosts.
/// Do not let a compromised/misconfigured model URL pivot the sidecar to an
/// arbitrary host or a non-TLS scheme.
fn validate_model_redirect(attempt: &Attempt<'_>) -> reqwest::redirect::Action {
    const MAX_REDIRECTS: usize = 5;
    let url = attempt.url();
    let approved_host = matches!(
        url.host_str(),
        Some("huggingface.co")
            | Some("cdn-lfs.huggingface.co")
            | Some("cas-bridge.xethub.hf.co")
            | Some("transfer.xethub.hf.co")
    );
    if attempt.previous().len() >= MAX_REDIRECTS || url.scheme() != "https" || !approved_host {
        attempt.error("model download redirect rejected by security policy")
    } else {
        attempt.follow()
    }
}
