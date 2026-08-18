use std::io::ErrorKind;
use std::path::Path as FsPath;
use std::path::PathBuf;
use std::time::Instant;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::downloads::DownloadArtifact;
use crate::errors::ApiError;
use crate::models::WhisperModel;
use crate::state::AppState;
use crate::transcription::{ComputeDevice, TranscriptionInput};

pub fn create_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(get_health))
        .route("/v1/models/:model/download", post(download_model))
        .route(
            "/v1/models/:model/download/:target",
            get(get_download_progress).post(handle_download_action),
        )
        .route(
            "/v1/models/:model/download/:job_id/:action",
            post(handle_job_action),
        )
        .route("/v1/models/:model", delete(delete_model))
        .route("/v1/models/:model/status", get(get_model_status))
        .route("/v1/devices", get(list_devices))
        .route("/v1/transcriptions", post(transcribe))
        .route(
            "/v1/transcriptions/sessions",
            post(create_transcription_session),
        )
        .route(
            "/v1/transcriptions/sessions/:session_id/chunks",
            post(append_transcription_session_chunk),
        )
        .route(
            "/v1/transcriptions/sessions/:session_id/finalize",
            post(finalize_transcription_session),
        )
        .route(
            "/v1/transcriptions/sessions/:session_id",
            delete(delete_transcription_session),
        )
        .layer(DefaultBodyLimit::max(250 * 1024 * 1024))
        .with_state(state)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    mode: &'static str,
}

async fn get_health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        mode: state.config.mode.as_str(),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DevicesResponse {
    devices: Vec<ComputeDevice>,
}

async fn list_devices(State(state): State<AppState>) -> Result<Json<DevicesResponse>, ApiError> {
    let devices = state
        .transcriber
        .list_devices()
        .await
        .map_err(|err| ApiError::internal("device_list_failed", err))?;

    Ok(Json(DevicesResponse { devices }))
}

#[derive(Debug, Deserialize)]
struct ModelPath {
    model: String,
}

#[derive(Debug, Deserialize)]
struct DownloadTargetPath {
    model: String,
    target: String,
}

#[derive(Debug, Deserialize)]
struct DownloadJobActionPath {
    model: String,
    job_id: String,
    action: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelStatusQuery {
    validate: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelStatusResponse {
    model: WhisperModel,
    downloaded: bool,
    valid: bool,
    file_bytes: Option<u64>,
    validation_error: Option<String>,
}

async fn download_model(
    State(state): State<AppState>,
    Path(path): Path<ModelPath>,
) -> Result<Json<crate::downloads::DownloadJobSnapshot>, ApiError> {
    let model = parse_model(&path.model)?;
    let model_download_lock = state.model_download_lock(model).await;
    // Validation/cleanup and registry job creation must be one per-model
    // critical section. Otherwise a concurrent request can start a worker
    // after the active-job check but before invalid artifacts are removed.
    let _model_download_guard = model_download_lock.lock().await;
    if model.is_onnx() {
        remove_invalid_onnx_bundle_before_download(&state, model).await?;
    }

    let client = state.http_client.clone();
    let artifacts = if model.is_onnx() {
        // One registry job owns the complete model bundle. Completion is not
        // published until every graph, weights file, and tokenizer/vocabulary
        // artifact is durable; any artifact failure is returned by this job.
        model
            .artifact_set()
            .into_iter()
            .map(|(name, url)| {
                DownloadArtifact::new(
                    url,
                    model.artifact_path(&state.config.models_dir, name),
                )
            })
            .collect()
    } else {
        vec![DownloadArtifact::new(
            model.download_url(),
            state.model_path(model),
        )]
    };

    let snapshot = state
        .downloads
        .start_or_get_active(model, artifacts, client)
        .await
        .map_err(|err| ApiError::internal("download_start_failed", err))?;

    Ok(Json(snapshot))
}

/// A complete bundle may still be malformed or incompatible. The download
/// registry intentionally treats existing files as resumable artifacts, so an
/// invalid complete bundle must be evicted before retrying; otherwise every
/// non-empty file would be skipped and the retry would falsely complete.
async fn remove_invalid_onnx_bundle_before_download(
    state: &AppState,
    model: WhisperModel,
) -> Result<(), ApiError> {
    // Never remove files owned by a running or paused bundle worker. A repeated
    // download request should simply return that existing job.
    if state.downloads.get_active_job(model).await.is_some() {
        return Ok(());
    }

    let status = read_model_status(state, model, false).await?;
    if !status.downloaded {
        return Ok(());
    }

    let model_path = state.model_path(model);
    let model_path_for_task = model_path.clone();
    let validation_result = tokio::task::spawn_blocking(move || {
        crate::onnx_inference::validate_model_classified(model, &model_path_for_task)
    })
    .await
    .map_err(|err| {
        ApiError::internal(
            "model_validation_failed",
            format!("validation task join failed: {err}"),
        )
    })?;

    match validation_result {
        Ok(_) => return Ok(()),
        Err(crate::onnx_inference::OnnxModelValidationError::Runtime(error)) => {
            return Err(ApiError::internal(
                "model_validation_unavailable",
                format!(
                    "cannot validate '{}' without a working ONNX Runtime: {error}",
                    model.as_slug()
                ),
            ));
        }
        Err(crate::onnx_inference::OnnxModelValidationError::Artifact(_)) => {}
    }

    crate::onnx_inference::evict_model(&model_path);
    for (name, _) in model.artifact_set() {
        let artifact_path = model.artifact_path(&state.config.models_dir, name);
        match tokio::fs::remove_file(&artifact_path).await {
            Ok(()) => {}
            Err(err) if err.kind() == ErrorKind::NotFound => {}
            Err(err) => {
                return Err(ApiError::internal(
                    "invalid_model_cleanup_failed",
                    format!(
                        "failed to remove invalid artifact '{}' for '{}': {err}",
                        artifact_path.display(),
                        model.as_slug()
                    ),
                ));
            }
        }
        remove_partial_model_downloads(&artifact_path, model).await?;
    }
    state.downloads.clear_model_history(model).await;
    Ok(())
}

async fn get_download_progress(
    State(state): State<AppState>,
    Path(path): Path<DownloadTargetPath>,
) -> Result<Json<crate::downloads::DownloadJobSnapshot>, ApiError> {
    let model = parse_model(&path.model)?;
    let job_id = Uuid::parse_str(path.target.trim())
        .map_err(|_| ApiError::bad_request("invalid_job_id", "jobId must be a valid UUID"))?;

    let snapshot = state
        .downloads
        .get_job(model, job_id)
        .await
        .ok_or_else(|| ApiError::not_found("download_not_found", "download job was not found"))?;

    Ok(Json(snapshot))
}

#[derive(Clone, Copy)]
enum ResolvedDownloadTarget {
    Active,
    Job(Uuid),
}

async fn dispatch_download_action(
    state: &AppState,
    model: WhisperModel,
    target: ResolvedDownloadTarget,
    action: &str,
) -> Result<Json<crate::downloads::DownloadJobSnapshot>, ApiError> {
    let snapshot = match (action.trim(), target) {
        ("pause", ResolvedDownloadTarget::Active) => state.downloads.pause_active(model).await,
        ("pause", ResolvedDownloadTarget::Job(job_id)) => {
            state.downloads.pause_job(model, job_id).await
        }
        ("cancel", ResolvedDownloadTarget::Active) => state.downloads.cancel_active(model).await,
        ("cancel", ResolvedDownloadTarget::Job(job_id)) => {
            state.downloads.cancel_job(model, job_id).await
        }
        _ => {
            return Err(ApiError::bad_request(
                "invalid_action",
                format!("unsupported download action '{action}'"),
            ));
        }
    };

    let not_found = match target {
        ResolvedDownloadTarget::Active => {
            format!("no active download found to {}", action.trim())
        }
        ResolvedDownloadTarget::Job(_) => "download job was not found".to_string(),
    };
    snapshot
        .map(Json)
        .ok_or_else(|| ApiError::not_found("download_not_found", not_found))
}

async fn handle_download_action(
    State(state): State<AppState>,
    Path(path): Path<DownloadTargetPath>,
) -> Result<Json<crate::downloads::DownloadJobSnapshot>, ApiError> {
    let model = parse_model(&path.model)?;
    dispatch_download_action(
        &state,
        model,
        ResolvedDownloadTarget::Active,
        &path.target,
    )
    .await
}

async fn handle_job_action(
    State(state): State<AppState>,
    Path(path): Path<DownloadJobActionPath>,
) -> Result<Json<crate::downloads::DownloadJobSnapshot>, ApiError> {
    let model = parse_model(&path.model)?;
    let job_id = Uuid::parse_str(path.job_id.trim())
        .map_err(|_| ApiError::bad_request("invalid_job_id", "jobId must be a valid UUID"))?;
    dispatch_download_action(
        &state,
        model,
        ResolvedDownloadTarget::Job(job_id),
        &path.action,
    )
    .await
}

async fn get_model_status(
    State(state): State<AppState>,
    Path(path): Path<ModelPath>,
    Query(query): Query<ModelStatusQuery>,
) -> Result<Json<ModelStatusResponse>, ApiError> {
    let model = parse_model(&path.model)?;
    let status = read_model_status(&state, model, query.validate.unwrap_or(true)).await?;
    Ok(Json(status))
}

async fn delete_model(
    State(state): State<AppState>,
    Path(path): Path<ModelPath>,
) -> Result<Json<ModelStatusResponse>, ApiError> {
    let model = parse_model(&path.model)?;
    let model_download_lock = state.model_download_lock(model).await;
    let _model_download_guard = model_download_lock.lock().await;

    if let Some(active_job) = state.downloads.get_active_job(model).await {
        if matches!(
            active_job.status,
            crate::downloads::DownloadJobStatus::Pending
                | crate::downloads::DownloadJobStatus::Running
        ) {
            return Err(ApiError::bad_request(
                "download_in_progress",
                format!(
                    "model '{}' is currently downloading; wait for it to finish before deleting",
                    model.as_slug()
                ),
            ));
        }
    }

    let model_path = state.model_path(model);
    match tokio::fs::remove_file(&model_path).await {
        Ok(_) => {}
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => {
            return Err(ApiError::internal(
                "model_delete_failed",
                format!("failed to delete model '{}': {err}", model.as_slug()),
            ));
        }
    }

    // For ONNX models, also remove the rest of the artifact set and any
    // in-progress auxiliary fragments in the model-specific directory.
    if model.is_onnx() {
        crate::onnx_inference::evict_model(&model_path);
        for (name, _) in model.artifact_set() {
            let artifact_path = model.artifact_path(&state.config.models_dir, name);
            match tokio::fs::remove_file(&artifact_path).await {
                Ok(()) => {}
                Err(err) if err.kind() == ErrorKind::NotFound => {}
                Err(err) => {
                    return Err(ApiError::internal(
                        "model_delete_failed",
                        format!(
                            "failed to delete companion artifact '{}': {err}",
                            artifact_path.display()
                        ),
                    ));
                }
            }
            remove_partial_model_downloads(&artifact_path, model).await?;
        }
        if let Some(model_dir) = model_path.parent() {
            let _ = tokio::fs::remove_dir(model_dir).await;
        }
    } else {
        remove_partial_model_downloads(&model_path, model).await?;
    }
    state.downloads.clear_model_history(model).await;
    let status = read_model_status(&state, model, false).await?;
    Ok(Json(status))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeRequest {
    model: WhisperModel,
    samples: Vec<f32>,
    sample_rate: u32,
    language: Option<String>,
    initial_prompt: Option<String>,
    device_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTranscriptionSessionRequest {
    model: WhisperModel,
    sample_rate: u32,
    language: Option<String>,
    initial_prompt: Option<String>,
    device_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TranscriptionSessionPath {
    session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateTranscriptionSessionResponse {
    session_id: Uuid,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppendTranscriptionChunkResponse {
    received_samples: usize,
    buffered_samples: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteTranscriptionSessionResponse {
    deleted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeResponse {
    text: String,
    model: WhisperModel,
    inference_device: String,
    duration_ms: u128,
}

async fn transcribe(
    State(state): State<AppState>,
    Json(request): Json<TranscribeRequest>,
) -> Result<Json<TranscribeResponse>, ApiError> {
    let model_path = ensure_model_downloaded(&state, request.model).await?;

    let started = Instant::now();
    let output = run_transcription_request(
        &state,
        request.model,
        model_path,
        request.samples,
        request.sample_rate,
        request.language,
        request.initial_prompt,
        request.device_id,
    )
    .await?;

    Ok(Json(TranscribeResponse {
        text: output.text,
        model: request.model,
        inference_device: output.inference_device,
        duration_ms: started.elapsed().as_millis(),
    }))
}

async fn create_transcription_session(
    State(state): State<AppState>,
    Json(request): Json<CreateTranscriptionSessionRequest>,
) -> Result<Json<CreateTranscriptionSessionResponse>, ApiError> {
    let _ = ensure_model_downloaded(&state, request.model).await?;

    let session_id = state
        .transcription_sessions
        .create(
            crate::streaming_sessions::BufferedTranscriptionSessionInput {
                model: request.model,
                sample_rate: request.sample_rate,
                language: request.language,
                initial_prompt: request.initial_prompt,
                device_id: request.device_id,
            },
        )
        .await;

    Ok(Json(CreateTranscriptionSessionResponse { session_id }))
}

async fn append_transcription_session_chunk(
    State(state): State<AppState>,
    Path(path): Path<TranscriptionSessionPath>,
    bytes: Bytes,
) -> Result<Json<AppendTranscriptionChunkResponse>, ApiError> {
    let session_id = parse_session_id(&path.session_id)?;
    let samples = decode_f32le_samples(bytes.as_ref())?;
    let received_samples = samples.len();

    let buffered_samples = state
        .transcription_sessions
        .append_samples(session_id, samples)
        .await
        .ok_or_else(|| {
            ApiError::not_found(
                "session_not_found",
                "transcription session does not exist or has already completed",
            )
        })?;

    Ok(Json(AppendTranscriptionChunkResponse {
        received_samples,
        buffered_samples,
    }))
}

async fn finalize_transcription_session(
    State(state): State<AppState>,
    Path(path): Path<TranscriptionSessionPath>,
) -> Result<Json<TranscribeResponse>, ApiError> {
    let session_id = parse_session_id(&path.session_id)?;
    let session = state
        .transcription_sessions
        .take(session_id)
        .await
        .ok_or_else(|| {
            ApiError::not_found(
                "session_not_found",
                "transcription session does not exist or has already completed",
            )
        })?;

    let model_path = ensure_model_downloaded(&state, session.model).await?;
    let started = Instant::now();
    let output = run_transcription_request(
        &state,
        session.model,
        model_path,
        session.samples,
        session.sample_rate,
        session.language,
        session.initial_prompt,
        session.device_id,
    )
    .await?;

    Ok(Json(TranscribeResponse {
        text: output.text,
        model: session.model,
        inference_device: output.inference_device,
        duration_ms: started.elapsed().as_millis(),
    }))
}

async fn delete_transcription_session(
    State(state): State<AppState>,
    Path(path): Path<TranscriptionSessionPath>,
) -> Result<Json<DeleteTranscriptionSessionResponse>, ApiError> {
    let session_id = parse_session_id(&path.session_id)?;
    let deleted = state.transcription_sessions.remove(session_id).await;
    Ok(Json(DeleteTranscriptionSessionResponse { deleted }))
}

fn parse_model(value: &str) -> Result<WhisperModel, ApiError> {
    WhisperModel::from_slug(value).ok_or_else(|| {
        ApiError::bad_request(
            "invalid_model",
            format!(
                "unsupported model '{}'; supported values: {}",
                value,
                WhisperModel::supported().join(", ")
            ),
        )
    })
}

fn parse_session_id(value: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(value.trim())
        .map_err(|_| ApiError::bad_request("invalid_session_id", "sessionId must be a valid UUID"))
}

fn decode_f32le_samples(bytes: &[u8]) -> Result<Vec<f32>, ApiError> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }

    if bytes.len() % std::mem::size_of::<f32>() != 0 {
        return Err(ApiError::bad_request(
            "invalid_audio_chunk",
            "audio chunk byte length must be a multiple of 4",
        ));
    }

    let mut samples = Vec::with_capacity(bytes.len() / std::mem::size_of::<f32>());
    for chunk in bytes.chunks_exact(std::mem::size_of::<f32>()) {
        let value = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        if value.is_finite() {
            samples.push(value);
        }
    }

    Ok(samples)
}

async fn ensure_model_downloaded(
    state: &AppState,
    model: WhisperModel,
) -> Result<PathBuf, ApiError> {
    let model_path = state.model_path(model);
    let required_paths = if model.is_onnx() {
        model
            .artifact_set()
            .into_iter()
            .map(|(name, _)| model.artifact_path(&state.config.models_dir, name))
            .collect::<Vec<_>>()
    } else {
        vec![model_path.clone()]
    };

    for required_path in required_paths {
        let present = tokio::fs::metadata(&required_path)
            .await
            .map(|metadata| metadata.is_file() && metadata.len() > 0)
            .unwrap_or(false);
        if !present {
            return Err(ApiError::not_found(
                "model_not_downloaded",
                format!(
                    "model '{}' is not downloaded; call /v1/models/{}/download first",
                    model.as_slug(),
                    model.as_slug()
                ),
            ));
        }
    }

    Ok(model_path)
}

async fn run_transcription_request(
    state: &AppState,
    model: WhisperModel,
    model_path: PathBuf,
    samples: Vec<f32>,
    sample_rate: u32,
    language: Option<String>,
    initial_prompt: Option<String>,
    device_id: Option<String>,
) -> Result<crate::transcription::TranscriptionOutput, ApiError> {
    state
        .transcriber
        .transcribe(TranscriptionInput {
            model,
            model_path,
            samples,
            sample_rate,
            language,
            initial_prompt,
            device_id,
        })
        .await
        .map_err(|error| map_transcription_error(model, error))
}

async fn read_model_status(
    state: &AppState,
    model: WhisperModel,
    validate: bool,
) -> Result<ModelStatusResponse, ApiError> {
    let model_path = state.model_path(model);
    let metadata = tokio::fs::metadata(&model_path).await.ok();

    let file_bytes = if model.is_onnx() {
        let mut total = 0_u64;
        let mut found = false;
        for (name, _) in model.artifact_set() {
            let artifact_path = model.artifact_path(&state.config.models_dir, name);
            if let Ok(meta) = tokio::fs::metadata(artifact_path).await {
                if meta.is_file() {
                    total = total.saturating_add(meta.len());
                    found = true;
                }
            }
        }
        found.then_some(total)
    } else {
        metadata.as_ref().map(|meta| meta.len())
    };

    let downloaded = if model.is_onnx() {
        // An ONNX model is only "downloaded" once the complete, model-specific
        // graph/weights/tokenizer artifact set is present on disk.
        let mut all_present = true;
        for (name, _) in model.artifact_set() {
            let artifact_path = model.artifact_path(&state.config.models_dir, name);
            match tokio::fs::metadata(&artifact_path).await {
                Ok(meta) if meta.is_file() && meta.len() > 0 => {}
                _ => {
                    all_present = false;
                    break;
                }
            }
        }
        all_present
    } else {
        metadata
            .as_ref()
            .map(|meta| meta.is_file() && meta.len() > 0)
            .unwrap_or(false)
    };

    if !downloaded {
        // Preserve the latest bundle failure on the model status endpoint as
        // well as on the job snapshot, so clients can diagnose a partial
        // bundle even after losing the original job ID.
        let validation_error = state
            .downloads
            .get_latest_job(model)
            .await
            .filter(|job| job.status == crate::downloads::DownloadJobStatus::Failed)
            .and_then(|job| job.error);
        return Ok(ModelStatusResponse {
            model,
            downloaded: false,
            valid: false,
            file_bytes,
            validation_error,
        });
    }

    if !validate {
        return Ok(ModelStatusResponse {
            model,
            downloaded: true,
            valid: true,
            file_bytes,
            validation_error: None,
        });
    }

    match state.transcriber.validate_model(model, model_path).await {
        Ok(valid) => Ok(ModelStatusResponse {
            model,
            downloaded: true,
            valid,
            file_bytes,
            validation_error: None,
        }),
        Err(err) => Ok(ModelStatusResponse {
            model,
            downloaded: true,
            valid: false,
            file_bytes,
            validation_error: Some(err),
        }),
    }
}

async fn remove_partial_model_downloads(
    model_path: &FsPath,
    model: WhisperModel,
) -> Result<(), ApiError> {
    let parent = match model_path.parent() {
        Some(parent) => parent,
        None => return Ok(()),
    };
    let filename = match model_path.file_name().and_then(|name| name.to_str()) {
        Some(filename) => filename,
        None => return Ok(()),
    };
    let prefix = format!("{filename}.");

    let mut entries = match tokio::fs::read_dir(parent).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(ApiError::internal(
                "model_delete_failed",
                format!(
                    "failed to inspect model directory for '{}': {err}",
                    model.as_slug()
                ),
            ));
        }
    };

    while let Some(entry) = entries.next_entry().await.map_err(|err| {
        ApiError::internal(
            "model_delete_failed",
            format!(
                "failed to enumerate partial model downloads for '{}': {err}",
                model.as_slug()
            ),
        )
    })? {
        let file_name = match entry.file_name().to_str() {
            Some(value) => value.to_string(),
            None => continue,
        };

        if !file_name.starts_with(&prefix)
            || !(file_name.ends_with(".download")
                || file_name.ends_with(".download.validator"))
        {
            continue;
        }

        let partial_path = entry.path();
        match tokio::fs::remove_file(&partial_path).await {
            Ok(_) => {}
            Err(err) if err.kind() == ErrorKind::NotFound => {}
            Err(err) => {
                return Err(ApiError::internal(
                    "model_delete_failed",
                    format!(
                        "failed to delete partial model file '{}' for '{}': {err}",
                        partial_path.display(),
                        model.as_slug()
                    ),
                ));
            }
        }
    }

    Ok(())
}

fn map_transcription_error(model: WhisperModel, error: String) -> ApiError {
    let lower = error.to_ascii_lowercase();

    if lower.contains("sample")
        || lower.contains("language")
        || lower.contains("prompt")
        || lower.contains("session")
    {
        ApiError::bad_request("invalid_transcription_request", error)
    } else if lower.contains("device") {
        ApiError::bad_request("invalid_device", error)
    } else if lower.contains("model") && lower.contains("failed") {
        ApiError::not_found(
            "model_not_downloaded",
            format!(
                "model '{}' is not downloaded; call /v1/models/{}/download first",
                model.as_slug(),
                model.as_slug()
            ),
        )
    } else {
        ApiError::internal("transcription_failed", error)
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::util::ServiceExt;

    use crate::compute::ComputeMode;
    use crate::config::SidecarConfig;

    use super::*;

    fn test_state() -> AppState {
        let temp_dir =
            std::env::temp_dir().join(format!("rust-transcription-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).expect("failed to create temp dir");

        AppState::new(SidecarConfig {
            mode: ComputeMode::Cpu,
            host: "127.0.0.1".parse().expect("valid ip"),
            port: 0,
            models_dir: temp_dir,
        })
        .expect("failed to build app state")
    }

    #[tokio::test]
    async fn health_endpoint_returns_mode() {
        let app = create_router(test_state());
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn status_endpoint_rejects_unknown_model() {
        let app = create_router(test_state());
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/models/nano/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn status_endpoint_reports_missing_model() {
        let app = create_router(test_state());
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/models/tiny/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn invalid_complete_onnx_bundle_is_removed_before_retry() {
        let state = test_state();
        let model = WhisperModel::ParakeetCtc06B;
        let model_dir = state.config.models_dir.join(model.as_slug());
        tokio::fs::create_dir_all(&model_dir).await.unwrap();
        tokio::fs::write(
            model_dir.join("model_int8.onnx"),
            b"not a valid ONNX graph",
        )
        .await
        .unwrap();
        tokio::fs::write(model_dir.join("model_int8.onnx_data"), b"corrupt weights")
            .await
            .unwrap();
        tokio::fs::write(model_dir.join("tokenizer.json"), b"{}")
            .await
            .unwrap();

        let invalid = read_model_status(&state, model, true).await.unwrap();
        assert_eq!(
            invalid.file_bytes,
            Some(
                b"not a valid ONNX graph".len() as u64
                    + b"corrupt weights".len() as u64
                    + b"{}".len() as u64
            )
        );
        assert!(invalid.downloaded);
        assert!(!invalid.valid);
        assert!(invalid.validation_error.is_some());

        remove_invalid_onnx_bundle_before_download(&state, model)
            .await
            .unwrap();
        let retry_artifacts = model
            .artifact_set()
            .into_iter()
            .map(|(name, _)| {
                let destination = model.artifact_path(&state.config.models_dir, name);
                assert!(!destination.exists(), "invalid artifact was not removed");
                DownloadArtifact::new(
                    format!("http://127.0.0.1:0/{name}"),
                    destination,
                )
            })
            .collect();
        let retry = state
            .downloads
            .start_or_get_active(model, retry_artifacts, state.http_client.clone())
            .await
            .unwrap();
        assert_eq!(retry.status, crate::downloads::DownloadJobStatus::Pending);
    }

    #[tokio::test]
    async fn devices_endpoint_returns_ok() {
        let app = create_router(test_state());
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/devices")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn delete_endpoint_handles_missing_model() {
        let app = create_router(test_state());
        let response = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/v1/models/tiny")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn pause_and_cancel_active_return_not_found_when_no_job() {
        let state = test_state();
        let app = create_router(state);
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/models/tiny/download/pause")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
