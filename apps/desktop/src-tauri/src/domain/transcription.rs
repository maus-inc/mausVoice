use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionAudioSnapshot {
    pub file_path: String,
    pub duration_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Transcription {
    pub id: String,
    pub transcript: String,
    pub timestamp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<TranscriptionAudioSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inference_device: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_transcript: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sanitized_transcript: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_process_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription_api_key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_process_api_key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_process_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_process_device: Option<String>,
    /// Provider slug (e.g. "cerebras") selected for post-processing,
    /// persisted even when the request fails so history attributes the
    /// attempt instead of showing "no provider selected".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_process_provider: Option<String>,
    /// True when a post-processing request was attempted and failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_process_failed: Option<bool>,
    /// Sanitized, non-secret error message from a failed post-processing
    /// request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_process_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription_duration_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub postprocess_duration_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_device_id: Option<String>,
}
