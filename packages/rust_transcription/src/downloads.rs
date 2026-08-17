use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::{watch, Mutex};
use uuid::Uuid;

use crate::models::WhisperModel;

struct DownloadJobParams {
    job_id: Uuid,
    generation: u64,
    model: WhisperModel,
    artifacts: Vec<DownloadArtifact>,
    client: reqwest::Client,
    control_rx: watch::Receiver<DownloadCommand>,
    prev_worker_rx: Option<watch::Receiver<bool>>,
    finished_tx: watch::Sender<bool>,
}

/// Largest currently-supported model artifact plus headroom. This is a hard
/// limit, not a progress hint, and protects users from chunked responses.
pub const MAX_MODEL_ARTIFACT_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadJobStatus {
    Pending,
    Running,
    Paused,
    Completed,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJobSnapshot {
    pub job_id: Uuid,
    pub model: WhisperModel,
    pub status: DownloadJobStatus,
    pub bytes_downloaded: u64,
    pub total_bytes: Option<u64>,
    pub progress: Option<f64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DownloadArtifact {
    pub url: String,
    pub destination: PathBuf,
    /// Hard upper bound enforced for both declared and chunked responses.
    pub max_bytes: u64,
    /// Pinned digest for executable ONNX graphs/weights.
    pub sha256: Option<&'static str>,
}

impl DownloadArtifact {
    pub fn new(url: String, destination: PathBuf) -> Self {
        Self::new_verified(url, destination, MAX_MODEL_ARTIFACT_BYTES, None)
    }

    pub fn new_verified(
        url: String,
        destination: PathBuf,
        max_bytes: u64,
        sha256: Option<&'static str>,
    ) -> Self {
        Self {
            url,
            destination,
            max_bytes,
            sha256,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadCommand {
    Run,
    Pause,
    Cancel,
}

enum ArtifactDownloadOutcome {
    Completed { bytes: u64 },
    Paused,
    Canceled,
    Obsolete,
}

#[derive(Clone)]
struct DownloadJobRecord {
    model: WhisperModel,
    status: DownloadJobStatus,
    bytes_downloaded: u64,
    total_bytes: Option<u64>,
    error: Option<String>,
    generation: u64,
    is_finalizing: bool,
    artifact_paths: Vec<PathBuf>,
    control_tx: Option<watch::Sender<DownloadCommand>>,
    worker_finished_rx: Option<watch::Receiver<bool>>,
}

impl DownloadJobRecord {
    fn to_snapshot(&self, job_id: Uuid) -> DownloadJobSnapshot {
        let progress = match self.total_bytes {
            Some(total) if total > 0 => {
                Some((self.bytes_downloaded as f64 / total as f64).min(1.0))
            }
            Some(_) => Some(1.0),
            None => None,
        };

        DownloadJobSnapshot {
            job_id,
            model: self.model,
            status: self.status,
            bytes_downloaded: self.bytes_downloaded,
            total_bytes: self.total_bytes,
            progress,
            error: self.error.clone(),
        }
    }
}

#[derive(Default)]
struct DownloadStore {
    jobs: HashMap<Uuid, DownloadJobRecord>,
    active_by_model: HashMap<WhisperModel, Uuid>,
    latest_by_model: HashMap<WhisperModel, Uuid>,
}

#[derive(Clone, Default)]
pub struct DownloadRegistry {
    inner: Arc<Mutex<DownloadStore>>,
}

impl DownloadRegistry {
    pub async fn start_or_get_active(
        &self,
        model: WhisperModel,
        artifacts: Vec<DownloadArtifact>,
        client: reqwest::Client,
    ) -> Result<DownloadJobSnapshot, String> {
        if artifacts.is_empty() {
            return Err("download job requires at least one artifact".to_string());
        }

        let artifact_paths = artifacts
            .iter()
            .map(|artifact| artifact.destination.clone())
            .collect::<Vec<_>>();
        // A bundle already on disk is only reported as completed when every
        // artifact still satisfies the current integrity policy (size cap plus
        // the pinned digest). Files written by an older build under mutable
        // `resolve/main/` URLs are therefore re-verified instead of trusted.
        if let Some(existing_size) = admitted_artifact_set_size(&artifacts).await {
            let job_id = Uuid::new_v4();
            let mut store = self.inner.lock().await;
            let record = DownloadJobRecord {
                model,
                status: DownloadJobStatus::Completed,
                bytes_downloaded: existing_size,
                total_bytes: Some(existing_size),
                error: None,
                generation: 1,
                is_finalizing: false,
                artifact_paths,
                control_tx: None,
                worker_finished_rx: None,
            };
            let snapshot = record.to_snapshot(job_id);
            store.jobs.insert(job_id, record);
            store.latest_by_model.insert(model, job_id);

            return Ok(snapshot);
        }

        let (job_id, generation, snapshot, control_rx, prev_worker_rx, finished_tx, should_spawn) = {
            let mut store = self.inner.lock().await;

            if let Some(existing_id) = store.active_by_model.get(&model).copied() {
                if let Some(record) = store.jobs.get_mut(&existing_id) {
                    if record.status == DownloadJobStatus::Paused && !record.is_finalizing {
                        let prev_finished_rx = record.worker_finished_rx.clone();
                        // Signal any previous worker to stop if it hasn't already
                        if let Some(tx) = &record.control_tx {
                            let _ = tx.send(DownloadCommand::Pause);
                        }
                        record.generation += 1;
                        let generation = record.generation;
                        let (control_tx, control_rx) = watch::channel(DownloadCommand::Run);
                        let (finished_tx, finished_rx) = watch::channel(false);
                        record.status = DownloadJobStatus::Pending;
                        record.error = None;
                        record.artifact_paths = artifact_paths.clone();
                        record.control_tx = Some(control_tx);
                        record.worker_finished_rx = Some(finished_rx);
                        let snapshot = record.to_snapshot(existing_id);
                        (
                            existing_id,
                            generation,
                            snapshot,
                            Some(control_rx),
                            prev_finished_rx,
                            Some(finished_tx),
                            true,
                        )
                    } else {
                        let generation = record.generation;
                        let existing = record.to_snapshot(existing_id);
                        (existing_id, generation, existing, None, None, None, false)
                    }
                } else {
                    store.active_by_model.remove(&model);
                    let (control_tx, control_rx) = watch::channel(DownloadCommand::Run);
                    let (finished_tx, finished_rx) = watch::channel(false);
                    let new_job_id = Uuid::new_v4();
                    let record = DownloadJobRecord {
                        model,
                        status: DownloadJobStatus::Pending,
                        bytes_downloaded: 0,
                        total_bytes: None,
                        error: None,
                        generation: 1,
                        is_finalizing: false,
                        artifact_paths: artifact_paths.clone(),
                        control_tx: Some(control_tx),
                        worker_finished_rx: Some(finished_rx),
                    };
                    let snapshot = record.to_snapshot(new_job_id);
                    store.jobs.insert(new_job_id, record);
                    store.active_by_model.insert(model, new_job_id);
                    store.latest_by_model.insert(model, new_job_id);
                    (
                        new_job_id,
                        1,
                        snapshot,
                        Some(control_rx),
                        None,
                        Some(finished_tx),
                        true,
                    )
                }
            } else {
                let job_id = Uuid::new_v4();
                let (control_tx, control_rx) = watch::channel(DownloadCommand::Run);
                let (finished_tx, finished_rx) = watch::channel(false);
                let record = DownloadJobRecord {
                    model,
                    status: DownloadJobStatus::Pending,
                    bytes_downloaded: 0,
                    total_bytes: None,
                    error: None,
                    generation: 1,
                    is_finalizing: false,
                    artifact_paths: artifact_paths.clone(),
                    control_tx: Some(control_tx),
                    worker_finished_rx: Some(finished_rx),
                };
                let snapshot = record.to_snapshot(job_id);
                store.jobs.insert(job_id, record);
                store.active_by_model.insert(model, job_id);
                store.latest_by_model.insert(model, job_id);

                (
                    job_id,
                    1,
                    snapshot,
                    Some(control_rx),
                    None,
                    Some(finished_tx),
                    true,
                )
            }
        };

        if should_spawn {
            if let (Some(control_rx), Some(finished_tx)) = (control_rx, finished_tx) {
                let registry = self.clone();
                tokio::spawn(async move {
                    if let Err(err) = registry
                        .run_download_job(DownloadJobParams {
                            job_id,
                            generation,
                            model,
                            artifacts,
                            client,
                            control_rx,
                            prev_worker_rx,
                            finished_tx,
                        })
                        .await
                    {
                        registry.mark_failed(job_id, generation, model, err).await;
                    }
                });
            }
        }

        Ok(snapshot)
    }

    pub async fn pause_job(
        &self,
        model: WhisperModel,
        job_id: Uuid,
    ) -> Option<DownloadJobSnapshot> {
        let mut store = self.inner.lock().await;
        let job = store.jobs.get_mut(&job_id)?;
        if job.model != model {
            return None;
        }

        if job.is_finalizing || job.status == DownloadJobStatus::Completed {
            return Some(job.to_snapshot(job_id));
        }

        if matches!(
            job.status,
            DownloadJobStatus::Running | DownloadJobStatus::Pending
        ) {
            if let Some(control_tx) = &job.control_tx {
                let _ = control_tx.send(DownloadCommand::Pause);
            }
            job.status = DownloadJobStatus::Paused;
        }

        Some(job.to_snapshot(job_id))
    }

    pub async fn pause_active(&self, model: WhisperModel) -> Option<DownloadJobSnapshot> {
        let job_id = {
            let store = self.inner.lock().await;
            store.active_by_model.get(&model).copied()?
        };
        self.pause_job(model, job_id).await
    }

    pub async fn cancel_job(
        &self,
        model: WhisperModel,
        job_id: Uuid,
    ) -> Option<DownloadJobSnapshot> {
        let (snapshot, temp_file_paths) = {
            let mut store = self.inner.lock().await;
            let job = store.jobs.get_mut(&job_id)?;
            if job.model != model {
                return None;
            }

            if job.is_finalizing || job.status == DownloadJobStatus::Completed {
                return Some(job.to_snapshot(job_id));
            }

            if let Some(control_tx) = &job.control_tx {
                let _ = control_tx.send(DownloadCommand::Cancel);
            }

            job.generation += 1;
            job.status = DownloadJobStatus::Canceled;
            job.control_tx = None;
            let snapshot = job.to_snapshot(job_id);
            let temp_file_paths = job
                .artifact_paths
                .iter()
                .filter_map(|destination| temporary_artifact_path(destination, job_id).ok())
                .collect::<Vec<_>>();
            store.active_by_model.remove(&model);
            (snapshot, temp_file_paths)
        };

        tokio::spawn(async move {
            for temp_file_path in temp_file_paths {
                let validator_path = temporary_validator_path(&temp_file_path).ok();
                let _ = tokio::fs::remove_file(temp_file_path).await;
                if let Some(validator_path) = validator_path {
                    let _ = tokio::fs::remove_file(validator_path).await;
                }
            }
        });

        Some(snapshot)
    }

    pub async fn cancel_active(&self, model: WhisperModel) -> Option<DownloadJobSnapshot> {
        let job_id = {
            let store = self.inner.lock().await;
            store.active_by_model.get(&model).copied()?
        };
        self.cancel_job(model, job_id).await
    }

    pub async fn get_job(&self, model: WhisperModel, job_id: Uuid) -> Option<DownloadJobSnapshot> {
        let store = self.inner.lock().await;
        let snapshot = store.snapshot(job_id)?;
        if snapshot.model == model {
            Some(snapshot)
        } else {
            None
        }
    }

    pub async fn get_active_job(&self, model: WhisperModel) -> Option<DownloadJobSnapshot> {
        let store = self.inner.lock().await;
        let job_id = store.active_by_model.get(&model).copied()?;
        store.snapshot(job_id)
    }

    pub async fn get_latest_job(&self, model: WhisperModel) -> Option<DownloadJobSnapshot> {
        let store = self.inner.lock().await;
        let job_id = store.latest_by_model.get(&model).copied()?;
        store.snapshot(job_id)
    }

    pub async fn clear_model_history(&self, model: WhisperModel) {
        let mut store = self.inner.lock().await;
        store.active_by_model.remove(&model);
        store.latest_by_model.remove(&model);
        store.jobs.retain(|_, job| job.model != model);
    }

    async fn run_download_job(&self, params: DownloadJobParams) -> Result<(), String> {
        let DownloadJobParams {
            job_id,
            generation,
            model,
            artifacts,
            client,
            mut control_rx,
            prev_worker_rx,
            finished_tx,
        } = params;
        // A resumed worker waits for its predecessor to close the active
        // artifact before opening the same partial file.
        if let Some(mut prev_rx) = prev_worker_rx {
            while !*prev_rx.borrow_and_update() {
                if prev_rx.changed().await.is_err() {
                    break;
                }
            }
        }

        let result = self
            .run_download_job_internal(
                job_id,
                generation,
                model,
                artifacts,
                client,
                &mut control_rx,
            )
            .await;

        let _ = finished_tx.send(true);
        result
    }

    async fn run_download_job_internal(
        &self,
        job_id: Uuid,
        generation: u64,
        model: WhisperModel,
        artifacts: Vec<DownloadArtifact>,
        client: reqwest::Client,
        control_rx: &mut watch::Receiver<DownloadCommand>,
    ) -> Result<(), String> {
        if !self.mark_running(job_id, generation).await {
            return Ok(());
        }

        let mut completed_bytes = 0_u64;
        for artifact in artifacts {
            let outcome = self
                .download_artifact(
                    job_id,
                    generation,
                    &artifact,
                    &client,
                    control_rx,
                    completed_bytes,
                )
                .await
                .map_err(|err| {
                    format!(
                        "artifact '{}' download failed: {err}",
                        artifact.destination.display()
                    )
                })?;

            match outcome {
                ArtifactDownloadOutcome::Completed { bytes } => {
                    completed_bytes = completed_bytes.saturating_add(bytes);
                    self.set_progress(job_id, generation, completed_bytes, None)
                        .await;
                }
                ArtifactDownloadOutcome::Paused => {
                    self.mark_paused(job_id, generation).await;
                    return Ok(());
                }
                ArtifactDownloadOutcome::Canceled => {
                    self.mark_canceled(job_id, generation, model).await;
                    return Ok(());
                }
                ArtifactDownloadOutcome::Obsolete => return Ok(()),
            }
        }

        // Publish completion only after every required graph, weights, and
        // tokenizer/vocabulary artifact has been durably moved into place.
        if !self.claim_finalization(job_id, generation).await {
            return Ok(());
        }
        self.mark_completed(
            job_id,
            generation,
            model,
            completed_bytes,
            Some(completed_bytes),
        )
        .await;
        Ok(())
    }

    async fn download_artifact(
        &self,
        job_id: Uuid,
        generation: u64,
        artifact: &DownloadArtifact,
        client: &reqwest::Client,
        control_rx: &mut watch::Receiver<DownloadCommand>,
        completed_before: u64,
    ) -> Result<ArtifactDownloadOutcome, String> {
        let command = *control_rx.borrow_and_update();
        match command {
            DownloadCommand::Pause => return Ok(ArtifactDownloadOutcome::Paused),
            DownloadCommand::Cancel => return Ok(ArtifactDownloadOutcome::Canceled),
            DownloadCommand::Run => {}
        }

        // An artifact that is already present is a shortcut, never an exemption:
        // it must pass exactly the size + SHA-256 gate enforced on a fresh
        // download. Anything else is discarded and re-fetched.
        if existing_model_file_size(&artifact.destination)
            .await
            .is_some()
        {
            if let Some(existing_size) = admitted_artifact_size(artifact).await {
                return Ok(ArtifactDownloadOutcome::Completed {
                    bytes: existing_size,
                });
            }
            discard_rejected_artifact(&artifact.destination, Some(job_id)).await;
        }

        if let Some(parent) = artifact.destination.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|err| format!("failed to create model directory: {err}"))?;
        }

        let temp_path = temporary_artifact_path(&artifact.destination, job_id)?;
        let validator_path = temporary_validator_path(&temp_path)?;
        let existing_bytes = match tokio::fs::metadata(&temp_path).await {
            Ok(metadata) if metadata.is_file() => metadata.len(),
            _ => 0,
        };
        let existing_validator = if existing_bytes > 0 {
            tokio::fs::read_to_string(&validator_path)
                .await
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        } else {
            None
        };

        let (response, resume_is_valid) = match request_artifact_response(
            client,
            &artifact.url,
            existing_bytes,
            existing_validator.as_deref(),
            artifact.max_bytes,
        )
        .await
        {
            Ok(response) => response,
            Err(error) => {
                // A rejected advertised size must not leave a resumable
                // partial artifact behind. Otherwise every retry preserves
                // data from a response that violated the policy.
                let _ = tokio::fs::remove_file(&temp_path).await;
                let _ = tokio::fs::remove_file(&validator_path).await;
                return Err(error);
            }
        };
        let validator = response_resume_validator(&response).or_else(|| {
            if resume_is_valid {
                existing_validator.clone()
            } else {
                None
            }
        });
        if let Some(validator) = validator {
            tokio::fs::write(&validator_path, validator)
                .await
                .map_err(|err| format!("failed to persist download validator: {err}"))?;
        } else {
            let _ = tokio::fs::remove_file(&validator_path).await;
        }

        let (mut downloaded, artifact_total, mut file) = if resume_is_valid {
            let total = response
                .content_length()
                .map(|len| existing_bytes.saturating_add(len));
            let file = tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&temp_path)
                .await
                .map_err(|err| format!("failed to open temporary file for append: {err}"))?;
            (existing_bytes, total, file)
        } else {
            let total = response.content_length();
            let file = tokio::fs::File::create(&temp_path)
                .await
                .map_err(|err| format!("failed to create temporary file: {err}"))?;
            (0_u64, total, file)
        };

        self.set_progress(
            job_id,
            generation,
            completed_before.saturating_add(downloaded),
            artifact_total.map(|total| completed_before.saturating_add(total)),
        )
        .await;

        let mut stream = response.bytes_stream();
        loop {
            tokio::select! {
                changed = control_rx.changed() => {
                    match changed {
                        Ok(()) => {
                            let command = *control_rx.borrow_and_update();
                            match command {
                                DownloadCommand::Pause => {
                                    file.flush().await
                                        .map_err(|err| format!("failed to flush paused artifact: {err}"))?;
                                    file.sync_all().await
                                        .map_err(|err| format!("failed to sync paused artifact: {err}"))?;
                                    return Ok(ArtifactDownloadOutcome::Paused);
                                }
                                DownloadCommand::Cancel => {
                                    drop(file);
                                    let _ = tokio::fs::remove_file(&temp_path).await;
                                    let _ = tokio::fs::remove_file(&validator_path).await;
                                    return Ok(ArtifactDownloadOutcome::Canceled);
                                }
                                DownloadCommand::Run => {}
                            }
                        }
                        Err(_) => return Ok(ArtifactDownloadOutcome::Obsolete),
                    }
                }
                item = stream.next() => {
                    match item {
                        Some(Ok(chunk)) => {
                            // Enforce the cap *before* writing so an oversized
                            // chunk is never buffered to disk. Incrementing
                            // after `write_all` would flush the whole chunk
                            // first and only detect the breach afterwards.
                            let next = downloaded.saturating_add(chunk.len() as u64);
                            if next > artifact.max_bytes {
                                drop(file);
                                let _ = tokio::fs::remove_file(&temp_path).await;
                                let _ = tokio::fs::remove_file(&validator_path).await;
                                return Err(format!("artifact exceeds {} byte limit", artifact.max_bytes));
                            }
                            file.write_all(&chunk)
                                .await
                                .map_err(|err| format!("failed to write artifact: {err}"))?;
                            downloaded = next;
                            self.set_progress(
                                job_id,
                                generation,
                                completed_before.saturating_add(downloaded),
                                artifact_total.map(|total| completed_before.saturating_add(total)),
                            )
                            .await;
                        }
                        Some(Err(err)) => return Err(format!("stream failed: {err}")),
                        None => break,
                    }
                }
            }
        }

        validate_downloaded_size(downloaded, artifact_total)?;

        file.flush()
            .await
            .map_err(|err| format!("failed to flush artifact: {err}"))?;
        file.sync_all()
            .await
            .map_err(|err| format!("failed to sync artifact: {err}"))?;
        drop(file);

        if let Some(expected_sha256) = artifact.sha256 {
            if let Err(error) = verify_file_sha256(&temp_path, expected_sha256).await {
                let _ = tokio::fs::remove_file(&temp_path).await;
                let _ = tokio::fs::remove_file(&validator_path).await;
                return Err(error);
            }
        }

        // Block pause/cancel only for the short replace+rename section. The
        // control sender stays installed for every subsequent artifact.
        if !self.begin_artifact_finalization(job_id, generation).await {
            let is_canceled = {
                let store = self.inner.lock().await;
                store
                    .jobs
                    .get(&job_id)
                    .map(|j| j.status == DownloadJobStatus::Canceled)
                    .unwrap_or(false)
            };
            if is_canceled {
                let _ = tokio::fs::remove_file(&temp_path).await;
                let _ = tokio::fs::remove_file(&validator_path).await;
            }
            return Ok(ArtifactDownloadOutcome::Obsolete);
        }

        if artifact.destination.exists() {
            tokio::fs::remove_file(&artifact.destination)
                .await
                .map_err(|err| format!("failed to replace existing artifact: {err}"))?;
        }
        tokio::fs::rename(&temp_path, &artifact.destination)
            .await
            .map_err(|err| format!("failed to finalize artifact: {err}"))?;
        let _ = tokio::fs::remove_file(&validator_path).await;
        self.end_artifact_finalization(job_id, generation).await;

        Ok(ArtifactDownloadOutcome::Completed { bytes: downloaded })
    }

    async fn begin_artifact_finalization(&self, job_id: Uuid, generation: u64) -> bool {
        let mut store = self.inner.lock().await;
        if let Some(job) = store.jobs.get_mut(&job_id) {
            if job.generation == generation
                && job.status == DownloadJobStatus::Running
                && !job.is_finalizing
            {
                job.is_finalizing = true;
                return true;
            }
        }
        false
    }

    async fn end_artifact_finalization(&self, job_id: Uuid, generation: u64) {
        let mut store = self.inner.lock().await;
        if let Some(job) = store.jobs.get_mut(&job_id) {
            if job.generation == generation && job.status == DownloadJobStatus::Running {
                job.is_finalizing = false;
            }
        }
    }

    async fn claim_finalization(&self, job_id: Uuid, generation: u64) -> bool {
        let mut store = self.inner.lock().await;
        if let Some(job) = store.jobs.get_mut(&job_id) {
            if job.generation == generation
                && matches!(
                    job.status,
                    DownloadJobStatus::Pending | DownloadJobStatus::Running
                )
                && !job.is_finalizing
            {
                job.is_finalizing = true;
                job.control_tx = None;
                return true;
            }
        }
        false
    }

    async fn mark_running(&self, job_id: Uuid, generation: u64) -> bool {
        let mut store = self.inner.lock().await;
        if let Some(job) = store.jobs.get_mut(&job_id) {
            if job.generation == generation
                && matches!(
                    job.status,
                    DownloadJobStatus::Pending | DownloadJobStatus::Running
                )
            {
                job.status = DownloadJobStatus::Running;
                job.error = None;
                return true;
            }
        }
        false
    }

    async fn mark_paused(&self, job_id: Uuid, generation: u64) {
        let mut store = self.inner.lock().await;
        if let Some(job) = store.jobs.get_mut(&job_id) {
            if job.generation == generation && !job.is_finalizing {
                job.status = DownloadJobStatus::Paused;
                job.control_tx = None;
            }
        }
    }

    async fn mark_canceled(&self, job_id: Uuid, generation: u64, model: WhisperModel) {
        let mut store = self.inner.lock().await;
        if let Some(job) = store.jobs.get_mut(&job_id) {
            if job.generation == generation {
                job.status = DownloadJobStatus::Canceled;
                job.is_finalizing = false;
                job.control_tx = None;
                store.active_by_model.remove(&model);
            }
        }
    }

    async fn set_progress(
        &self,
        job_id: Uuid,
        generation: u64,
        downloaded: u64,
        total_bytes: Option<u64>,
    ) {
        let mut store = self.inner.lock().await;
        if let Some(job) = store.jobs.get_mut(&job_id) {
            if job.generation == generation
                && matches!(
                    job.status,
                    DownloadJobStatus::Pending | DownloadJobStatus::Running
                )
            {
                job.bytes_downloaded = downloaded;
                job.total_bytes = match (job.total_bytes, total_bytes) {
                    (Some(existing), Some(incoming)) => Some(existing.max(incoming)),
                    (Some(existing), None) => Some(existing),
                    (None, incoming) => incoming,
                };
            }
        }
    }

    async fn mark_completed(
        &self,
        job_id: Uuid,
        generation: u64,
        model: WhisperModel,
        downloaded: u64,
        total_bytes: Option<u64>,
    ) {
        let mut store = self.inner.lock().await;
        if let Some(job) = store.jobs.get_mut(&job_id) {
            if job.generation == generation {
                job.status = DownloadJobStatus::Completed;
                job.bytes_downloaded = downloaded;
                let completed_total = total_bytes.unwrap_or(downloaded).max(downloaded);
                job.total_bytes = Some(
                    job.total_bytes
                        .map_or(completed_total, |existing| existing.max(completed_total)),
                );
                job.error = None;
                job.is_finalizing = false;
                job.control_tx = None;
                store.active_by_model.remove(&model);
            }
        }
    }

    async fn mark_failed(
        &self,
        job_id: Uuid,
        generation: u64,
        model: WhisperModel,
        error_message: String,
    ) {
        let mut store = self.inner.lock().await;
        if let Some(job) = store.jobs.get_mut(&job_id) {
            if job.generation == generation {
                job.status = DownloadJobStatus::Failed;
                job.error = Some(error_message);
                job.is_finalizing = false;
                job.control_tx = None;
                store.active_by_model.remove(&model);
            }
        }
    }
}

impl DownloadStore {
    fn snapshot(&self, job_id: Uuid) -> Option<DownloadJobSnapshot> {
        self.jobs.get(&job_id).map(|job| job.to_snapshot(job_id))
    }
}

fn validate_downloaded_size(downloaded: u64, expected: Option<u64>) -> Result<(), String> {
    if let Some(expected) = expected {
        if downloaded != expected {
            return Err(format!(
                "downloaded byte count mismatch: received {downloaded}, expected {expected}"
            ));
        }
    }
    Ok(())
}

async fn request_artifact_response(
    client: &reqwest::Client,
    url: &str,
    existing_bytes: u64,
    if_range: Option<&str>,
    max_bytes: u64,
) -> Result<(reqwest::Response, bool), String> {
    // Never append without a validator tied to the existing prefix. A bare
    // byte offset cannot prove that the remote object is still the same file.
    if existing_bytes > max_bytes {
        return Err(format!(
            "existing partial artifact exceeds {max_bytes} byte limit"
        ));
    }
    if let Some(if_range) = if_range.filter(|_| existing_bytes > 0) {
        let ranged = client
            .get(url)
            .header(reqwest::header::RANGE, format!("bytes={existing_bytes}-"))
            .header(reqwest::header::IF_RANGE, if_range)
            .send()
            .await
            .map_err(|err| format!("request failed: {err}"))?;

        if ranged.status() == reqwest::StatusCode::PARTIAL_CONTENT {
            if content_range_start(&ranged) == Some(existing_bytes) {
                reject_oversized_response(&ranged, max_bytes.saturating_sub(existing_bytes))?;
                return Ok((ranged, true));
            }
            // A 206 response is append-safe only when the server confirms
            // the exact requested offset. Restart from byte zero.
        } else if ranged.status() == reqwest::StatusCode::OK {
            // If-Range intentionally produces 200 when the remote object
            // changed. The caller truncates the stale temporary prefix.
            reject_oversized_response(&ranged, max_bytes)?;
            return Ok((ranged, false));
        } else if ranged.status() != reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            return Err(format!("request failed with status {}", ranged.status()));
        }
    }

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|err| format!("request failed: {err}"))?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!("request failed with status {}", response.status()));
    }
    reject_oversized_response(&response, max_bytes)?;
    Ok((response, false))
}

fn reject_oversized_response(response: &reqwest::Response, max_bytes: u64) -> Result<(), String> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes)
    {
        return Err(format!("artifact exceeds {max_bytes} byte limit"));
    }
    Ok(())
}

async fn verify_file_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let path = path.to_path_buf();
    let expected = expected.to_owned();
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut file = std::fs::File::open(&path)
            .map_err(|err| format!("failed to reopen artifact for checksum: {err}"))?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file
                .read(&mut buffer)
                .map_err(|err| format!("failed to checksum artifact: {err}"))?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        let actual = format!("{:x}", hasher.finalize());
        if actual.eq_ignore_ascii_case(&expected) {
            Ok(())
        } else {
            Err(format!(
                "artifact SHA-256 mismatch (expected {expected}, got {actual})"
            ))
        }
    })
    .await
    .map_err(|err| format!("checksum task failed: {err}"))?
}

fn content_range_start(response: &reqwest::Response) -> Option<u64> {
    let value = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)?
        .to_str()
        .ok()?
        .strip_prefix("bytes ")?;
    value.split_once('-')?.0.parse().ok()
}

fn response_resume_validator(response: &reqwest::Response) -> Option<String> {
    let strong_etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.starts_with("W/"));
    strong_etag
        .or_else(|| {
            response
                .headers()
                .get(reqwest::header::LAST_MODIFIED)
                .and_then(|value| value.to_str().ok())
        })
        .map(str::to_owned)
}

async fn existing_model_file_size(path: &Path) -> Option<u64> {
    match tokio::fs::metadata(path).await {
        Ok(metadata) if metadata.is_file() && metadata.len() > 0 => Some(metadata.len()),
        _ => None,
    }
}

/// Admission gate for an artifact that is already present on disk.
///
/// Returns `true` only when the existing file satisfies the same policy the
/// fresh-download path enforces: it is within `max_bytes` **and**, when a digest
/// is pinned, its SHA-256 matches. Without this gate an artifact fetched by an
/// older build (mutable `resolve/main/` URL, no digest policy) would be trusted
/// forever and would silently bypass the pinning trust boundary.
async fn artifact_admitted(destination: &Path, max_bytes: u64, sha256: Option<&str>) -> bool {
    let Some(size) = existing_model_file_size(destination).await else {
        return false;
    };
    if size > max_bytes {
        return false;
    }
    match sha256 {
        Some(expected) => verify_file_sha256(destination, expected).await.is_ok(),
        None => true,
    }
}

/// Size of a pre-existing artifact that passed the admission gate.
async fn admitted_artifact_size(artifact: &DownloadArtifact) -> Option<u64> {
    let size = existing_model_file_size(&artifact.destination).await?;
    if artifact_admitted(&artifact.destination, artifact.max_bytes, artifact.sha256).await {
        Some(size)
    } else {
        None
    }
}

/// Total size of a complete artifact set, but only when **every** artifact
/// passes the admission gate. Rejected files are removed so the download path
/// cannot mistake them for completed artifacts; artifacts that passed the gate
/// are preserved so a partially valid bundle is not re-downloaded in full.
async fn admitted_artifact_set_size(artifacts: &[DownloadArtifact]) -> Option<u64> {
    let mut total = Some(0_u64);
    for artifact in artifacts {
        match admitted_artifact_size(artifact).await {
            Some(size) => {
                total = total.and_then(|sum| sum.checked_add(size));
            }
            None => {
                // Missing, oversized, or digest-mismatched. Removal is a no-op
                // for an artifact that was simply never downloaded.
                discard_rejected_artifact(&artifact.destination, None).await;
                total = None;
            }
        }
    }
    total
}

/// Delete an artifact that failed the admission gate, plus the job-scoped
/// partial download and resume validator when the caller owns a job. The
/// artifact is then re-downloaded from byte zero under the current policy.
async fn discard_rejected_artifact(destination: &Path, job_id: Option<Uuid>) {
    let _ = tokio::fs::remove_file(destination).await;
    let Some(job_id) = job_id else {
        return;
    };
    if let Ok(temp_path) = temporary_artifact_path(destination, job_id) {
        if let Ok(validator_path) = temporary_validator_path(&temp_path) {
            let _ = tokio::fs::remove_file(validator_path).await;
        }
        let _ = tokio::fs::remove_file(temp_path).await;
    }
}

fn temporary_artifact_path(destination: &Path, job_id: Uuid) -> Result<PathBuf, String> {
    let filename = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid destination filename".to_string())?;
    Ok(destination.with_file_name(format!("{filename}.{job_id}.download")))
}

fn temporary_validator_path(temporary_path: &Path) -> Result<PathBuf, String> {
    let filename = temporary_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid temporary filename".to_string())?;
    Ok(temporary_path.with_file_name(format!("{filename}.validator")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn test_pause_and_resume_generation_isolation() {
        let registry = DownloadRegistry::default();
        let job_id = Uuid::new_v4();
        {
            let mut store = registry.inner.lock().await;
            store.jobs.insert(
                job_id,
                DownloadJobRecord {
                    model: WhisperModel::Tiny,
                    status: DownloadJobStatus::Running,
                    bytes_downloaded: 100,
                    total_bytes: Some(1000),
                    error: None,
                    generation: 1,
                    is_finalizing: false,
                    artifact_paths: Vec::new(),
                    control_tx: None,
                    worker_finished_rx: None,
                },
            );
            store.active_by_model.insert(WhisperModel::Tiny, job_id);
        }

        // Pause the job
        let paused = registry.pause_job(WhisperModel::Tiny, job_id).await;
        assert_eq!(paused.unwrap().status, DownloadJobStatus::Paused);

        // Verify mark_paused with stale generation does not mutate state if generation was bumped
        {
            let mut store = registry.inner.lock().await;
            if let Some(job) = store.jobs.get_mut(&job_id) {
                job.generation = 2;
                job.status = DownloadJobStatus::Pending;
            }
        }
        registry.mark_paused(job_id, 1).await;
        let current = registry.get_job(WhisperModel::Tiny, job_id).await.unwrap();
        assert_eq!(current.status, DownloadJobStatus::Pending);
    }

    #[tokio::test]
    async fn test_claim_finalization_prevents_pause_or_cancel() {
        let registry = DownloadRegistry::default();
        let job_id = Uuid::new_v4();
        {
            let mut store = registry.inner.lock().await;
            store.jobs.insert(
                job_id,
                DownloadJobRecord {
                    model: WhisperModel::Tiny,
                    status: DownloadJobStatus::Running,
                    bytes_downloaded: 1000,
                    total_bytes: Some(1000),
                    error: None,
                    generation: 1,
                    is_finalizing: false,
                    artifact_paths: Vec::new(),
                    control_tx: None,
                    worker_finished_rx: None,
                },
            );
            store.active_by_model.insert(WhisperModel::Tiny, job_id);
        }

        let claimed = registry.claim_finalization(job_id, 1).await;
        assert!(claimed);

        // Subsequent pause should not change status to Paused
        let paused = registry.pause_job(WhisperModel::Tiny, job_id).await;
        assert_ne!(paused.unwrap().status, DownloadJobStatus::Paused);

        // Subsequent cancel should not cancel finalizing job
        let canceled = registry.cancel_job(WhisperModel::Tiny, job_id).await;
        assert_ne!(canceled.unwrap().status, DownloadJobStatus::Canceled);

        // Worker marks completed
        registry
            .mark_completed(job_id, 1, WhisperModel::Tiny, 1000, Some(1000))
            .await;
        let final_job = registry.get_job(WhisperModel::Tiny, job_id).await.unwrap();
        assert_eq!(final_job.status, DownloadJobStatus::Completed);
    }

    #[tokio::test]
    async fn test_cancel_job_cleans_up_all_bundle_temp_files() {
        let temp_dir = tempfile::tempdir().unwrap();
        let destination = temp_dir.path().join("model.bin");
        let auxiliary_destination = temp_dir.path().join("tokens.txt");
        let registry = DownloadRegistry::default();
        let job_id = Uuid::new_v4();

        let temp_file = temporary_artifact_path(&destination, job_id).unwrap();
        let auxiliary_temp_file = temporary_artifact_path(&auxiliary_destination, job_id).unwrap();
        let validator_file = temporary_validator_path(&temp_file).unwrap();
        let auxiliary_validator_file = temporary_validator_path(&auxiliary_temp_file).unwrap();
        tokio::fs::write(&temp_file, b"partial bytes")
            .await
            .unwrap();
        tokio::fs::write(&auxiliary_temp_file, b"partial tokens")
            .await
            .unwrap();
        tokio::fs::write(&validator_file, b"\"model-v1\"")
            .await
            .unwrap();
        tokio::fs::write(&auxiliary_validator_file, b"\"tokens-v1\"")
            .await
            .unwrap();
        assert!(temp_file.exists());
        assert!(auxiliary_temp_file.exists());
        assert!(validator_file.exists());
        assert!(auxiliary_validator_file.exists());

        {
            let mut store = registry.inner.lock().await;
            store.jobs.insert(
                job_id,
                DownloadJobRecord {
                    model: WhisperModel::Tiny,
                    status: DownloadJobStatus::Running,
                    bytes_downloaded: 50,
                    total_bytes: Some(100),
                    error: None,
                    generation: 1,
                    is_finalizing: false,
                    artifact_paths: vec![destination.clone(), auxiliary_destination.clone()],
                    control_tx: None,
                    worker_finished_rx: None,
                },
            );
            store.active_by_model.insert(WhisperModel::Tiny, job_id);
        }

        let canceled = registry.cancel_job(WhisperModel::Tiny, job_id).await;
        assert_eq!(canceled.unwrap().status, DownloadJobStatus::Canceled);

        // Wait for async deletion task
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        assert!(!temp_file.exists());
        assert!(!auxiliary_temp_file.exists());
        assert!(!validator_file.exists());
        assert!(!auxiliary_validator_file.exists());
    }

    #[tokio::test]
    async fn test_pause_and_resume_worker_handover_preserves_file() {
        let temp_dir = tempfile::tempdir().unwrap();
        let destination = temp_dir.path().join("model.bin");
        let registry = DownloadRegistry::default();
        let job_id = Uuid::new_v4();

        let filename = destination.file_name().and_then(|n| n.to_str()).unwrap();
        let temp_file = destination.with_file_name(format!("{filename}.{job_id}.download"));
        tokio::fs::write(&temp_file, b"first-chunk").await.unwrap();

        let (finished_tx, finished_rx) = watch::channel(false);
        {
            let mut store = registry.inner.lock().await;
            store.jobs.insert(
                job_id,
                DownloadJobRecord {
                    model: WhisperModel::Tiny,
                    status: DownloadJobStatus::Paused,
                    bytes_downloaded: 11,
                    total_bytes: Some(22),
                    error: None,
                    generation: 1,
                    is_finalizing: false,
                    artifact_paths: vec![destination.clone()],
                    control_tx: None,
                    worker_finished_rx: Some(finished_rx),
                },
            );
            store.active_by_model.insert(WhisperModel::Tiny, job_id);
        }

        // Simulate old worker releasing file
        finished_tx.send(true).unwrap();

        // Resuming the job
        let client = reqwest::Client::new();
        let snapshot = registry
            .start_or_get_active(
                WhisperModel::Tiny,
                vec![DownloadArtifact::new(
                    "http://127.0.0.1:9999/model.bin".to_string(),
                    destination.clone(),
                )],
                client,
            )
            .await
            .unwrap();

        assert_eq!(snapshot.status, DownloadJobStatus::Pending);
        assert_eq!(snapshot.bytes_downloaded, 11);
    }

    #[tokio::test]
    async fn bundle_job_waits_for_auxiliary_artifact() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted_tx, accepted_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await.unwrap();
            let _ = accepted_tx.send(());
            let _ = release_rx.await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\naux")
                .await
                .unwrap();
        });

        let temp_dir = tempfile::tempdir().unwrap();
        let primary = temp_dir.path().join("encoder.onnx");
        let auxiliary = temp_dir.path().join("vocab.txt");
        tokio::fs::write(&primary, b"existing primary")
            .await
            .unwrap();
        let registry = DownloadRegistry::default();
        let snapshot = registry
            .start_or_get_active(
                WhisperModel::ParakeetTdt06B,
                vec![
                    DownloadArtifact::new("http://unused.invalid".to_string(), primary),
                    DownloadArtifact::new(format!("http://{address}/vocab.txt"), auxiliary.clone()),
                ],
                reqwest::Client::new(),
            )
            .await
            .unwrap();

        accepted_rx.await.unwrap();
        let running = registry
            .get_job(WhisperModel::ParakeetTdt06B, snapshot.job_id)
            .await
            .unwrap();
        assert_eq!(running.status, DownloadJobStatus::Running);
        release_tx.send(()).unwrap();

        let mut completed = false;
        for _ in 0..100 {
            let current = registry
                .get_job(WhisperModel::ParakeetTdt06B, snapshot.job_id)
                .await
                .unwrap();
            if current.status == DownloadJobStatus::Completed {
                completed = true;
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
        }
        assert!(
            completed,
            "bundle did not complete after auxiliary finalized"
        );
        assert_eq!(tokio::fs::read(&auxiliary).await.unwrap(), b"aux");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn mismatched_content_range_restarts_without_append() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for response in [
                b"HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\nContent-Range: bytes 0-2/6\r\nConnection: close\r\n\r\nbad".as_slice(),
                b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabcdef".as_slice(),
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0_u8; 1024];
                let size = socket.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..size]);
                let request = request.to_ascii_lowercase();
                if response.starts_with(b"HTTP/1.1 206") {
                    assert!(request.contains("range: bytes=3-"));
                    assert!(request.contains("if-range: \"artifact-v1\""));
                } else {
                    assert!(!request.contains("range:"));
                }
                socket.write_all(response).await.unwrap();
            }
        });

        let (response, append) = request_artifact_response(
            &reqwest::Client::new(),
            &format!("http://{address}/artifact"),
            3,
            Some("\"artifact-v1\""),
            MAX_MODEL_ARTIFACT_BYTES,
        )
        .await
        .unwrap();
        assert!(!append);
        assert_eq!(response.bytes().await.unwrap().as_ref(), b"abcdef");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn partial_download_without_validator_restarts_from_zero() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let size = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..size]).to_ascii_lowercase();
            assert!(!request.contains("range:"));
            assert!(!request.contains("if-range:"));
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabcdef",
                )
                .await
                .unwrap();
        });

        let (response, append) = request_artifact_response(
            &reqwest::Client::new(),
            &format!("http://{address}/artifact"),
            3,
            None,
            MAX_MODEL_ARTIFACT_BYTES,
        )
        .await
        .unwrap();
        assert!(!append);
        assert_eq!(response.bytes().await.unwrap().as_ref(), b"abcdef");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn successful_status_without_artifact_body_is_rejected() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let size = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..size]).to_ascii_lowercase();
            assert!(request.contains("range: bytes=3-"));
            assert!(request.contains("if-range: \"artifact-v1\""));
            socket
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        });

        let error = request_artifact_response(
            &reqwest::Client::new(),
            &format!("http://{address}/artifact"),
            3,
            Some("\"artifact-v1\""),
            MAX_MODEL_ARTIFACT_BYTES,
        )
        .await
        .unwrap_err();
        assert!(error.contains("204"));
        server.await.unwrap();
    }

    #[test]
    fn final_download_size_must_match_advertised_total() {
        assert!(validate_downloaded_size(6, Some(6)).is_ok());
        assert!(validate_downloaded_size(5, Some(6)).is_err());
        assert!(validate_downloaded_size(6, None).is_ok());
    }

    #[tokio::test]
    async fn progress_total_never_decreases_between_artifacts() {
        let registry = DownloadRegistry::default();
        let job_id = Uuid::new_v4();
        {
            let mut store = registry.inner.lock().await;
            store.jobs.insert(
                job_id,
                DownloadJobRecord {
                    model: WhisperModel::Tiny,
                    status: DownloadJobStatus::Running,
                    bytes_downloaded: 100,
                    total_bytes: Some(1_000),
                    error: None,
                    generation: 1,
                    is_finalizing: false,
                    artifact_paths: Vec::new(),
                    control_tx: None,
                    worker_finished_rx: None,
                },
            );
        }

        registry.set_progress(job_id, 1, 200, Some(200)).await;
        let snapshot = registry.get_job(WhisperModel::Tiny, job_id).await.unwrap();
        assert_eq!(snapshot.bytes_downloaded, 200);
        assert_eq!(snapshot.total_bytes, Some(1_000));

        registry
            .mark_completed(job_id, 1, WhisperModel::Tiny, 900, Some(900))
            .await;
        let snapshot = registry.get_job(WhisperModel::Tiny, job_id).await.unwrap();
        assert_eq!(snapshot.total_bytes, Some(1_000));
    }

    #[tokio::test]
    async fn auxiliary_failure_is_reported_by_bundle_job() {
        let temp_dir = tempfile::tempdir().unwrap();
        let primary = temp_dir.path().join("encoder.onnx");
        let auxiliary = temp_dir.path().join("vocab.txt");
        tokio::fs::write(&primary, b"existing primary")
            .await
            .unwrap();

        let registry = DownloadRegistry::default();
        let snapshot = registry
            .start_or_get_active(
                WhisperModel::ParakeetTdt06B,
                vec![
                    DownloadArtifact::new(
                        "http://127.0.0.1:0/already-present".to_string(),
                        primary.clone(),
                    ),
                    DownloadArtifact::new(
                        "http://127.0.0.1:0/missing-vocab".to_string(),
                        auxiliary.clone(),
                    ),
                ],
                reqwest::Client::new(),
            )
            .await
            .unwrap();

        assert_ne!(snapshot.status, DownloadJobStatus::Completed);
        let mut failed = None;
        for _ in 0..100 {
            let current = registry
                .get_job(WhisperModel::ParakeetTdt06B, snapshot.job_id)
                .await
                .unwrap();
            if current.status == DownloadJobStatus::Failed {
                failed = Some(current);
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
        }

        let failed = failed.expect("bundle job did not report auxiliary failure");
        let error = failed
            .error
            .expect("failed bundle should include a diagnostic");
        assert!(
            error.contains("vocab.txt"),
            "unexpected diagnostic: {error}"
        );
        let latest = registry
            .get_latest_job(WhisperModel::ParakeetTdt06B)
            .await
            .expect("latest bundle job should remain observable");
        assert_eq!(latest.status, DownloadJobStatus::Failed);
        assert!(primary.exists());
        assert!(!auxiliary.exists());
    }

    #[tokio::test]
    async fn pre_existing_artifact_must_pass_size_and_digest_gate() {
        let temp_dir = tempfile::tempdir().unwrap();
        let destination = temp_dir.path().join("model.int8.onnx");
        let bytes = b"pre-existing artifact bytes";
        tokio::fs::write(&destination, bytes).await.unwrap();
        let digest = format!("{:x}", Sha256::digest(bytes));

        // Matching digest and size within the cap is the only admitted case.
        assert!(artifact_admitted(&destination, 1_024, Some(&digest)).await);
        assert!(artifact_admitted(&destination, 1_024, None).await);
        // Digest mismatch: a file downloaded before the pinning policy existed.
        assert!(!artifact_admitted(&destination, 1_024, Some(&"a".repeat(64))).await);
        // Oversized relative to the per-artifact cap.
        assert!(!artifact_admitted(&destination, 4, None).await);
        // Missing files are never admitted.
        assert!(!artifact_admitted(&temp_dir.path().join("absent.onnx"), 1_024, None).await);
    }

    #[tokio::test]
    async fn pre_existing_bundle_with_wrong_digest_is_rejected_and_removed() {
        let temp_dir = tempfile::tempdir().unwrap();
        let pinned = temp_dir.path().join("encoder-model.int8.onnx");
        let unpinned = temp_dir.path().join("vocab.txt");
        tokio::fs::write(&pinned, b"legacy unverified graph")
            .await
            .unwrap();
        tokio::fs::write(&unpinned, b"legacy vocabulary")
            .await
            .unwrap();

        let artifacts = vec![
            DownloadArtifact::new_verified(
                "http://127.0.0.1:0/encoder-model.int8.onnx".to_string(),
                pinned.clone(),
                MAX_MODEL_ARTIFACT_BYTES,
                Some("0000000000000000000000000000000000000000000000000000000000000000"),
            ),
            DownloadArtifact::new("http://127.0.0.1:0/vocab.txt".to_string(), unpinned.clone()),
        ];
        assert_eq!(admitted_artifact_set_size(&artifacts).await, None);
        // The digest-mismatched artifact is dropped so it is re-downloaded, and
        // the artifact that passed the gate is preserved.
        assert!(!pinned.exists());
        assert!(unpinned.exists());

        // The registry must not publish the stale bundle as completed either.
        let registry = DownloadRegistry::default();
        let snapshot = registry
            .start_or_get_active(
                WhisperModel::ParakeetTdt06B,
                artifacts,
                reqwest::Client::new(),
            )
            .await
            .unwrap();
        assert_ne!(snapshot.status, DownloadJobStatus::Completed);
    }

    #[tokio::test]
    async fn oversized_content_length_is_rejected_before_download() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await.unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 9999999999\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });

        let error = request_artifact_response(
            &reqwest::Client::new(),
            &format!("http://{address}/artifact"),
            0,
            None,
            100,
        )
        .await
        .unwrap_err();
        assert!(
            error.contains("exceeds 100 byte limit"),
            "unexpected error: {error}"
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn chunk_cap_breach_deletes_partial_download_file() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await.unwrap();
            // No Content-Length and Connection: close, so reqwest reads until
            // EOF; the 6-byte body exceeds the 4-byte artifact cap and must
            // trigger a chunk-cap breach.
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nTOOBIG")
                .await
                .unwrap();
        });

        let temp_dir = tempfile::tempdir().unwrap();
        let destination = temp_dir.path().join("model.bin");
        let artifact = DownloadArtifact::new_verified(
            format!("http://{address}/model.bin"),
            destination.clone(),
            4,
            None,
        );

        let registry = DownloadRegistry::default();
        let snapshot = registry
            .start_or_get_active(
                WhisperModel::Tiny,
                vec![artifact],
                reqwest::Client::new(),
            )
            .await
            .unwrap();

        let mut failed = None;
        for _ in 0..100 {
            let current = registry
                .get_job(WhisperModel::Tiny, snapshot.job_id)
                .await
                .unwrap();
            if current.status == DownloadJobStatus::Failed {
                failed = Some(current);
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
        }

        let failed = failed.expect("chunk cap breach should fail the job");
        assert!(
            failed
                .error
                .as_ref()
                .map(|err| err.contains("exceeds 4 byte limit"))
                .unwrap_or(false),
            "unexpected diagnostic: {:?}",
            failed.error
        );

        // The partial temp file must be removed on the cap breach so a retry
        // cannot resume from poisoned data.
        let temp_file = temporary_artifact_path(&destination, snapshot.job_id).unwrap();
        assert!(!temp_file.exists());
        server.await.unwrap();
    }

    /// A typo'd digest constant is a permanent, unrecoverable download failure
    /// (the artifact can never verify). Refetching upstream needs network access
    /// CI cannot rely on, so at minimum every pinned digest must be a plausible
    /// SHA-256: exactly 64 hexadecimal characters.
    #[test]
    fn pinned_artifact_digests_are_well_formed_sha256() {
        let mut pinned_digests = 0_usize;
        for slug in WhisperModel::supported() {
            let Some(model) = WhisperModel::from_slug(slug) else {
                continue;
            };
            for (name, _, sha256) in model.artifact_set() {
                let Some(digest) = sha256 else {
                    continue;
                };
                assert_eq!(
                    digest.len(),
                    64,
                    "pinned digest for '{name}' must be 64 hex characters: '{digest}'"
                );
                assert!(
                    digest
                        .chars()
                        .all(|character| character.is_ascii_hexdigit()),
                    "pinned digest for '{name}' must be hexadecimal: '{digest}'"
                );
                pinned_digests += 1;
            }
        }
        assert!(
            pinned_digests > 0,
            "at least one artifact must carry a pinned SHA-256 digest"
        );
    }
}
