use std::collections::HashMap;
use std::path::PathBuf;
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
    control_tx: Option<watch::Sender<DownloadCommand>>,
}

#[derive(Default)]
struct DownloadStore {
    jobs: HashMap<Uuid, DownloadJobRecord>,
    active_by_model: HashMap<WhisperModel, Uuid>,
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
            store.jobs.insert(
                job_id,
                DownloadJobRecord {
                    model,
                    status: DownloadJobStatus::Completed,
                    bytes_downloaded: existing_size,
                    total_bytes: Some(existing_size),
                    error: None,
                    generation: 1,
                    control_tx: None,
                },
            );

            return store
                .snapshot(job_id)
                .ok_or_else(|| "failed to create completed job snapshot".to_string());
        }

        let (job_id, generation, snapshot, control_rx, should_spawn) = {
            let mut store = self.inner.lock().await;

            if let Some(existing_id) = store.active_by_model.get(&model).copied() {
                if let Some(record) = store.jobs.get_mut(&existing_id) {
                    if record.status == DownloadJobStatus::Paused {
                        // Signal any previous worker to stop if it hasn't already
                        if let Some(tx) = &record.control_tx {
                            let _ = tx.send(DownloadCommand::Pause);
                        }
                        record.generation += 1;
                        let generation = record.generation;
                        let (control_tx, control_rx) = watch::channel(DownloadCommand::Run);
                        record.status = DownloadJobStatus::Pending;
                        record.error = None;
                        record.control_tx = Some(control_tx);
                        let snapshot = store
                            .snapshot(existing_id)
                            .ok_or_else(|| "job snapshot missing".to_string())?;
                        (existing_id, generation, snapshot, Some(control_rx), true)
                    } else {
                        let existing = store
                            .snapshot(existing_id)
                            .ok_or_else(|| "active download job is missing".to_string())?;
                        (existing_id, record.generation, existing, None, false)
                    }
                } else {
                    store.active_by_model.remove(&model);
                    let (control_tx, control_rx) = watch::channel(DownloadCommand::Run);
                    let new_job_id = Uuid::new_v4();
                    store.jobs.insert(
                        new_job_id,
                        DownloadJobRecord {
                            model,
                            status: DownloadJobStatus::Pending,
                            bytes_downloaded: 0,
                            total_bytes: None,
                            error: None,
                            generation: 1,
                            control_tx: Some(control_tx),
                        },
                    );
                    store.active_by_model.insert(model, new_job_id);
                    let snapshot = store
                        .snapshot(new_job_id)
                        .ok_or_else(|| "failed to create job snapshot".to_string())?;
                    (new_job_id, 1, snapshot, Some(control_rx), true)
                }
            } else {
                let job_id = Uuid::new_v4();
                let (control_tx, control_rx) = watch::channel(DownloadCommand::Run);
                store.jobs.insert(
                    job_id,
                    DownloadJobRecord {
                        model,
                        status: DownloadJobStatus::Pending,
                        bytes_downloaded: 0,
                        total_bytes: None,
                        error: None,
                        generation: 1,
                        control_tx: Some(control_tx),
                    },
                );
                store.active_by_model.insert(model, job_id);

                let snapshot = store
                    .snapshot(job_id)
                    .ok_or_else(|| "failed to create job snapshot".to_string())?;

                (job_id, 1, snapshot, Some(control_rx), true)
            }
        };

        if should_spawn {
            if let Some(control_rx) = control_rx {
                let registry = self.clone();
                tokio::spawn(async move {
                    if let Err(err) = registry
                        .run_download_job(job_id, generation, model, download_url, destination, client, control_rx)
                        .await
                    {
                        registry.mark_failed(job_id, generation, model, err).await;
                    }
                });
            }
        }

        Ok(snapshot)
    }

    pub async fn pause_job(&self, model: WhisperModel, job_id: Uuid) -> Option<DownloadJobSnapshot> {
        let mut store = self.inner.lock().await;
        let job = store.jobs.get_mut(&job_id)?;
        if job.model != model {
            return None;
        }

        if matches!(job.status, DownloadJobStatus::Running | DownloadJobStatus::Pending) {
            if let Some(control_tx) = &job.control_tx {
                let _ = control_tx.send(DownloadCommand::Pause);
            }
            job.status = DownloadJobStatus::Paused;
        }

        store.snapshot(job_id)
    }

    pub async fn pause_active(&self, model: WhisperModel) -> Option<DownloadJobSnapshot> {
        let job_id = {
            let store = self.inner.lock().await;
            store.active_by_model.get(&model).copied()?
        };
        self.pause_job(model, job_id).await
    }

    pub async fn cancel_job(&self, model: WhisperModel, job_id: Uuid, destination: &PathBuf) -> Option<DownloadJobSnapshot> {
        let (has_live_worker, snapshot) = {
            let mut store = self.inner.lock().await;
            let job = store.jobs.get_mut(&job_id)?;
            if job.model != model {
                return None;
            }

            let has_worker = if let Some(control_tx) = &job.control_tx {
                let _ = control_tx.send(DownloadCommand::Cancel);
                true
            } else {
                false
            };

            job.generation += 1;
            job.status = DownloadJobStatus::Canceled;
            job.control_tx = None;
            store.active_by_model.remove(&model);

            (has_worker, store.snapshot(job_id))
        };

        if !has_live_worker {
            let filename = destination.file_name().and_then(|name| name.to_str()).unwrap_or("model.bin");
            let temp_path = destination.with_file_name(format!("{filename}.{job_id}.download"));
            tokio::spawn(async move {
                let _ = tokio::fs::remove_file(temp_path).await;
            });
        }

        snapshot
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
            let _ = tokio::fs::remove_file(&temp_path).await;
            self.mark_canceled(job_id, generation, model).await;
            return Ok(());
        }

        if was_paused {
            let _ = file.flush().await;
            let _ = file.sync_all().await;
            self.mark_paused(job_id, generation).await;
            return Ok(());
        }

        // Before finalizing to destination, ensure generation is still valid and job is running or pending
        let should_finalize = {
            let store = self.inner.lock().await;
            if let Some(job) = store.jobs.get(&job_id) {
                job.generation == generation && matches!(job.status, DownloadJobStatus::Pending | DownloadJobStatus::Running)
            } else {
                false
            }
        };

        if !should_finalize {
            return Ok(());
        }

        file.flush()
            .await
            .map_err(|err| format!("failed to flush model file: {err}"))?;
        file.sync_all()
            .await
            .map_err(|err| format!("failed to sync model file: {err}"))?;

        if destination.exists() {
            tokio::fs::remove_file(&destination)
                .await
                .map_err(|err| format!("failed to replace existing model file: {err}"))?;
        }

        tokio::fs::rename(&temp_path, &destination)
            .await
            .map_err(|err| format!("failed to finalize model file: {err}"))?;

        self.mark_completed(job_id, generation, model, downloaded, total_bytes)
            .await;

        Ok(())
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
            if job.generation == generation {
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
            if job.generation == generation && matches!(job.status, DownloadJobStatus::Pending | DownloadJobStatus::Running) {
                job.status = DownloadJobStatus::Completed;
                job.bytes_downloaded = downloaded;
                job.total_bytes = total_bytes.or(Some(downloaded));
                job.error = None;
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
            if job.generation == generation && matches!(job.status, DownloadJobStatus::Pending | DownloadJobStatus::Running) {
                job.status = DownloadJobStatus::Failed;
                job.error = Some(error_message);
                job.control_tx = None;
                store.active_by_model.remove(&model);
            }
        }
    }
}

impl DownloadStore {
    fn snapshot(&self, job_id: Uuid) -> Option<DownloadJobSnapshot> {
        let job = self.jobs.get(&job_id)?;
        let progress = match job.total_bytes {
            Some(total) if total > 0 => Some((job.bytes_downloaded as f64 / total as f64).min(1.0)),
            Some(_) => Some(1.0),
            None => None,
        };

        Some(DownloadJobSnapshot {
            job_id,
            model: job.model,
            status: job.status,
            bytes_downloaded: job.bytes_downloaded,
            total_bytes: job.total_bytes,
            progress,
            error: job.error.clone(),
        })
    }
}

async fn existing_model_file_size(path: &PathBuf) -> Option<u64> {
    match tokio::fs::metadata(path).await {
        Ok(metadata) if metadata.is_file() && metadata.len() > 0 => Some(metadata.len()),
        _ => None,
    }
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
                    control_tx: None,
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
}
