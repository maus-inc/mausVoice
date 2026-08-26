use serde::{Deserialize, Serialize};

pub const DEFAULT_DICTATION_LIMIT_MINUTES: i64 = 5;

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UserPreferences {
    pub user_id: String,
    #[serde(default)]
    pub transcription_mode: Option<String>,
    #[serde(default)]
    pub transcription_api_key_id: Option<String>,
    #[serde(default)]
    pub transcription_device: Option<String>,
    #[serde(default)]
    pub transcription_model_size: Option<String>,
    #[serde(default)]
    pub post_processing_mode: Option<String>,
    #[serde(default)]
    pub post_processing_api_key_id: Option<String>,
    #[serde(default)]
    pub post_processing_ollama_url: Option<String>,
    #[serde(default)]
    pub post_processing_ollama_model: Option<String>,
    #[serde(default)]
    pub agent_mode: Option<String>,
    #[serde(default)]
    pub agent_mode_api_key_id: Option<String>,
    #[serde(default)]
    pub openclaw_gateway_url: Option<String>,
    #[serde(default)]
    pub openclaw_token: Option<String>,
    #[serde(default)]
    pub active_tone_id: Option<String>,
    #[serde(default)]
    pub got_started_at: Option<i64>,
    #[serde(default)]
    pub gpu_enumeration_enabled: bool,
    #[serde(default)]
    pub paste_keybind: Option<String>,
    #[serde(default)]
    pub last_seen_feature: Option<String>,
    #[serde(default)]
    pub language_switch_enabled: bool,
    #[serde(default)]
    pub secondary_dictation_language: Option<String>,
    #[serde(default)]
    pub active_dictation_language: Option<String>,
    #[serde(default)]
    pub additional_dictation_languages: Option<Vec<String>>,
    #[serde(default)]
    pub preferred_microphone: Option<String>,
    #[serde(default)]
    pub ignore_update_dialog: bool,
    #[serde(default)]
    pub incognito_mode_enabled: bool,
    #[serde(default)]
    pub incognito_mode_include_in_stats: bool,
    #[serde(default = "default_preserve_audio_on_failure")]
    pub preserve_audio_on_failure: bool,
    #[serde(default = "default_dictation_limit_minutes")]
    pub dictation_limit_minutes: i64,
    #[serde(default = "default_dictation_pill_visibility")]
    pub dictation_pill_visibility: String,
    #[serde(default)]
    pub use_new_backend: bool,
    #[serde(default)]
    pub realtime_output_enabled: bool,
    #[serde(default)]
    pub remote_output_enabled: bool,
    #[serde(default)]
    pub remote_target_device_id: Option<String>,
    #[serde(default)]
    pub remote_receiver_port: Option<i64>,
    #[serde(default)]
    pub remote_receiver_auto_start: bool,
    #[serde(default = "default_dictation_audio_dim")]
    pub dictation_audio_dim: f64,
    #[serde(default)]
    pub menu_bar_icon_hidden: bool,
    #[serde(default)]
    pub insertion_method: Option<String>,
    #[serde(default)]
    pub typing_speed_ms: Option<i64>,
    /// Which monitor "Reset Pill Position" re-homes the pill onto:
    /// "current" (the monitor the pill lives on) or "cursor".
    #[serde(default = "default_pill_reset_monitor_strategy")]
    pub pill_reset_monitor_strategy: String,
    /// Request admin elevation (UAC) on every startup. Windows-only; off by
    /// default so existing behavior is unchanged.
    #[serde(default)]
    pub always_request_admin_on_startup: bool,
    /// Where the dictation pill anchors on screen. Accepted values are
    /// "top" or "bottom"; any other value is treated as the default
    /// "bottom" so legacy data never breaks the UI.
    #[serde(default = "default_pill_placement")]
    pub pill_placement: String,
    /// Delay (ms) between a hands-free stop and the actual paste/type
    /// action. NULL disables the delay (immediate paste on stop).
    #[serde(default)]
    pub hands_free_delay_ms: Option<i64>,
    #[serde(default)]
    pub in_dictation_style_switching_enabled: bool,
    #[serde(default = "default_hallucination_filter_enabled")]
    pub hallucination_filter_enabled: bool,
    #[serde(default)]
    pub review_before_insert: Option<bool>,
    #[serde(default)]
    pub agent_enabled_tools: Option<String>,
    #[serde(default = "default_agent_max_iterations")]
    pub agent_max_iterations: i64,
    #[serde(default = "default_agent_permission_timeout_ms")]
    pub agent_permission_timeout_ms: i64,
    /// Deterministic spoken formatting / scratch-that. Default on.
    #[serde(default = "default_true")]
    pub spoken_commands_enabled: bool,
}

fn default_hallucination_filter_enabled() -> bool {
    true
}

fn default_agent_max_iterations() -> i64 {
    20
}

fn default_agent_permission_timeout_ms() -> i64 {
    60_000

fn default_pill_reset_monitor_strategy() -> String {
    "current".to_string()
}

fn default_dictation_pill_visibility() -> String {
    "while_active".to_string()
}

fn default_dictation_limit_minutes() -> i64 {
    DEFAULT_DICTATION_LIMIT_MINUTES
}

fn default_dictation_audio_dim() -> f64 {
    1.0
}

fn default_preserve_audio_on_failure() -> bool {
    true
}

fn default_pill_placement() -> String {
    "bottom".to_string()
}

fn default_true() -> bool {
    true
}
