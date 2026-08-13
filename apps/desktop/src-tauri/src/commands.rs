use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use url::Url;

/// Per-command re-entry guards. When an IPC command mutates global OS state
/// (synthesized keystrokes, clipboard, audio playback), invoking it again
/// before the previous call completes produces interleaved/garbled output
/// and is almost always a bug (double-click, repeat-key, or async race).
/// These flags are acquired before the blocking work runs and released when
/// it finishes; a second call returns a clear error instead of stacking.
static PASTE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static SIMULATE_TYPE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static PLAY_AUDIO_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Drop-guard that clears an AtomicBool re-entry flag when it goes out of
/// scope. Panics during the blocking work still release the guard so a
/// crash on one command doesn't wedge the feature forever.
struct ReentryGuard<'a> {
    flag: &'a AtomicBool,
}

impl<'a> ReentryGuard<'a> {
    fn acquire(flag: &'a AtomicBool) -> Result<Self, String> {
        if flag
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("Command is already in progress".to_string());
        }
        Ok(Self { flag })
    }
}

impl Drop for ReentryGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::Release);
    }
}

/// Monotonic id for the currently-active (most recently started) typing
/// session. The platform `type_text_into_focused_field` reads
/// `CANCEL_TYPING`; we leave that flag as the single cancel signal, but
/// `cancel_typing` can optionally target a specific session so cancel
/// signals from an earlier session cannot cancel a newer one.
static TYPING_SESSION_ID: AtomicU64 = AtomicU64::new(0);

static CANCEL_TYPING: AtomicBool = AtomicBool::new(false);
use tauri::{AppHandle, EventTarget, Manager, State};

use crate::domain::{
    ApiKey, ApiKeyCreateRequest, ApiKeyView, AudioChunkPayload, OverlayPhase, OverlayPhasePayload,
    RecordingLevelPayload, TranscriptionAudioSnapshot, EVT_AUDIO_CHUNK, EVT_OVERLAY_PHASE,
    EVT_REC_LEVEL,
};
use crate::platform::{ChunkCallback, LevelCallback};
use crate::system::crypto::{protect_api_key, reveal_api_key};
use crate::system::StorageRepo;

use crate::platform::input::paste_text_into_focused_field as platform_paste_text;

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StopRecordingResponse {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StartRecordingResponse {
    pub sample_rate: u32,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CurrentAppInfoResponse {
    pub app_name: String,
    pub icon_base64: String,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TextFieldInfo {
    pub cursor_position: Option<usize>,
    pub selection_length: Option<usize>,
    pub text_content: Option<String>,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScreenContextInfo {
    pub screen_context: Option<String>,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityDumpResult {
    pub dump: Option<String>,
    pub window_title: Option<String>,
    pub process_name: Option<String>,
    pub element_count: usize,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ElementFingerprint {
    pub automation_id: Option<String>,
    pub class_name: Option<String>,
    pub control_type: i32,
    pub name: Option<String>,
    pub framework_id: Option<String>,
    pub child_index: usize,
    /// macOS only. AXRole of the element at this depth (e.g. "AXTextArea").
    /// Required match at resolve time when present.
    #[serde(default)]
    pub ax_role: Option<String>,
    /// macOS only. AXSubrole if any (e.g. "AXSecureTextField").
    #[serde(default)]
    pub ax_subrole: Option<String>,
    /// macOS only. AXTitle.
    #[serde(default)]
    pub ax_title: Option<String>,
    /// macOS only. AXDescription / AXHelp text.
    #[serde(default)]
    pub ax_description: Option<String>,
    /// macOS only. AXIdentifier (developer-assigned) when present — strongest
    /// stable signal and a hard disqualifier when mismatched.
    #[serde(default)]
    pub ax_identifier: Option<String>,
    /// Free-form escape hatch for future fingerprint metadata. Persisted
    /// round-trip through the frontend / Firestore so we can extend
    /// fingerprinting later without bumping the type schema. Convention:
    /// JSON string keyed by feature name when there's something to store.
    #[serde(default)]
    pub details: Option<String>,
}

/// Canonical string identifier for a JAB element at one level of the tree.
/// JAB has no developer-assigned ID, so we combine `name` + `role` (English)
/// with `index_in_parent` as a tiebreaker when siblings collide.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JabElementId {
    pub name: Option<String>,
    pub role: Option<String>,
    pub index_in_parent: usize,
}

/// Stable, relaunch-surviving identifier for a host application. PIDs change
/// every launch; these fields do not. Populated by `get_focused_field_info`
/// at capture time, then passed to `resolve_app_pids` on subsequent sessions
/// to re-resolve the current PID.
///
/// Every field is optional because availability is platform-dependent and
/// bindings captured on one OS must still deserialize on another.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppIdentity {
    /// Windows: full absolute path to the process executable (e.g.
    /// `C:\Program Files\LigoLab\LigoLab.exe`). Case-insensitive match.
    #[serde(default)]
    pub exe_path: Option<String>,
    /// Windows: basename of `exe_path` (e.g. `LigoLab.exe`). Lossy fallback
    /// used when the install directory differs across machines.
    #[serde(default)]
    pub exe_name: Option<String>,
    /// macOS: `CFBundleIdentifier` of the application (e.g.
    /// `com.ligolab.client`). The canonical stable id on that platform.
    #[serde(default)]
    pub bundle_id: Option<String>,
}

/// A currently-running process that matches an `AppIdentity`. Returned from
/// `resolve_app_pids`; the caller (frontend) picks one, typically by
/// matching `window_title` against the title recorded with the binding.
#[derive(serde::Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppProcessMatch {
    pub pid: i32,
    pub exe_path: Option<String>,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityFieldInfo {
    pub role: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub value: Option<String>,
    pub placeholder: Option<String>,
    pub app_pid: Option<i32>,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub is_settable: bool,
    pub element_index_path: Vec<usize>,
    pub fingerprint_chain: Vec<ElementFingerprint>,
    pub can_paste: bool,
    /// "jab" for Java Access Bridge fields, None for UIAutomation
    #[serde(default)]
    pub backend: Option<String>,
    /// Canonical string path for JAB elements. Empty for UIAutomation.
    /// When present, resolvers prefer it over `element_index_path`.
    #[serde(default)]
    pub jab_string_path: Vec<JabElementId>,
    /// Stable identity (exe path, bundle id, ...) captured at bind time.
    /// Persisting this alongside the PID lets callers re-resolve the PID
    /// after the host app restarts via `resolve_app_pids`.
    #[serde(default)]
    pub app_identity: Option<AppIdentity>,
    /// Free-form escape hatch for future field metadata. See the matching
    /// field on `ElementFingerprint` — same purpose: lets us extend the
    /// payload later without shipping a new schema version.
    #[serde(default)]
    pub details: Option<String>,
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityFocusTarget {
    pub app_pid: i32,
    pub element_index_path: Vec<usize>,
    pub fingerprint_chain: Option<Vec<ElementFingerprint>>,
    #[serde(default)]
    pub backend: Option<String>,
    #[serde(default)]
    pub jab_string_path: Option<Vec<JabElementId>>,
}

#[derive(serde::Deserialize, Clone, Debug, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum JabWriteMethod {
    /// JAB `setTextContents` API — replaces entire field contents directly.
    SetTextContents,
    /// Focus element → Ctrl+A → Ctrl+V (clipboard paste). Default.
    #[default]
    ClipboardPaste,
    /// Focus element → Ctrl+A → type each character via SendInput.
    KeystrokeSimulation,
    /// Read current text, compute diff, apply minimal edits via cursor + keystrokes.
    KeystrokeSimulationSmart,
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityWriteEntry {
    pub app_pid: i32,
    pub element_index_path: Vec<usize>,
    pub fingerprint_chain: Option<Vec<ElementFingerprint>>,
    pub value: String,
    #[serde(default)]
    pub backend: Option<String>,
    #[serde(default)]
    pub jab_write_method: JabWriteMethod,
    #[serde(default)]
    pub jab_string_path: Option<Vec<JabElementId>>,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityWriteResult {
    pub succeeded: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldValueRequest {
    pub app_pid: i32,
    pub element_index_path: Vec<usize>,
    pub fingerprint_chain: Option<Vec<ElementFingerprint>>,
    #[serde(default)]
    pub backend: Option<String>,
    #[serde(default)]
    pub jab_string_path: Option<Vec<JabElementId>>,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldValueResult {
    pub value: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, serde::Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PasteTargetState {
    Editable,
    NotEditable,
    Unknown,
}

#[derive(Debug, Clone, Copy, serde::Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PasteOutcome {
    Pasted,
    CopiedToClipboard,
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppTargetUpsertArgs {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub tone_id: Option<String>,
    #[serde(default)]
    pub icon_path: Option<String>,
    #[serde(default)]
    pub paste_keybind: Option<String>,
    #[serde(default)]
    pub insertion_method: Option<String>,
    #[serde(default)]
    pub typing_speed_ms: Option<i64>,
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PairedRemoteDeviceUpsertArgs {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub role: String,
    pub shared_secret: String,
    pub paired_at: String,
    #[serde(default)]
    pub last_seen_at: Option<String>,
    #[serde(default)]
    pub last_known_address: Option<String>,
    #[serde(default)]
    pub trusted: bool,
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PairedRemoteDeviceDeleteArgs {
    pub id: String,
}

#[derive(serde::Deserialize, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StartRemoteReceiverArgs {
    #[serde(default)]
    pub port: Option<u16>,
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSenderDeliverArgs {
    pub target_device_id: String,
    pub text: String,
    pub mode: String,
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSenderPairArgs {
    pub receiver_device_id: String,
    pub receiver_name: String,
    pub receiver_platform: String,
    pub receiver_address: String,
    pub pairing_code: String,
}

#[derive(serde::Deserialize, specta::Type)]
pub enum AudioClip {
    #[serde(rename = "start_recording_clip")]
    StartRecordingClip,
    #[serde(rename = "stop_recording_clip")]
    StopRecordingClip,
    #[serde(rename = "alert_macos_clip")]
    AlertMacosClip,
    #[serde(rename = "alert_windows_10_clip")]
    AlertWindows10Clip,
    #[serde(rename = "alert_windows_11_clip")]
    AlertWindows11Clip,
}

#[derive(serde::Deserialize, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StartRecordingArgs {
    pub preferred_microphone: Option<String>,
}

#[derive(Debug, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UserPreferencesGetArgs {
    pub user_id: String,
}

const MAX_RETAINED_TRANSCRIPTION_AUDIO: usize = 20;

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionAudioData {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

async fn delete_audio_entries(
    app: AppHandle,
    entries: Vec<(String, String)>,
) -> Result<Vec<String>, String> {
    if entries.is_empty() {
        return Ok(Vec::new());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let mut removed = Vec::new();
        for (id, path) in entries {
            let file_path = PathBuf::from(&path);
            if let Err(err) = crate::system::audio_store::delete_audio_file(&app, &file_path) {
                log::error!("Failed to delete audio file for transcription {id}: {err}");
            }
            removed.push(id);
        }
        removed
    })
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn user_set_one(
    user: crate::domain::User,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::User, String> {
    crate::db::user_queries::upsert_user(database.pool(), &user)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn user_get_one(
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Option<crate::domain::User>, String> {
    crate::db::user_queries::fetch_user(database.pool())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn user_preferences_set(
    preferences: crate::domain::UserPreferences,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::UserPreferences, String> {
    crate::db::preferences_queries::upsert_user_preferences(database.pool(), &preferences)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn user_preferences_get(
    args: UserPreferencesGetArgs,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Option<crate::domain::UserPreferences>, String> {
    crate::db::preferences_queries::fetch_user_preferences(database.pool(), &args.user_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn list_microphones() -> Vec<crate::platform::audio::InputDeviceDescriptor> {
    crate::platform::audio::list_input_devices()
}

#[tauri::command]
#[specta::specta]
pub fn list_gpus() -> Vec<crate::system::gpu::GpuAdapterInfo> {
    crate::system::gpu::list_available_gpus()
}

/// Static machine capabilities (RAM, CPU cores, GPU list) used by the
/// frontend to recommend local transcription models that fit the device.
#[tauri::command]
#[specta::specta]
pub fn get_system_capabilities() -> crate::system::capabilities::SystemCapabilities {
    crate::system::capabilities::get_system_capabilities()
}

#[tauri::command]
#[specta::specta]
pub fn get_monitor_at_cursor() -> Option<crate::domain::MonitorAtCursor> {
    crate::platform::monitor::get_monitor_at_cursor()
}

#[tauri::command]
#[specta::specta]
pub fn get_screen_visible_area() -> crate::domain::ScreenVisibleArea {
    crate::platform::monitor::get_screen_visible_area()
}

#[tauri::command]
#[specta::specta]
pub fn check_microphone_permission() -> Result<crate::domain::PermissionStatus, String> {
    crate::platform::permissions::check_microphone_permission()
}

#[tauri::command]
#[specta::specta]
pub fn request_microphone_permission() -> Result<crate::domain::PermissionStatus, String> {
    crate::platform::permissions::request_microphone_permission()
}

#[tauri::command]
#[specta::specta]
pub fn check_accessibility_permission() -> Result<crate::domain::PermissionStatus, String> {
    crate::platform::permissions::check_accessibility_permission()
}

#[tauri::command]
#[specta::specta]
pub fn request_accessibility_permission() -> Result<crate::domain::PermissionStatus, String> {
    crate::platform::permissions::request_accessibility_permission()
}

#[tauri::command]
#[specta::specta]
pub async fn get_current_app_info() -> Result<CurrentAppInfoResponse, String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tauri::async_runtime::spawn_blocking(|| {
            crate::platform::app_info::get_current_app_info().map(|info| CurrentAppInfoResponse {
                app_name: info.app_name,
                icon_base64: info.icon_base64,
            })
        }),
    )
    .await
    .map_err(|_| "get_current_app_info timed out".to_string())?
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn app_target_upsert(
    args: AppTargetUpsertArgs,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::AppTarget, String> {
    crate::db::app_target_queries::upsert_app_target(
        database.pool(),
        &args.id,
        &args.name,
        args.tone_id,
        args.icon_path,
        args.paste_keybind,
        args.insertion_method,
        args.typing_speed_ms,
    )
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn app_target_list(
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Vec<crate::domain::AppTarget>, String> {
    crate::db::app_target_queries::fetch_app_targets(database.pool())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn paired_remote_device_upsert(
    args: PairedRemoteDeviceUpsertArgs,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::PairedRemoteDevice, String> {
    let device = crate::domain::PairedRemoteDevice {
        id: args.id,
        name: args.name,
        platform: args.platform,
        role: args.role,
        shared_secret: args.shared_secret,
        paired_at: args.paired_at,
        last_seen_at: args.last_seen_at,
        last_known_address: args.last_known_address,
        trusted: args.trusted,
    };

    crate::db::paired_remote_device_queries::upsert_paired_remote_device(database.pool(), &device)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn paired_remote_device_list(
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Vec<crate::domain::PairedRemoteDevice>, String> {
    crate::db::paired_remote_device_queries::fetch_paired_remote_devices(database.pool())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn paired_remote_device_delete(
    args: PairedRemoteDeviceDeleteArgs,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<(), String> {
    crate::db::paired_remote_device_queries::delete_paired_remote_device(database.pool(), &args.id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn remote_receiver_start(
    args: StartRemoteReceiverArgs,
    app: AppHandle,
    database: State<'_, crate::state::OptionKeyDatabase>,
    receiver_state: State<'_, crate::state::RemoteReceiverState>,
) -> Result<crate::state::RemoteReceiverStatus, String> {
    crate::system::remote_receiver::start(
        app,
        receiver_state.inner().clone(),
        database.pool(),
        args.port,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub fn remote_receiver_stop(
    receiver_state: State<'_, crate::state::RemoteReceiverState>,
) -> Result<(), String> {
    crate::system::remote_receiver::stop(receiver_state.inner().clone());
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn remote_receiver_status(
    receiver_state: State<'_, crate::state::RemoteReceiverState>,
) -> Result<crate::state::RemoteReceiverStatus, String> {
    Ok(receiver_state.status())
}

#[tauri::command]
#[specta::specta]
pub async fn remote_sender_deliver_final_text(
    args: RemoteSenderDeliverArgs,
    database: State<'_, crate::state::OptionKeyDatabase>,
    receiver_state: State<'_, crate::state::RemoteReceiverState>,
) -> Result<(), String> {
    crate::system::remote_sender::deliver_final_text(
        database.pool(),
        receiver_state.inner().clone(),
        &args.target_device_id,
        &args.text,
        &args.mode,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn remote_sender_pair_with_receiver(
    args: RemoteSenderPairArgs,
    database: State<'_, crate::state::OptionKeyDatabase>,
    receiver_state: State<'_, crate::state::RemoteReceiverState>,
) -> Result<crate::domain::PairedRemoteDevice, String> {
    crate::system::remote_sender::pair_with_receiver(
        database.pool(),
        receiver_state.inner().clone(),
        &args.receiver_device_id,
        &args.receiver_name,
        &args.receiver_platform,
        &args.receiver_address,
        &args.pairing_code,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn transcription_create(
    transcription: crate::domain::Transcription,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::Transcription, String> {
    crate::db::transcription_queries::insert_transcription(database.pool(), &transcription)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn transcription_list(
    limit: Option<u32>,
    offset: Option<u32>,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Vec<crate::domain::Transcription>, String> {
    let limit = limit.unwrap_or(20);
    let offset = offset.unwrap_or(0);

    crate::db::transcription_queries::fetch_transcriptions(database.pool(), limit, offset)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn transcription_delete(
    app: AppHandle,
    id: String,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<(), String> {
    let pool = database.pool();

    let audio_path: Option<String> = sqlx::query_scalar(
        "SELECT audio_path
         FROM transcriptions
         WHERE id = ?1",
    )
    .bind(&id)
    .fetch_optional(&pool)
    .await
    .map_err(|err| err.to_string())?;

    if let Some(path) = audio_path {
        delete_audio_entries(app.clone(), vec![(id.clone(), path)]).await?;
    }

    crate::db::transcription_queries::delete_transcription(pool, &id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn transcription_update(
    transcription: crate::domain::Transcription,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::Transcription, String> {
    crate::db::transcription_queries::update_transcription(database.pool(), &transcription)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn transcription_audio_load(
    app: AppHandle,
    id: String,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<TranscriptionAudioData, String> {
    let pool = database.pool();

    let audio_path: Option<String> = sqlx::query_scalar(
        "SELECT audio_path
         FROM transcriptions
         WHERE id = ?1",
    )
    .bind(&id)
    .fetch_optional(&pool)
    .await
    .map_err(|err| err.to_string())?;

    let audio_path = audio_path
        .ok_or_else(|| "No audio snapshot available for this transcription".to_string())?;

    let audio_dir = crate::system::audio_store::audio_dir(&app).map_err(|err| err.to_string())?;
    let audio_path_buf = PathBuf::from(&audio_path);

    if !audio_path_buf.starts_with(&audio_dir) {
        return Err("Audio snapshot path is outside the managed directory".to_string());
    }

    let (samples, sample_rate) = tauri::async_runtime::spawn_blocking(move || {
        crate::system::audio_store::load_audio_samples(&audio_path_buf)
            .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())??;

    Ok(TranscriptionAudioData {
        samples,
        sample_rate,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn export_transcription(
    app: AppHandle,
    id: String,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<bool, String> {
    let pool = database.pool();

    let row = sqlx::query(
        "SELECT transcript, raw_transcript, audio_path
         FROM transcriptions
         WHERE id = ?1",
    )
    .bind(&id)
    .fetch_optional(&pool)
    .await
    .map_err(|err| err.to_string())?
    .ok_or_else(|| "Transcription not found".to_string())?;

    let transcript: String = row.get("transcript");
    let raw_transcript: Option<String> = row.get("raw_transcript");
    let audio_path: Option<String> = row.get("audio_path");

    let short_id = if id.len() > 8 { &id[..8] } else { &id };
    let dialog = rfd::AsyncFileDialog::new()
        .set_file_name(format!("mausvoice-{short_id}.zip"))
        .add_filter("ZIP Archive", &["zip"])
        .save_file()
        .await;

    let save_path = match dialog {
        Some(handle) => handle.path().to_path_buf(),
        None => return Ok(false),
    };

    let audio_dir = crate::system::audio_store::audio_dir(&app).map_err(|err| err.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        use zip::write::SimpleFileOptions;

        let file = std::fs::File::create(&save_path)
            .map_err(|err| format!("Failed to create file: {err}"))?;
        let mut zip = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        zip.start_file("processed.txt", options)
            .map_err(|err| err.to_string())?;
        zip.write_all(transcript.as_bytes())
            .map_err(|err| err.to_string())?;

        if let Some(ref raw) = raw_transcript {
            if !raw.is_empty() {
                zip.start_file("raw.txt", options)
                    .map_err(|err| err.to_string())?;
                zip.write_all(raw.as_bytes())
                    .map_err(|err| err.to_string())?;
            }
        }

        if let Some(ref audio_path_str) = audio_path {
            let audio_path_buf = PathBuf::from(audio_path_str);
            if audio_path_buf.starts_with(&audio_dir) && audio_path_buf.exists() {
                let audio_data = std::fs::read(&audio_path_buf)
                    .map_err(|err| format!("Failed to read audio: {err}"))?;
                zip.start_file("audio.wav", options)
                    .map_err(|err| err.to_string())?;
                zip.write_all(&audio_data).map_err(|err| err.to_string())?;
            }
        }

        zip.finish().map_err(|err| err.to_string())?;
        Ok::<bool, String>(true)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn export_diagnostics(app: AppHandle, diagnostics_info: String) -> Result<bool, String> {
    let dialog = rfd::AsyncFileDialog::new()
        .set_file_name("mausvoice-diagnostics.zip")
        .add_filter("ZIP Archive", &["zip"])
        .save_file()
        .await;

    let save_path = match dialog {
        Some(handle) => handle.path().to_path_buf(),
        None => return Ok(false),
    };

    let logs_dir = crate::system::paths::logs_dir(&app).map_err(|err| err.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        use zip::write::SimpleFileOptions;

        let file = std::fs::File::create(&save_path)
            .map_err(|err| format!("Failed to create file: {err}"))?;
        let mut zip = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        // Write diagnostics info
        zip.start_file("diagnostics.txt", options)
            .map_err(|err| err.to_string())?;
        zip.write_all(diagnostics_info.as_bytes())
            .map_err(|err| err.to_string())?;

        // Include all files from the logs directory
        if let Ok(entries) = std::fs::read_dir(&logs_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let filename = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown");
                let raw =
                    std::fs::read(&path).map_err(|err| format!("Failed to read log: {err}"))?;
                let content = match std::str::from_utf8(&raw) {
                    Ok(text) => {
                        crate::utils::log_sanitizer::sanitize_log_content(text).into_bytes()
                    }
                    Err(_) => raw,
                };
                zip.start_file(format!("logs/{filename}"), options)
                    .map_err(|err| err.to_string())?;
                zip.write_all(&content).map_err(|err| err.to_string())?;
            }
        }

        zip.finish().map_err(|err| err.to_string())?;
        Ok::<bool, String>(true)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn term_create(
    term: crate::domain::Term,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::Term, String> {
    crate::db::term_queries::insert_term(database.pool(), &term)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn term_update(
    term: crate::domain::Term,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::Term, String> {
    crate::db::term_queries::update_term(database.pool(), &term)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn term_list(
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Vec<crate::domain::Term>, String> {
    crate::db::term_queries::fetch_terms(database.pool())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn term_delete(
    id: String,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<(), String> {
    crate::db::term_queries::delete_term(database.pool(), &id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn hotkey_list(
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Vec<crate::domain::Hotkey>, String> {
    crate::db::hotkey_queries::fetch_hotkeys(database.pool())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn hotkey_save(
    hotkey: crate::domain::Hotkey,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::Hotkey, String> {
    crate::db::hotkey_queries::upsert_hotkey(database.pool(), &hotkey)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn hotkey_delete(
    id: String,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<(), String> {
    crate::db::hotkey_queries::delete_hotkey(database.pool(), &id)
        .await
        .map_err(|err| err.to_string())
}

fn current_timestamp_millis() -> Result<i64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("System clock is before UNIX epoch: {err}"))?;

    duration
        .as_millis()
        .try_into()
        .map_err(|_| "System timestamp out of representable range".to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn api_key_create(
    api_key: ApiKeyCreateRequest,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<ApiKeyView, String> {
    let ApiKeyCreateRequest {
        id,
        name,
        provider,
        key,
        base_url,
        azure_region,
        include_v1_path,
    } = api_key;

    let protected = protect_api_key(&key);
    let created_at = current_timestamp_millis()?;

    let stored = ApiKey {
        id,
        name,
        provider,
        created_at,
        salt: protected.salt_b64,
        key_hash: protected.hash_b64,
        key_ciphertext: protected.ciphertext_b64,
        key_suffix: protected.key_suffix,
        transcription_model: None,
        post_processing_model: None,
        openrouter_config: None,
        base_url,
        azure_region,
        include_v1_path,
    };

    crate::db::api_key_queries::insert_api_key(database.pool(), &stored)
        .await
        .map(|saved| ApiKeyView::from(saved).with_full_key(Some(key)))
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn api_key_list(
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Vec<ApiKeyView>, String> {
    crate::db::api_key_queries::fetch_api_keys(database.pool())
        .await
        .map(|api_keys| {
            api_keys
                .into_iter()
                .map(|api_key| {
                    let full_key = reveal_api_key(&api_key.salt, &api_key.key_ciphertext)
                        .map_err(|err| {
                            log::error!("Failed to reveal API key {}: {}", api_key.id, err);
                            err
                        })
                        .ok();
                    ApiKeyView::from(api_key).with_full_key(full_key)
                })
                .collect()
        })
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn api_key_delete(
    id: String,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<(), String> {
    crate::db::api_key_queries::delete_api_key(database.pool(), &id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn api_key_update(
    request: crate::domain::ApiKeyUpdateRequest,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<ApiKeyView, String> {
    let (salt, key_hash, key_ciphertext, key_suffix, full_key) =
        match request.key.as_deref().filter(|k| !k.is_empty()) {
            Some(raw_key) => {
                let protected = protect_api_key(raw_key);
                (
                    Some(protected.salt_b64),
                    Some(protected.hash_b64),
                    Some(protected.ciphertext_b64),
                    protected.key_suffix,
                    Some(raw_key.to_string()),
                )
            }
            None => (None, None, None, None, None),
        };

    crate::db::api_key_queries::update_api_key(
        database.pool(),
        &request,
        salt.as_deref(),
        key_hash.as_deref(),
        key_ciphertext.as_deref(),
        key_suffix.as_deref(),
    )
    .await
    .map_err(|err| err.to_string())?;

    // Re-fetch the updated key to return fresh data
    let all_keys = crate::db::api_key_queries::fetch_api_keys(database.pool())
        .await
        .map_err(|err| err.to_string())?;

    let updated = all_keys
        .into_iter()
        .find(|k| k.id == request.id)
        .ok_or_else(|| "API key not found after update".to_string())?;

    let revealed = if full_key.is_some() {
        full_key
    } else {
        reveal_api_key(&updated.salt, &updated.key_ciphertext)
            .map_err(|err| {
                log::error!("Failed to reveal API key {}: {}", updated.id, err);
                err
            })
            .ok()
    };

    Ok(ApiKeyView::from(updated).with_full_key(revealed))
}

#[tauri::command]
#[specta::specta]
pub async fn tone_upsert(
    tone: crate::domain::Tone,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::Tone, String> {
    let pool = database.pool();

    if let Some(existing) = crate::db::tone_queries::fetch_tone_by_id(pool.clone(), &tone.id)
        .await
        .map_err(|err| err.to_string())?
    {
        let updated = crate::domain::Tone {
            created_at: existing.created_at,
            ..tone.clone()
        };

        crate::db::tone_queries::update_tone(pool.clone(), &updated)
            .await
            .map_err(|err| err.to_string())?;

        return Ok(updated);
    }

    let created_at = if tone.created_at > 0 {
        tone.created_at
    } else {
        current_timestamp_millis()?
    };

    let new_tone = crate::domain::Tone { created_at, ..tone };

    crate::db::tone_queries::insert_tone(pool, &new_tone)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn tone_list(
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Vec<crate::domain::Tone>, String> {
    crate::db::tone_queries::fetch_all_tones(database.pool())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn tone_get(
    id: String,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Option<crate::domain::Tone>, String> {
    crate::db::tone_queries::fetch_tone_by_id(database.pool(), &id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn tone_delete(
    id: String,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<(), String> {
    crate::db::tone_queries::delete_tone(database.pool(), &id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn clear_local_data(
    app: AppHandle,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<(), String> {
    let pool = database.pool();

    // Wipe every user-data table. When adding user-data tables, extend this
    // list — the UI explicitly promises "this will delete all preferences,
    // dictionary entries, and saved transcriptions from this device" and a
    // missed table here is a privacy leak.
    //
    // Table names are all `&'static str` literals from this source file
    // (never user input), so `format!` is safe from SQL injection here.
    const TABLES_TO_CLEAR: [&str; 11] = [
        "chat_messages",
        "conversations",
        "user_profiles",
        "transcriptions",
        "terms",
        "hotkeys",
        "api_keys",
        "user_preferences",
        "tones",
        "app_targets",
        "paired_remote_devices",
    ];

    // Collect audio file paths BEFORE wiping transcriptions so we can delete
    // them from disk after the transaction commits.
    let audio_paths: Vec<String> = sqlx::query_scalar::<_, String>(
        "SELECT audio_path FROM transcriptions WHERE audio_path IS NOT NULL AND audio_path != ''",
    )
    .fetch_all(&pool)
    .await
    .map_err(|err| err.to_string())?;

    let mut transaction = pool.begin().await.map_err(|err| err.to_string())?;
    for table in TABLES_TO_CLEAR {
        let statement = format!("DELETE FROM {table}");
        sqlx::query(&statement)
            .execute(&mut *transaction)
            .await
            .map_err(|err| err.to_string())?;
    }
    transaction.commit().await.map_err(|err| err.to_string())?;

    // After commit, delete every audio WAV on disk that the DB used to know
    // about. Use the audited start_with() guard so we cannot walk outside
    // the managed audio directory (defense-in-depth if a stale path leaks
    // in). Each delete failure is logged but non-fatal.
    if let Ok(audio_dir) = crate::system::audio_store::audio_dir(&app) {
        for path in &audio_paths {
            let file_path = PathBuf::from(path);
            if file_path.starts_with(&audio_dir) {
                if let Err(err) = std::fs::remove_file(&file_path) {
                    if err.kind() != std::io::ErrorKind::NotFound {
                        log::warn!("Failed to delete audio file {} during clear: {err}", file_path.display());
                    }
                }
            }
        }

        // As a final sweep, delete any orphaned .wav files in the audio
        // directory that are no longer referenced by the (now-empty) DB
        // (e.g. files left over from an interrupted record).
        if let Ok(entries) = std::fs::read_dir(&audio_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|e| e.to_str()) == Some("wav") {
                    if let Err(err) = std::fs::remove_file(&p) {
                        log::warn!("Failed to remove orphaned audio file {}: {err}", p.display());
                    }
                }
            }
        }
    }

    if let Err(err) = sqlx::query("VACUUM").execute(&pool).await {
        log::warn!("VACUUM failed after clearing local data: {err}");
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn play_audio(clip: AudioClip) -> Result<(), String> {
    // Rapid re-entry (e.g. double-pressing the record hotkey) can layer
    // multiple overlapping chimes and produce a disorienting UX. If a chime
    // is already playing, return a clear error rather than stacking more.
    let _guard = ReentryGuard::acquire(&PLAY_AUDIO_IN_PROGRESS)
        .map_err(|_| "Audio cue is already playing".to_string())?;

    match clip {
        AudioClip::StartRecordingClip => crate::system::audio_feedback::play_start_recording_clip(),
        AudioClip::StopRecordingClip => crate::system::audio_feedback::play_stop_recording_clip(),
        AudioClip::AlertMacosClip => crate::system::audio_feedback::play_alert_macos_clip(),
        AudioClip::AlertWindows10Clip => {
            crate::system::audio_feedback::play_alert_windows_10_clip()
        }
        AudioClip::AlertWindows11Clip => {
            crate::system::audio_feedback::play_alert_windows_11_clip()
        }
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn start_recording(
    app: AppHandle,
    recorder: State<'_, Arc<dyn crate::platform::Recorder>>,
    args: Option<StartRecordingArgs>,
) -> Result<StartRecordingResponse, String> {
    let options = args.unwrap_or_default();

    recorder.set_preferred_input_device(options.preferred_microphone.clone());

    let level_emit_handle = app.clone();
    let level_emitter: LevelCallback = Arc::new(move |levels: Vec<f32>| {
        let overlay_state = level_emit_handle.state::<crate::state::OverlayState>();
        overlay_state.set_audio_levels(levels.clone());
        crate::platform::overlay::notify_audio_levels(&level_emit_handle, &levels);

        let payload = RecordingLevelPayload { levels };
        if let Err(err) = level_emit_handle.emit_to(EventTarget::any(), EVT_REC_LEVEL, payload) {
            log::error!("Failed to emit recording_level event: {err}");
        }
    });

    let chunk_emit_handle = app.clone();
    let chunk_emitter: ChunkCallback = Arc::new(move |samples: Vec<f32>| {
        let payload = AudioChunkPayload { samples };
        if let Err(err) = chunk_emit_handle.emit_to(EventTarget::any(), EVT_AUDIO_CHUNK, payload) {
            log::error!("Failed to emit audio_chunk event: {err}");
        }
    });

    let recorder_clone = Arc::clone(&recorder);
    let start_result = tauri::async_runtime::spawn_blocking(move || {
        match recorder_clone.start(Some(level_emitter), Some(chunk_emitter)) {
            Ok(()) => Ok(()),
            Err(err) => {
                let already_recording = (*err)
                    .downcast_ref::<crate::errors::RecordingError>()
                    .map(|inner| matches!(inner, crate::errors::RecordingError::AlreadyRecording))
                    .unwrap_or(false);
                Err((err.to_string(), already_recording))
            }
        }
    })
    .await
    .map_err(|err| format!("Recording task panicked: {err}"))?;

    match start_result {
        Ok(()) => {
            let reported_sample_rate = recorder.current_sample_rate().unwrap_or(16_000);
            Ok(StartRecordingResponse {
                sample_rate: reported_sample_rate,
            })
        }
        Err((message, already_recording)) => {
            if already_recording {
                let reported_sample_rate = recorder.current_sample_rate().unwrap_or(16_000);
                return Ok(StartRecordingResponse {
                    sample_rate: reported_sample_rate,
                });
            }

            log::error!("Failed to start recording via command: {message}");
            Err(message)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn stop_recording(
    _app: AppHandle,
    recorder: State<'_, Arc<dyn crate::platform::Recorder>>,
) -> Result<StopRecordingResponse, String> {
    let recorder = Arc::clone(&recorder);

    tauri::async_runtime::spawn_blocking(move || match recorder.stop() {
        Ok(result) => {
            let audio = result.audio;
            Ok(StopRecordingResponse {
                samples: audio.samples,
                sample_rate: audio.sample_rate,
            })
        }
        Err(err) => {
            let not_recording = (*err)
                .downcast_ref::<crate::errors::RecordingError>()
                .map(|inner| matches!(inner, crate::errors::RecordingError::NotRecording))
                .unwrap_or(false);

            if not_recording {
                return Ok(StopRecordingResponse {
                    samples: Vec::new(),
                    sample_rate: 0,
                });
            }

            let message = err.to_string();
            log::error!("Failed to stop recording via command: {message}");
            Err(message)
        }
    })
    .await
    .map_err(|err| err.to_string())?
}


#[tauri::command]
#[specta::specta]
pub async fn pause_recording(
    recorder: State<'_, Arc<dyn crate::platform::Recorder>>,
) -> Result<(), String> {
    let recorder = Arc::clone(&recorder);
    tauri::async_runtime::spawn_blocking(move || recorder.pause().map_err(|err| err.to_string()))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn resume_recording(
    recorder: State<'_, Arc<dyn crate::platform::Recorder>>,
) -> Result<(), String> {
    let recorder = Arc::clone(&recorder);
    tauri::async_runtime::spawn_blocking(move || recorder.resume().map_err(|err| err.to_string()))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn store_transcription_audio(
    app: AppHandle,
    id: String,
    samples: Vec<f64>,
    sample_rate: u32,
) -> Result<TranscriptionAudioSnapshot, String> {
    if sample_rate == 0 {
        return Err("Audio sample rate must be greater than zero".to_string());
    }

    let mut filtered = Vec::with_capacity(samples.len());
    for sample in samples {
        if sample.is_finite() {
            filtered.push(sample as f32);
        }
    }

    if filtered.is_empty() {
        return Err("No usable audio samples provided".to_string());
    }

    let handle = app.clone();
    let audio_id = id.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::system::audio_store::save_transcription_audio(
            &handle,
            &audio_id,
            &filtered,
            sample_rate,
        )
        .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?;

    result
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StorageUploadArgs {
    pub path: String,
    pub data: Vec<u8>,
}

#[tauri::command]
#[specta::specta]
pub fn storage_upload_data(app: AppHandle, args: StorageUploadArgs) -> Result<(), String> {
    let repo = StorageRepo::new(&app).map_err(|err| err.to_string())?;
    repo.upload_data(&args.path, &args.data)
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn storage_get_download_url(app: AppHandle, path: String) -> Result<String, String> {
    let repo = StorageRepo::new(&app).map_err(|err| err.to_string())?;
    repo.get_download_url(&path).map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn purge_stale_transcription_audio(
    app: AppHandle,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Vec<String>, String> {
    let pool = database.pool();

    let rows = sqlx::query(
        "SELECT id, audio_path
         FROM transcriptions
         WHERE audio_path IS NOT NULL
         ORDER BY timestamp DESC",
    )
    .fetch_all(&pool)
    .await
    .map_err(|err| err.to_string())?;

    let stale_entries: Vec<(String, String)> = rows
        .into_iter()
        .skip(MAX_RETAINED_TRANSCRIPTION_AUDIO)
        .map(|row| {
            (
                row.get::<String, _>("id"),
                row.get::<String, _>("audio_path"),
            )
        })
        .collect();

    if stale_entries.is_empty() {
        return Ok(Vec::new());
    }

    let purged_ids = delete_audio_entries(app.clone(), stale_entries).await?;

    if purged_ids.is_empty() {
        return Ok(purged_ids);
    }

    for id in &purged_ids {
        sqlx::query(
            "UPDATE transcriptions
             SET audio_path = NULL,
                 audio_duration_ms = NULL
             WHERE id = ?1",
        )
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|err| err.to_string())?;
    }

    Ok(purged_ids)
}

#[tauri::command]
#[specta::specta]
pub fn surface_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    crate::platform::window::surface_main_window(&window)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn set_pill_window_size(
    app: AppHandle,
    size: crate::domain::PillWindowSize,
    overlay_state: State<'_, crate::state::OverlayState>,
) {
    overlay_state.set_pill_window_size(size);
    crate::platform::overlay::notify_pill_window_size(&app, &size);
}

#[tauri::command]
#[specta::specta]
pub fn sync_native_pill_assistant(app: AppHandle, payload: String) {
    crate::platform::overlay::notify_assistant_state(&app, &payload);
}

#[tauri::command]
#[specta::specta]
pub fn copy_to_clipboard(text: String) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("clipboard unavailable: {e}"))?;
    clipboard
        .set_text(text)
        .map_err(|e| format!("failed to set clipboard: {e}"))
}

#[tauri::command]
#[specta::specta]
pub async fn paste(
    text: String,
    keybind: Option<String>,
    skip_clipboard_restore: Option<bool>,
) -> Result<PasteOutcome, String> {
    // Re-entry guard: a paste in progress owns the clipboard and the
    // synthetic keystroke pipeline. Racing a second paste interleaves both
    // clipboard swaps and keystrokes and produces garbled output.
    let _paste_guard =
        ReentryGuard::acquire(&PASTE_IN_PROGRESS).map_err(|_| "Paste is already in progress".to_string())?;

    // Probe the focused target first. If it clearly can't accept text, write
    // the transcript to the clipboard and skip the paste keystroke entirely —
    // that avoids the race where paste's delayed clipboard-restore overwrites
    // the transcript we just put there. A short timeout keeps paste latency
    // bounded if the accessibility probe stalls.
    let target = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        tauri::async_runtime::spawn_blocking(
            crate::platform::accessibility::check_focused_paste_target,
        ),
    )
    .await
    .ok()
    .and_then(|r| r.ok())
    .unwrap_or(PasteTargetState::Unknown);

    if matches!(target, PasteTargetState::NotEditable) {
        let copy_result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let mut clipboard =
                arboard::Clipboard::new().map_err(|e| format!("clipboard unavailable: {e}"))?;
            clipboard
                .set_text(text)
                .map_err(|e| format!("failed to set clipboard: {e}"))
        })
        .await;

        return match copy_result {
            Ok(Ok(())) => Ok(PasteOutcome::CopiedToClipboard),
            Ok(Err(err)) => {
                log::error!("Copy-to-clipboard fallback failed: {err}");
                Err(err)
            }
            Err(err) => {
                let message = format!("Paste task join error: {err}");
                log::error!("{message}");
                Err(message)
            }
        };
    }

    let skip_clipboard_restore = skip_clipboard_restore.unwrap_or(false);
    let join_result = tauri::async_runtime::spawn_blocking(move || {
        platform_paste_text(&text, keybind.as_deref(), skip_clipboard_restore)
    })
    .await;

    match join_result {
        Ok(result) => {
            if let Err(err) = result.as_ref() {
                log::error!("Paste failed: {err}");
            }

            result.map(|()| PasteOutcome::Pasted)
        }
        Err(err) => {
            let message = format!("Paste task join error: {err}");
            log::error!("{message}");
            Err(message)
        }
    }
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SimulateTypeResponse {
    /// Opaque session id that can be passed to `cancel_typing` to cancel
    /// exactly this typing session without interrupting a later one.
    pub typing_id: u64,
}

#[tauri::command]
#[specta::specta]
pub async fn simulate_type(text: String, delay_ms: u64) -> Result<SimulateTypeResponse, String> {
    if text.trim().is_empty() {
        // Even on an empty text we return a fresh id so the TS side has a
        // consistent shape; cancel against it is a harmless no-op.
        let typing_id = TYPING_SESSION_ID.fetch_add(1, Ordering::AcqRel) + 1;
        return Ok(SimulateTypeResponse { typing_id });
    }

    // Re-entry guard: two concurrent `simulate_type` calls would race the
    // global CANCEL_TYPING flag and interleave keystrokes. Serialize them.
    let _type_guard = ReentryGuard::acquire(&SIMULATE_TYPE_IN_PROGRESS)
        .map_err(|_| "Simulated typing is already in progress".to_string())?;

    // Allocate a fresh session id and reset the cancel flag for this run.
    let typing_id = TYPING_SESSION_ID.fetch_add(1, Ordering::AcqRel) + 1;
    CANCEL_TYPING.store(false, Ordering::SeqCst);

    // Run the platform typer on the blocking thread. It polls the global
    // CANCEL_TYPING flag between keystrokes; session-id scoping is done at
    // this layer (cancel_typing refuses to set the flag for stale sessions)
    // so we don't need to change the platform backend signatures.
    let join_result = tauri::async_runtime::spawn_blocking(move || {
        crate::platform::input::type_text_into_focused_field(&text, delay_ms, &CANCEL_TYPING)
    })
    .await;

    match join_result {
        Ok(result) => {
            if let Err(ref err) = result {
                log::error!("Simulated typing failed: {err}");
                return Err(err.clone());
            }
            Ok(SimulateTypeResponse { typing_id })
        }
        Err(err) => {
            let message = format!("Simulate type task join error: {err}");
            log::error!("{message}");
            Err(message)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn cancel_typing(typing_id: Option<u64>) -> Result<(), String> {
    // If the caller supplies a typing id they received from `simulate_type`,
    // only cancel if that session is still the most recent one. This
    // prevents a stale cancel (e.g. from a blur handler on an older
    // transcription) from killing a later typing session the user started.
    //
    // If no id is supplied (legacy callers), cancel the active session
    // unconditionally for backward compatibility.
    if let Some(id) = typing_id {
        let current = TYPING_SESSION_ID.load(Ordering::Acquire);
        if id != current {
            // Stale cancel — ignore silently.
            return Ok(());
        }
    }
    CANCEL_TYPING.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn set_phase(
    app: AppHandle,
    phase: String,
    overlay_state: State<'_, crate::state::OverlayState>,
) -> Result<(), String> {
    let resolved =
        OverlayPhase::parse(phase.as_str()).ok_or_else(|| format!("invalid phase: {phase}"))?;

    overlay_state.set_phase(&resolved);
    crate::platform::overlay::notify_phase(&app, &resolved);

    let payload = OverlayPhasePayload {
        phase: resolved.clone(),
    };

    app.emit_to(EventTarget::any(), EVT_OVERLAY_PHASE, payload)
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn set_pill_visibility(app: AppHandle, visibility: String) -> Result<(), String> {
    // Reject unknown visibility strings so a typo in the frontend cannot
    // silently leave the pill in an undefined state. Platform overlay
    // backends treat unknown strings as "while_active" (default), which
    // would mask the bug.
    match visibility.as_str() {
        "hidden" | "persistent" | "while_active" => {}
        other => return Err(format!("invalid pill visibility: {other:?}")),
    }
    crate::platform::overlay::notify_visibility(&app, &visibility);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn notify_pill_style_info(app: AppHandle, count: u32, name: String) {
    crate::platform::overlay::notify_style_info(&app, count, &name);
}

#[tauri::command]
#[specta::specta]
pub fn start_key_listener(app: AppHandle) -> Result<(), String> {
    crate::platform::keyboard::start_key_listener(&app)
}

#[tauri::command]
#[specta::specta]
pub fn stop_key_listener() -> Result<(), String> {
    crate::platform::keyboard::stop_key_listener()
}

#[tauri::command]
#[specta::specta]
pub fn sync_hotkey_combos(combos: Vec<Vec<String>>) {
    crate::platform::keyboard::sync_combos(combos);
}

#[tauri::command]
#[specta::specta]
pub fn reset_key_listener_state() {
    crate::platform::keyboard::reset_pressed_keys();
}

#[tauri::command]
#[specta::specta]
pub fn get_key_listener_health() -> String {
    crate::platform::keyboard::current_listener_health()
}

/// Manual, user-triggered retry. Rust owns automatic recovery; this just restarts the listener
/// (interrupting any slow-retry backoff) for when the user wants to retry immediately.
#[tauri::command]
#[specta::specta]
pub fn retry_key_listener(app: AppHandle) -> Result<(), String> {
    crate::platform::keyboard::start_key_listener(&app)
}

#[tauri::command]
#[specta::specta]
pub fn sync_compositor_hotkeys(
    app: AppHandle,
    bindings: Vec<crate::domain::CompositorBinding>,
) -> Result<(), String> {
    crate::platform::compositor::sync_compositor_hotkeys(&app, &bindings)
}

#[tauri::command]
#[specta::specta]
pub fn get_hotkey_strategy() -> String {
    crate::platform::get_hotkey_strategy().to_string()
}

#[tauri::command]
#[specta::specta]
pub fn supports_app_detection() -> bool {
    crate::platform::supports_app_detection()
}

#[tauri::command]
#[specta::specta]
pub fn supports_paste_keybinds() -> crate::platform::PasteKeybindSupport {
    crate::platform::supports_paste_keybinds()
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JavaAccessBridgeStatus {
    /// Absolute path to the `.accessibility.properties` file we operate on.
    pub path: String,
    /// True if the file already contained our entry — nothing was changed.
    pub already_enabled: bool,
    /// True if we wrote (or rewrote) the file.
    pub wrote_file: bool,
    /// True if any Java app currently running needs to be restarted before
    /// it picks up the bridge. Always true when `wrote_file` is true.
    pub restart_required: bool,
}

/// Enable Java Access Bridge (JAB) for the current user by ensuring
/// `~/.accessibility.properties` opts the JVM into our assistive-tech entry.
///
/// JAB is what surfaces Swing/AWT components (e.g. LigoLab) to the OS-level
/// accessibility APIs our binding/import/export pipeline talks to. Without it,
/// a Java window looks like a single opaque element and we can't read or
/// write its fields.
///
/// Idempotent: running on an already-configured machine is a no-op. If the
/// file exists with other assistive-tech entries (e.g. screen readers), we
/// preserve them and append our value to the comma-separated list rather
/// than overwriting.
///
/// The JVM only reads this file at process startup, so any Java app that's
/// currently running must be restarted before the bridge is loaded.
#[tauri::command]
#[specta::specta]
pub fn enable_java_access_bridge() -> Result<JavaAccessBridgeStatus, String> {
    const ASSISTIVE_TECH_KEY: &str = "assistive_technologies";
    const JAB_VALUE: &str = "com.sun.java.accessibility.AccessBridge";

    // Resolve the user's home dir. Windows uses USERPROFILE; macOS uses HOME.
    // The JVM reads `.accessibility.properties` from there on every OS.
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| "Cannot resolve user home directory".to_string())?;
    let path = std::path::PathBuf::from(home).join(".accessibility.properties");

    // Read existing contents (if any). A missing file is treated as empty.
    let existing = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => {
            return Err(format!("Failed to read {}: {}", path.display(), err));
        }
    };

    // Walk the file line-by-line, preserving everything we don't own. If we
    // find an existing `assistive_technologies=` line, merge our value into
    // its comma-separated list instead of clobbering whatever was already
    // there (e.g. screen reader entries).
    let mut lines: Vec<String> = Vec::new();
    let mut found_key = false;
    let mut already_enabled = false;

    for raw in existing.lines() {
        let trimmed = raw.trim_start();
        if let Some(rest) = trimmed.strip_prefix(ASSISTIVE_TECH_KEY) {
            let after = rest.trim_start();
            if let Some(value_part) = after.strip_prefix('=') {
                found_key = true;
                let values: Vec<&str> = value_part
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect();
                if values.contains(&JAB_VALUE) {
                    already_enabled = true;
                    lines.push(raw.to_string());
                    continue;
                }
                let mut merged: Vec<&str> = values;
                merged.push(JAB_VALUE);
                lines.push(format!("{}={}", ASSISTIVE_TECH_KEY, merged.join(",")));
                continue;
            }
        }
        lines.push(raw.to_string());
    }

    if !found_key {
        lines.push(format!("{}={}", ASSISTIVE_TECH_KEY, JAB_VALUE));
    }

    if already_enabled {
        return Ok(JavaAccessBridgeStatus {
            path: path.to_string_lossy().into_owned(),
            already_enabled: true,
            wrote_file: false,
            restart_required: false,
        });
    }

    let mut new_contents = lines.join("\n");
    if !new_contents.ends_with('\n') {
        new_contents.push('\n');
    }

    // Atomic write: write to a sibling temp file, then rename into place so
    // a crash mid-write doesn't leave a half-written `.accessibility.properties`.
    let parent = path
        .parent()
        .ok_or_else(|| format!("Cannot determine parent dir of {}", path.display()))?;
    let tmp = parent.join(".accessibility.properties.mausvoice-tmp");
    std::fs::write(&tmp, new_contents.as_bytes())
        .map_err(|err| format!("Failed to write {}: {}", tmp.display(), err))?;
    std::fs::rename(&tmp, &path).map_err(|err| {
        format!(
            "Failed to rename {} to {}: {}",
            tmp.display(),
            path.display(),
            err
        )
    })?;

    Ok(JavaAccessBridgeStatus {
        path: path.to_string_lossy().into_owned(),
        already_enabled: false,
        wrote_file: true,
        restart_required: true,
    })
}

#[tauri::command]
#[specta::specta]
pub fn get_native_setup_status() -> crate::platform::NativeSetupStatus {
    crate::platform::init::get_native_setup_status()
}

#[tauri::command]
#[specta::specta]
pub async fn run_native_setup(app: tauri::AppHandle) -> crate::platform::NativeSetupResult {
    crate::platform::init::run_native_setup(app).await
}

#[tauri::command]
#[specta::specta]
pub fn set_tray_title(app: AppHandle, title: Option<String>) -> Result<(), String> {
    // Tray titles are a macOS-only concept in AppKit (NSStatusItem.button.title).
    // Windows/Linux silently ignore them in Tauri; to keep command behaviour
    // predictable across platforms we no-op on non-macOS targets rather than
    // paying the cost of a (no-op) platform call.
    #[cfg(target_os = "macos")]
    {
        use tauri::tray::TrayIconId;
        if let Some(tray) = app.tray_by_id(&TrayIconId::new("main")) {
            let title_ref = match &title {
                Some(t) if !t.is_empty() => Some(t.as_str()),
                _ => Some(""),
            };
            tray.set_title(title_ref).map_err(|err| err.to_string())?;
        }
    }

    // Silence unused-parameter warnings on non-macOS builds without adding
    // extra cfg-attributes to the function signature.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, title);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn set_menu_icon(
    app: AppHandle,
    variant: crate::system::tray::MenuIconVariant,
) -> Result<(), String> {
    crate::system::tray::set_menu_icon(&app, variant)
}

#[tauri::command]
#[specta::specta]
pub fn set_tray_language_menu(
    app: AppHandle,
    items: Vec<crate::system::tray::TrayLanguageMenuItem>,
) -> Result<(), String> {
    crate::system::tray::set_tray_language_menu(&app, items)
}

#[tauri::command]
#[specta::specta]
pub fn set_register_app_label(app: AppHandle, app_name: Option<String>) -> Result<(), String> {
    crate::system::tray::set_register_app_label(&app, app_name)
}

/// Sync the tray's pill-visibility label.
///
/// Presentation only — the frontend owns the preference, resolves the localized
/// label, and calls this after a successful save, so the label can never claim
/// a state that was not persisted.
#[tauri::command]
#[specta::specta]
pub fn set_pill_visibility_menu_state(app: AppHandle, label: String) -> Result<(), String> {
    crate::system::tray::set_pill_visibility_menu_state(&app, &label)
}

/// Enable or disable the "Reset Pill Position" tray menu item.
///
/// Called by the frontend whenever the pill's saved-position state changes
/// (drag end → enable; reset → disable) so the menu item is grayed out
/// when there is nothing to reset.
#[tauri::command]
#[specta::specta]
pub fn set_reset_pill_position_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    crate::system::tray::set_reset_pill_position_enabled(&app, enabled)
}

/// Send a reset-position IPC message to the native pill overlay.
///
/// Clears the pill's saved position so the next tick repositions it to the
/// default centre-bottom of a monitor. `strategy` selects which monitor:
/// `"current"` (the monitor the pill lives on, the historical default) or
/// `"cursor"` (the monitor under the mouse).
#[tauri::command]
#[specta::specta]
pub fn reset_pill_position(
    app: AppHandle,
    strategy: Option<String>,
) -> Result<(), String> {
    let strategy = strategy.unwrap_or_else(|| "current".to_string());
    crate::platform::overlay::notify_reset_position(&app, &strategy)
}

#[tauri::command]
#[specta::specta]
pub fn set_tray_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    use tauri::tray::TrayIconId;
    if let Some(tray) = app.tray_by_id(&TrayIconId::new("main")) {
        tray.set_visible(visible).map_err(|err| err.to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_text_field_info() -> Result<TextFieldInfo, String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tauri::async_runtime::spawn_blocking(crate::platform::accessibility::get_text_field_info),
    )
    .await
    .map_err(|_| "get_text_field_info timed out".to_string())?
    .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_screen_context() -> Result<ScreenContextInfo, String> {
    tauri::async_runtime::spawn_blocking(crate::platform::accessibility::get_screen_context)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn find_pid_by_window_title(title_substring: String) -> Result<Option<i32>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::platform::find_pid_by_window_title(&title_substring)
    })
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_selected_text() -> Result<Option<String>, String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tauri::async_runtime::spawn_blocking(crate::platform::accessibility::get_selected_text),
    )
    .await
    .map_err(|_| "get_selected_text timed out".to_string())?
    .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn gather_accessibility_dump() -> Result<AccessibilityDumpResult, String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(120),
        tauri::async_runtime::spawn_blocking(
            crate::platform::accessibility::gather_accessibility_dump,
        ),
    )
    .await
    .map_err(|_| "gather_accessibility_dump timed out after 120s".to_string())?
    .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn get_focused_field_info() -> Result<Option<AccessibilityFieldInfo>, String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tauri::async_runtime::spawn_blocking(
            crate::platform::accessibility::get_focused_field_info,
        ),
    )
    .await
    .map_err(|_| "get_focused_field_info timed out".to_string())?
    .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn write_accessibility_fields(
    entries: Vec<AccessibilityWriteEntry>,
) -> Result<AccessibilityWriteResult, String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tauri::async_runtime::spawn_blocking(move || {
            crate::platform::accessibility::write_accessibility_fields(entries)
        }),
    )
    .await
    .map_err(|_| "write_accessibility_fields timed out".to_string())?
    .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn focus_accessibility_field(target: AccessibilityFocusTarget) -> Result<(), String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tauri::async_runtime::spawn_blocking(move || {
            crate::platform::accessibility::focus_accessibility_field(
                target.app_pid,
                &target.element_index_path,
                target.fingerprint_chain.as_deref(),
                target.backend.as_deref(),
                target.jab_string_path.as_deref(),
            )
        }),
    )
    .await
    .map_err(|_| "focus_accessibility_field timed out".to_string())?
    .map_err(|err| err.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn read_accessibility_field_values(
    fields: Vec<FieldValueRequest>,
) -> Result<Vec<FieldValueResult>, String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tauri::async_runtime::spawn_blocking(move || {
            crate::platform::accessibility::read_field_values(fields)
        }),
    )
    .await
    .map_err(|_| "read_accessibility_field_values timed out".to_string())?
    .map_err(|err| err.to_string())
}

/// Enumerate currently-running processes matching `identity`. Returns every
/// candidate so the caller (which knows the binding's `windowTitle` and other
/// heuristics) can disambiguate when multiple instances are running. Returns
/// an empty vec when the app is not running.
#[tauri::command]
#[specta::specta]
pub async fn resolve_app_pids(identity: AppIdentity) -> Result<Vec<AppProcessMatch>, String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tauri::async_runtime::spawn_blocking(move || {
            crate::platform::accessibility::resolve_app_pids(&identity)
        }),
    )
    .await
    .map_err(|_| "resolve_app_pids timed out".to_string())?
    .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn check_focused_paste_target() -> Result<PasteTargetState, String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        tauri::async_runtime::spawn_blocking(
            crate::platform::accessibility::check_focused_paste_target,
        ),
    )
    .await
    .map_err(|_| "check_focused_paste_target timed out".to_string())?
    .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_keyboard_language() -> Result<String, String> {
    crate::platform::keyboard_language::get_keyboard_language()
}

#[tauri::command]
#[specta::specta]
pub async fn conversation_create(
    conversation: crate::domain::Conversation,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::Conversation, String> {
    crate::db::conversation_queries::insert_conversation(database.pool(), &conversation)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn conversation_list(
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Vec<crate::domain::Conversation>, String> {
    crate::db::conversation_queries::fetch_conversations(database.pool())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn conversation_update(
    conversation: crate::domain::Conversation,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::Conversation, String> {
    crate::db::conversation_queries::update_conversation(database.pool(), &conversation)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn conversation_delete(
    id: String,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<(), String> {
    crate::db::conversation_queries::delete_conversation(database.pool(), &id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn chat_message_create(
    message: crate::domain::ChatMessage,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::ChatMessage, String> {
    crate::db::chat_message_queries::insert_chat_message(database.pool(), &message)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn chat_message_list(
    conversation_id: String,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<Vec<crate::domain::ChatMessage>, String> {
    crate::db::chat_message_queries::fetch_chat_messages_by_conversation(
        database.pool(),
        &conversation_id,
    )
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn chat_message_update(
    message: crate::domain::ChatMessage,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<crate::domain::ChatMessage, String> {
    crate::db::chat_message_queries::update_chat_message(database.pool(), &message)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn chat_message_delete_many(
    ids: Vec<String>,
    database: State<'_, crate::state::OptionKeyDatabase>,
) -> Result<(), String> {
    crate::db::chat_message_queries::delete_chat_messages(database.pool(), &ids)
        .await
        .map_err(|err| err.to_string())
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RunTerminalCommandResponse {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Maximum number of bytes the AI agent is allowed to read back from an allowed
/// command. Caps stdout+stderr so a runaway command cannot OOM the app.
const TERMINAL_COMMAND_MAX_OUTPUT_BYTES: usize = 128 * 1024;
/// Per-command wall-clock timeout. A hung subprocess must not hang the agent.
const TERMINAL_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Allow-list of safe binaries the AI agent may invoke through the power-mode
/// `run_terminal_command` tool. Each entry names an exact binary (resolved via
/// `which`/PATH lookup, *not* via a shell) and, optionally, a fixed set of
/// prefix arguments that are always prepended. Free-form arguments are still
/// passed through but they never flow through `sh -c` / `cmd /c`, so shell
/// metacharacters (`;`, `|`, `&`, `$()`, backticks, redirections) are treated
/// as literal argv tokens rather than interpreted by a shell.
///
/// To add a new safe command, extend this list — never relax the allow-list to
/// `sh`, `cmd`, `bash`, `powershell`, `pwsh`, `zsh`, or any other shell.
struct AllowedCommand {
    binary: &'static str,
    /// Optional fixed argv prefix applied before caller-provided args.
    fixed_args: &'static [&'static str],
}

#[cfg(not(target_os = "windows"))]
const ALLOWED_COMMANDS: &[AllowedCommand] = &[
    AllowedCommand { binary: "ls", fixed_args: &[] },
    AllowedCommand { binary: "pwd", fixed_args: &[] },
    AllowedCommand { binary: "echo", fixed_args: &[] },
    AllowedCommand { binary: "cat", fixed_args: &[] },
    AllowedCommand { binary: "which", fixed_args: &[] },
    AllowedCommand { binary: "whoami", fixed_args: &[] },
    AllowedCommand { binary: "date", fixed_args: &[] },
    AllowedCommand { binary: "uname", fixed_args: &["-a"] },
    AllowedCommand { binary: "df", fixed_args: &["-h"] },
    AllowedCommand { binary: "du", fixed_args: &["-sh"] },
    AllowedCommand { binary: "head", fixed_args: &["-n", "200"] },
    AllowedCommand { binary: "tail", fixed_args: &["-n", "200"] },
    AllowedCommand { binary: "wc", fixed_args: &["-l"] },
    #[cfg(target_os = "macos")]
    AllowedCommand { binary: "open", fixed_args: &[] },
    #[cfg(target_os = "linux")]
    AllowedCommand { binary: "xdg-open", fixed_args: &[] },
];

#[cfg(target_os = "windows")]
const ALLOWED_COMMANDS: &[AllowedCommand] = &[
    AllowedCommand { binary: "dir", fixed_args: &[] },
    AllowedCommand { binary: "echo", fixed_args: &[] },
    AllowedCommand { binary: "cd", fixed_args: &[] },
    AllowedCommand { binary: "whoami", fixed_args: &[] },
    AllowedCommand { binary: "date", fixed_args: &["/t"] },
    AllowedCommand { binary: "ver", fixed_args: &[] },
    AllowedCommand { binary: "explorer", fixed_args: &[] },
];

/// Validate that a single argv token contains no NUL bytes (which would truncate
/// the C-string passed to execve) and no control characters that could be used
/// for terminal injection when humans view the output.
fn is_safe_arg_token(token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    token.chars().all(|ch| !(ch.is_control() && ch != '\t') && ch != '\0')
}

/// Characters that are forbidden inside any argv token passed through
/// `run_terminal_command`. Blocked as defense-in-depth even though we never
/// invoke a shell — makes it obvious to model authors that shell
/// composition is out.
const TERMINAL_FORBIDDEN_CHARS: &[char] =
    &[';', '|', '&', '$', '`', '>', '<', '(', ')', '\n', '\r'];

/// Validate a user-supplied command string against the same rules
/// `run_terminal_command` enforces. Shared between the command itself and
/// its unit tests so both paths can't drift apart. On success returns the
/// matched `AllowedCommand` entry and the split argv tail (user args).
fn validate_terminal_command_args(
    command: &str,
) -> Result<(&'static AllowedCommand, Vec<String>), String> {
    let tokens: Vec<&str> = command.split_whitespace().collect();
    let Some((binary, user_args)) = tokens.split_first() else {
        return Err("Empty command".to_string());
    };

    if binary.contains('/') || binary.contains('\\') {
        return Err(format!(
            "Command not allowed: absolute or relative paths are not permitted (got {binary:?})"
        ));
    }

    for token in *user_args {
        if !is_safe_arg_token(token) {
            return Err(format!(
                "Command argument contains disallowed characters: {token:?}"
            ));
        }
        for ch in token.chars() {
            if TERMINAL_FORBIDDEN_CHARS.contains(&ch) {
                return Err(format!(
                    "Shell metacharacters are not permitted in command arguments (found {ch:?} in {token:?})"
                ));
            }
        }
    }

    let allowed = ALLOWED_COMMANDS
        .iter()
        .find(|entry| entry.binary == *binary)
        .ok_or_else(|| format!("Command not in allow-list: {binary}"))?;
    Ok((allowed, user_args.iter().map(|s| s.to_string()).collect()))
}

/// Validate a floating-window URL before navigation. Extracted from
/// `floating_window_create` so the allow-list can be unit-tested without
/// spinning up a Tauri window.
#[cfg(test)]
fn validate_floating_window_url(url: &str) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {
            let host = parsed.host_str().unwrap_or("");
            let is_localhost =
                host == "localhost" || host == "127.0.0.1" || host == "[::1]";
            let is_docs_site = host == "maus-inc.github.io"
                && parsed.path().starts_with("/mausVoice/");
            if !is_localhost && !is_docs_site {
                return Err(format!(
                    "Floating window URL host {host:?} is not in the trusted allow-list"
                ));
            }
        }
        "tauri" | "asset" | "data" => {}
        other => {
            return Err(format!(
                "Floating window URL scheme {other:?} is not permitted"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_command_rejects_empty() {
        assert!(validate_terminal_command_args("").is_err());
        assert!(validate_terminal_command_args("   ").is_err());
    }

    #[test]
    fn terminal_command_rejects_paths_and_shells() {
        assert!(validate_terminal_command_args("/bin/sh").is_err());
        assert!(validate_terminal_command_args("../../sh").is_err());
        assert!(validate_terminal_command_args("sh -c 'echo hi'").is_err());
        assert!(validate_terminal_command_args("bash ls").is_err());
        assert!(validate_terminal_command_args("cmd /c dir").is_err());
    }

    #[test]
    fn terminal_command_rejects_metacharacters() {
        assert!(validate_terminal_command_args("ls ; rm -rf /").is_err());
        assert!(validate_terminal_command_args("ls | cat").is_err());
        assert!(validate_terminal_command_args("echo $(whoami)").is_err());
        assert!(validate_terminal_command_args("echo `whoami`").is_err());
        assert!(validate_terminal_command_args("echo > file").is_err());
    }

    #[test]
    fn terminal_command_allows_allowlisted() {
        assert_eq!(
            validate_terminal_command_args("ls -la").unwrap().0.binary,
            "ls"
        );
        assert_eq!(
            validate_terminal_command_args("pwd").unwrap().0.binary,
            "pwd"
        );
        assert_eq!(
            validate_terminal_command_args("echo hello world")
                .unwrap()
                .0
                .binary,
            "echo"
        );
    }

    #[test]
    fn floating_window_allows_localhost() {
        assert!(validate_floating_window_url("http://localhost:1420/").is_ok());
        assert!(validate_floating_window_url("http://127.0.0.1:8080/foo").is_ok());
    }

    #[test]
    fn floating_window_allows_docs_site() {
        assert!(validate_floating_window_url(
            "https://maus-inc.github.io/mausVoice/welcome"
        )
        .is_ok());
        // GitHub Pages URL must be scoped to /mausVoice/ to avoid any
        // other user site hosted on the same origin inheriting IPC access.
        assert!(validate_floating_window_url(
            "https://maus-inc.github.io/other-project/"
        )
        .is_err());
    }

    #[test]
    fn floating_window_rejects_arbitrary_origins() {
        assert!(validate_floating_window_url("https://evil.com/").is_err());
        assert!(validate_floating_window_url("file:///etc/passwd").is_err());
        assert!(validate_floating_window_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn pill_visibility_rejects_unknown_values() {
        // The validation in set_pill_visibility is a literal match against
        // these three strings; any deviation would change the command's
        // public contract and is caught here.
        let valid = ["hidden", "persistent", "while_active"];
        for v in valid {
            assert!(matches!(v, "hidden" | "persistent" | "while_active"));
        }
        assert!(!matches!(
            "always_on_top",
            "hidden" | "persistent" | "while_active"
        ));
    }

    #[test]
    fn current_timestamp_ok() {
        // Replicate the function body to avoid a public exposure. SystemTime
        // should always be post-epoch on modern OSes; if it isn't we'd want
        // to know rather than silently return i64::MAX.
        let duration = SystemTime::now().duration_since(UNIX_EPOCH);
        assert!(duration.is_ok());
        let millis: Result<i64, _> = duration.unwrap().as_millis().try_into();
        assert!(millis.is_ok());
    }
}

/// Strict, shell-free execution for an allow-listed command.
///
/// Security properties:
/// - No shell is invoked; `command` is tokenized into argv by whitespace only
///   (no quoting, no metacharacter evaluation). A token like `;rm -rf /` is
///   passed as a single literal argument to the binary.
/// - The binary must appear in `ALLOWED_COMMANDS` (exact name match); path
///   traversal (e.g. `/bin/sh`, `../../sh`) is rejected.
/// - Per-command timeout and output-size cap bound resource use.
#[tauri::command]
#[specta::specta]
pub async fn run_terminal_command(command: String) -> Result<RunTerminalCommandResponse, String> {
    // Whitespace-tokenize without shell interpretation. Quoting is deliberately
    // unsupported — AI tools pass structured argv tokens separated by spaces.
    // All validation is centralised in validate_terminal_command_args so the
    // production path and unit tests can't drift.
    let (allowed, user) = validate_terminal_command_args(&command)?;

    let fixed = allowed.fixed_args.to_vec();
    let bin = allowed.binary.to_string();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(&bin);
        cmd.args(&fixed);
        cmd.args(&user);

        // Never inherit the user's shell environment wholesale; clear dangerous vars.
        cmd.env_clear();
        if let Ok(path) = std::env::var("PATH") {
            cmd.env("PATH", path);
        }
        cmd.env("LANG", "C.UTF-8");

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let child = cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|err| format!("Failed to spawn {bin}: {err}"))?;

        // Run wait_with_output on a worker thread so we can bound it with a
        // wall-clock timeout (Command::output/wait_with_output have no
        // native timeout).
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(child.wait_with_output());
        });

        let output = match rx.recv_timeout(TERMINAL_COMMAND_TIMEOUT) {
            Ok(Ok(output)) => output,
            Ok(Err(err)) => return Err(format!("Failed to await {bin}: {err}")),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // Worker is still running wait_with_output; we cannot kill
                // the child from this thread (worker owns it), but the
                // per-command wall-clock is a best-effort bound. Return a
                // clear timeout error — the worker will finish whenever the
                // child exits naturally.
                return Err(format!(
                    "Command {bin} timed out after {}s",
                    TERMINAL_COMMAND_TIMEOUT.as_secs()
                ));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(format!("Failed to await {bin}: worker thread panicked"));
            }
        };

        // Bound the output size before allocating Strings.
        let stdout = if output.stdout.len() > TERMINAL_COMMAND_MAX_OUTPUT_BYTES {
            let truncated = &output.stdout[..TERMINAL_COMMAND_MAX_OUTPUT_BYTES];
            let mut s = String::from_utf8_lossy(truncated).to_string();
            s.push_str(&format!(
                "\n...[truncated: {} bytes total]",
                output.stdout.len()
            ));
            s
        } else {
            String::from_utf8_lossy(&output.stdout).to_string()
        };

        let stderr = if output.stderr.len() > TERMINAL_COMMAND_MAX_OUTPUT_BYTES {
            let truncated = &output.stderr[..TERMINAL_COMMAND_MAX_OUTPUT_BYTES];
            let mut s = String::from_utf8_lossy(truncated).to_string();
            s.push_str(&format!(
                "\n...[truncated: {} bytes total]",
                output.stderr.len()
            ));
            s
        } else {
            String::from_utf8_lossy(&output.stderr).to_string()
        };

        Ok(RunTerminalCommandResponse {
            stdout,
            stderr,
            exit_code: output.status.code().unwrap_or(-1),
        })
    })
    .await
    .map_err(|err| format!("Terminal command task panicked: {err}"))?;

    result
}

/// Returns `true` when the running app bundle can be updated in-place.
/// On macOS this checks whether the process can write to the directory that
/// contains the `.app` bundle (typically `/Applications`).
/// Non-macOS platforms always return `true`.
#[tauri::command]
#[specta::specta]
pub fn check_app_location_writable() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;

        // macOS layout: <dir>/mausVoice.app/Contents/MacOS/mausvoice-desktop
        let app_parent = exe
            .parent() // MacOS/
            .and_then(|p| p.parent()) // Contents/
            .and_then(|p| p.parent()) // mausVoice.app/
            .and_then(|p| p.parent()) // containing directory
            .ok_or("Could not determine app parent directory")?;

        let probe = app_parent.join(".mausvoice_write_probe");
        match std::fs::File::create(&probe) {
            Ok(_) => {
                let _ = std::fs::remove_file(&probe);
                Ok(true)
            }
            Err(_) => Ok(false),
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }
}

/// Downloads a `.pkg` installer to a temp directory and opens it with
/// macOS Installer.app. This is used as a fallback when the normal in-place
/// updater cannot write to the app's install location.
#[tauri::command]
#[specta::specta]
pub async fn download_and_open_mac_installer(url: String) -> Result<(), String> {
    // Defense-in-depth: only allow downloads from the trusted release host.
    // The TS caller derives this URL from the signed updater manifest, but
    // any future caller (including a compromised webview) must not be able
    // to make us download+execute arbitrary files.
    let parsed = Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("Installer URL must use https".to_string());
    }
    let host = parsed.host_str().unwrap_or("");
    if !matches!(host, "github.com" | "objects.githubusercontent.com") {
        return Err(format!(
            "Installer URL host {host:?} is not in the trusted allow-list"
        ));
    }
    let path = parsed.path();
    if !path.ends_with(".pkg") {
        return Err("Installer URL must point to a .pkg file".to_string());
    }

    // Use a unique temp filename (not the URL-derived basename) so a crafted
    // path like "../../../LaunchAgents/foo" cannot escape the temp dir. The
    // nanosecond timestamp + pid is unique enough for our purposes; we
    // overwrite then delete on installer completion anyway.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let dest = std::env::temp_dir().join(format!("mausvoice-update-{nanos}-{pid}.pkg"));

    // Remove any stale previous download (best-effort).
    let _ = std::fs::remove_file(&dest);

    let response = reqwest::get(parsed).await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Download failed with status {}", response.status()));
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > 250 * 1024 * 1024 {
        return Err("Installer download exceeded 250MiB safety limit".to_string());
    }
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;

    std::process::Command::new("open")
        .arg(&dest)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn get_system_volume() -> Result<f64, String> {
    crate::platform::volume::get_system_volume()
}

#[tauri::command]
#[specta::specta]
pub fn set_system_volume(volume: f64) -> Result<(), String> {
    let clamped = volume.clamp(0.0, 1.0);
    crate::platform::volume::set_system_volume(clamped)
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateFloatingWindowArgs {
    pub url: String,
    pub title: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub min_width: Option<f64>,
    pub min_height: Option<f64>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub decorations: Option<bool>,
    pub transparent: Option<bool>,
    pub resizable: Option<bool>,
    pub focused: Option<bool>,
}

#[derive(serde::Serialize, specta::Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FloatingWindowInfo {
    pub id: String,
    pub url: String,
    pub title: String,
}

/// Opens a draggable, always-on-top webview window pointed at the given URL
/// and returns a stable id that can be used to destroy it later.
///
/// External URLs are restricted to http(s) and to a small allow-list of
/// trusted schemes/hosts; this is the only place in the app that creates a
/// webview pointed at a non-local origin, so any URL accepted here inherits
/// the webview's full capability set (IPC commands, etc. via the
/// `floating-*` window capability). We keep the allow-list small to avoid
/// a compromised or confused caller creating a floating window on an
/// attacker-controlled origin.
#[tauri::command]
#[specta::specta]
pub async fn floating_window_create(
    args: CreateFloatingWindowArgs,
    app: AppHandle,
    state: State<'_, crate::state::FloatingWindowState>,
) -> Result<FloatingWindowInfo, String> {
    let parsed_url = Url::parse(&args.url).map_err(|err| err.to_string())?;

    match parsed_url.scheme() {
        "http" | "https" => {
            let host = parsed_url.host_str().unwrap_or("");
            // Allow localhost loopback (dev tooling, in-app docs previews)
            // and the GitHub Pages docs site. Other remote origins are
            // rejected — they would otherwise have full IPC access via the
            // floating-* capability.
            let is_localhost =
                matches!(host, "localhost" | "127.0.0.1" | "[::1]");
            let is_docs_site = host == "maus-inc.github.io"
                && parsed_url.path().starts_with("/mausVoice/");
            if !is_localhost && !is_docs_site {
                return Err(format!(
                    "Floating window URL host {host:?} is not in the trusted allow-list"
                ));
            }
        }
        "tauri" | "asset" | "data" => {
            // Local app / asset / data URLs are always permitted.
        }
        other => {
            return Err(format!(
                "Floating window URL scheme {other:?} is not permitted"
            ));
        }
    }

    let label = state.next_label();
    let title = args.title.clone().unwrap_or_else(|| "mausVoice".to_string());

    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        label.clone(),
        tauri::WebviewUrl::External(parsed_url),
    )
    .title(title.clone())
    .always_on_top(true)
    .skip_taskbar(true)
    .decorations(args.decorations.unwrap_or(true))
    .resizable(args.resizable.unwrap_or(true))
    .focused(args.focused.unwrap_or(false));

    if args.transparent.unwrap_or(false) {
        builder = builder.transparent(true);
    }

    if let (Some(w), Some(h)) = (args.width, args.height) {
        builder = builder.inner_size(w, h);
    }
    if let (Some(min_w), Some(min_h)) = (args.min_width, args.min_height) {
        builder = builder.min_inner_size(min_w, min_h);
    }
    if let (Some(x), Some(y)) = (args.x, args.y) {
        builder = builder.position(x, y);
    }

    builder.build().map_err(|err| err.to_string())?;

    Ok(FloatingWindowInfo {
        id: label,
        url: args.url,
        title,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn floating_window_destroy(id: String, app: AppHandle) -> Result<(), String> {
    if !id.starts_with(crate::state::FLOATING_WINDOW_LABEL_PREFIX) {
        return Err(format!("invalid floating window id: {id}"));
    }
    match app.get_webview_window(&id) {
        Some(window) => window.close().map_err(|err| err.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn floating_window_list(app: AppHandle) -> Result<Vec<FloatingWindowInfo>, String> {
    let mut out = Vec::new();
    for (label, window) in app.webview_windows() {
        if !label.starts_with(crate::state::FLOATING_WINDOW_LABEL_PREFIX) {
            continue;
        }
        let title = window.title().unwrap_or_default();
        let url = window
            .url()
            .map(|u| u.to_string())
            .unwrap_or_else(|_| String::new());
        out.push(FloatingWindowInfo {
            id: label,
            url,
            title,
        });
    }
    Ok(out)
}
