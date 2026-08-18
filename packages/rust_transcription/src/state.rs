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
fn validate_model_redirect(attempt: Attempt<'_>) -> reqwest::redirect::Action {
    const MAX_REDIRECTS: usize = 5;
    let url = attempt.url();
    // Hugging Face operates the Hub, LFS, and Xet delivery fleet beneath
    // these registrable domains. Allow subdomains (for regional/CDN rollout)
    // but never look-alikes such as `huggingface.co.attacker.example`.
    let approved_host = url.host_str().is_some_and(is_hugging_face_delivery_host);
    if attempt.previous().len() >= MAX_REDIRECTS || url.scheme() != "https" || !approved_host {
        attempt.error("model download redirect rejected by security policy")
    } else {
        attempt.follow()
    }
}

fn is_hugging_face_delivery_host(host: &str) -> bool {
    host == "huggingface.co" || host.ends_with(".huggingface.co") || host.ends_with(".hf.co")
}

#[cfg(test)]
mod tests {
    use super::is_hugging_face_delivery_host;

    #[test]
    fn model_redirect_host_allowlist_accepts_only_hugging_face_domains() {
        for host in [
            "huggingface.co",
            "cdn-lfs-us-1.hf.co",
            "cas-bridge.xethub.hf.co",
        ] {
            assert!(is_hugging_face_delivery_host(host));
        }
        for host in [
            "huggingface.co.attacker.example",
            "evil-hf.co",
            "example.com",
        ] {
            assert!(!is_hugging_face_delivery_host(host));
        }
    }
}
