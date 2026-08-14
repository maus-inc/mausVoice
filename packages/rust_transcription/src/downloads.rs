use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_util::StreamExt;
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::sync::{watch, Mutex};
use uuid::Uuid;

use crate::models::WhisperModel;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadCommand {
    Run,
    Pause,
    Cancel,
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

/// Lifecycle of a fire-and-forget auxiliary artifact download (e.g. a
/// tokenizer, vocab, or secondary graph) that accompanies the primary model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuxArtifactStatus {
    Running,
    Completed,
    Failed,
}

/// Tracks the outcome of an auxiliary artifact download so a failure is
/// observable instead of being silently discarded by the spawner.
#[derive(Clone)]
struct AuxArtifactRecord {
    status: AuxArtifactStatus,
    error: Option<String>,
}

#[derive(Default)]
struct DownloadStore {
    jobs: HashMap<Uuid, DownloadJobRecord>,
    active_by_model: HashMap<WhisperModel, Uuid>,
    aux_by_model: HashMap<WhisperModel, Vec<Uuid>>,
    aux_jobs: HashMap<Uuid, AuxArtifactRecord>,
}

#[derive(Clone, Default)]
pub struct DownloadRegistry {
    inner: Arc<Mutex<DownloadStore>>,
}

impl DownloadRegistry {
    pub async fn start_or_get_active(
        &self,
        model: WhisperModel,
        download_url: String,
        destination: PathBuf,
        client: reqwest::Client,
    ) -> Result<DownloadJobSnapshot, String> {
        if let Some(existing_size) = existing_model_file_size(&destination).await {
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
                control_tx: None,
                worker_finished_rx: None,
            };
            let snapshot = record.to_snapshot(job_id);
            store.jobs.insert(job_id, record);

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
                        (
                            existing_id,
                            generation,
                            existing,
                            None,
                            None,
                            None,
                            false,
                        )
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
                        control_tx: Some(control_tx),
                        worker_finished_rx: Some(finished_rx),
                    };
                    let snapshot = record.to_snapshot(new_job_id);
                    store.jobs.insert(new_job_id, record);
                    store.active_by_model.insert(model, new_job_id);
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
                    control_tx: Some(control_tx),
                    worker_finished_rx: Some(finished_rx),
                };
                let snapshot = record.to_snapshot(job_id);
                store.jobs.insert(job_id, record);
                store.active_by_model.insert(model, job_id);

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
                        .run_download_job(
                            job_id,
                            generation,
                            model,
                            download_url,
                            destination,
                            client,
                            control_rx,
                            prev_worker_rx,
                            finished_tx,
                        )
                        .await
                    {
                        registry.mark_failed(job_id, generation, model, err).await;
                    }
                });
            }
        }

        Ok(snapshot)
    }

    /// Fetch a small companion artifact (tokenizer, vocab, secondary graph) in
    /// the background while keeping its outcome observable. Unlike the primary
    /// download, auxiliary artifacts are not resumable or pausable, but a failed
    /// fetch is recorded so the model status can surface the error.
    pub async fn start_auxiliary_download(
        &self,
        model: WhisperModel,
        url: String,
        destination: PathBuf,
        client: reqwest::Client,
    ) {
        let job_id = Uuid::new_v4();
        {
            let mut store = self.inner.lock().await;
            store.aux_jobs.insert(
                job_id,
                AuxArtifactRecord {
                    status: AuxArtifactStatus::Running,
                    error: None,
                },
            );
            store.aux_by_model.entry(model).or_default().push(job_id);
        }

        let registry = self.clone();
        tokio::spawn(async move {
            let outcome = download_file_to_path(&client, &url, &destination).await;
            registry.record_auxiliary_outcome(job_id, outcome).await;
        });
    }

    async fn record_auxiliary_outcome(
        &self,
        job_id: Uuid,
        outcome: Result<(), String>,
    ) {
        let mut store = self.inner.lock().await;
        if let Some(job) = store.aux_jobs.get_mut(&job_id) {
            match outcome {
                Ok(()) => job.status = AuxArtifactStatus::Completed,
                Err(err) => {
                    job.status = AuxArtifactStatus::Failed;
                    job.error = Some(err);
                }
            }
        }
    }

    /// Return errors for any auxiliary artifact downloads that failed for
    /// `model`. Used by the status endpoint to surface otherwise-silent
    /// companion download failures.
    pub async fn auxiliary_errors(&self, model: WhisperModel) -> Vec<String> {
        let store = self.inner.lock().await;
        store
            .aux_by_model
            .get(&model)
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| {
                        store.aux_jobs.get(id).and_then(|job| {
                            if job.status == AuxArtifactStatus::Failed {
                                job.error.clone()
                            } else {
                                None
                            }
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Drop all auxiliary download tracking for `model`.
    pub async fn clear_auxiliary(&self, model: WhisperModel) {
        let mut store = self.inner.lock().await;
        if let Some(ids) = store.aux_by_model.remove(&model) {
            for id in ids {
                store.aux_jobs.remove(&id);
            }
        }
    }

    pub async fn pause_job(&self, model: WhisperModel, job_id: Uuid) -> Option<DownloadJobSnapshot> {
        let mut store = self.inner.lock().await;
        let job = store.jobs.get_mut(&job_id)?;
        if job.model != model {
            return None;
        }

        if job.is_finalizing || job.status == DownloadJobStatus::Completed {
            return Some(job.to_snapshot(job_id));
        }

        if matches!(job.status, DownloadJobStatus::Running | DownloadJobStatus::Pending) {
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

    pub async fn cancel_job(&self, model: WhisperModel, job_id: Uuid, destination: &PathBuf) -> Option<DownloadJobSnapshot> {
        let (snapshot, temp_file_path) = {
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
            store.active_by_model.remove(&model);

            let filename = destination.file_name().and_then(|name| name.to_str()).unwrap_or("model.bin");
            let temp_path = destination.with_file_name(format!("{filename}.{job_id}.download"));
            (snapshot, temp_path)
        };

        tokio::spawn(async move {
            let _ = tokio::fs::remove_file(temp_file_path).await;
        });

        Some(snapshot)
    }

    pub async fn cancel_active(&self, model: WhisperModel, destination: &PathBuf) -> Option<DownloadJobSnapshot> {
        let job_id = {
            let store = self.inner.lock().await;
            store.active_by_model.get(&model).copied()?
        };
        self.cancel_job(model, job_id, destination).await
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

    async fn run_download_job(
        &self,
        job_id: Uuid,
        generation: u64,
        model: WhisperModel,
        download_url: String,
        destination: PathBuf,
        client: reqwest::Client,
        mut control_rx: watch::Receiver<DownloadCommand>,
        prev_worker_rx: Option<watch::Receiver<bool>>,
        finished_tx: watch::Sender<bool>,
    ) -> Result<(), String> {
        // If there was a previous worker for this job (e.g. paused), wait for it to fully close and release the file
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
                download_url,
                destination,
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
        download_url: String,
        destination: PathBuf,
        client: reqwest::Client,
        control_rx: &mut watch::Receiver<DownloadCommand>,
    ) -> Result<(), String> {
        if !self.mark_running(job_id, generation).await {
            return Ok(());
        }

        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|err| format!("failed to create model directory: {err}"))?;
        }

        let filename = destination
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "invalid destination filename".to_string())?;

        let temp_path = destination.with_file_name(format!("{filename}.{job_id}.download"));

        let existing_bytes = match tokio::fs::metadata(&temp_path).await {
            Ok(metadata) if metadata.is_file() => metadata.len(),
            _ => 0,
        };

        let mut request = client.get(&download_url);
        if existing_bytes > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={existing_bytes}-"));
        }

        let response = request
            .send()
            .await
            .map_err(|err| format!("failed to request model download: {err}"))?;

        let status = response.status();
        if !status.is_success() {
            return Err(format!(
                "model download request failed with status {}",
                status
            ));
        }

        let is_partial = status == reqwest::StatusCode::PARTIAL_CONTENT;
        let (mut downloaded, total_bytes, mut file) = if is_partial && existing_bytes > 0 {
            let content_len = response.content_length();
            let total = content_len.map(|len| existing_bytes + len);
            let file = tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&temp_path)
                .await
                .map_err(|err| format!("failed to open temporary model file for append: {err}"))?;
            (existing_bytes, total, file)
        } else {
            let total = response.content_length();
            let file = tokio::fs::File::create(&temp_path)
                .await
                .map_err(|err| format!("failed to create temporary model file: {err}"))?;
            (0u64, total, file)
        };

        self.set_progress(job_id, generation, downloaded, total_bytes).await;

        let mut stream = response.bytes_stream();
        let mut was_paused = false;
        let mut was_canceled = false;

        loop {
            tokio::select! {
                changed = control_rx.changed() => {
                    match changed {
                        Ok(()) => match *control_rx.borrow() {
                            DownloadCommand::Pause => {
                                was_paused = true;
                                break;
                            }
                            DownloadCommand::Cancel => {
                                was_canceled = true;
                                break;
                            }
                            DownloadCommand::Run => {}
                        },
                        Err(_) => {
                            return Ok(());
                        }
                    }
                }
                item = stream.next() => {
                    match item {
                        Some(Ok(chunk)) => {
                            file.write_all(&chunk)
                                .await
                                .map_err(|err| format!("failed to write model file: {err}"))?;
                            downloaded += chunk.len() as u64;
                            self.set_progress(job_id, generation, downloaded, total_bytes).await;
                        }
                        Some(Err(err)) => {
                            return Err(format!("download stream failed: {err}"));
                        }
                        None => break,
                    }
                }
            }
        }

        if was_canceled {
            drop(file);
            let _ = tokio::fs::remove_file(&temp_path).await;
            self.mark_canceled(job_id, generation, model).await;
            return Ok(());
        }

        if was_paused {
            let _ = file.flush().await;
            let _ = file.sync_all().await;
            drop(file);
            self.mark_paused(job_id, generation).await;
            return Ok(());
        }

        // Atomically claim finalization while holding the registry lock.
        // Once claimed, pause and cancel requests will not override finalization.
        if !self.claim_finalization(job_id, generation).await {
            let is_canceled = {
                let store = self.inner.lock().await;
                store
                    .jobs
                    .get(&job_id)
                    .map(|j| j.status == DownloadJobStatus::Canceled || j.generation != generation)
                    .unwrap_or(true)
            };
            drop(file);
            if is_canceled {
                let _ = tokio::fs::remove_file(&temp_path).await;
            }
            return Ok(());
        }

        if let Err(err) = file.flush().await {
            drop(file);
            let _ = tokio::fs::remove_file(&temp_path).await;
            let msg = format!("failed to flush model file: {err}");
            self.mark_failed(job_id, generation, model, msg.clone()).await;
            return Err(msg);
        }
        if let Err(err) = file.sync_all().await {
            drop(file);
            let _ = tokio::fs::remove_file(&temp_path).await;
            let msg = format!("failed to sync model file: {err}");
            self.mark_failed(job_id, generation, model, msg.clone()).await;
            return Err(msg);
        }
        drop(file);

        if destination.exists() {
            if let Err(err) = tokio::fs::remove_file(&destination).await {
                let _ = tokio::fs::remove_file(&temp_path).await;
                let msg = format!("failed to replace existing model file: {err}");
                self.mark_failed(job_id, generation, model, msg.clone()).await;
                return Err(msg);
            }
        }

        if let Err(err) = tokio::fs::rename(&temp_path, &destination).await {
            let _ = tokio::fs::remove_file(&temp_path).await;
            let msg = format!("failed to finalize model file: {err}");
            self.mark_failed(job_id, generation, model, msg.clone()).await;
            return Err(msg);
        }

        self.mark_completed(job_id, generation, model, downloaded, total_bytes)
            .await;

        Ok(())
    }

    async fn claim_finalization(&self, job_id: Uuid, generation: u64) -> bool {
        let mut store = self.inner.lock().await;
        if let Some(job) = store.jobs.get_mut(&job_id) {
            if job.generation == generation
                && matches!(job.status, DownloadJobStatus::Pending | DownloadJobStatus::Running)
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
            if job.generation == generation && matches!(job.status, DownloadJobStatus::Pending | DownloadJobStatus::Running) {
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
            if job.generation == generation && matches!(job.status, DownloadJobStatus::Pending | DownloadJobStatus::Running) {
                job.bytes_downloaded = downloaded;
                job.total_bytes = total_bytes;
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
                job.total_bytes = total_bytes.or(Some(downloaded));
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

async fn existing_model_file_size(path: &PathBuf) -> Option<u64> {
    match tokio::fs::metadata(path).await {
        Ok(metadata) if metadata.is_file() && metadata.len() > 0 => Some(metadata.len()),
        _ => None,
    }
}

/// Stream a single auxiliary artifact (e.g. `tokens.txt`, the decoder/joiner
/// ONNX files) straight to disk. Unlike [`DownloadRegistry`] this is not
/// resumable and does not participate in pause/cancel — it is used to fetch the
/// secondary files that accompany the primary ONNX model, whose download
/// (and progress/pause/cancel) is tracked by the registry.
pub async fn download_file_to_path(
    client: &reqwest::Client,
    url: &str,
    destination: &Path,
) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|err| format!("failed to create model directory: {err}"))?;
    }

    let filename = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid destination filename".to_string())?;
    let temp_path = destination.with_file_name(format!("{filename}.{}.download", Uuid::new_v4()));

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|err| format!("failed to request artifact download: {err}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "artifact download request failed with status {}",
            response.status()
        ));
    }

    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|err| format!("failed to create temporary artifact file: {err}"))?;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| format!("download stream failed: {err}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|err| format!("failed to write artifact file: {err}"))?;
    }

    file.flush()
        .await
        .map_err(|err| format!("failed to flush artifact file: {err}"))?;
    file.sync_all()
        .await
        .map_err(|err| format!("failed to sync artifact file: {err}"))?;
    drop(file);

    if destination.exists() {
        let _ = tokio::fs::remove_file(destination).await;
    }

    tokio::fs::rename(&temp_path, destination)
        .await
        .map_err(|err| format!("failed to finalize artifact file: {err}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let dest = PathBuf::from("/tmp/fake-model.bin");
        let canceled = registry.cancel_job(WhisperModel::Tiny, job_id, &dest).await;
        assert_ne!(canceled.unwrap().status, DownloadJobStatus::Canceled);

        // Worker marks completed
        registry
            .mark_completed(job_id, 1, WhisperModel::Tiny, 1000, Some(1000))
            .await;
        let final_job = registry.get_job(WhisperModel::Tiny, job_id).await.unwrap();
        assert_eq!(final_job.status, DownloadJobStatus::Completed);
    }

    #[tokio::test]
    async fn test_cancel_job_cleans_up_temp_file() {
        let temp_dir = tempfile::tempdir().unwrap();
        let destination = temp_dir.path().join("model.bin");
        let registry = DownloadRegistry::default();
        let job_id = Uuid::new_v4();

        let filename = destination
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap();
        let temp_file = destination.with_file_name(format!("{filename}.{job_id}.download"));
        tokio::fs::write(&temp_file, b"partial bytes").await.unwrap();
        assert!(temp_file.exists());

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
                    control_tx: None,
                    worker_finished_rx: None,
                },
            );
            store.active_by_model.insert(WhisperModel::Tiny, job_id);
        }

        let canceled = registry
            .cancel_job(WhisperModel::Tiny, job_id, &destination)
            .await;
        assert_eq!(canceled.unwrap().status, DownloadJobStatus::Canceled);

        // Wait for async deletion task
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        assert!(!temp_file.exists());
    }

    #[tokio::test]
    async fn test_pause_and_resume_worker_handover_preserves_file() {
        let temp_dir = tempfile::tempdir().unwrap();
        let destination = temp_dir.path().join("model.bin");
        let registry = DownloadRegistry::default();
        let job_id = Uuid::new_v4();

        let filename = destination
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap();
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
                "http://127.0.0.1:9999/model.bin".to_string(),
                destination.clone(),
                client,
            )
            .await
            .unwrap();

        assert_eq!(snapshot.status, DownloadJobStatus::Pending);
        assert_eq!(snapshot.bytes_downloaded, 11);
    }
}
