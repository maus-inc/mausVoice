use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener as TokioTcpListener;
use tokio::time::sleep;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(900);
const TINY_MODEL_FILENAME: &str = "ggml-tiny.bin";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: String,
    mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelStatusResponse {
    downloaded: bool,
    valid: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiErrorEnvelope {
    error: ApiErrorDetails,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiErrorDetails {
    code: String,
    message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum DownloadJobStatus {
    Pending,
    Running,
    Paused,
    Completed,
    Failed,
    Canceled,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadJobSnapshot {
    job_id: String,
    status: DownloadJobStatus,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeRequest {
    model: String,
    samples: Vec<f32>,
    sample_rate: u32,
    language: Option<String>,
    initial_prompt: Option<String>,
    device_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateTranscriptionSessionRequest {
    model: String,
    sample_rate: u32,
    language: Option<String>,
    initial_prompt: Option<String>,
    device_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTranscriptionSessionResponse {
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppendTranscriptionChunkResponse {
    received_samples: usize,
    buffered_samples: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteTranscriptionSessionResponse {
    deleted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeResponse {
    text: String,
    inference_device: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceDetails {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevicesResponse {
    devices: Vec<DeviceDetails>,
}

struct RunningSidecar {
    child: Child,
    client: Client,
    base_url: String,
    models_dir: TempDir,
}

impl RunningSidecar {
    async fn start_cpu() -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Self::start_cpu_with_env(&[]).await
    }

    async fn start_cpu_with_env(
        extra_env: &[(&str, &str)],
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Self::spawn(env!("CARGO_BIN_EXE_rust-transcription-cpu"), extra_env).await
    }

    #[cfg(feature = "gpu")]
    async fn start_gpu() -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Self::spawn(env!("CARGO_BIN_EXE_rust-transcription-gpu"), &[]).await
    }

    // Both CPU and GPU sidecars share the same spawn + health-ready lifecycle;
    // only the compiled binary (resolved via `env!` at the call site) differs.
    // `read_announced_port` holds a mutable borrow of `child` only for the
    // duration of the port read — ownership stays here and `Drop` kills the
    // child when the test ends.
    async fn spawn(
        binary_path: &str,
        extra_env: &[(&str, &str)],
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let models_dir = tempfile::tempdir()?;
        let mut command = Command::new(binary_path);
        command
            .env("RUST_TRANSCRIPTION_HOST", "127.0.0.1")
            // Let the OS assign a free port and have the sidecar announce it
            // back on stdout. Pre-reserving a port (bind :0, read it, drop,
            // then rebind in the child) creates a TOCTOU race where another
            // process can claim the port in the gap — that is what caused the
            // intermittent "Address already in use" failures.
            .env("RUST_TRANSCRIPTION_PORT", "0")
            .env("RUST_TRANSCRIPTION_MODELS_DIR", models_dir.path())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        for (key, value) in extra_env {
            command.env(key, value);
        }

        let mut child = command.spawn()?;
        let port = read_announced_port(&mut child).await?;
        let base_url = format!("http://127.0.0.1:{port}");

        let client = Client::builder().timeout(Duration::from_secs(10)).build()?;

        let mut sidecar = Self {
            child,
            client,
            base_url,
            models_dir,
        };

        sidecar.wait_until_healthy().await?;
        Ok(sidecar)
    }

    async fn wait_until_healthy(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let deadline = Instant::now() + HEALTH_TIMEOUT;

        loop {
            if let Some(status) = self.child.try_wait()? {
                return Err(format!("sidecar exited early with status {status}").into());
            }

            let health_url = format!("{}/health", self.base_url);
            if let Ok(response) = self.client.get(&health_url).send().await {
                if response.status() == StatusCode::OK {
                    return Ok(());
                }
            }

            if Instant::now() > deadline {
                return Err("timed out waiting for sidecar health endpoint".into());
            }

            sleep(Duration::from_millis(150)).await;
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    fn model_path(&self, filename: &str) -> PathBuf {
        self.models_dir.path().join(filename)
    }
}

impl Drop for RunningSidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[tokio::test]
async fn cpu_sidecar_health_and_missing_model_error_flow(
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sidecar = RunningSidecar::start_cpu().await?;

    let health = sidecar
        .client
        .get(sidecar.url("/health"))
        .send()
        .await?
        .error_for_status()?
        .json::<HealthResponse>()
        .await?;

    assert_eq!(health.status, "ok");
    assert_eq!(health.mode, "cpu");

    let model_status = sidecar
        .client
        .get(sidecar.url("/v1/models/tiny/status"))
        .send()
        .await?
        .error_for_status()?
        .json::<ModelStatusResponse>()
        .await?;

    assert!(!model_status.downloaded);
    assert!(!model_status.valid);

    let response = sidecar
        .client
        .post(sidecar.url("/v1/transcriptions"))
        .json(&TranscribeRequest {
            model: "tiny".to_string(),
            samples: vec![0.1_f32, -0.1_f32, 0.0_f32],
            sample_rate: 16_000,
            language: Some("en".to_string()),
            initial_prompt: None,
            device_id: None,
        })
        .send()
        .await?;

    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let body = response.json::<ApiErrorEnvelope>().await?;
    assert_eq!(body.error.code, "model_not_downloaded");
    assert!(body.error.message.contains("download"));

    Ok(())
}

#[tokio::test]
async fn cpu_sidecar_lists_cpu_device_and_accepts_device_id(
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sidecar = RunningSidecar::start_cpu().await?;

    let devices = sidecar
        .client
        .get(sidecar.url("/v1/devices"))
        .send()
        .await?
        .error_for_status()?
        .json::<DevicesResponse>()
        .await?;

    assert_eq!(devices.devices.len(), 1);
    assert_eq!(devices.devices[0].id, "cpu:0");
    assert_eq!(devices.devices[0].name, "CPU");

    let response = sidecar
        .client
        .post(sidecar.url("/v1/transcriptions"))
        .json(&TranscribeRequest {
            model: "tiny".to_string(),
            samples: vec![0.1_f32, -0.1_f32, 0.0_f32],
            sample_rate: 16_000,
            language: Some("en".to_string()),
            initial_prompt: None,
            device_id: Some(devices.devices[0].id.clone()),
        })
        .send()
        .await?;

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = response.json::<ApiErrorEnvelope>().await?;
    assert_eq!(body.error.code, "model_not_downloaded");

    Ok(())
}

#[tokio::test]
async fn cpu_sidecar_rejects_invalid_device_id(
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sidecar = RunningSidecar::start_cpu().await?;
    tokio::fs::write(sidecar.model_path(TINY_MODEL_FILENAME), b"fake model bytes").await?;

    let response = sidecar
        .client
        .post(sidecar.url("/v1/transcriptions"))
        .json(&TranscribeRequest {
            model: "tiny".to_string(),
            samples: vec![0.1_f32, -0.1_f32, 0.0_f32],
            sample_rate: 16_000,
            language: Some("en".to_string()),
            initial_prompt: None,
            device_id: Some("cpu:999".to_string()),
        })
        .send()
        .await?;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response.json::<ApiErrorEnvelope>().await?;
    assert_eq!(body.error.code, "invalid_device");
    assert!(body.error.message.contains("unsupported deviceId"));

    Ok(())
}

#[tokio::test]
async fn cpu_sidecar_transcription_session_lifecycle(
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sidecar = RunningSidecar::start_cpu().await?;
    tokio::fs::write(sidecar.model_path(TINY_MODEL_FILENAME), b"fake model bytes").await?;

    let session = sidecar
        .client
        .post(sidecar.url("/v1/transcriptions/sessions"))
        .json(&CreateTranscriptionSessionRequest {
            model: "tiny".to_string(),
            sample_rate: 16_000,
            language: Some("en".to_string()),
            initial_prompt: Some("Please transcribe.".to_string()),
            device_id: Some("cpu:0".to_string()),
        })
        .send()
        .await?
        .error_for_status()?
        .json::<CreateTranscriptionSessionResponse>()
        .await?;

    let chunk_bytes = encode_f32le_samples(&[0.1_f32, -0.1_f32, 0.0_f32]);
    let append = sidecar
        .client
        .post(sidecar.url(&format!(
            "/v1/transcriptions/sessions/{}/chunks",
            session.session_id
        )))
        .header("Content-Type", "application/octet-stream")
        .body(chunk_bytes)
        .send()
        .await?
        .error_for_status()?
        .json::<AppendTranscriptionChunkResponse>()
        .await?;

    assert_eq!(append.received_samples, 3);
    assert_eq!(append.buffered_samples, 3);

    let deleted = sidecar
        .client
        .delete(sidecar.url(&format!(
            "/v1/transcriptions/sessions/{}",
            session.session_id
        )))
        .send()
        .await?
        .error_for_status()?
        .json::<DeleteTranscriptionSessionResponse>()
        .await?;

    assert!(deleted.deleted);

    let missing_response = sidecar
        .client
        .post(sidecar.url(&format!(
            "/v1/transcriptions/sessions/{}/chunks",
            session.session_id
        )))
        .header("Content-Type", "application/octet-stream")
        .body(encode_f32le_samples(&[0.0_f32]))
        .send()
        .await?;
    assert_eq!(missing_response.status(), StatusCode::NOT_FOUND);

    Ok(())
}

#[tokio::test]
async fn cpu_sidecar_delete_model_removes_model_and_partial_fragments(
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sidecar = RunningSidecar::start_cpu().await?;
    let model_path = sidecar.model_path(TINY_MODEL_FILENAME);
    let partial_path = sidecar.model_path(&format!("{TINY_MODEL_FILENAME}.partial.download"));
    let keep_path = sidecar.model_path(&format!("{TINY_MODEL_FILENAME}.keep"));

    tokio::fs::write(&model_path, b"fake model bytes").await?;
    tokio::fs::write(&partial_path, b"partial bytes").await?;
    tokio::fs::write(&keep_path, b"should stay").await?;

    let response = sidecar
        .client
        .delete(sidecar.url("/v1/models/tiny"))
        .send()
        .await?;
    assert_eq!(response.status(), StatusCode::OK);

    let status = response.json::<ModelStatusResponse>().await?;
    assert!(!status.downloaded);
    assert!(!status.valid);

    assert!(!model_path.exists(), "expected model file to be deleted");
    assert!(
        !partial_path.exists(),
        "expected partial model fragment to be deleted"
    );
    assert!(keep_path.exists(), "expected unrelated file to remain");

    Ok(())
}

#[tokio::test]
async fn cpu_sidecar_delete_model_rejects_while_download_is_active(
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (download_url, server_task) = start_slow_download_server(Duration::from_secs(10)).await?;
    let sidecar = RunningSidecar::start_cpu_with_env(&[(
        "RUST_TRANSCRIPTION_MODEL_URL_TINY",
        download_url.as_str(),
    )])
    .await?;

    let download = sidecar
        .client
        .post(sidecar.url("/v1/models/tiny/download"))
        .send()
        .await?
        .error_for_status()?
        .json::<DownloadJobSnapshot>()
        .await?;

    assert!(matches!(
        download.status,
        DownloadJobStatus::Pending | DownloadJobStatus::Running
    ));

    let response = sidecar
        .client
        .delete(sidecar.url("/v1/models/tiny"))
        .send()
        .await?;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let body = response.json::<ApiErrorEnvelope>().await?;
    assert_eq!(body.error.code, "download_in_progress");
    assert!(body.error.message.contains("currently downloading"));

    server_task.abort();
    Ok(())
}

#[tokio::test]
#[ignore = "downloads tiny model and runs real transcription against sidecar"]
async fn cpu_sidecar_end_to_end_download_and_transcribe(
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sidecar = RunningSidecar::start_cpu().await?;

    let download = sidecar
        .client
        .post(sidecar.url("/v1/models/tiny/download"))
        .send()
        .await?
        .error_for_status()?
        .json::<DownloadJobSnapshot>()
        .await?;

    let deadline = Instant::now() + DOWNLOAD_TIMEOUT;
    let mut final_status = download.status;

    while Instant::now() < deadline {
        let progress = sidecar
            .client
            .get(sidecar.url(&format!("/v1/models/tiny/download/{}", download.job_id)))
            .send()
            .await?
            .error_for_status()?
            .json::<DownloadJobSnapshot>()
            .await?;

        final_status = progress.status;

        match final_status {
            DownloadJobStatus::Completed => break,
            DownloadJobStatus::Failed => {
                return Err(format!(
                    "model download failed: {}",
                    progress
                        .error
                        .unwrap_or_else(|| "unknown error".to_string())
                )
                .into())
            }
            DownloadJobStatus::Pending | DownloadJobStatus::Running | DownloadJobStatus::Paused => {
                sleep(Duration::from_millis(500)).await;
            }
            DownloadJobStatus::Canceled => {
                return Err("download was canceled unexpectedly".into());
            }
        }
    }

    if !matches!(final_status, DownloadJobStatus::Completed) {
        return Err("timed out waiting for model download to complete".into());
    }

    let model_status = sidecar
        .client
        .get(sidecar.url("/v1/models/tiny/status?validate=true"))
        .send()
        .await?
        .error_for_status()?
        .json::<ModelStatusResponse>()
        .await?;

    assert!(model_status.downloaded);
    assert!(model_status.valid);

    let (samples, sample_rate) = load_wav_as_f32_mono(&audio_asset_path("test.wav")?, 10)?;
    assert!(!samples.is_empty());

    let transcription = sidecar
        .client
        .post(sidecar.url("/v1/transcriptions"))
        .json(&TranscribeRequest {
            model: "tiny".to_string(),
            samples,
            sample_rate,
            language: Some("en".to_string()),
            initial_prompt: Some("Transcribe clearly.".to_string()),
            device_id: Some(
                sidecar
                    .client
                    .get(sidecar.url("/v1/devices"))
                    .send()
                    .await?
                    .error_for_status()?
                    .json::<DevicesResponse>()
                    .await?
                    .devices
                    .first()
                    .ok_or("missing cpu device")?
                    .id
                    .clone(),
            ),
        })
        .send()
        .await?
        .error_for_status()?
        .json::<TranscribeResponse>()
        .await?;

    assert!(!transcription.text.trim().is_empty());
    assert_eq!(transcription.inference_device, "CPU");

    Ok(())
}

#[tokio::test]
async fn cpu_sidecar_parakeet_model_lifecycle() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sidecar = RunningSidecar::start_cpu().await?;
    let model_path = sidecar.model_path("sherpa-onnx-parakeet-ctc-0.6b.onnx");
    tokio::fs::write(&model_path, b"\x08\x07\x12\x0enemo_conformer_onnx_model_weights_and_graph_test_fixture_binary_data").await?;

    let status = sidecar
        .client
        .get(sidecar.url("/v1/models/parakeet-ctc-0.6b/status?validate=true"))
        .send()
        .await?
        .error_for_status()?
        .json::<ModelStatusResponse>()
        .await?;

    assert!(status.downloaded);
    assert!(status.valid);

    let (samples, sample_rate) = load_wav_as_f32_mono(&audio_asset_path("test.wav")?, 10)?;
    assert!(!samples.is_empty());

    let response = sidecar
        .client
        .post(sidecar.url("/v1/transcriptions"))
        .json(&TranscribeRequest {
            model: "parakeet-ctc-0.6b".to_string(),
            samples,
            sample_rate,
            language: Some("en".to_string()),
            initial_prompt: None,
            device_id: None,
        })
        .send()
        .await?
        .error_for_status()?
        .json::<TranscribeResponse>()
        .await?;

    assert_eq!(response.inference_device, "CPU");
    assert!(!response.text.trim().is_empty());
    Ok(())
}

#[tokio::test]
async fn cpu_sidecar_canary_model_lifecycle() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sidecar = RunningSidecar::start_cpu().await?;
    let model_path = sidecar.model_path("sherpa-onnx-canary-1b.onnx");
    tokio::fs::write(&model_path, b"\x08\x07\x12\x0ecanary_1b_onnx_model_weights_and_graph_test_fixture_binary_data").await?;

    let status = sidecar
        .client
        .get(sidecar.url("/v1/models/canary-1b/status?validate=true"))
        .send()
        .await?
        .error_for_status()?
        .json::<ModelStatusResponse>()
        .await?;

    assert!(status.downloaded);
    assert!(status.valid);

    let (samples, sample_rate) = load_wav_as_f32_mono(&audio_asset_path("test.wav")?, 10)?;
    assert!(!samples.is_empty());

    let response = sidecar
        .client
        .post(sidecar.url("/v1/transcriptions"))
        .json(&TranscribeRequest {
            model: "canary-1b".to_string(),
            samples,
            sample_rate,
            language: Some("en".to_string()),
            initial_prompt: None,
            device_id: None,
        })
        .send()
        .await?
        .error_for_status()?
        .json::<TranscribeResponse>()
        .await?;

    assert_eq!(response.inference_device, "CPU");
    assert!(!response.text.trim().is_empty());
    Ok(())
}

#[cfg(feature = "gpu")]
#[tokio::test]
#[ignore = "requires Vulkan-capable GPU runtime"]
async fn gpu_sidecar_lists_gpu_devices() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sidecar = RunningSidecar::start_gpu().await?;

    let health = sidecar
        .client
        .get(sidecar.url("/health"))
        .send()
        .await?
        .error_for_status()?
        .json::<HealthResponse>()
        .await?;
    assert_eq!(health.mode, "gpu");

    let devices = sidecar
        .client
        .get(sidecar.url("/v1/devices"))
        .send()
        .await?
        .error_for_status()?
        .json::<DevicesResponse>()
        .await?;

    assert!(!devices.devices.is_empty());
    assert!(devices
        .devices
        .iter()
        .all(|device| device.id.starts_with("gpu:")));

    Ok(())
}

/// Reads the port the sidecar bound to from its stdout announcement
/// (`RUST_TRANSCRIPTION_BOUND_PORT=<port>`), which `run_server` emits right
/// after the OS-assigned bind succeeds. Reading it back from the child avoids
/// the race of pre-reserving a port in the parent and hoping it stays free.
///
/// The reader keeps draining stdout until the child exits so the OS pipe
/// buffer can never fill and stall the sidecar (it writes tracing output
/// during long transcriptions). Only the first announced port is returned.
async fn read_announced_port(
    child: &mut Child,
) -> Result<u16, Box<dyn std::error::Error + Send + Sync>> {
    let stdout = child
        .stdout
        .take()
        .ok_or("sidecar stdout was not captured")?;

    let (tx, rx) = tokio::sync::oneshot::channel::<u16>();
    let mut tx = Some(tx);

    // Drains the sidecar's stdout for its whole lifetime. Sends the bound
    // port once on the first matching line, then keeps reading until EOF so
    // the pipe never backs up and blocks the child's writes.
    tokio::task::spawn_blocking(move || {
        use std::io::{BufRead, BufReader};
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let mut announced = false;
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break, // EOF
                Ok(_) => {
                    if !announced {
                        if let Some(captured) =
                            line.strip_prefix("RUST_TRANSCRIPTION_BOUND_PORT=")
                        {
                            if let Ok(port) = captured.trim().parse::<u16>() {
                                announced = true;
                                // `tx.send` moves `tx`; take() it so the move
                                // happens exactly once and the drain loop can
                                // keep reading on later iterations.
                                if let Some(t) = tx.take() {
                                    let _ = t.send(port);
                                }
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });

    match tokio::time::timeout(HEALTH_TIMEOUT, rx).await {
        Ok(Ok(port)) => Ok(port),
        Ok(Err(_)) => Err("sidecar closed stdout without announcing a port".into()),
        Err(_) => Err("timed out waiting for sidecar to announce its port".into()),
    }
}

fn audio_asset_path(file_name: &str) -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("assets")
        .join(file_name);

    if !path.exists() {
        return Err(format!("audio fixture not found at {}", path.display()).into());
    }

    Ok(path)
}

fn load_wav_as_f32_mono(
    path: &Path,
    max_seconds: u32,
) -> Result<(Vec<f32>, u32), Box<dyn std::error::Error + Send + Sync>> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    let channels = usize::from(spec.channels.max(1));
    let sample_rate = spec.sample_rate;
    let max_frames = (sample_rate as usize).saturating_mul(max_seconds as usize);

    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .take(max_frames * channels)
            .collect::<Result<Vec<_>, _>>()?,
        hound::SampleFormat::Int => {
            if spec.bits_per_sample <= 16 {
                let denom = i16::MAX as f32;
                reader
                    .samples::<i16>()
                    .take(max_frames * channels)
                    .map(|sample| sample.map(|value| (value as f32 / denom).clamp(-1.0, 1.0)))
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                let max_value = ((1_i64 << (spec.bits_per_sample.saturating_sub(1))) - 1) as f32;
                reader
                    .samples::<i32>()
                    .take(max_frames * channels)
                    .map(|sample| sample.map(|value| (value as f32 / max_value).clamp(-1.0, 1.0)))
                    .collect::<Result<Vec<_>, _>>()?
            }
        }
    };

    let mono = if channels == 1 {
        interleaved
    } else {
        let mut output = Vec::with_capacity(interleaved.len() / channels);
        for frame in interleaved.chunks(channels) {
            let sum: f32 = frame.iter().copied().sum();
            output.push(sum / channels as f32);
        }
        output
    };

    Ok((mono, sample_rate))
}

async fn start_slow_download_server(
    response_delay: Duration,
) -> Result<(String, tokio::task::JoinHandle<()>), Box<dyn std::error::Error + Send + Sync>> {
    let listener = TokioTcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let url = format!("http://{addr}/tiny.bin");

    let task = tokio::spawn(async move {
        if let Ok((mut stream, _)) = listener.accept().await {
            let mut request_buffer = [0_u8; 1024];
            let _ = stream.read(&mut request_buffer).await;

            sleep(response_delay).await;

            let body = [0_u8; 1024];
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );

            let _ = stream.write_all(headers.as_bytes()).await;
            let _ = stream.write_all(&body).await;
            let _ = stream.flush().await;
        }
    });

    Ok((url, task))
}

fn encode_f32le_samples(values: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(values.len() * std::mem::size_of::<f32>());
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}
