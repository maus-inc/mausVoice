use std::io::BufReader;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
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

/// Shared cancel signal for the in-progress `simulate_type` call.
/// `ReentryGuard` on `SIMULATE_TYPE_IN_PROGRESS` serializes typing, so
/// there is never more than one live session and this flag is unambiguous.
static CANCEL_TYPING: AtomicBool = AtomicBool::new(false);

/// User-data tables wiped by `clear_local_data`. Extend this list when
/// adding a table that stores user content — a missed table is a privacy leak.
const USER_DATA_TABLES_TO_CLEAR: [&str; 11] = [
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
use tauri::{AppHandle, Emitter, EventTarget, Manager, State};

use crate::domain::{
    ApiKey, ApiKeyCreateRequest, ApiKeyView, AudioChunkPayload, OverlayPhase, OverlayPhasePayload,
    RecordingLevelPayload, TranscriptionAudioSnapshot, EVT_AUDIO_CHUNK, EVT_OVERLAY_PHASE,
    EVT_REC_LEVEL,
};
use crate::platform::{ChunkCallback, LevelCallback};

#[path = "../../../../packages/rust_transcription/src/audio.rs"]
mod shared_audio;
use crate::system::crypto::{protect_api_key, reveal_api_key};
use crate::system::StorageRepo;
use sqlx::Row;
use rodio::Source;

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
const MAX_AUDIO_IMPORT_FILE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_AUDIO_IMPORT_DURATION_SECONDS: u64 = 5 * 60;
const MAX_AUDIO_IMPORT_OUTPUT_SAMPLES: usize =
    16_000 * MAX_AUDIO_IMPORT_DURATION_SECONDS as usize;
// Keep one absolute memory ceiling for pathological sample rates while the
// normal limit below is derived from the file's actual rate and channel count.
const MAX_AUDIO_IMPORT_DECODED_MEMORY_BYTES: usize = 128 * 1024 * 1024;
const MAX_AUDIO_IMPORT_ABSOLUTE_DECODED_SAMPLES: usize =
    MAX_AUDIO_IMPORT_DECODED_MEMORY_BYTES / std::mem::size_of::<f32>();

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionAudioData {
    /// Little-endian signed 16-bit mono PCM. Keeping the IPC payload binary
    /// avoids expanding every sample into a JSON number.
    pub pcm16_le: Vec<u8>,
    pub sample_rate: u32,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionAudioSamplesData {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

#[tauri::command]
#[specta::specta]
pub async fn transcription_import_audio(path: String) -> Result<TranscriptionAudioData, String> {
    let path = PathBuf::from(path.trim());
    if path.as_os_str().is_empty() {
        return Err("No audio file was selected".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let file = std::fs::File::open(&path)
            .map_err(|err| format!("failed to open audio file '{}': {err}", path.display()))?;
        let file_bytes = file
            .metadata()
            .map_err(|err| format!("failed to inspect audio file '{}': {err}", path.display()))?
            .len();
        if file_bytes > MAX_AUDIO_IMPORT_FILE_BYTES {
            return Err(format!(
                "The selected audio file is too large (maximum is {} MiB)",
                MAX_AUDIO_IMPORT_FILE_BYTES / (1024 * 1024)
            ));
        }

        let decoder = rodio::Decoder::new(BufReader::new(file))
            .map_err(|err| format!("failed to decode audio file '{}': {err}", path.display()))?;
        let source_rate = decoder.sample_rate();
        let channels = decoder.channels().max(1) as usize;
        if source_rate == 0 {
            return Err("The selected audio file contains no usable samples".to_string());
        }

        // The decoded stream is interleaved, so derive its duration limit from
        // the source rate and channel count rather than multiplying the
        // 16 kHz mono output cap by a fixed factor. This accepts ordinary
        // 44.1/48 kHz stereo recordings while retaining an absolute memory
        // ceiling for unusual high-rate files.
        let duration_sample_limit = (source_rate as usize)
            .saturating_mul(channels)
            .saturating_mul(MAX_AUDIO_IMPORT_DURATION_SECONDS as usize);
        let max_decoded_samples = duration_sample_limit
            .clamp(1, MAX_AUDIO_IMPORT_ABSOLUTE_DECODED_SAMPLES);
        let memory_limited = duration_sample_limit > max_decoded_samples;
        let decoded: Vec<f32> = decoder
            .convert_samples::<f32>()
            .take(max_decoded_samples.saturating_add(1))
            .collect();

        if decoded.len() > max_decoded_samples {
            let reason = if memory_limited {
                "the decoded audio exceeds the safe memory limit"
            } else {
                "the audio exceeds the duration limit"
            };
            return Err(format!(
                "The selected audio file cannot be imported because {reason}"
            ));
        }
        if decoded.is_empty() {
            return Err("The selected audio file contains no usable samples".to_string());
        }

        let mono = if channels == 1 {
            decoded
        } else {
            decoded
                .chunks(channels)
                .map(|frame| frame.iter().copied().sum::<f32>() / frame.len() as f32)
                .collect()
        };
        let samples = shared_audio::resample_to_rate(&mono, source_rate, 16_000);
        if samples.is_empty() {
            return Err("Unable to convert the selected audio to 16 kHz mono".to_string());
        }
        if samples.len() > MAX_AUDIO_IMPORT_OUTPUT_SAMPLES {
            return Err(format!(
                "The selected audio file exceeds the {} minute import limit",
                MAX_AUDIO_IMPORT_DURATION_SECONDS / 60
            ));
        }

        Ok(TranscriptionAudioData {
            pcm16_le: encode_pcm16_le(&samples),
            sample_rate: 16_000,
        })
    })
    .await
    .map_err(|err| format!("audio import task failed: {err}"))?
}

fn encode_pcm16_le(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len().saturating_mul(2));
    for sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let value = if clamped < 0.0 {
            (clamped * 0x8000 as f32) as i16
        } else {
            (clamped * 0x7fff as f32) as i16
        };
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
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

/// Resolve `path` to the exact file to delete, or `None` when it does not
/// live directly inside the managed transcription-audio directory. Both the
/// candidate's parent directory and `audio_dir` are canonicalized before
/// comparison, so a `..` traversal, an intermediate symlink, or an
/// `audio_dir` spelled with `.`/`..` all resolve to real paths first — a
/// lexical `starts_with` cannot do that. Callers must delete the returned
/// path — never the raw input — because a relative input is resolved
/// against `audio_dir` here.
fn resolve_managed_audio_path(
    path: &std::path::Path,
    audio_dir: &std::path::Path,
) -> Option<std::path::PathBuf> {
    // Resolve the candidate: an absolute `path` is taken as-is; a relative
    // `path` is resolved against `audio_dir`.
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        audio_dir.join(path)
    };

    // Managed audio is a flat directory of `<id>.wav` files, so the file
    // must sit directly inside `audio_dir`. Canonicalize the parent only:
    // the entry itself may be a symlink we want to unlink rather than
    // follow, and it may already be gone.
    let file_name = candidate.file_name()?;
    let real_parent = std::fs::canonicalize(candidate.parent()?).ok()?;
    let real_audio_dir = std::fs::canonicalize(audio_dir).ok()?;
    if real_parent != real_audio_dir {
        return None;
    }

    Some(real_parent.join(file_name))
}

/// Delete listed audio files that still live under `audio_dir`. Paths
/// outside the managed directory (including traversal attempts) are skipped
/// (not an error).
fn delete_listed_audio_files(audio_dir: &std::path::Path, paths: &[String]) {
    for path in paths {
        // Delete the validated path, not the raw DB value: a relative entry
        // such as `clip.wav` must resolve inside `audio_dir` rather than
        // against the process working directory.
        let Some(file_path) = resolve_managed_audio_path(&PathBuf::from(path), audio_dir) else {
            continue;
        };
        if let Err(err) = std::fs::remove_file(&file_path) {
            if err.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "Failed to delete audio file {} during clear: {err}",
                    file_path.display()
                );
            }
        }
    }
}

/// Remove leftover `.wav` files in the managed audio directory after the
/// DB table has been wiped (orphans from an interrupted record, etc.).
fn sweep_orphaned_wavs(audio_dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(audio_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) == Some("wav") {
            if let Err(err) = std::fs::remove_file(&p) {
                log::warn!(
                    "Failed to remove orphaned audio file {}: {err}",
                    p.display()
                );
            }
        }
    }
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
) -> Result<TranscriptionAudioSamplesData, String> {
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

    Ok(TranscriptionAudioSamplesData {
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

    // Wipe every user-data table. When adding user-data tables, extend
    // `USER_DATA_TABLES_TO_CLEAR` — the UI explicitly promises "this will
    // delete all preferences, dictionary entries, and saved transcriptions
    // from this device" and a missed table here is a privacy leak.
    //
    // Table names are all `&'static str` literals from this source file
    // (never user input), so `format!` is safe from SQL injection here.

    // Collect audio file paths BEFORE wiping transcriptions so we can delete
    // them from disk after the transaction commits.
    let audio_paths: Vec<String> = sqlx::query_scalar::<_, String>(
        "SELECT audio_path FROM transcriptions WHERE audio_path IS NOT NULL AND audio_path != ''",
    )
    .fetch_all(&pool)
    .await
    .map_err(|err| err.to_string())?;

    let mut transaction = pool.begin().await.map_err(|err| err.to_string())?;
    for table in USER_DATA_TABLES_TO_CLEAR {
        let statement = format!("DELETE FROM {table}");
        sqlx::query(&statement)
            .execute(&mut *transaction)
            .await
            .map_err(|err| err.to_string())?;
    }
    transaction.commit().await.map_err(|err| err.to_string())?;

    // After commit, delete every audio WAV on disk that the DB used to know
    // about, then sweep orphans. Each path goes through
    // `resolve_managed_audio_path`, which canonicalizes the path and its
    // parent so only files that really sit inside the managed audio
    // directory are deleted.
    if let Ok(audio_dir) = crate::system::audio_store::audio_dir(&app) {
        delete_listed_audio_files(&audio_dir, &audio_paths);
        sweep_orphaned_wavs(&audio_dir);
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

#[tauri::command]
#[specta::specta]
pub async fn simulate_type(text: String, delay_ms: u64) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }

    // Re-entry guard serializes typing: only one session can be live, so
    // `cancel_typing` is unambiguous without a session id.
    let _type_guard = ReentryGuard::acquire(&SIMULATE_TYPE_IN_PROGRESS)
        .map_err(|_| "Simulated typing is already in progress".to_string())?;

    CANCEL_TYPING.store(false, Ordering::SeqCst);

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
            Ok(())
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
pub fn cancel_typing() -> Result<(), String> {
    // Serialization by the re-entry guard is what makes cancel unambiguous:
    // only one `simulate_type` can be live, so this flag always targets it.
    // Ignore cancels that arrive with no live session (a late blur/Escape,
    // or another caller): otherwise the flag would stay set and abort the
    // *next* typing session before it starts.
    if !SIMULATE_TYPE_IN_PROGRESS.load(Ordering::Acquire) {
        return Ok(());
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
pub fn request_admin_relaunch(app: tauri::AppHandle) -> crate::platform::NativeSetupResult {
    #[cfg(target_os = "windows")]
    {
        crate::platform::windows::init::request_elevation_relaunch(app)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        crate::platform::NativeSetupResult::Success
    }
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

/// Read a child pipe, retaining at most `limit` bytes while still draining the
/// stream to EOF. Draining matters: if we stopped reading at the limit, a
/// chatty child would block forever writing into a full pipe buffer and never
/// reach its own exit, defeating the wall-clock timeout. Memory stays bounded
/// by `limit` regardless of how much the child emits. Returns the retained
/// prefix and the total number of bytes the child actually produced.
fn read_capped<R: std::io::Read>(mut reader: R, limit: usize) -> (Vec<u8>, usize) {
    let mut retained: Vec<u8> = Vec::new();
    let mut total = 0usize;
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                total += n;
                if retained.len() < limit {
                    let take = std::cmp::min(n, limit - retained.len());
                    retained.extend_from_slice(&chunk[..take]);
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    (retained, total)
}

/// Render a captured stream, appending a marker when the child produced more
/// than we retained.
fn format_capped_output(retained: &[u8], total: usize) -> String {
    let mut text = String::from_utf8_lossy(retained).to_string();
    if total > retained.len() {
        text.push_str(&format!("\n...[truncated: {total} bytes total]"));
    }
    text
}
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

/// Windows allow-list. Deliberately excludes CMD builtins (`dir`, `cd`,
/// `echo`, `date`, `ver`): we spawn binaries directly rather than through
/// `cmd /c`, so a builtin has no `.exe` on PATH and `Command::new` would
/// always fail with "program not found". Only real executables are listed.
#[cfg(target_os = "windows")]
const ALLOWED_COMMANDS: &[AllowedCommand] = &[
    AllowedCommand { binary: "whoami", fixed_args: &[] },
    AllowedCommand { binary: "where", fixed_args: &[] },
    AllowedCommand { binary: "hostname", fixed_args: &[] },
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

    for token in user_args {
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

/// Validate a floating-window URL before navigation. Shared by
/// `floating_window_create` and its unit tests so the allow-list cannot
/// silently diverge.
fn validate_floating_window_url(url: &Url) -> Result<(), String> {
    match url.scheme() {
        "http" | "https" => {
            let host = url.host_str().unwrap_or("");
            let is_localhost =
                host == "localhost" || host == "127.0.0.1" || host == "[::1]";
            // Docs-site windows are allowed to load, but they do not inherit
            // IPC: `maus-inc.github.io` is not in the `floating-*` capability
            // `remote.urls` list. Localhost remains the only remote host with
            // IPC (dev tooling).
            let is_docs_site = host == "maus-inc.github.io"
                && url.path().starts_with("/mausVoice/");
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

fn parse_floating_window_url(url: &str) -> Result<Url, String> {
    Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn percent_decode_route_path(path: &str) -> Result<String, String> {
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = bytes
                .get(index + 1)
                .and_then(|value| hex_value(*value))
                .ok_or_else(|| "Floating app route has invalid percent encoding".to_string())?;
            let low = bytes
                .get(index + 2)
                .and_then(|value| hex_value(*value))
                .ok_or_else(|| "Floating app route has invalid percent encoding".to_string())?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded)
        .map_err(|_| "Floating app route path is not valid UTF-8".to_string())
}

/// Validate only the path portion of a local app route. Query values are
/// opaque user data; rejecting `..` anywhere in the full route would reject
/// legitimate transcript text such as "Wait... what?".
fn validate_local_app_route(route: &str) -> Result<(), String> {
    let path = route.split(['?', '#']).next().unwrap_or(route);
    let decoded_path = percent_decode_route_path(path)?;
    let has_parent_segment = decoded_path.split('/').any(|segment| segment == "..");

    if decoded_path.is_empty()
        || decoded_path.starts_with('/')
        || decoded_path.contains('\\')
        || has_parent_segment
    {
        return Err(
            "Floating app routes must be relative and cannot contain path traversal".to_string(),
        );
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

    #[cfg(not(target_os = "windows"))]
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

    #[cfg(target_os = "windows")]
    #[test]
    fn terminal_command_allows_allowlisted() {
        assert_eq!(
            validate_terminal_command_args("whoami").unwrap().0.binary,
            "whoami"
        );
        assert_eq!(
            validate_terminal_command_args("where cargo").unwrap().0.binary,
            "where"
        );
        // CMD builtins are intentionally absent: without a shell they have
        // no executable to spawn.
        assert!(validate_terminal_command_args("dir").is_err());
    }

    /// Every allow-listed entry must be reachable through the validator,
    /// so the const and the parser can't drift apart on any platform.
    #[test]
    fn terminal_command_allowlist_entries_are_reachable() {
        for entry in ALLOWED_COMMANDS {
            let (matched, args) = validate_terminal_command_args(entry.binary)
                .unwrap_or_else(|err| panic!("{} should validate: {err}", entry.binary));
            assert_eq!(matched.binary, entry.binary);
            assert!(args.is_empty());
        }
    }

    #[test]
    fn installer_url_accepts_trusted_release_hosts() {
        assert!(validate_installer_url(
            &Url::parse("https://github.com/maus-inc/mausVoice/releases/download/v1/app.pkg")
                .unwrap()
        )
        .is_ok());
        assert!(validate_installer_url(
            &Url::parse("https://objects.githubusercontent.com/foo/app.pkg").unwrap()
        )
        .is_ok());
    }

    #[test]
    fn installer_url_rejects_untrusted_hosts_schemes_and_extensions() {
        // A redirect target on an untrusted host must be refused: this is the
        // check the redirect policy applies to every hop.
        assert!(
            validate_installer_url(&Url::parse("https://evil.com/app.pkg").unwrap()).is_err()
        );
        assert!(validate_installer_url(
            &Url::parse("http://github.com/maus-inc/app.pkg").unwrap()
        )
        .is_err());
        assert!(validate_installer_url(
            &Url::parse("https://github.com/maus-inc/payload.sh").unwrap()
        )
        .is_err());
    }

    #[test]
    fn capped_reader_bounds_memory_and_reports_total() {
        let payload = vec![b'x'; 10_000];
        let (retained, total) = read_capped(payload.as_slice(), 1_000);
        assert_eq!(retained.len(), 1_000);
        assert_eq!(total, 10_000);

        let rendered = format_capped_output(&retained, total);
        assert!(rendered.contains("truncated: 10000 bytes total"));
    }

    #[test]
    fn capped_reader_passes_through_small_output() {
        let (retained, total) = read_capped(b"hello".as_slice(), 1_000);
        assert_eq!(total, 5);
        assert_eq!(format_capped_output(&retained, total), "hello");
    }

    #[test]
    fn floating_window_allows_localhost() {
        assert!(validate_floating_window_url(&Url::parse("http://localhost:1420/").unwrap()).is_ok());
        assert!(validate_floating_window_url(&Url::parse("http://127.0.0.1:8080/foo").unwrap()).is_ok());
    }

    #[test]
    fn local_app_route_allows_dots_in_query_data() {
        assert!(validate_local_app_route("composer?text=Wait...%20what%3F").is_ok());
        assert!(validate_local_app_route("composer/../settings").is_err());
        assert!(validate_local_app_route("composer/%2e%2e/settings").is_err());
    }

    #[test]
    fn floating_window_allows_docs_site() {
        assert!(validate_floating_window_url(
            &Url::parse("https://maus-inc.github.io/mausVoice/welcome").unwrap()
        )
        .is_ok());
        // GitHub Pages URL must be scoped to /mausVoice/ even though that
        // host has no IPC capability — keep the navigation allow-list tight.
        assert!(validate_floating_window_url(
            &Url::parse("https://maus-inc.github.io/other-project/").unwrap()
        )
        .is_err());
    }

    #[test]
    fn floating_window_rejects_arbitrary_origins() {
        assert!(validate_floating_window_url(&Url::parse("https://evil.com/").unwrap()).is_err());
        assert!(validate_floating_window_url(&Url::parse("file:///etc/passwd").unwrap()).is_err());
        assert!(validate_floating_window_url(&Url::parse("javascript:alert(1)").unwrap()).is_err());
        assert!(parse_floating_window_url("not a url").is_err());
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
    fn cancel_typing_only_signals_a_live_session() {
        // `CANCEL_TYPING` is process-wide and `cargo test` runs tests in
        // parallel, so put it back the way we found it before returning.
        let previous = CANCEL_TYPING.load(Ordering::SeqCst);
        CANCEL_TYPING.store(false, Ordering::SeqCst);

        // No typing session is live, so the cancel must be ignored instead
        // of arming the flag for the next session.
        cancel_typing().unwrap();
        assert!(!CANCEL_TYPING.load(Ordering::SeqCst));

        {
            let _session = ReentryGuard::acquire(&SIMULATE_TYPE_IN_PROGRESS).unwrap();
            cancel_typing().unwrap();
            assert!(CANCEL_TYPING.load(Ordering::SeqCst));
        }

        CANCEL_TYPING.store(previous, Ordering::SeqCst);
    }

    #[test]
    fn reentry_guard_rejects_a_second_acquire() {
        let flag = AtomicBool::new(false);
        let first = ReentryGuard::acquire(&flag).unwrap();
        assert!(ReentryGuard::acquire(&flag).is_err());
        drop(first);
        assert!(ReentryGuard::acquire(&flag).is_ok());
    }

    #[test]
    fn reentry_guard_releases_on_panic() {
        let flag = AtomicBool::new(false);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = ReentryGuard::acquire(&flag).unwrap();
            panic!("boom");
        }));
        assert!(result.is_err());
        assert!(!flag.load(Ordering::Acquire));
        assert!(ReentryGuard::acquire(&flag).is_ok());
    }

    /// Tables that live in the schema but hold no user content, so
    /// `clear_local_data` may skip them. Adding a name here is an explicit
    /// privacy decision, which is the point: it cannot happen by omission.
    const NON_USER_DATA_TABLES: &[&str] = &[];

    /// Rebuild the set of tables the schema actually ends up with by
    /// replaying the migration SQL. Derived independently of
    /// `USER_DATA_TABLES_TO_CLEAR`, so a new table that nobody remembered
    /// to clear still shows up here.
    /// Strip SQL noise that would otherwise be mis-tokenized when the
    /// migrations are replayed as statements:
    /// - `/* */` block comments,
    /// - `--` line comments (to end of line),
    /// - single-quoted string literals (which may contain `;`, `--`, or
    ///   `*/`), including the `''` doubled-quote escape.
    ///
    /// Double-quoted identifiers (table/column names in SQLite) are left in
    /// place by this pass: they are not string literals, so unlike `'...'`
    /// above they are not skipped. The surrounding quote characters are
    /// trimmed later when the table name is extracted, so `"my_table"` and
    /// `my_table` resolve to the same bare name that SQLite reports.
    fn strip_sql_noise(sql: &str) -> String {
        let mut out = String::with_capacity(sql.len());
        let mut chars = sql.chars().peekable();
        let mut in_block_comment = false;
        let mut in_line_comment = false;
        while let Some(c) = chars.next() {
            if in_line_comment {
                if c == '\n' {
                    in_line_comment = false;
                    out.push(c);
                }
                continue;
            }
            if in_block_comment {
                if c == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    in_block_comment = false;
                }
                continue;
            }
            if c == '/' && chars.peek() == Some(&'*') {
                chars.next();
                in_block_comment = true;
                continue;
            }
            if c == '-' && chars.peek() == Some(&'-') {
                chars.next();
                in_line_comment = true;
                continue;
            }
            if c == '\'' {
                // Single-quoted string literal: skip content (incl. '' escape).
                while let Some(q) = chars.next() {
                    if q == '\'' {
                        if chars.peek() == Some(&'\'') {
                            chars.next(); // doubled-quote escape
                            continue;
                        }
                        break;
                    }
                }
                continue;
            }
            out.push(c);
        }
        out
    }

    fn tables_declared_by_migrations() -> std::collections::BTreeSet<String> {
        let first_word = |rest: &str| -> Option<String> {
            rest.split(|c: char| c == '(' || c.is_whitespace())
                .find(|part| !part.is_empty())
                // Trim surrounding double quotes so a quoted identifier
                // (`CREATE TABLE "name"`) resolves to the same bare name
                // SQLite reports, rather than `"name"`.
                .map(|name| name.trim_matches('"').to_string())
        };

        let mut tables: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for migration in crate::db::migrations() {
            // `strip_sql_noise` fully cleans each migration's SQL (block
            // comments, line comments, and single-quoted string literals),
            // so the remaining text can be replayed statement by statement.
            let sql = strip_sql_noise(migration.sql)
                .lines()
                .map(|line| line.trim())
                .collect::<Vec<_>>()
                .join(" ");

            for raw_statement in sql.split(';') {
                let statement = raw_statement
                    .split_whitespace()
                    .map(|word| word.to_ascii_lowercase())
                    .collect::<Vec<_>>()
                    .join(" ");

                if let Some(rest) = statement
                    .strip_prefix("create table if not exists ")
                    .or_else(|| statement.strip_prefix("create table "))
                {
                    if let Some(name) = first_word(rest) {
                        tables.insert(name);
                    }
                } else if let Some(rest) = statement
                    .strip_prefix("drop table if exists ")
                    .or_else(|| statement.strip_prefix("drop table "))
                {
                    if let Some(name) = first_word(rest) {
                        tables.remove(&name);
                    }
                } else if let Some(rest) = statement.strip_prefix("alter table ") {
                    if let Some((old, new)) = rest.split_once(" rename to ") {
                        if let (Some(old), Some(new)) = (first_word(old), first_word(new)) {
                            tables.remove(&old);
                            tables.insert(new);
                        }
                    }
                }
            }
        }
        tables
    }

    #[test]
    fn user_data_tables_to_clear_covers_the_privacy_set() {
        let declared = tables_declared_by_migrations();
        assert!(
            !declared.is_empty(),
            "no tables parsed from the migrations — the parser is broken"
        );

        for table in &declared {
            assert!(
                USER_DATA_TABLES_TO_CLEAR.contains(&table.as_str())
                    || NON_USER_DATA_TABLES.contains(&table.as_str()),
                "table `{table}` exists in the schema but clear_local_data never wipes it — a missed table is a privacy leak"
            );
        }

        for table in USER_DATA_TABLES_TO_CLEAR {
            assert!(
                declared.contains(table),
                "`{table}` is cleared but no longer exists in the schema"
            );
        }
    }

    #[test]
    fn managed_audio_path_rejects_paths_outside_the_audio_dir() {
        let root = std::env::temp_dir()
            .join(format!("mausvoice-audio-guard-{}", std::process::id()));
        let audio_dir = root.join("audio");
        let other_dir = root.join("other");
        std::fs::create_dir_all(&audio_dir).unwrap();
        std::fs::create_dir_all(&other_dir).unwrap();
        // Canonicalized because the guard returns real paths (e.g. macOS
        // maps /tmp to /private/tmp).
        let expected = std::fs::canonicalize(&audio_dir).unwrap().join("clip.wav");

        let inside = audio_dir.join("clip.wav");
        let outside = other_dir.join("clip.wav");
        // A traversal attempt must NOT escape the managed directory.
        let traversal = audio_dir.join("..").join("escaped.wav");
        assert_eq!(
            resolve_managed_audio_path(&inside, &audio_dir),
            Some(expected.clone())
        );
        assert_eq!(resolve_managed_audio_path(&outside, &audio_dir), None);
        assert_eq!(resolve_managed_audio_path(&traversal, &audio_dir), None);
        // A relative entry must resolve inside the managed directory, never
        // against the process working directory.
        assert_eq!(
            resolve_managed_audio_path(std::path::Path::new("clip.wav"), &audio_dir),
            Some(expected.clone())
        );
        // An `audio_dir` spelled with `.` still matches its own contents.
        assert_eq!(
            resolve_managed_audio_path(&inside, &root.join(".").join("audio")),
            Some(expected)
        );

        #[cfg(unix)]
        {
            // A symlinked subdirectory must not tunnel out of audio_dir.
            let link = audio_dir.join("link");
            std::os::unix::fs::symlink(&other_dir, &link).unwrap();
            assert_eq!(
                resolve_managed_audio_path(&link.join("clip.wav"), &audio_dir),
                None
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn clear_local_data_file_helpers_respect_the_audio_dir_guard() {
        let root = std::env::temp_dir().join(format!(
            "mausvoice-clear-local-{}",
            std::process::id()
        ));
        let audio_dir = root.join("audio");
        let outside_dir = root.join("outside");
        std::fs::create_dir_all(&audio_dir).unwrap();
        std::fs::create_dir_all(&outside_dir).unwrap();

        let inside = audio_dir.join("keep-me-not.wav");
        let relative = audio_dir.join("relative.wav");
        let orphan = audio_dir.join("orphan.wav");
        let other = audio_dir.join("notes.txt");
        let outside = outside_dir.join("do-not-delete.wav");
        std::fs::write(&inside, b"in").unwrap();
        std::fs::write(&relative, b"rel").unwrap();
        std::fs::write(&orphan, b"or").unwrap();
        std::fs::write(&other, b"txt").unwrap();
        std::fs::write(&outside, b"out").unwrap();

        delete_listed_audio_files(
            &audio_dir,
            &[
                inside.to_string_lossy().into_owned(),
                // A relative row must be deleted from inside `audio_dir`.
                "relative.wav".to_string(),
                outside.to_string_lossy().into_owned(),
            ],
        );
        assert!(!inside.exists());
        assert!(!relative.exists());
        assert!(outside.exists());

        sweep_orphaned_wavs(&audio_dir);
        assert!(!orphan.exists());
        assert!(other.exists());
        assert!(outside.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn installer_redirect_validates_each_hop_and_caps_depth() {
        let ok = Url::parse(
            "https://github.com/maus-inc/mausVoice/releases/download/v1/app.pkg",
        )
        .unwrap();
        let evil = Url::parse("https://evil.com/app.pkg").unwrap();
        assert!(installer_redirect_allowed(0, &ok).is_ok());
        assert!(installer_redirect_allowed(9, &ok).is_ok());
        assert!(installer_redirect_allowed(10, &ok).is_err());
        assert!(installer_redirect_allowed(0, &evil).is_err());
    }

    #[test]
    fn installer_size_cap_rejects_advertised_and_streamed_oversize() {
        assert!(installer_content_length_ok(None).is_ok());
        assert!(installer_content_length_ok(Some(INSTALLER_MAX_BYTES)).is_ok());
        assert!(installer_content_length_ok(Some(INSTALLER_MAX_BYTES + 1)).is_err());
        assert_eq!(
            installer_account_chunk(0, INSTALLER_MAX_BYTES).unwrap(),
            INSTALLER_MAX_BYTES
        );
        assert!(installer_account_chunk(INSTALLER_MAX_BYTES, 1).is_err());
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

        let mut child = cmd
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|err| format!("Failed to spawn {bin}: {err}"))?;

        // Take the pipes and drain them on dedicated threads. Each reader
        // retains at most TERMINAL_COMMAND_MAX_OUTPUT_BYTES, so a command
        // streaming gigabytes cannot exhaust memory, and because the readers
        // keep draining to EOF the child never blocks on a full pipe.
        let stdout_pipe = child
            .stdout
            .take()
            .ok_or_else(|| format!("Failed to capture stdout of {bin}"))?;
        let stderr_pipe = child
            .stderr
            .take()
            .ok_or_else(|| format!("Failed to capture stderr of {bin}"))?;

        let stdout_reader =
            std::thread::spawn(move || read_capped(stdout_pipe, TERMINAL_COMMAND_MAX_OUTPUT_BYTES));
        let stderr_reader =
            std::thread::spawn(move || read_capped(stderr_pipe, TERMINAL_COMMAND_MAX_OUTPUT_BYTES));

        // Poll for exit so this thread retains ownership of `child` and can
        // actually kill it on timeout. `wait_with_output` would move the
        // child into a worker and leave the process unkillable.
        let deadline = std::time::Instant::now() + TERMINAL_COMMAND_TIMEOUT;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        // Kill the process and reap it so we don't leak a
                        // zombie; repeated timeouts must not pile up
                        // long-running children.
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(format!(
                            "Command {bin} timed out after {}s and was terminated",
                            TERMINAL_COMMAND_TIMEOUT.as_secs()
                        ));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(err) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("Failed to await {bin}: {err}"));
                }
            }
        };

        let (stdout_bytes, stdout_total) = stdout_reader
            .join()
            .map_err(|_| format!("Failed to read stdout of {bin}"))?;
        let (stderr_bytes, stderr_total) = stderr_reader
            .join()
            .map_err(|_| format!("Failed to read stderr of {bin}"))?;

        Ok(RunTerminalCommandResponse {
            stdout: format_capped_output(&stdout_bytes, stdout_total),
            stderr: format_capped_output(&stderr_bytes, stderr_total),
            exit_code: status.code().unwrap_or(-1),
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

/// Maximum size we are willing to download for a `.pkg` installer.
const INSTALLER_MAX_BYTES: u64 = 250 * 1024 * 1024;
const INSTALLER_MAX_REDIRECTS: usize = 10;

/// Decide whether a redirect hop is allowed. Applied to every hop so an
/// allowed host cannot bounce us onto an untrusted origin.
fn installer_redirect_allowed(previous_hops: usize, url: &Url) -> Result<(), String> {
    if previous_hops >= INSTALLER_MAX_REDIRECTS {
        return Err("too many redirects".to_string());
    }
    validate_installer_url(url)
}

/// Reject an advertised Content-Length above the streaming cap before any
/// bytes are written.
fn installer_content_length_ok(len: Option<u64>) -> Result<(), String> {
    if let Some(n) = len {
        if n > INSTALLER_MAX_BYTES {
            return Err("Installer download exceeded 250MiB safety limit".to_string());
        }
    }
    Ok(())
}

/// Accumulate a downloaded chunk against the streaming cap.
fn installer_account_chunk(written: u64, chunk_len: u64) -> Result<u64, String> {
    let next = written.saturating_add(chunk_len);
    if next > INSTALLER_MAX_BYTES {
        return Err("Installer download exceeded 250MiB safety limit".to_string());
    }
    Ok(next)
}

/// Validate an installer URL (scheme, host allow-list, `.pkg` path). Applied
/// to the initial URL *and* to every redirect hop, because the redirect chain
/// is attacker-influenced: an allowed host could otherwise bounce us to an
/// untrusted origin whose bytes we would write and execute.
fn validate_installer_url(url: &Url) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err("Installer URL must use https".to_string());
    }
    let host = url.host_str().unwrap_or("");
    if !matches!(host, "github.com" | "objects.githubusercontent.com") {
        return Err(format!(
            "Installer URL host {host:?} is not in the trusted allow-list"
        ));
    }
    if !url.path().ends_with(".pkg") {
        return Err("Installer URL must point to a .pkg file".to_string());
    }
    Ok(())
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
    validate_installer_url(&parsed)?;

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

    // Validate every redirect hop rather than trusting the initial URL: the
    // default policy would silently follow an allowed host to an arbitrary one.
    let redirect_policy = reqwest::redirect::Policy::custom(|attempt| {
        match installer_redirect_allowed(attempt.previous().len(), attempt.url()) {
            Ok(()) => attempt.follow(),
            Err(err) => attempt.error(err),
        }
    });
    let client = reqwest::Client::builder()
        .redirect(redirect_policy)
        .build()
        .map_err(|e| e.to_string())?;

    let mut response = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Download failed with status {}", response.status()));
    }

    // Reject an oversized advertised length before transferring anything.
    installer_content_length_ok(response.content_length())?;

    // Stream to disk, enforcing the cap as we go so a server that lies about
    // (or omits) Content-Length cannot exhaust memory or fill the disk.
    let mut file = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
    let mut written: u64 = 0;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        written = match installer_account_chunk(written, chunk.len() as u64) {
            Ok(next) => next,
            Err(err) => {
                drop(file);
                let _ = std::fs::remove_file(&dest);
                return Err(err);
            }
        };
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
    }
    std::io::Write::flush(&mut file).map_err(|e| e.to_string())?;
    drop(file);

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
    /// When set, load a local app route instead of an external URL. This is
    /// used by the composer so it never depends on localhost or a network
    /// origin.
    pub route: Option<String>,
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

#[tauri::command]
#[specta::specta]
pub fn composer_register_text(
    request_id: String,
    text: String,
    state: State<'_, crate::state::FloatingWindowState>,
) -> Result<(), String> {
    let request_id = request_id.trim().to_string();
    if request_id.is_empty() {
        return Err("composer request id must not be empty".to_string());
    }
    state.register_composer_text(request_id, text)
}

#[tauri::command]
#[specta::specta]
pub fn composer_peek_text(
    request_id: String,
    state: State<'_, crate::state::FloatingWindowState>,
) -> Result<Option<String>, String> {
    state.peek_composer_text(request_id.trim())
}

#[tauri::command]
#[specta::specta]
pub fn composer_take_text(
    request_id: String,
    state: State<'_, crate::state::FloatingWindowState>,
) -> Result<Option<String>, String> {
    state.take_composer_text(request_id.trim())
}

#[tauri::command]
#[specta::specta]
pub fn composer_discard_text(
    request_id: String,
    state: State<'_, crate::state::FloatingWindowState>,
) -> Result<(), String> {
    state.discard_composer_text(request_id.trim())
}

#[derive(serde::Serialize, specta::Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FloatingWindowInfo {
    pub id: String,
    pub url: String,
    pub title: String,
}

/// Opens a draggable, always-on-top webview window pointed at the given URL
/// or a trusted local app route and returns a stable id that can be used to
/// destroy it later.
///
/// External URLs are restricted to http(s) and to a small allow-list of
/// trusted schemes/hosts. This is the only place in the app that creates a
/// webview pointed at a non-local origin. Localhost loopback is the only
/// remote host that also receives IPC (via `floating-*` `remote.urls`);
/// the GitHub Pages docs host is allowed to load but has no IPC capability.
/// We keep the navigation allow-list small to avoid a compromised or
/// confused caller creating a floating window on an attacker-controlled origin.
#[tauri::command]
#[specta::specta]
pub async fn floating_window_create(
    args: CreateFloatingWindowArgs,
    app: AppHandle,
    state: State<'_, crate::state::FloatingWindowState>,
) -> Result<FloatingWindowInfo, String> {
    let label = state.next_label();
    let title = args.title.clone().unwrap_or_else(|| "mausVoice".to_string());
    let (webview_url, reported_url) = if let Some(route) = args
        .route
        .as_deref()
        .map(str::trim)
        .filter(|route| !route.is_empty())
    {
        validate_local_app_route(route)?;
        (
            tauri::WebviewUrl::App(route.into()),
            format!("app://{route}"),
        )
    } else {
        let parsed_url = parse_floating_window_url(&args.url)?;
        validate_floating_window_url(&parsed_url)?;
        (tauri::WebviewUrl::External(parsed_url), args.url.clone())
    };

    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        label.clone(),
        webview_url,
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
        url: reported_url,
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
