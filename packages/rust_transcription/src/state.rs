use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use reqwest::redirect::Policy;
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
        let http_client = build_http_client()?;

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

/// Build the HTTP client used for model artifact downloads.
///
/// Redirects are restricted to Hugging Face hosts (the only source of model
/// artifacts) plus loopback addresses used by local tests. REVIEW.md §3.3
/// requires a custom redirect policy that validates the target host so a
/// compromised or upgraded CDN edge cannot silently retarget a multi-GB
/// download to an arbitrary origin.
fn build_http_client() -> Result<reqwest::Client, String> {
    let policy = Policy::custom(|attempt| {
        let allowed = attempt
            .url()
            .host_str()
            .map(is_allowed_download_host)
            .unwrap_or(false);
        if allowed {
            attempt.follow()
        } else {
            attempt.stop()
        }
    });

    reqwest::Client::builder()
        .user_agent("mausvoice-rust-transcription/0.1")
        .redirect(policy)
        .build()
        .map_err(|err| format!("failed to initialize http client: {err}"))
}

fn is_allowed_download_host(host: &str) -> bool {
    if host == "huggingface.co"
        || host.ends_with(".huggingface.co")
        || host == "hf.co"
        || host.ends_with(".hf.co")
    {
        return true;
    }

    // Loopback is only reachable in local/test scenarios and cannot be targeted
    // by an external redirect, so permitting it here does not widen the
    // production attack surface.
    host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1"
}
