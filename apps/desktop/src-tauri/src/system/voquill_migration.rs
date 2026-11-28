use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Row, SqlitePool,
};
use tauri::Manager;

use crate::{
    db::{
        api_key_queries,
        open::{
            open_app_database, open_app_database_readonly_verified, open_app_database_strict,
            StrictOpenError,
        },
        DB_FILENAME,
    },
    domain::ApiKeyCredentialStatus,
    state::OptionKeyDatabase,
    system::{
        crypto::inspect_api_key_credential,
        paths::{legacy_voquill_config_dir, legacy_voquill_data_dir, LEGACY_DB_FILENAME},
    },
};

const MANIFEST_SCHEMA_VERSION: u32 = 1;
const MANIFEST_FILENAME: &str = "voquill-migration-state.json";
const ASSET_PROGRESS_FILENAME: &str = "voquill-migration-assets-progress.json";
const STAGING_DIR_NAME: &str = ".voquill-migration-staging";
const STAGED_DB_FILENAME: &str = "staged.db";
const PROMOTION_MARKER_FILENAME: &str = ".voquill-db-promoting";
const PROMOTION_TEMP_SUFFIX: &str = ".migrating.tmp";
const PRE_RETRY_BACKUP_SUFFIX: &str = ".pre-retry.bak";
const SQLITE_HEADER_MAGIC: &[u8; 16] = b"SQLite format 3\0";
const SQLITE_MIN_HEADER_BYTES: usize = 100;

static ASSET_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

const MODELS_DIR_NAME: &str = "transcription-models";
const LEGACY_MODELS_DIR_NAME: &str = "models";
const AUDIO_DIR_NAME: &str = "transcription-audio";
const STORAGE_DIR_NAME: &str = "storage";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum VoquillMigrationStatus {
    NotNeeded,
    Completed,
    Partial,
    Failed,
    SkippedExistingProfile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum VoquillMigrationPhaseStatus {
    NotFound,
    Pending,
    Migrated,
    Partial,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VoquillMigrationCounts {
    pub has_profile: bool,
    pub has_preferences: bool,
    pub transcriptions: u32,
    pub dictionary_terms: u32,
    pub hotkeys: u32,
    pub tones: u32,
    pub app_targets: u32,
    pub provider_entries: u32,
    pub providers_needing_attention: u32,
    pub local_models_migrated: u32,
    pub audio_files_migrated: u32,
    pub storage_files_migrated: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VoquillMigrationIssue {
    pub category: String,
    pub code: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VoquillMigrationActionItem {
    pub kind: String,
    pub target_section: String,
    pub count: u32,
    pub providers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VoquillMigrationReport {
    pub schema_version: u32,
    pub status: VoquillMigrationStatus,
    pub legacy_detected: bool,
    pub legacy_source_preserved: bool,
    pub detected_at: Option<String>,
    pub completed_at: Option<String>,
    pub dismissed_at: Option<String>,
    pub attempt_count: u32,
    pub database_phase: VoquillMigrationPhaseStatus,
    pub models_phase: VoquillMigrationPhaseStatus,
    pub audio_phase: VoquillMigrationPhaseStatus,
    pub storage_phase: VoquillMigrationPhaseStatus,
    pub counts: VoquillMigrationCounts,
    pub removed_modes_reset: Vec<String>,
    pub issues: Vec<VoquillMigrationIssue>,
    pub action_items: Vec<VoquillMigrationActionItem>,
    pub can_retry: bool,
}

impl VoquillMigrationReport {
    pub fn not_needed() -> Self {
        Self {
            schema_version: MANIFEST_SCHEMA_VERSION,
            status: VoquillMigrationStatus::NotNeeded,
            legacy_detected: false,
            legacy_source_preserved: false,
            detected_at: None,
            completed_at: None,
            dismissed_at: None,
            attempt_count: 0,
            database_phase: VoquillMigrationPhaseStatus::NotFound,
            models_phase: VoquillMigrationPhaseStatus::NotFound,
            audio_phase: VoquillMigrationPhaseStatus::NotFound,
            storage_phase: VoquillMigrationPhaseStatus::NotFound,
            counts: VoquillMigrationCounts::default(),
            removed_modes_reset: Vec::new(),
            issues: Vec::new(),
            action_items: Vec::new(),
            can_retry: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct MigrationDirs {
    pub current_config_dir: PathBuf,
    pub current_data_dir: PathBuf,
    pub legacy_config_dir: Option<PathBuf>,
    pub legacy_data_dir: Option<PathBuf>,
}

impl MigrationDirs {
    pub fn from_app(app: &tauri::AppHandle) -> io::Result<Self> {
        let current_config_dir = app
            .path()
            .app_config_dir()
            .map_err(|err| io::Error::other(err.to_string()))?;
        let current_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|err| io::Error::other(err.to_string()))?;
        let legacy_config_dir = legacy_voquill_config_dir(app)?;
        let legacy_data_dir = legacy_voquill_data_dir(app)?;
        Ok(Self {
            current_config_dir,
            current_data_dir,
            legacy_config_dir,
            legacy_data_dir,
        })
    }

    pub fn current_db_path(&self) -> PathBuf {
        self.current_config_dir.join(DB_FILENAME)
    }

    pub fn legacy_db_path(&self) -> Option<PathBuf> {
        self.legacy_config_dir
            .as_ref()
            .map(|dir| dir.join(LEGACY_DB_FILENAME))
    }

    #[cfg(test)]
    fn manifest_path(&self) -> PathBuf {
        self.current_config_dir.join(MANIFEST_FILENAME)
    }

    fn staging_dir(&self) -> PathBuf {
        self.current_config_dir.join(STAGING_DIR_NAME)
    }

    fn promotion_marker_path(&self) -> PathBuf {
        self.current_config_dir.join(PROMOTION_MARKER_FILENAME)
    }
}

/// Maps a provider slug to a safe, secret-free display name for migration
/// notices. Unknown slugs are normalized to a safe ASCII identifier without
/// ever including user-entered secrets or URLs.
pub fn safe_provider_display_name(provider: &str) -> String {
    match provider.trim().to_ascii_lowercase().as_str() {
        "groq" => "Groq".to_string(),
        "deepgram" => "Deepgram".to_string(),
        "openai" => "OpenAI".to_string(),
        "anthropic" | "claude" => "Anthropic".to_string(),
        "google" | "gemini" => "Google Gemini".to_string(),
        "openrouter" => "OpenRouter".to_string(),
        "azure" => "Azure".to_string(),
        "elevenlabs" => "ElevenLabs".to_string(),
        "assemblyai" => "AssemblyAI".to_string(),
        "aldea" => "Aldea".to_string(),
        "gladia" => "Gladia".to_string(),
        "deepseek" => "DeepSeek".to_string(),
        "cerebras" => "Cerebras".to_string(),
        "xai" => "xAI".to_string(),
        "ollama" => "Ollama".to_string(),
        "speaches" => "Speaches".to_string(),
        "openai-compatible" => "OpenAI-compatible".to_string(),
        _ => "Custom provider".to_string(),
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn saturating_u32(value: i64) -> u32 {
    u32::try_from(value.max(0)).unwrap_or(u32::MAX)
}

fn usize_to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct PromotionMarker {
    mode: String,
    staged_sha256: String,
    #[serde(default)]
    staged_payload_sha256: String,
    #[serde(default)]
    pre_retry_payload_sha256: Option<String>,
    #[serde(default)]
    removed_modes_reset: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AssetMigrationProgress {
    #[serde(default)]
    models: HashSet<String>,
    #[serde(default)]
    audio: HashSet<String>,
    #[serde(default)]
    storage: HashSet<String>,
    #[serde(skip)]
    models_pending: HashMap<String, String>,
    #[serde(skip)]
    audio_pending: HashMap<String, String>,
    #[serde(skip)]
    storage_pending: HashMap<String, String>,
    #[serde(skip)]
    models_digests: HashMap<String, String>,
    #[serde(skip)]
    audio_digests: HashMap<String, String>,
    #[serde(skip)]
    storage_digests: HashMap<String, String>,
}

fn sync_dir_best_effort(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(dir)?.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
    Ok(())
}

fn sha256_file_from_offset_hex(path: &Path, skip_bytes: u64) -> io::Result<String> {
    use std::io::Seek;
    let mut file = File::open(path)?;
    if skip_bytes > 0 {
        let len = file.metadata()?.len();
        if len < skip_bytes {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "database file shorter than SQLite header",
            ));
        }
        file.seek(io::SeekFrom::Start(skip_bytes))?;
    }
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buf)?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    Ok(hex)
}

fn sha256_file_hex(path: &Path) -> io::Result<String> {
    sha256_file_from_offset_hex(path, 0)
}

/// Computes SHA-256 over the SQLite database body past the 100-byte database
/// header (`100..EOF`). Opening an already-migrated standalone DB in WAL mode
/// only updates header fields (bytes 18-19, 24-27, 92-99), leaving the payload
/// digest cryptographically invariant for our promoted DB while differing from
/// any unrelated database.
fn sha256_db_payload_hex(path: &Path) -> io::Result<String> {
    sha256_file_from_offset_hex(path, SQLITE_MIN_HEADER_BYTES as u64)
}

fn hash_staged_database(path: &Path) -> io::Result<(String, String)> {
    let full = sha256_file_hex(path)?;
    let payload = sha256_db_payload_hex(path)?;
    Ok((full, payload))
}

#[derive(Debug)]
enum AtomicWriteError {
    BeforePublish(io::Error),
    AfterPublishSyncFailed(io::Error),
}

impl AtomicWriteError {
    fn was_published(&self) -> bool {
        matches!(self, Self::AfterPublishSyncFailed(_))
    }
}

impl std::fmt::Display for AtomicWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BeforePublish(err) | Self::AfterPublishSyncFailed(err) => err.fmt(f),
        }
    }
}

fn write_atomic_json_with_sync<T: Serialize, F>(
    target: &Path,
    value: &T,
    sync_dir: F,
) -> Result<(), AtomicWriteError>
where
    F: FnOnce(&Path) -> io::Result<()>,
{
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(AtomicWriteError::BeforePublish)?;
    }
    let tmp_name = format!(
        ".{}.{}.tmp",
        target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("state"),
        ASSET_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let tmp = target.with_file_name(tmp_name);
    let payload = serde_json::to_vec_pretty(value).map_err(|err| {
        AtomicWriteError::BeforePublish(io::Error::new(io::ErrorKind::InvalidData, err))
    })?;

    let publish_res = (|| -> io::Result<()> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(&payload)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, target)?;
        Ok(())
    })();

    if let Err(err) = publish_res {
        let _ = fs::remove_file(&tmp);
        return Err(AtomicWriteError::BeforePublish(err));
    }

    if let Some(parent) = target.parent() {
        sync_dir(parent).map_err(AtomicWriteError::AfterPublishSyncFailed)?;
    }
    Ok(())
}

fn write_promotion_marker_record_with_sync<F>(
    path: &Path,
    marker: &PromotionMarker,
    sync_dir: F,
) -> Result<(), AtomicWriteError>
where
    F: FnOnce(&Path) -> io::Result<()>,
{
    write_atomic_json_with_sync(path, marker, sync_dir)
}

fn write_promotion_marker(
    path: &Path,
    mode: &str,
    staged_sha256: String,
    staged_payload_sha256: String,
    removed_modes_reset: Vec<String>,
) -> Result<(), AtomicWriteError> {
    write_promotion_marker_record_with_sync(
        path,
        &PromotionMarker {
            mode: mode.to_string(),
            staged_sha256,
            staged_payload_sha256,
            pre_retry_payload_sha256: None,
            removed_modes_reset,
        },
        sync_dir_best_effort,
    )
}

fn retire_promotion_marker_with_sync<F>(marker_path: &Path, sync_dir: F) -> io::Result<()>
where
    F: FnOnce(&Path) -> io::Result<()>,
{
    match fs::remove_file(marker_path) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    if let Some(parent) = marker_path.parent() {
        sync_dir(parent)?;
    }
    Ok(())
}

fn retire_promotion_marker_sync(marker_path: &Path) -> io::Result<()> {
    retire_promotion_marker_with_sync(marker_path, sync_dir_best_effort)
}

async fn retire_promotion_marker_async(marker_path: &Path) -> io::Result<()> {
    let path = marker_path.to_path_buf();
    tokio::task::spawn_blocking(move || retire_promotion_marker_sync(&path))
        .await
        .map_err(|err| io::Error::other(format!("promotion marker retire task failed: {err}")))?
}

fn read_promotion_marker(path: &Path) -> Result<Option<PromotionMarker>, io::Error> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    serde_json::from_slice::<PromotionMarker>(&raw)
        .map(Some)
        .map_err(|err| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Malformed Voquill promotion marker JSON: {err}"),
            )
        })
}

fn apply_progress_log_line(progress: &mut AssetMigrationProgress, line: &str) {
    let (op, rest) = if let Some(rest) = line.strip_prefix('+') {
        ('+', rest)
    } else if let Some(rest) = line.strip_prefix('?') {
        ('?', rest)
    } else if let Some(rest) = line.strip_prefix('-') {
        ('-', rest)
    } else {
        return;
    };
    let Some((cat, value_part)) = rest.split_once('\t') else {
        return;
    };
    let (key, digest) = match value_part.split_once('\t') {
        Some((k, d)) if !d.is_empty() => (k, Some(d)),
        _ => (value_part, None),
    };
    let (confirmed, pending, digests) = match cat {
        "m" => (
            &mut progress.models,
            &mut progress.models_pending,
            &mut progress.models_digests,
        ),
        "a" => (
            &mut progress.audio,
            &mut progress.audio_pending,
            &mut progress.audio_digests,
        ),
        "s" => (
            &mut progress.storage,
            &mut progress.storage_pending,
            &mut progress.storage_digests,
        ),
        _ => return,
    };
    match op {
        '+' => {
            pending.remove(key);
            confirmed.insert(key.to_string());
            if let Some(d) = digest {
                digests.insert(key.to_string(), d.to_string());
            } else {
                digests.remove(key);
            }
        }
        '?' => {
            if let Some(d) = digest {
                pending.insert(key.to_string(), d.to_string());
            }
        }
        '-' => {
            confirmed.remove(key);
            pending.remove(key);
            digests.remove(key);
        }
        _ => {}
    }
}

fn load_asset_progress(config_dir: &Path) -> AssetMigrationProgress {
    let path = config_dir.join(ASSET_PROGRESS_FILENAME);
    let Ok(raw) = fs::read(&path) else {
        return AssetMigrationProgress::default();
    };
    let text = String::from_utf8_lossy(&raw);
    let trimmed = text.trim_start();
    if trimmed.starts_with('{') {
        if let Ok(parsed) = serde_json::from_str::<AssetMigrationProgress>(trimmed) {
            return parsed;
        }
    }
    let mut progress = AssetMigrationProgress::default();
    // Replay only complete newline-terminated records so an interrupted tail
    // (e.g. `+a` without `\n`) can never be misread as a committed entry.
    if let Some(last_nl) = text.rfind('\n') {
        for line in text[..last_nl].split('\n') {
            apply_progress_log_line(&mut progress, line.trim_end_matches('\r'));
        }
    }
    progress
}

fn serialize_progress_entries(progress: &AssetMigrationProgress) -> String {
    let mut out = String::new();
    let mut models: Vec<&str> = progress.models.iter().map(String::as_str).collect();
    models.sort_unstable();
    for key in models {
        out.push_str("+m\t");
        out.push_str(key);
        out.push('\n');
    }
    let mut audio: Vec<&str> = progress.audio.iter().map(String::as_str).collect();
    audio.sort_unstable();
    for key in audio {
        out.push_str("+a\t");
        out.push_str(key);
        out.push('\n');
    }
    let mut storage: Vec<&str> = progress.storage.iter().map(String::as_str).collect();
    storage.sort_unstable();
    for key in storage {
        out.push_str("+s\t");
        out.push_str(key);
        out.push('\n');
    }
    out
}

fn first_non_ascii_whitespace_byte(file: &mut File) -> io::Result<Option<u8>> {
    file.seek(SeekFrom::Start(0))?;
    let mut buf = [0u8; 64];
    loop {
        let read = file.read(&mut buf)?;
        if read == 0 {
            return Ok(None);
        }
        if let Some(&byte) = buf[..read].iter().find(|b| !b.is_ascii_whitespace()) {
            return Ok(Some(byte));
        }
    }
}

fn find_last_newline_end(file: &mut File, file_len: u64) -> io::Result<u64> {
    const CHUNK_SIZE: usize = 4096;
    let mut cursor = file_len;
    let mut buf = [0u8; CHUNK_SIZE];
    while cursor > 0 {
        let chunk_u64 = cursor.min(CHUNK_SIZE as u64);
        let chunk = usize::try_from(chunk_u64).unwrap_or(CHUNK_SIZE);
        cursor -= chunk_u64;
        file.seek(SeekFrom::Start(cursor))?;
        file.read_exact(&mut buf[..chunk])?;
        if let Some(pos) = buf[..chunk].iter().rposition(|&b| b == b'\n') {
            return Ok(cursor + pos as u64 + 1);
        }
    }
    Ok(0)
}

fn append_asset_progress_record_with_sync(
    config_dir: &Path,
    op: char,
    category: AssetCategory,
    encoded_key: &str,
    digest: Option<&str>,
    sync_dir: &dyn Fn(&Path) -> io::Result<()>,
) -> io::Result<bool> {
    fs::create_dir_all(config_dir)?;
    let path = config_dir.join(ASSET_PROGRESS_FILENAME);
    let created = fs::symlink_metadata(&path).is_err();
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)?;
    let file_len = file.metadata()?.len();

    // Upgrade legacy JSON snapshots atomically once to newline-terminated
    // append-only records; normal append-only logs start with `+`, `?`, or `-`
    // so only a small leading prefix is inspected.
    if file_len > 0 && first_non_ascii_whitespace_byte(&mut file)? == Some(b'{') {
        file.seek(SeekFrom::Start(0))?;
        let mut existing = Vec::new();
        file.read_to_end(&mut existing)?;
        if let Ok(legacy) = serde_json::from_slice::<AssetMigrationProgress>(&existing) {
            drop(file);
            let mut payload = serialize_progress_entries(&legacy);
            payload.push(op);
            payload.push_str(category.code());
            payload.push('\t');
            payload.push_str(encoded_key);
            if let Some(d) = digest {
                payload.push('\t');
                payload.push_str(d);
            }
            payload.push('\n');
            let tmp = config_dir.join(format!("{ASSET_PROGRESS_FILENAME}.tmp"));
            let mut tmp_file = File::create(&tmp)?;
            tmp_file.write_all(payload.as_bytes())?;
            tmp_file.sync_all()?;
            drop(tmp_file);
            fs::rename(&tmp, &path)?;
            sync_dir(config_dir)?;
            return Ok(true);
        }
    }

    // For append-only logs, inspect the last byte in O(1) and only scan
    // backward in chunks to truncate an unterminated trailing record.
    let mut valid_len = file_len;
    if file_len > 0 {
        let mut last_byte = [0u8; 1];
        file.seek(SeekFrom::Start(file_len - 1))?;
        file.read_exact(&mut last_byte)?;
        if last_byte[0] != b'\n' {
            valid_len = find_last_newline_end(&mut file, file_len)?;
            file.set_len(valid_len)?;
        }
    }
    file.seek(SeekFrom::Start(valid_len))?;
    if let Some(d) = digest {
        writeln!(file, "{op}{}\t{encoded_key}\t{d}", category.code())?;
    } else {
        writeln!(file, "{op}{}\t{encoded_key}", category.code())?;
    }
    file.sync_all()?;
    drop(file);
    if created {
        sync_dir(config_dir)?;
        return Ok(true);
    }
    Ok(false)
}

fn append_asset_progress_entry_with_sync(
    config_dir: &Path,
    op: char,
    category: AssetCategory,
    encoded_key: &str,
    sync_dir: &dyn Fn(&Path) -> io::Result<()>,
) -> io::Result<bool> {
    append_asset_progress_record_with_sync(config_dir, op, category, encoded_key, None, sync_dir)
}

#[cfg(test)]
fn append_asset_progress_entry(
    config_dir: &Path,
    op: char,
    category: AssetCategory,
    encoded_key: &str,
) -> io::Result<()> {
    append_asset_progress_entry_with_sync(
        config_dir,
        op,
        category,
        encoded_key,
        &sync_dir_best_effort,
    )?;
    Ok(())
}

fn remove_asset_progress(config_dir: &Path) {
    if fs::remove_file(config_dir.join(ASSET_PROGRESS_FILENAME)).is_ok() {
        let _ = sync_dir_best_effort(config_dir);
    }
}

fn save_manifest_with_sync<F>(
    config_dir: &Path,
    report: &VoquillMigrationReport,
    sync_dir: F,
) -> io::Result<()>
where
    F: FnOnce(&Path) -> io::Result<()>,
{
    fs::create_dir_all(config_dir)?;
    let target = config_dir.join(MANIFEST_FILENAME);
    let tmp = config_dir.join(format!("{MANIFEST_FILENAME}.tmp"));
    let payload = serde_json::to_vec_pretty(report)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;

    let mut file = File::create(&tmp)?;
    file.write_all(&payload)?;
    file.sync_all()?;
    drop(file);

    fs::rename(&tmp, &target)?;
    sync_dir(config_dir)?;
    Ok(())
}

fn save_manifest(config_dir: &Path, report: &VoquillMigrationReport) -> io::Result<()> {
    save_manifest_with_sync(config_dir, report, sync_dir_best_effort)
}

fn try_load_manifest(config_dir: &Path) -> Result<Option<VoquillMigrationReport>, String> {
    let path = config_dir.join(MANIFEST_FILENAME);
    let raw = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            log::warn!(
                "Unable to read Voquill migration manifest {}: {err}",
                path.display()
            );
            return Err(format!("Could not read Voquill migration state: {err}"));
        }
    };

    serde_json::from_slice::<VoquillMigrationReport>(&raw)
        .map(Some)
        .map_err(|err| {
            log::warn!(
                "Voquill migration manifest {} is malformed: {err}",
                path.display()
            );
            format!("Voquill migration state is malformed: {err}")
        })
}

#[cfg(test)]
fn load_manifest(config_dir: &Path) -> Option<VoquillMigrationReport> {
    try_load_manifest(config_dir).ok().flatten()
}

fn manifest_read_failed_report(dirs: &MigrationDirs, detail: String) -> VoquillMigrationReport {
    let mut report = new_startup_report(
        now_iso(),
        VoquillMigrationStatus::Partial,
        VoquillMigrationPhaseStatus::Pending,
        VoquillMigrationPhaseStatus::Pending,
        true,
    );
    report.legacy_source_preserved = legacy_source_still_present(dirs);
    report.issues.push(VoquillMigrationIssue {
        category: "database".to_string(),
        code: "manifest_read_failed".to_string(),
        detail,
    });
    rebuild_action_items(&mut report, Vec::new());
    report
}

fn remove_staging_and_markers(config_dir: &Path) -> io::Result<()> {
    let promotion_temp_filename = format!("{DB_FILENAME}{PROMOTION_TEMP_SUFFIX}");
    for filename in [
        "voquill-migration-state.json.tmp",
        PROMOTION_MARKER_FILENAME,
        ASSET_PROGRESS_FILENAME,
        promotion_temp_filename.as_str(),
    ] {
        let path = config_dir.join(filename);
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
    }

    for suffix in ["", "-wal", "-shm", "-journal"] {
        let backup = config_dir.join(format!("{DB_FILENAME}{suffix}{PRE_RETRY_BACKUP_SUFFIX}"));
        match fs::remove_file(&backup) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
    }

    let staging = config_dir.join(STAGING_DIR_NAME);
    match fs::remove_dir_all(&staging) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }

    Ok(())
}

/// Remove migration manifest and any leftover staging artifacts.
pub fn clear_migration_artifacts(config_dir: &Path) -> io::Result<()> {
    let manifest = config_dir.join(MANIFEST_FILENAME);
    match fs::remove_file(&manifest) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    remove_staging_and_markers(config_dir)
}

/// Record that an explicit local-data clear completed so untouched legacy
/// Voquill asset directories are never automatically re-imported on future
/// launches.
pub fn record_migration_cleared(config_dir: &Path) -> io::Result<()> {
    remove_staging_and_markers(config_dir)?;
    save_manifest(config_dir, &VoquillMigrationReport::not_needed())
}

fn has_any_legacy_source(dirs: &MigrationDirs) -> bool {
    if let Some(legacy_db) = dirs.legacy_db_path() {
        match fs::symlink_metadata(&legacy_db) {
            Ok(_) => return true,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return true,
        }
    }
    if let Some(legacy_data) = dirs.legacy_data_dir.as_ref() {
        for sub in [
            LEGACY_MODELS_DIR_NAME,
            MODELS_DIR_NAME,
            AUDIO_DIR_NAME,
            STORAGE_DIR_NAME,
        ] {
            if dir_has_any_entry(&legacy_data.join(sub)) {
                return true;
            }
        }
    }
    false
}

/// Returns `false` only when `dir` is definitely absent or readable and empty.
/// Unreadable directories (e.g. `PermissionDenied`) or symlinked directories
/// return `true` so startup enters the copy phase and truthfully reports the
/// error instead of silently collapsing to `NotNeeded`.
fn dir_has_any_entry(dir: &Path) -> bool {
    let meta = match fs::symlink_metadata(dir) {
        Ok(meta) => meta,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return false,
        Err(_) => return true,
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return true;
    }
    match fs::read_dir(dir) {
        Ok(mut iter) => iter.next().is_some(),
        Err(_) => true,
    }
}

fn legacy_source_still_present(dirs: &MigrationDirs) -> bool {
    has_any_legacy_source(dirs)
}

fn cleanup_staging(staging_dir: &Path) {
    if let Err(err) = fs::remove_dir_all(staging_dir) {
        if err.kind() != io::ErrorKind::NotFound {
            log::warn!(
                "Failed to remove Voquill migration staging directory {}: {err}",
                staging_dir.display()
            );
        }
    }
}

fn copy_file_strict_no_symlink(src: &Path, dst: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(src).map_err(|err| format!("unable to inspect file: {err}"))?;
    if meta.file_type().is_symlink() {
        return Err("refusing to import a symbolic link".to_string());
    }
    if !meta.is_file() {
        return Err("source path is not a regular file".to_string());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("unable to prepare staging directory: {err}"))?;
    }
    let mut src_file = File::open(src).map_err(|err| format!("failed to copy file: {err}"))?;
    let mut dst_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dst)
        .map_err(|err| format!("failed to copy file: {err}"))?;
    io::copy(&mut src_file, &mut dst_file).map_err(|err| format!("failed to copy file: {err}"))?;
    Ok(())
}

fn validate_sqlite_header(path: &Path) -> Result<(), String> {
    let mut file = File::open(path).map_err(|err| format!("unable to open database: {err}"))?;
    let mut header = [0u8; SQLITE_MIN_HEADER_BYTES];
    let bytes_read = file
        .read(&mut header)
        .map_err(|err| format!("unable to read database header: {err}"))?;
    if bytes_read < SQLITE_MIN_HEADER_BYTES || &header[..16] != SQLITE_HEADER_MAGIC {
        return Err("file is not a valid SQLite database".to_string());
    }
    Ok(())
}

async fn precheck_and_inspect_staged_db(staged_db: &Path) -> Result<Vec<String>, (String, String)> {
    validate_sqlite_header(staged_db).map_err(|detail| ("corrupt_database".to_string(), detail))?;

    let options = SqliteConnectOptions::new()
        .filename(staged_db)
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|err| {
            let code = if crate::db::open::is_integrity_failure(&err.to_string()) {
                "corrupt_database"
            } else {
                "database_open_failed"
            };
            (
                code.to_string(),
                format!("could not open staged database: {err}"),
            )
        })?;

    // Check full integrity before running any migrations.
    let integrity: Result<Vec<String>, sqlx::Error> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&pool)
        .await;
    match integrity {
        Ok(rows) if rows.len() == 1 && rows[0].eq_ignore_ascii_case("ok") => {}
        Ok(rows) => {
            pool.close().await;
            return Err((
                "corrupt_database".to_string(),
                format!(
                    "SQLite integrity check failed ({} problem(s))",
                    rows.len().max(1)
                ),
            ));
        }
        Err(err) => {
            pool.close().await;
            return Err((
                "corrupt_database".to_string(),
                format!("SQLite integrity check failed: {err}"),
            ));
        }
    }

    // Fold any copied WAL frames cleanly into the staged main database file.
    if let Err(err) = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&pool)
        .await
    {
        pool.close().await;
        return Err((
            "wal_checkpoint_failed".to_string(),
            format!("could not checkpoint staged WAL file: {err}"),
        ));
    }

    let removed_modes = inspect_legacy_removed_modes(pool.clone()).await;
    pool.close().await;
    Ok(removed_modes)
}

async fn inspect_legacy_removed_modes(pool: SqlitePool) -> Vec<String> {
    let mut found = BTreeSet::new();

    let prefs_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'user_preferences'",
    )
    .fetch_one(&pool)
    .await
    .unwrap_or(0);

    // Older Voquill schemas (versions 10-15) stored AI modes directly on
    // user_profiles before 015_user_preferences migrated them.
    let (table, checks): (&str, &[(&str, &str)]) = if prefs_exists > 0 {
        (
            "user_preferences",
            &[
                ("transcription_mode", "transcription:cloud"),
                ("post_processing_mode", "post_processing:cloud"),
                ("agent_mode", "agent:cloud"),
            ],
        )
    } else {
        (
            "user_profiles",
            &[
                ("preferred_transcription_mode", "transcription:cloud"),
                ("preferred_post_processing_mode", "post_processing:cloud"),
            ],
        )
    };

    let pragma_query = format!("SELECT name FROM pragma_table_info('{table}')");
    let columns: BTreeSet<String> = sqlx::query(&pragma_query)
        .fetch_all(&pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>("name").ok())
        .collect();

    for &(column, label) in checks {
        if columns.contains(column) {
            let query = format!(
                "SELECT DISTINCT lower(trim({column})) FROM {table} WHERE {column} IS NOT NULL"
            );
            let modes: Vec<String> = sqlx::query_scalar(&query)
                .fetch_all(&pool)
                .await
                .unwrap_or_default();
            if modes.iter().any(|mode| mode == "cloud") {
                found.insert(label.to_string());
            }
        }
    }

    found.into_iter().collect()
}

struct DatabaseAudit {
    counts: VoquillMigrationCounts,
    attention_providers: Vec<String>,
}

async fn audit_migrated_database(pool: SqlitePool) -> Result<DatabaseAudit, String> {
    let profile_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_profiles")
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("failed to count user profiles: {err}"))?;
    let prefs_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_preferences")
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("failed to count user preferences: {err}"))?;
    let transcriptions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcriptions")
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("failed to count transcriptions: {err}"))?;
    let dictionary_terms: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM terms")
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("failed to count dictionary terms: {err}"))?;
    let hotkeys: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM hotkeys")
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("failed to count hotkeys: {err}"))?;
    let tones: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tones")
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("failed to count tones: {err}"))?;
    let app_targets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM app_targets")
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("failed to count app targets: {err}"))?;

    let (provider_entries, providers_needing_attention, attention_providers) =
        inspect_live_api_key_attention(pool).await?;

    Ok(DatabaseAudit {
        counts: VoquillMigrationCounts {
            has_profile: profile_count > 0,
            has_preferences: prefs_count > 0,
            transcriptions: saturating_u32(transcriptions),
            dictionary_terms: saturating_u32(dictionary_terms),
            hotkeys: saturating_u32(hotkeys),
            tones: saturating_u32(tones),
            app_targets: saturating_u32(app_targets),
            provider_entries,
            providers_needing_attention,
            local_models_migrated: 0,
            audio_files_migrated: 0,
            storage_files_migrated: 0,
        },
        attention_providers,
    })
}

async fn inspect_live_api_key_attention(
    pool: SqlitePool,
) -> Result<(u32, u32, Vec<String>), String> {
    let keys = api_key_queries::fetch_api_keys(pool)
        .await
        .map_err(|err| format!("failed to inspect stored API keys: {err}"))?;

    let total = usize_to_u32(keys.len());
    let mut attention_count: u32 = 0;
    let mut provider_labels = BTreeSet::new();

    for key in &keys {
        let inspection = inspect_api_key_credential(
            &key.provider,
            &key.salt,
            &key.key_ciphertext,
            key.base_url.as_deref(),
            key.azure_region.as_deref(),
        );
        if inspection.status != ApiKeyCredentialStatus::Usable {
            attention_count = attention_count.saturating_add(1);
            provider_labels.insert(safe_provider_display_name(&key.provider));
        }
    }

    Ok((
        total,
        attention_count,
        provider_labels.into_iter().collect(),
    ))
}

struct StagedDbSuccess {
    audit: DatabaseAudit,
    removed_modes_reset: Vec<String>,
}

async fn check_path_exists_no_follow(path: &Path) -> io::Result<bool> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err),
    }
}

async fn path_exists_no_follow(path: &Path) -> bool {
    tokio::fs::symlink_metadata(path).await.is_ok()
}

async fn stage_validate_and_promote_database_with_sync<FP>(
    dirs: &MigrationDirs,
    promote_sync_dir: FP,
) -> Result<StagedDbSuccess, PromoteError>
where
    FP: FnOnce(&Path) -> io::Result<()> + Send + 'static,
{
    let staging_dir = dirs.staging_dir();
    let (staged_db, staged) = stage_validate_in_staging_only(dirs)
        .await
        .map_err(PromoteError::NotInstalled)?;

    let current_db = dirs.current_db_path();
    if path_exists_no_follow(&current_db).await {
        cleanup_staging(&staging_dir);
        return Err(PromoteError::NotInstalled(existing_profile_conflict_issue()));
    }

    if let Some(parent) = current_db.parent() {
        if let Err(err) = tokio::fs::create_dir_all(parent).await {
            cleanup_staging(&staging_dir);
            return Err(PromoteError::NotInstalled(VoquillMigrationIssue {
                category: "database".to_string(),
                code: "promote_io_error".to_string(),
                detail: format!("Could not prepare mausVoice config directory: {err}"),
            }));
        }
    }

    let marker_path = dirs.promotion_marker_path();
    let staged_for_hash = staged_db.clone();
    let (staged_sha256, staged_payload_sha256) =
        tokio::task::spawn_blocking(move || hash_staged_database(&staged_for_hash))
            .await
            .map_err(|err| {
                PromoteError::NotInstalled(VoquillMigrationIssue {
                    category: "database".to_string(),
                    code: "promote_io_error".to_string(),
                    detail: format!("Could not hash staged database before promotion: {err}"),
                })
            })?
            .map_err(|err| {
                cleanup_staging(&staging_dir);
                PromoteError::NotInstalled(VoquillMigrationIssue {
                    category: "database".to_string(),
                    code: "promote_io_error".to_string(),
                    detail: format!("Could not hash staged database before promotion: {err}"),
                })
            })?;

    let marker_for_write = marker_path.clone();
    let marker_modes = staged.removed_modes_reset.clone();
    let write_marker_result = tokio::task::spawn_blocking(move || {
        write_promotion_marker(
            &marker_for_write,
            "startup",
            staged_sha256,
            staged_payload_sha256,
            marker_modes,
        )
    })
    .await
    .map_err(|err| {
        PromoteError::NotInstalled(VoquillMigrationIssue {
            category: "database".to_string(),
            code: "promote_io_error".to_string(),
            detail: format!("Could not record promotion recovery marker: {err}"),
        })
    })?;
    if let Err(err) = write_marker_result {
        if err.was_published() {
            let _ = retire_promotion_marker_async(&marker_path).await;
        }
        cleanup_staging(&staging_dir);
        return Err(PromoteError::NotInstalled(VoquillMigrationIssue {
            category: "database".to_string(),
            code: "promote_io_error".to_string(),
            detail: format!("Could not record promotion recovery marker: {err}"),
        }));
    }

    let staged_for_promote = staged_db.clone();
    let current_for_promote = current_db.clone();
    let promote_result = tokio::task::spawn_blocking(move || {
        promote_staged_file_with_sync(&staged_for_promote, &current_for_promote, promote_sync_dir)
    })
    .await
    .map_err(|err| {
        PromoteError::NotInstalled(VoquillMigrationIssue {
            category: "database".to_string(),
            code: "promote_io_error".to_string(),
            detail: format!("Database promotion task failed: {err}"),
        })
    })?;

    match promote_result {
        Ok(()) => {
            cleanup_staging(&staging_dir);
            Ok(staged)
        }
        Err(PromoteError::NotInstalled(issue)) => {
            let _ = retire_promotion_marker_async(&marker_path).await;
            cleanup_staging(&staging_dir);
            Err(PromoteError::NotInstalled(issue))
        }
        Err(PromoteError::InstalledButNotSynced(issue)) => {
            // Keep the promotion marker on disk so startup fails closed until
            // recovery verifies, directory-syncs, and checkpoints the DB.
            cleanup_staging(&staging_dir);
            Err(PromoteError::InstalledButNotSynced(issue))
        }
    }
}

#[cfg(test)]
async fn stage_validate_and_promote_database(
    dirs: &MigrationDirs,
) -> Result<StagedDbSuccess, PromoteError> {
    stage_validate_and_promote_database_with_sync(dirs, sync_dir_best_effort).await
}

fn is_partial_download_name(name: &std::ffi::OsStr) -> bool {
    let lower = name.to_string_lossy().to_ascii_lowercase();
    lower.ends_with(".tmp")
        || lower.ends_with(".part")
        || lower.ends_with(".download")
        || lower.ends_with(".crdownload")
}

#[derive(Default)]
struct AssetCopyOutcome {
    copied: u32,
    previously_migrated: u32,
    skipped_existing: u32,
    failed: u32,
    source_present: bool,
    first_error: Option<String>,
}

impl AssetCopyOutcome {
    fn record_failure(&mut self, detail: impl Into<String>) {
        self.source_present = true;
        self.failed = self.failed.saturating_add(1);
        if self.first_error.is_none() {
            self.first_error = Some(detail.into());
        }
    }

    fn migrated_total(&self) -> u32 {
        self.copied.saturating_add(self.previously_migrated)
    }

    fn phase_status(&self) -> VoquillMigrationPhaseStatus {
        if !self.source_present && self.previously_migrated == 0 {
            return VoquillMigrationPhaseStatus::NotFound;
        }
        let any_present =
            self.copied > 0 || self.previously_migrated > 0 || self.skipped_existing > 0;
        if self.failed == 0 {
            if any_present {
                VoquillMigrationPhaseStatus::Migrated
            } else {
                VoquillMigrationPhaseStatus::NotFound
            }
        } else if any_present {
            VoquillMigrationPhaseStatus::Partial
        } else {
            VoquillMigrationPhaseStatus::Failed
        }
    }
}

pub const ASSET_COPY_TEMP_PREFIX: &str = ".voquill-asset-tmp-";

/// Removes orphaned `.voquill-asset-tmp-*` staging directories left behind in
/// `data_dir` by an interrupted Voquill asset migration. Never follows symlinks
/// and never touches any directory or file without the exact temp prefix.
pub fn sweep_orphaned_asset_copy_temp_dirs(data_dir: &Path) -> Result<(), String> {
    sweep_orphaned_asset_copy_temp_dirs_with_sync(data_dir, sync_dir_best_effort)
}

fn sweep_orphaned_asset_copy_temp_dirs_with_sync<F>(
    data_dir: &Path,
    sync_dir: F,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> io::Result<()>,
{
    let meta = match fs::symlink_metadata(data_dir) {
        Ok(meta) => meta,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(format!(
                "Failed to inspect data directory for orphaned migration temp dirs: {err}"
            ));
        }
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(
            "Refusing to sweep migration temp directories: data directory is not a regular directory"
                .to_string(),
        );
    }

    let dir = cap_std::fs::Dir::open_ambient_dir(data_dir, cap_std::ambient_authority())
        .map_err(|err| format!("Failed to open data directory for migration temp sweep: {err}"))?;
    let entries = dir
        .entries()
        .map_err(|err| format!("Failed to list data directory for migration temp sweep: {err}"))?;

    let mut errors = Vec::new();
    for entry_res in entries {
        let entry = match entry_res {
            Ok(entry) => entry,
            Err(err) => {
                errors.push(format!("read entry: {err}"));
                continue;
            }
        };
        let file_name = entry.file_name();
        if !file_name
            .as_encoded_bytes()
            .starts_with(ASSET_COPY_TEMP_PREFIX.as_bytes())
        {
            continue;
        }
        let entry_meta = match dir.symlink_metadata(&file_name) {
            Ok(meta) => meta,
            Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
            Err(err) => {
                errors.push(format!("stat {}: {err}", file_name.to_string_lossy()));
                continue;
            }
        };
        if entry_meta.is_symlink() || !entry_meta.is_dir() {
            continue;
        }
        match dir.remove_dir_all(&file_name) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => errors.push(format!("remove {}: {err}", file_name.to_string_lossy())),
        }
    }

    let sync_result = sync_dir(data_dir);

    if !errors.is_empty() {
        if let Err(err) = sync_result {
            errors.push(format!("sync data directory: {err}"));
        }
        return Err(format!(
            "Failed to remove orphaned migration temp directories: {}",
            errors.join("; ")
        ));
    }

    sync_result.map_err(|err| {
        format!("Failed to sync data directory after migration temp sweep: {err}")
    })?;

    Ok(())
}

struct AssetCopyTempDir(PathBuf);

impl AssetCopyTempDir {
    fn create_near(dst_root: &Path) -> io::Result<Self> {
        let base_parent = dst_root.parent().unwrap_or(dst_root);
        fs::create_dir_all(base_parent)?;
        let seq = ASSET_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = base_parent.join(format!(
            "{ASSET_COPY_TEMP_PREFIX}{}-{seq}",
            std::process::id()
        ));
        fs::create_dir(&dir)?;
        Ok(Self(dir))
    }

    fn create_exclusive_file(&self) -> io::Result<(PathBuf, File)> {
        let seq = ASSET_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = self.0.join(format!("copy-{seq}.tmp"));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        Ok((path, file))
    }
}

impl Drop for AssetCopyTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone, Copy)]
enum AssetCategory {
    Models,
    Audio,
    Storage,
}

impl AssetCategory {
    fn code(self) -> &'static str {
        match self {
            Self::Models => "m",
            Self::Audio => "a",
            Self::Storage => "s",
        }
    }

    fn paths(self, progress: &AssetMigrationProgress) -> &HashSet<String> {
        match self {
            Self::Models => &progress.models,
            Self::Audio => &progress.audio,
            Self::Storage => &progress.storage,
        }
    }

    fn paths_mut(self, progress: &mut AssetMigrationProgress) -> &mut HashSet<String> {
        match self {
            Self::Models => &mut progress.models,
            Self::Audio => &mut progress.audio,
            Self::Storage => &mut progress.storage,
        }
    }

    fn pending(self, progress: &AssetMigrationProgress) -> &HashMap<String, String> {
        match self {
            Self::Models => &progress.models_pending,
            Self::Audio => &progress.audio_pending,
            Self::Storage => &progress.storage_pending,
        }
    }

    fn pending_mut(self, progress: &mut AssetMigrationProgress) -> &mut HashMap<String, String> {
        match self {
            Self::Models => &mut progress.models_pending,
            Self::Audio => &mut progress.audio_pending,
            Self::Storage => &mut progress.storage_pending,
        }
    }

    fn digests(self, progress: &AssetMigrationProgress) -> &HashMap<String, String> {
        match self {
            Self::Models => &progress.models_digests,
            Self::Audio => &progress.audio_digests,
            Self::Storage => &progress.storage_digests,
        }
    }

    fn digests_mut(self, progress: &mut AssetMigrationProgress) -> &mut HashMap<String, String> {
        match self {
            Self::Models => &mut progress.models_digests,
            Self::Audio => &mut progress.audio_digests,
            Self::Storage => &mut progress.storage_digests,
        }
    }

    fn contains(self, progress: &AssetMigrationProgress, rel_key: &str) -> bool {
        self.paths(progress).contains(rel_key)
    }
}

struct AssetCopyContext<'a> {
    dst_root: &'a Path,
    temp_dir: &'a AssetCopyTempDir,
    config_dir: &'a Path,
    category: AssetCategory,
    progress: &'a mut AssetMigrationProgress,
    seen_in_pass: &'a mut HashSet<PathBuf>,
    dirs_to_sync: &'a mut BTreeSet<PathBuf>,
    journal_dir_synced: bool,
    sync_journal_dir: &'a dyn Fn(&Path) -> io::Result<()>,
}

fn ensure_destination_ancestors_no_symlink(dst_root: &Path, dst: &Path) -> io::Result<()> {
    let rel = dst.strip_prefix(dst_root).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "destination path escapes target root",
        )
    })?;

    let mut current = dst_root.to_path_buf();
    check_ancestor_dir_component(&current)?;

    let mut components = rel.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(segment) = component else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid relative destination path component",
            ));
        };
        current.push(segment);
        if components.peek().is_some() {
            check_ancestor_dir_component(&current)?;
        }
    }
    Ok(())
}

fn check_ancestor_dir_component(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "destination ancestor directory is a symbolic link",
        )),
        Ok(meta) if !meta.is_dir() => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "destination ancestor path is not a directory",
        )),
        Ok(_) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

fn check_existing_destination(dst: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(dst) {
        Ok(meta) if !meta.file_type().is_symlink() && meta.is_file() => Ok(true),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "destination path is occupied by a non-regular file or directory",
        )),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err),
    }
}

fn ensure_parent_dirs_and_track_sync(
    dst_root: &Path,
    parent: &Path,
    dirs_to_sync: &mut BTreeSet<PathBuf>,
) -> io::Result<()> {
    let mut missing = Vec::new();
    let mut cursor = parent.to_path_buf();
    let stop_root = dst_root.parent().unwrap_or(dst_root);
    loop {
        match fs::symlink_metadata(&cursor) {
            Ok(_) => break,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                missing.push(cursor.clone());
                if cursor == stop_root {
                    break;
                }
                let Some(next) = cursor.parent() else {
                    break;
                };
                cursor = next.to_path_buf();
            }
            Err(err) => return Err(err),
        }
    }

    fs::create_dir_all(parent)?;
    if !missing.is_empty() {
        // Also sync the existing ancestor directory that received the first new
        // subdirectory entry, plus every newly created directory in the chain.
        dirs_to_sync.insert(cursor);
        for dir in missing {
            dirs_to_sync.insert(dir);
        }
    }
    dirs_to_sync.insert(parent.to_path_buf());
    Ok(())
}

/// Publishes an already-copied, fsynced temporary file at `dst` without ever
/// overwriting an existing entry at `dst`.
///
/// Uses `fs::hard_link(&tmp_dst, dst)` (which fails atomically with
/// `AlreadyExists` if `dst` appeared concurrently) followed by unlinking
/// `tmp_dst`, keeping `dst` an independent file (`nlink == 1`) with no link to
/// the legacy source. Falls back to `create_new(true)` copy on filesystems that
/// disallow hard links.
fn publish_temp_file_no_replace(tmp_dst: &Path, dst: &Path) -> io::Result<bool> {
    match fs::hard_link(tmp_dst, dst) {
        Ok(()) => {
            let _ = fs::remove_file(tmp_dst);
            Ok(true)
        }
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            let _ = fs::remove_file(tmp_dst);
            if check_existing_destination(dst)? {
                Ok(false)
            } else {
                Err(err)
            }
        }
        Err(err)
            if matches!(
                err.kind(),
                io::ErrorKind::Unsupported
                    | io::ErrorKind::PermissionDenied
                    | io::ErrorKind::CrossesDevices
            ) =>
        {
            let mut dst_file = match OpenOptions::new().write(true).create_new(true).open(dst) {
                Ok(file) => file,
                Err(open_err) if open_err.kind() == io::ErrorKind::AlreadyExists => {
                    let _ = fs::remove_file(tmp_dst);
                    if check_existing_destination(dst)? {
                        return Ok(false);
                    }
                    return Err(open_err);
                }
                Err(open_err) => return Err(open_err),
            };
            let copy_res = (|| -> io::Result<()> {
                let mut src_tmp = File::open(tmp_dst)?;
                io::copy(&mut src_tmp, &mut dst_file)?;
                dst_file.sync_all()?;
                Ok(())
            })();
            drop(dst_file);
            if let Err(copy_err) = copy_res {
                let _ = fs::remove_file(dst);
                return Err(copy_err);
            }
            let _ = fs::remove_file(tmp_dst);
            Ok(true)
        }
        Err(err) => Err(err),
    }
}

fn copy_file_to_temp_and_hash(src: &Path, tmp_file: &mut File) -> io::Result<String> {
    let mut src_file = File::open(src)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let read = src_file.read(&mut buf)?;
        if read == 0 {
            break;
        }
        tmp_file.write_all(&buf[..read])?;
        hasher.update(&buf[..read]);
    }
    tmp_file.sync_all()?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn copy_file_non_destructive_hashed(
    src: &Path,
    dst_root: &Path,
    dst: &Path,
    temp_dir: &AssetCopyTempDir,
    dirs_to_sync: &mut BTreeSet<PathBuf>,
    mut before_publish: impl FnMut(&str) -> io::Result<()>,
) -> io::Result<Option<String>> {
    ensure_destination_ancestors_no_symlink(dst_root, dst)?;
    if check_existing_destination(dst)? {
        return Ok(None);
    }
    if let Some(parent) = dst.parent() {
        ensure_parent_dirs_and_track_sync(dst_root, parent, dirs_to_sync)?;
    }

    // Always copy legacy bytes into an exclusively created temp file outside
    // the destination filename namespace so legacy files are never hard-linked
    // or mutated, then publish at `dst` without replacing any existing file.
    let (tmp_dst, mut tmp_file) = temp_dir.create_exclusive_file()?;
    let copy_result = (|| -> io::Result<Option<String>> {
        let staged_sha256 = copy_file_to_temp_and_hash(src, &mut tmp_file)?;
        drop(tmp_file);

        ensure_destination_ancestors_no_symlink(dst_root, dst)?;
        if check_existing_destination(dst)? {
            let _ = fs::remove_file(&tmp_dst);
            return Ok(None);
        }
        // Durably record intent + content digest BEFORE publishing `dst` so a
        // crash right after link/publish can verify ownership without ever
        // attributing an unrelated concurrent file to this migration.
        before_publish(&staged_sha256)?;
        if publish_temp_file_no_replace(&tmp_dst, dst)? {
            Ok(Some(staged_sha256))
        } else {
            Ok(None)
        }
    })();

    if copy_result.is_err() {
        let _ = fs::remove_file(&tmp_dst);
    }

    copy_result
}

#[cfg(test)]
fn copy_file_non_destructive(
    src: &Path,
    dst_root: &Path,
    dst: &Path,
    temp_dir: &AssetCopyTempDir,
    dirs_to_sync: &mut BTreeSet<PathBuf>,
    mut before_publish: impl FnMut() -> io::Result<()>,
) -> io::Result<bool> {
    copy_file_non_destructive_hashed(src, dst_root, dst, temp_dir, dirs_to_sync, |_| {
        before_publish()
    })
    .map(|published| published.is_some())
}

#[cfg(not(windows))]
fn encode_bytes_lossless(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    for &byte in bytes {
        let safe_ascii = byte.is_ascii_graphic() && !matches!(byte, b'%' | b'/' | b'\\');
        if safe_ascii || byte == b' ' {
            out.push(byte as char);
        } else {
            let _ = write!(&mut out, "%{byte:02x}");
        }
    }
    out
}

fn encode_component_lossless(component: &std::ffi::OsStr) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        encode_bytes_lossless(component.as_bytes())
    }

    #[cfg(windows)]
    {
        use std::fmt::Write as _;
        use std::os::windows::ffi::OsStrExt;
        let mut out = String::new();
        for unit in component.encode_wide() {
            if unit < 0x80 {
                let byte = unit as u8;
                let safe_ascii = byte.is_ascii_graphic() && !matches!(byte, b'%' | b'/' | b'\\');
                if safe_ascii || byte == b' ' {
                    out.push(byte as char);
                    continue;
                }
            }
            let _ = write!(&mut out, "%u{unit:04x}");
        }
        out
    }

    #[cfg(not(any(unix, windows)))]
    {
        encode_bytes_lossless(component.to_string_lossy().as_bytes())
    }
}

fn relative_asset_key(dst_root: &Path, dst: &Path) -> String {
    dst.strip_prefix(dst_root)
        .unwrap_or(dst)
        .components()
        .map(|c| encode_component_lossless(c.as_os_str()))
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(not(windows))]
fn decode_bytes_lossless(encoded: &str) -> Option<Vec<u8>> {
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            let value = u8::from_str_radix(hex, 16).ok()?;
            out.push(value);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    Some(out)
}

fn decode_component_lossless(encoded: &str) -> Option<std::ffi::OsString> {
    if encoded.is_empty() {
        return None;
    }

    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        let bytes = decode_bytes_lossless(encoded)?;
        if bytes.is_empty()
            || bytes == b"."
            || bytes == b".."
            || bytes.iter().any(|&b| matches!(b, b'/' | b'\\' | 0))
        {
            return None;
        }
        Some(std::ffi::OsString::from_vec(bytes))
    }

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStringExt;
        let bytes = encoded.as_bytes();
        let mut units = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' {
                if i + 5 >= bytes.len() || bytes[i + 1] != b'u' {
                    return None;
                }
                let hex = std::str::from_utf8(&bytes[i + 2..i + 6]).ok()?;
                let unit = u16::from_str_radix(hex, 16).ok()?;
                units.push(unit);
                i += 6;
            } else {
                units.push(u16::from(bytes[i]));
                i += 1;
            }
        }
        if units.is_empty()
            || units == [u16::from(b'.')]
            || units == [u16::from(b'.'), u16::from(b'.')]
            || units
                .iter()
                .any(|&u| u == u16::from(b'/') || u == u16::from(b'\\') || u == 0)
        {
            return None;
        }
        Some(std::ffi::OsString::from_wide(&units))
    }

    #[cfg(not(any(unix, windows)))]
    {
        let bytes = decode_bytes_lossless(encoded)?;
        let decoded = String::from_utf8(bytes).ok()?;
        if decoded.is_empty()
            || decoded == "."
            || decoded == ".."
            || decoded.contains(['/', '\\', '\0'])
        {
            return None;
        }
        Some(std::ffi::OsString::from(decoded))
    }
}

fn decode_relative_asset_key(rel_key: &str) -> Option<PathBuf> {
    if rel_key.is_empty() {
        return None;
    }
    let mut path = PathBuf::new();
    for segment in rel_key.split('/') {
        path.push(decode_component_lossless(segment)?);
    }
    let mut has_component = false;
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return None;
        }
        has_component = true;
    }
    has_component.then_some(path)
}

fn ensure_journal_dir_synced_fields(
    config_dir: &Path,
    journal_dir_synced: &mut bool,
    sync_journal_dir: &dyn Fn(&Path) -> io::Result<()>,
    synced_now: bool,
) -> io::Result<()> {
    if synced_now {
        *journal_dir_synced = true;
    } else if !*journal_dir_synced {
        sync_journal_dir(config_dir)?;
        *journal_dir_synced = true;
    }
    Ok(())
}

fn ensure_journal_dir_synced(ctx: &mut AssetCopyContext<'_>, synced_now: bool) -> io::Result<()> {
    ensure_journal_dir_synced_fields(
        ctx.config_dir,
        &mut ctx.journal_dir_synced,
        ctx.sync_journal_dir,
        synced_now,
    )
}

fn confirm_asset_progress_entry(
    ctx: &mut AssetCopyContext<'_>,
    rel_key: &str,
    digest: &str,
) -> io::Result<()> {
    let dir_synced_now = append_asset_progress_record_with_sync(
        ctx.config_dir,
        '+',
        ctx.category,
        rel_key,
        Some(digest),
        ctx.sync_journal_dir,
    )?;
    ensure_journal_dir_synced(ctx, dir_synced_now)?;
    ctx.category.pending_mut(ctx.progress).remove(rel_key);
    ctx.category
        .paths_mut(ctx.progress)
        .insert(rel_key.to_string());
    ctx.category
        .digests_mut(ctx.progress)
        .insert(rel_key.to_string(), digest.to_string());
    Ok(())
}

fn revert_asset_progress_entry(ctx: &mut AssetCopyContext<'_>, rel_key: &str) -> io::Result<()> {
    append_asset_progress_entry_with_sync(
        ctx.config_dir,
        '-',
        ctx.category,
        rel_key,
        ctx.sync_journal_dir,
    )?;
    ctx.category.paths_mut(ctx.progress).remove(rel_key);
    ctx.category.pending_mut(ctx.progress).remove(rel_key);
    ctx.category.digests_mut(ctx.progress).remove(rel_key);
    Ok(())
}

fn record_confirmed_existing_asset(
    ctx: &AssetCopyContext<'_>,
    rel_key: &str,
    dst_path: &Path,
    outcome: &mut AssetCopyOutcome,
) {
    let expected_digest = ctx.category.digests(ctx.progress).get(rel_key).cloned();
    match expected_digest {
        None => {
            outcome.previously_migrated = outcome.previously_migrated.saturating_add(1);
        }
        Some(expected) => match sha256_file_hex(dst_path) {
            Ok(actual) if actual == expected => {
                outcome.previously_migrated = outcome.previously_migrated.saturating_add(1);
            }
            Ok(_) => {
                outcome.skipped_existing = outcome.skipped_existing.saturating_add(1);
            }
            Err(err) => {
                outcome.record_failure(format!("could not verify existing migrated asset: {err}"));
            }
        },
    }
}

fn reconcile_pending_existing_asset(
    ctx: &mut AssetCopyContext<'_>,
    rel_key: &str,
    dst_path: &Path,
    expected_digest: &str,
    outcome: &mut AssetCopyOutcome,
) {
    match sha256_file_hex(dst_path) {
        Ok(actual_digest) if actual_digest == expected_digest => {
            if let Err(confirm_err) = confirm_asset_progress_entry(ctx, rel_key, &actual_digest) {
                log::warn!(
                    "Failed to confirm recovered Voquill asset entry for {rel_key}: {confirm_err}"
                );
                outcome.record_failure(format!(
                    "could not confirm recovered asset progress log: {confirm_err}"
                ));
            } else {
                outcome.previously_migrated = outcome.previously_migrated.saturating_add(1);
            }
        }
        Ok(_) => {
            if let Err(revert_err) = revert_asset_progress_entry(ctx, rel_key) {
                log::warn!(
                    "Failed to revert unmatched Voquill asset intent for {rel_key}: {revert_err}"
                );
                outcome
                    .record_failure(format!("could not revert asset progress log: {revert_err}"));
            }
            outcome.skipped_existing = outcome.skipped_existing.saturating_add(1);
        }
        Err(err) => {
            outcome.record_failure(format!(
                "could not verify existing destination asset: {err}"
            ));
        }
    }
}

fn copy_regular_asset_file(
    src_path: &Path,
    dst_path: &Path,
    ctx: &mut AssetCopyContext<'_>,
    outcome: &mut AssetCopyOutcome,
) {
    let rel_path = dst_path
        .strip_prefix(ctx.dst_root)
        .unwrap_or(dst_path)
        .to_path_buf();
    if !ctx.seen_in_pass.insert(rel_path) {
        return;
    }
    let rel_key = relative_asset_key(ctx.dst_root, dst_path);
    let was_already_confirmed = ctx.category.contains(ctx.progress, &rel_key);
    let prior_pending_digest = ctx.category.pending(ctx.progress).get(&rel_key).cloned();
    let mut recorded_intent_for_publish = false;
    let config_dir = ctx.config_dir;
    let category = ctx.category;
    let progress = &mut *ctx.progress;
    let journal_dir_synced = &mut ctx.journal_dir_synced;
    let sync_journal_dir = ctx.sync_journal_dir;
    let copy_result = copy_file_non_destructive_hashed(
        src_path,
        ctx.dst_root,
        dst_path,
        ctx.temp_dir,
        ctx.dirs_to_sync,
        |staged_sha256| {
            let mut dir_synced_now = false;
            let same_intent_already_recorded =
                prior_pending_digest.as_deref() == Some(staged_sha256);
            if !was_already_confirmed && !same_intent_already_recorded {
                dir_synced_now = append_asset_progress_record_with_sync(
                    config_dir,
                    '?',
                    category,
                    &rel_key,
                    Some(staged_sha256),
                    sync_journal_dir,
                )?;
                category
                    .pending_mut(progress)
                    .insert(rel_key.clone(), staged_sha256.to_string());
                recorded_intent_for_publish = true;
            }
            // Ensure the journal's directory entry is durable in `config_dir`
            // before any asset publication that relies on a newly appended or
            // replayed journal record (e.g. after a prior attempt created the
            // journal file and failed on dir sync).
            ensure_journal_dir_synced_fields(
                config_dir,
                journal_dir_synced,
                sync_journal_dir,
                dir_synced_now,
            )?;
            Ok(())
        },
    );

    match copy_result {
        Ok(Some(published_sha256)) => {
            if let Err(confirm_err) = confirm_asset_progress_entry(ctx, &rel_key, &published_sha256)
            {
                log::warn!(
                    "Failed to confirm Voquill asset progress entry for {rel_key}: {confirm_err}"
                );
                outcome.record_failure(format!(
                    "could not confirm asset progress log: {confirm_err}"
                ));
            } else {
                outcome.copied = outcome.copied.saturating_add(1);
            }
        }
        Ok(None) if was_already_confirmed => {
            record_confirmed_existing_asset(ctx, &rel_key, dst_path, outcome);
        }
        Ok(None) if recorded_intent_for_publish => {
            if let Err(revert_err) = revert_asset_progress_entry(ctx, &rel_key) {
                log::warn!(
                    "Failed to revert Voquill asset progress entry for {rel_key}: {revert_err}"
                );
                outcome
                    .record_failure(format!("could not revert asset progress log: {revert_err}"));
            }
            outcome.skipped_existing = outcome.skipped_existing.saturating_add(1);
        }
        Ok(None) => {
            if let Some(expected_digest) = prior_pending_digest {
                reconcile_pending_existing_asset(
                    ctx,
                    &rel_key,
                    dst_path,
                    &expected_digest,
                    outcome,
                );
            } else {
                outcome.skipped_existing = outcome.skipped_existing.saturating_add(1);
            }
        }
        Err(err) => {
            if recorded_intent_for_publish {
                if let Err(revert_err) = revert_asset_progress_entry(ctx, &rel_key) {
                    log::warn!(
                        "Failed to revert Voquill asset progress entry for {rel_key}: {revert_err}"
                    );
                }
            }
            outcome.record_failure(format!("could not copy file: {err}"));
        }
    }
}

fn copy_directory_entry(
    entry: fs::DirEntry,
    dst_dir: &Path,
    skip_partial_downloads: bool,
    ctx: &mut AssetCopyContext<'_>,
    outcome: &mut AssetCopyOutcome,
) {
    let name = entry.file_name();
    if skip_partial_downloads && is_partial_download_name(&name) {
        return;
    }

    let src_path = entry.path();
    let dst_path = dst_dir.join(&name);

    let entry_meta = match fs::symlink_metadata(&src_path) {
        Ok(meta) => meta,
        Err(err) => {
            outcome.record_failure(format!("could not inspect entry: {err}"));
            return;
        }
    };

    if entry_meta.file_type().is_symlink() {
        outcome.record_failure("skipped symbolic link in legacy directory");
        return;
    }

    if entry_meta.is_dir() {
        if let Err(err) = ensure_destination_ancestors_no_symlink(ctx.dst_root, &dst_path)
            .and_then(|()| check_ancestor_dir_component(&dst_path))
        {
            outcome.record_failure(format!("destination directory blocked: {err}"));
            return;
        }
        copy_directory_tree_non_destructive(
            &src_path,
            &dst_path,
            skip_partial_downloads,
            ctx,
            outcome,
        );
        return;
    }

    if !entry_meta.is_file() || (skip_partial_downloads && entry_meta.len() == 0) {
        return;
    }

    outcome.source_present = true;
    copy_regular_asset_file(&src_path, &dst_path, ctx, outcome);
}

fn copy_directory_tree_non_destructive(
    src_dir: &Path,
    dst_dir: &Path,
    skip_partial_downloads: bool,
    ctx: &mut AssetCopyContext<'_>,
    outcome: &mut AssetCopyOutcome,
) {
    let meta = match fs::symlink_metadata(src_dir) {
        Ok(meta) => meta,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return,
        Err(err) => {
            outcome.record_failure(format!("could not inspect directory: {err}"));
            return;
        }
    };

    if meta.file_type().is_symlink() || !meta.is_dir() {
        outcome.record_failure("refused symbolic link or non-directory source");
        return;
    }

    let entries = match fs::read_dir(src_dir) {
        Ok(entries) => entries,
        Err(err) => {
            outcome.record_failure(format!("could not read directory: {err}"));
            return;
        }
    };

    for entry_result in entries {
        match entry_result {
            Ok(entry) => {
                copy_directory_entry(entry, dst_dir, skip_partial_downloads, ctx, outcome);
            }
            Err(err) => outcome.record_failure(format!("could not read directory entry: {err}")),
        }
    }
}

fn run_asset_category(
    dirs: &MigrationDirs,
    sources: &[PathBuf],
    dst_root: &Path,
    skip_partial_downloads: bool,
    category: AssetCategory,
    progress: &mut AssetMigrationProgress,
) -> AssetCopyOutcome {
    run_asset_category_with_journal_sync(
        dirs,
        sources,
        dst_root,
        skip_partial_downloads,
        category,
        progress,
        &sync_dir_best_effort,
    )
}

fn reconcile_recorded_publications(ctx: &mut AssetCopyContext<'_>, outcome: &mut AssetCopyOutcome) {
    let confirmed_keys: Vec<String> = ctx.category.paths(ctx.progress).iter().cloned().collect();
    for rel_key in confirmed_keys {
        let Some(rel_path) = decode_relative_asset_key(&rel_key) else {
            continue;
        };
        if ctx.seen_in_pass.contains(&rel_path) {
            continue;
        }
        let dst_path = ctx.dst_root.join(&rel_path);
        let exists = ensure_destination_ancestors_no_symlink(ctx.dst_root, &dst_path)
            .and_then(|()| check_existing_destination(&dst_path));
        let Ok(true) = exists else {
            continue;
        };
        let expected_digest = ctx.category.digests(ctx.progress).get(&rel_key).cloned();
        match expected_digest {
            None => {
                outcome.previously_migrated = outcome.previously_migrated.saturating_add(1);
            }
            Some(expected) => match sha256_file_hex(&dst_path) {
                Ok(actual) if actual == expected => {
                    outcome.previously_migrated = outcome.previously_migrated.saturating_add(1);
                }
                Ok(_) => {}
                Err(err) => {
                    outcome.record_failure(format!(
                        "could not verify previously migrated asset: {err}"
                    ));
                }
            },
        }
    }

    let pending_entries: Vec<(String, String)> = ctx
        .category
        .pending(ctx.progress)
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    for (rel_key, expected_digest) in pending_entries {
        let Some(rel_path) = decode_relative_asset_key(&rel_key) else {
            continue;
        };
        if ctx.seen_in_pass.contains(&rel_path) {
            continue;
        }
        let dst_path = ctx.dst_root.join(&rel_path);
        let exists = ensure_destination_ancestors_no_symlink(ctx.dst_root, &dst_path)
            .and_then(|()| check_existing_destination(&dst_path));
        match exists {
            Ok(true) => match sha256_file_hex(&dst_path) {
                Ok(actual_digest) if actual_digest == expected_digest => {
                    if let Err(confirm_err) =
                        confirm_asset_progress_entry(ctx, &rel_key, &actual_digest)
                    {
                        log::warn!(
                            "Failed to confirm recovered Voquill asset entry for {rel_key}: {confirm_err}"
                        );
                        outcome.record_failure(format!(
                            "could not confirm recovered asset progress log: {confirm_err}"
                        ));
                    } else {
                        outcome.previously_migrated = outcome.previously_migrated.saturating_add(1);
                    }
                }
                Ok(_) => {
                    if let Err(revert_err) = revert_asset_progress_entry(ctx, &rel_key) {
                        log::warn!(
                            "Failed to revert unmatched Voquill asset intent for {rel_key}: {revert_err}"
                        );
                        outcome.record_failure(format!(
                            "could not revert asset progress log: {revert_err}"
                        ));
                    }
                }
                Err(err) => {
                    outcome.record_failure(format!(
                        "could not verify existing destination asset: {err}"
                    ));
                }
            },
            Ok(false) => {
                if let Err(revert_err) = revert_asset_progress_entry(ctx, &rel_key) {
                    log::warn!(
                        "Failed to revert unpublished Voquill asset intent for {rel_key}: {revert_err}"
                    );
                }
            }
            Err(_) => {}
        }
    }
}

fn run_asset_category_with_journal_sync(
    dirs: &MigrationDirs,
    sources: &[PathBuf],
    dst_root: &Path,
    skip_partial_downloads: bool,
    category: AssetCategory,
    progress: &mut AssetMigrationProgress,
    sync_journal_dir: &dyn Fn(&Path) -> io::Result<()>,
) -> AssetCopyOutcome {
    let mut outcome = AssetCopyOutcome::default();
    if sources.is_empty()
        && category.paths(progress).is_empty()
        && category.pending(progress).is_empty()
    {
        return outcome;
    }
    let temp_dir = match AssetCopyTempDir::create_near(dst_root) {
        Ok(dir) => dir,
        Err(err) => {
            outcome.record_failure(format!("could not prepare temporary copy directory: {err}"));
            return outcome;
        }
    };
    let mut seen_in_pass = HashSet::new();
    let mut dirs_to_sync = BTreeSet::new();
    let mut ctx = AssetCopyContext {
        dst_root,
        temp_dir: &temp_dir,
        config_dir: &dirs.current_config_dir,
        category,
        progress,
        seen_in_pass: &mut seen_in_pass,
        dirs_to_sync: &mut dirs_to_sync,
        journal_dir_synced: false,
        sync_journal_dir,
    };
    for src_dir in sources {
        copy_directory_tree_non_destructive(
            src_dir,
            dst_root,
            skip_partial_downloads,
            &mut ctx,
            &mut outcome,
        );
    }
    reconcile_recorded_publications(&mut ctx, &mut outcome);
    for dir in &dirs_to_sync {
        if let Err(err) = sync_dir_best_effort(dir) {
            outcome.record_failure(format!("could not sync destination directory: {err}"));
        }
    }
    outcome
}

fn phase_needs_asset_copy(phase: VoquillMigrationPhaseStatus) -> bool {
    matches!(
        phase,
        VoquillMigrationPhaseStatus::Pending
            | VoquillMigrationPhaseStatus::Partial
            | VoquillMigrationPhaseStatus::Failed
    )
}

fn push_asset_copy_issue(
    report: &mut VoquillMigrationReport,
    category: &str,
    label: &str,
    verb: &str,
    outcome: &AssetCopyOutcome,
) {
    if outcome.failed == 0 {
        return;
    }
    report.issues.push(VoquillMigrationIssue {
        category: category.to_string(),
        code: "partial_asset_copy".to_string(),
        detail: format!(
            "{} {label} could not be {verb} ({}).",
            outcome.failed,
            outcome.first_error.as_deref().unwrap_or("filesystem error")
        ),
    });
}

fn migrate_asset_phases(dirs: &MigrationDirs, report: &mut VoquillMigrationReport) {
    // Keep database issues intact while refreshing asset issues for this run.
    report
        .issues
        .retain(|issue| !matches!(issue.category.as_str(), "models" | "audio" | "storage"));

    let mut progress = load_asset_progress(&dirs.current_config_dir);

    if phase_needs_asset_copy(report.models_phase) {
        let target_models_dir = dirs.current_data_dir.join(MODELS_DIR_NAME);
        let sources: Vec<PathBuf> = dirs
            .legacy_data_dir
            .as_ref()
            .map(|legacy_data| {
                vec![
                    legacy_data.join(MODELS_DIR_NAME),
                    legacy_data.join(LEGACY_MODELS_DIR_NAME),
                ]
            })
            .unwrap_or_default();
        let outcome = run_asset_category(
            dirs,
            &sources,
            &target_models_dir,
            true,
            AssetCategory::Models,
            &mut progress,
        );
        report.models_phase = outcome.phase_status();
        report.counts.local_models_migrated = outcome.migrated_total();
        push_asset_copy_issue(
            report,
            "models",
            "local model file(s)",
            "imported",
            &outcome,
        );
    }

    if phase_needs_asset_copy(report.audio_phase) {
        let target_audio_dir = dirs.current_data_dir.join(AUDIO_DIR_NAME);
        let sources: Vec<PathBuf> = dirs
            .legacy_data_dir
            .as_ref()
            .map(|legacy_data| vec![legacy_data.join(AUDIO_DIR_NAME)])
            .unwrap_or_default();
        let outcome = run_asset_category(
            dirs,
            &sources,
            &target_audio_dir,
            false,
            AssetCategory::Audio,
            &mut progress,
        );
        report.audio_phase = outcome.phase_status();
        report.counts.audio_files_migrated = outcome.migrated_total();
        push_asset_copy_issue(report, "audio", "audio recording(s)", "copied", &outcome);
    }

    if phase_needs_asset_copy(report.storage_phase) {
        let target_storage_dir = dirs.current_data_dir.join(STORAGE_DIR_NAME);
        let sources: Vec<PathBuf> = dirs
            .legacy_data_dir
            .as_ref()
            .map(|legacy_data| vec![legacy_data.join(STORAGE_DIR_NAME)])
            .unwrap_or_default();
        let outcome = run_asset_category(
            dirs,
            &sources,
            &target_storage_dir,
            false,
            AssetCategory::Storage,
            &mut progress,
        );
        report.storage_phase = outcome.phase_status();
        report.counts.storage_files_migrated = outcome.migrated_total();
        push_asset_copy_issue(
            report,
            "storage",
            "app icon or storage file(s)",
            "copied",
            &outcome,
        );
    }
}

/// Removes the temporary per-file asset migration journal ONLY after the caller
/// has durably saved the migration manifest and no asset phases remain pending.
fn remove_asset_progress_if_settled(config_dir: &Path, report: &VoquillMigrationReport) {
    let all_asset_phases_settled = ![
        report.models_phase,
        report.audio_phase,
        report.storage_phase,
    ]
    .into_iter()
    .any(phase_needs_asset_copy);
    if all_asset_phases_settled {
        remove_asset_progress(config_dir);
    }
}

fn finalize_status_and_actions(
    report: &mut VoquillMigrationReport,
    attention_providers: Vec<String>,
) {
    let any_asset_failed = [
        report.models_phase,
        report.audio_phase,
        report.storage_phase,
    ]
    .into_iter()
    .any(|phase| {
        matches!(
            phase,
            VoquillMigrationPhaseStatus::Partial | VoquillMigrationPhaseStatus::Failed
        )
    });

    match report.database_phase {
        VoquillMigrationPhaseStatus::Failed => {
            report.status = VoquillMigrationStatus::Failed;
            report.can_retry = true;
            report.completed_at = None;
        }
        VoquillMigrationPhaseStatus::Skipped => {
            report.status = VoquillMigrationStatus::SkippedExistingProfile;
            report.can_retry = false;
        }
        VoquillMigrationPhaseStatus::Migrated => {
            if any_asset_failed {
                report.status = VoquillMigrationStatus::Partial;
                report.can_retry = true;
            } else {
                report.status = VoquillMigrationStatus::Completed;
                report.can_retry = false;
                if report.completed_at.is_none() {
                    report.completed_at = Some(now_iso());
                }
            }
        }
        VoquillMigrationPhaseStatus::NotFound => {
            let any_asset_migrated = [
                report.models_phase,
                report.audio_phase,
                report.storage_phase,
            ]
            .into_iter()
            .any(|phase| matches!(phase, VoquillMigrationPhaseStatus::Migrated));
            if any_asset_failed {
                report.status = VoquillMigrationStatus::Partial;
                report.can_retry = true;
            } else if any_asset_migrated {
                report.status = VoquillMigrationStatus::Completed;
                report.can_retry = false;
                if report.completed_at.is_none() {
                    report.completed_at = Some(now_iso());
                }
            } else {
                report.status = VoquillMigrationStatus::NotNeeded;
                report.legacy_detected = false;
                report.can_retry = false;
            }
        }
        VoquillMigrationPhaseStatus::Pending | VoquillMigrationPhaseStatus::Partial => {
            report.status = VoquillMigrationStatus::Partial;
            report.can_retry = true;
        }
    }

    rebuild_action_items(report, attention_providers);
}

fn rebuild_action_items(report: &mut VoquillMigrationReport, attention_providers: Vec<String>) {
    let mut actions = Vec::new();

    if report.counts.providers_needing_attention > 0 {
        actions.push(VoquillMigrationActionItem {
            kind: "reenter_api_keys".to_string(),
            target_section: "ai_models".to_string(),
            count: report.counts.providers_needing_attention,
            providers: attention_providers,
        });
    }

    if !report.removed_modes_reset.is_empty() {
        actions.push(VoquillMigrationActionItem {
            kind: "review_removed_cloud_mode".to_string(),
            target_section: "ai_models".to_string(),
            count: usize_to_u32(report.removed_modes_reset.len()),
            providers: Vec::new(),
        });
    }

    if matches!(
        report.status,
        VoquillMigrationStatus::Partial | VoquillMigrationStatus::Failed
    ) && report.can_retry
    {
        actions.push(VoquillMigrationActionItem {
            kind: "retry_migration".to_string(),
            target_section: "privacy_data".to_string(),
            count: usize_to_u32(report.issues.len()).max(1),
            providers: Vec::new(),
        });
    }

    report.action_items = actions;
}

const PRE_RETRY_RESTORE_ORDER: [&str; 4] = ["-wal", "-shm", "-journal", ""];

fn has_any_pre_retry_backup(current_db: &Path) -> bool {
    PRE_RETRY_RESTORE_ORDER.iter().any(|suffix| {
        let bak =
            current_db.with_file_name(format!("{DB_FILENAME}{suffix}{PRE_RETRY_BACKUP_SUFFIX}"));
        fs::symlink_metadata(&bak).is_ok()
    })
}

fn reconcile_orphaned_pre_retry_backup(
    dirs: &MigrationDirs,
    manifest: Option<&VoquillMigrationReport>,
) -> Result<(), String> {
    let current_db = dirs.current_db_path();
    if !has_any_pre_retry_backup(&current_db) {
        return Ok(());
    }

    let swap_already_committed = manifest
        .is_some_and(|report| report.database_phase == VoquillMigrationPhaseStatus::Migrated);
    if swap_already_committed {
        if let Some(parent) = current_db.parent() {
            sync_dir_best_effort(parent).map_err(|err| {
                format!(
                    "Could not sync migrated database directory {}: {err}",
                    parent.display()
                )
            })?;
        }
        sync_dir_best_effort(&dirs.current_config_dir).map_err(|err| {
            format!(
                "Could not sync migration manifest directory {}: {err}",
                dirs.current_config_dir.display()
            )
        })?;
        remove_rollback_backup(&current_db);
        retire_promotion_marker_sync(&dirs.promotion_marker_path())
            .map_err(|err| format!("Could not retire Voquill promotion recovery marker: {err}"))?;
        return Ok(());
    }

    let main_backup = current_db.with_file_name(format!("{DB_FILENAME}{PRE_RETRY_BACKUP_SUFFIX}"));
    let has_main_backup = fs::symlink_metadata(&main_backup).is_ok();
    if fs::symlink_metadata(&current_db).is_ok() {
        if !has_main_backup {
            // Main DB was restored or present while sidecar `.pre-retry.bak`
            // files still remain un-restored: restore those sidecars before
            // allowing SQLite to open the DB without them.
            restore_rollback_backup(&current_db, &["-wal", "-shm", "-journal"]).map_err(|err| {
                format!(
                    "Could not restore pre-retry database sidecar backup for {}: {err}",
                    current_db.display()
                )
            })?;
            return Ok(());
        }
        // Never overwrite an existing `mausvoice.db` when a full pre-retry backup
        // is still on disk: either `current_db` is our already-promoted DB waiting
        // for startup marker recovery (which will remove the backup after
        // verification + manifest checkpoint), or it is an unrelated profile DB
        // that must not be deleted.
        log::warn!(
            "Found pre-retry backup at {} alongside existing {}; preserving current database for recovery check",
            main_backup.display(),
            current_db.display()
        );
        return Ok(());
    }

    log::warn!(
        "Found orphaned pre-retry database backup at {}; restoring previous mausVoice database",
        main_backup.display()
    );
    // Restore sidecars BEFORE the main database file so a sidecar restore
    // failure keeps the main backup detectable on every subsequent attempt.
    restore_rollback_backup(&current_db, &PRE_RETRY_RESTORE_ORDER).map_err(|err| {
        format!(
            "Could not restore pre-retry database backup {}: {err}",
            main_backup.display()
        )
    })?;
    let _ = retire_promotion_marker_sync(&dirs.promotion_marker_path());
    Ok(())
}

/// Guards startup `open_app_database`: fails closed when an orphaned pre-retry
/// backup still remains on disk and `mausvoice.db` is missing or missing an
/// un-restored sidecar backup, so startup can never create a fresh DB over an
/// un-restored backup or open an incomplete DB without its WAL/journal.
pub fn ensure_no_unrestored_pre_retry_backup(dirs: &MigrationDirs) -> Result<(), String> {
    let current_db = dirs.current_db_path();
    if !has_any_pre_retry_backup(&current_db) {
        return Ok(());
    }
    let main_backup = current_db.with_file_name(format!("{DB_FILENAME}{PRE_RETRY_BACKUP_SUFFIX}"));
    if fs::symlink_metadata(&current_db).is_err() || fs::symlink_metadata(&main_backup).is_err() {
        return Err(format!(
            "Pre-retry database backup for {} could not be fully restored; refusing to open an incomplete or fresh database.",
            current_db.display()
        ));
    }
    Ok(())
}

/// Guards startup `open_app_database`: fails closed when a Voquill database
/// promotion recovery marker still remains on disk. Because the marker is only
/// retired after the checkpoint manifest is durably renamed AND directory-synced,
/// any remaining marker means recovery verification or checkpoint durability is
/// not yet settled; opening `mausvoice.db` for normal use before then would
/// mutate its SQLite header/pages, invalidate the marker digest, or accept
/// writes before the manifest reaches disk.
pub fn ensure_no_pending_promotion_recovery(dirs: &MigrationDirs) -> Result<(), String> {
    let marker_path = dirs.promotion_marker_path();
    match fs::symlink_metadata(&marker_path) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!(
            "Could not inspect Voquill promotion recovery marker {}: {err}",
            marker_path.display()
        )),
        Ok(_) => Err(format!(
            "Voquill database promotion at {} is still awaiting recovery verification and durable checkpointing; refusing to open the database for normal use.",
            dirs.current_db_path().display()
        )),
    }
}

/// Guards startup `open_app_database`: fails closed if startup migration
/// detected a legacy Voquill profile (database or asset-only) while
/// `mausvoice.db` does not yet exist, but could not durably persist its initial
/// migration checkpoint. Allowing `open_app_database` to create a fresh DB
/// without a durable checkpoint would cause the next launch to classify the
/// profile as `SkippedExistingProfile` and permanently mask the legacy import.
pub fn ensure_no_uncheckpointed_initial_migration(
    dirs: &MigrationDirs,
    report: &VoquillMigrationReport,
) -> Result<(), String> {
    let has_manifest_io_failure = report.issues.iter().any(|issue| {
        matches!(
            issue.code.as_str(),
            "manifest_save_failed" | "manifest_read_failed"
        )
    });
    if !report.legacy_detected || !has_manifest_io_failure {
        return Ok(());
    }
    let current_db_absent = matches!(
        fs::symlink_metadata(dirs.current_db_path()),
        Err(err) if err.kind() == io::ErrorKind::NotFound
    );
    if !current_db_absent {
        return Ok(());
    }
    let initial_checkpoint_aborted = report.models_phase == VoquillMigrationPhaseStatus::Skipped
        && report.audio_phase == VoquillMigrationPhaseStatus::Skipped
        && report.storage_phase == VoquillMigrationPhaseStatus::Skipped;
    let persisted_manifest_blocks_fresh_db = match try_load_manifest(&dirs.current_config_dir) {
        Ok(None) => true,
        Ok(Some(manifest)) => manifest.database_phase == VoquillMigrationPhaseStatus::Pending,
        Err(_) => true,
    };
    if initial_checkpoint_aborted
        || persisted_manifest_blocks_fresh_db
        || report.database_phase == VoquillMigrationPhaseStatus::Failed
    {
        return Err(format!(
            "Could not durably persist or read the Voquill migration state in {}; refusing to create a fresh mausVoice database that would mask or conflict with the legacy Voquill profile.",
            dirs.current_config_dir.display()
        ));
    }
    Ok(())
}

fn mark_manifest_save_failure(report: &mut VoquillMigrationReport, err: &io::Error) {
    report.status = VoquillMigrationStatus::Partial;
    report.can_retry = true;
    report.completed_at = None;
    report.issues.push(VoquillMigrationIssue {
        category: "database".to_string(),
        code: "manifest_save_failed".to_string(),
        detail: format!("Could not persist Voquill migration state: {err}"),
    });
}

fn mark_existing_profile_conflict(
    config_dir: &Path,
    mut report: VoquillMigrationReport,
) -> VoquillMigrationReport {
    report.status = VoquillMigrationStatus::SkippedExistingProfile;
    report.database_phase = VoquillMigrationPhaseStatus::Skipped;
    report.models_phase = VoquillMigrationPhaseStatus::Skipped;
    report.audio_phase = VoquillMigrationPhaseStatus::Skipped;
    report.storage_phase = VoquillMigrationPhaseStatus::Skipped;
    report.issues = vec![VoquillMigrationIssue {
        category: "database".to_string(),
        code: "existing_profile_conflict".to_string(),
        detail: "An existing mausVoice profile was found, so the older Voquill profile was not imported over it.".to_string(),
    }];
    finalize_status_and_actions(&mut report, Vec::new());
    if let Err(err) = save_manifest(config_dir, &report) {
        log::warn!("Failed to persist skipped-profile migration manifest: {err}");
    }
    report
}

async fn remove_promotion_marker(marker_path: &Path) {
    let _ = retire_promotion_marker_async(marker_path).await;
}

async fn finish_startup_database_and_assets_with_hooks<FP, FM>(
    dirs: &MigrationDirs,
    mut report: VoquillMigrationReport,
    legacy_db_present: bool,
    promote_sync_dir: FP,
    manifest_sync_dir: FM,
) -> VoquillMigrationReport
where
    FP: FnOnce(&Path) -> io::Result<()> + Send + 'static,
    FM: Fn(&Path) -> io::Result<()>,
{
    let mut attention_providers = Vec::new();
    let marker_path = dirs.promotion_marker_path();

    // Persist in-progress state before staging/promoting a database OR copying
    // asset-only legacy files so crashes or manifest-save failures remain
    // observable. If the initial checkpoint cannot be durably persisted, abort
    // before touching `mausvoice.db` or copying assets so startup can fail
    // closed instead of creating a fresh DB that would mask the legacy profile.
    report.can_retry = true;
    rebuild_action_items(&mut report, Vec::new());
    if let Err(err) = save_manifest_with_sync(&dirs.current_config_dir, &report, &manifest_sync_dir)
    {
        log::warn!(
            "Failed to persist initial Voquill migration manifest; aborting startup migration: {err}"
        );
        if legacy_db_present {
            report.database_phase = VoquillMigrationPhaseStatus::Failed;
        }
        report.models_phase = VoquillMigrationPhaseStatus::Skipped;
        report.audio_phase = VoquillMigrationPhaseStatus::Skipped;
        report.storage_phase = VoquillMigrationPhaseStatus::Skipped;
        if legacy_db_present {
            report.issues.push(VoquillMigrationIssue {
                category: "database".to_string(),
                code: "manifest_save_failed".to_string(),
                detail: format!("Could not persist initial Voquill migration state: {err}"),
            });
            finalize_status_and_actions(&mut report, Vec::new());
        } else {
            mark_manifest_save_failure(&mut report, &err);
            rebuild_action_items(&mut report, Vec::new());
        }
        return report;
    }

    if legacy_db_present {
        match stage_validate_and_promote_database_with_sync(dirs, promote_sync_dir).await {
            Ok(staged) => {
                report.database_phase = VoquillMigrationPhaseStatus::Migrated;
                report.status = VoquillMigrationStatus::Partial;
                report.can_retry = true;
                report.completed_at = None;
                report.counts = staged.audit.counts;
                report.removed_modes_reset = staged.removed_modes_reset;
                attention_providers = staged.audit.attention_providers;
                clear_resolved_database_promotion_issues(&mut report);
                // Checkpoint DB completion durably before retiring the promotion
                // marker. If checkpointing or marker retirement fails, keep the
                // marker and report `Pending` so the startup guard refuses to
                // admit `mausvoice.db` for normal use until settled.
                if let Err(err) =
                    save_manifest_with_sync(&dirs.current_config_dir, &report, &manifest_sync_dir)
                {
                    log::warn!(
                        "Failed to checkpoint promoted Voquill DB manifest; keeping recovery marker: {err}"
                    );
                    report.database_phase = VoquillMigrationPhaseStatus::Pending;
                    mark_manifest_save_failure(&mut report, &err);
                    rebuild_action_items(&mut report, Vec::new());
                    return report;
                }
                if let Err(err) = retire_promotion_marker_async(&marker_path).await {
                    log::warn!("Failed to retire Voquill promotion recovery marker: {err}");
                    report.database_phase = VoquillMigrationPhaseStatus::Pending;
                    report.status = VoquillMigrationStatus::Partial;
                    report.can_retry = true;
                    report.completed_at = None;
                    report.issues.push(VoquillMigrationIssue {
                        category: "database".to_string(),
                        code: "recovery_marker_io_error".to_string(),
                        detail: format!(
                            "Could not retire Voquill promotion recovery marker: {err}"
                        ),
                    });
                    rebuild_action_items(&mut report, Vec::new());
                    return report;
                }
            }
            Err(PromoteError::InstalledButNotSynced(issue)) => {
                // `mausvoice.db` is already installed on disk, but the parent
                // directory sync failed. Keep the promotion marker and leave
                // `database_phase` as `Pending` so `ensure_no_pending_promotion_recovery`
                // blocks normal startup until recovery verifies, syncs, and
                // checkpoints the installation.
                report.database_phase = VoquillMigrationPhaseStatus::Pending;
                report.status = VoquillMigrationStatus::Partial;
                report.can_retry = true;
                report.completed_at = None;
                report.issues.push(issue);
                rebuild_action_items(&mut report, Vec::new());
                if let Err(err) =
                    save_manifest_with_sync(&dirs.current_config_dir, &report, &manifest_sync_dir)
                {
                    log::warn!("Failed to persist pending Voquill promotion manifest: {err}");
                }
                return report;
            }
            Err(PromoteError::NotInstalled(issue)) => {
                let _ = retire_promotion_marker_async(&marker_path).await;
                if issue.code == "existing_profile_conflict" {
                    return mark_existing_profile_conflict(&dirs.current_config_dir, report);
                }
                report.database_phase = VoquillMigrationPhaseStatus::Failed;
                report.models_phase = VoquillMigrationPhaseStatus::Skipped;
                report.audio_phase = VoquillMigrationPhaseStatus::Skipped;
                report.storage_phase = VoquillMigrationPhaseStatus::Skipped;
                report.issues.push(issue);
                finalize_status_and_actions(&mut report, Vec::new());
                if let Err(err) =
                    save_manifest_with_sync(&dirs.current_config_dir, &report, &manifest_sync_dir)
                {
                    log::warn!("Failed to persist failed Voquill migration manifest: {err}");
                    report.issues.push(VoquillMigrationIssue {
                        category: "database".to_string(),
                        code: "manifest_save_failed".to_string(),
                        detail: format!("Could not persist Voquill migration state: {err}"),
                    });
                    rebuild_action_items(&mut report, Vec::new());
                }
                return report;
            }
        }
    }

    migrate_asset_phases(dirs, &mut report);
    report.legacy_source_preserved = legacy_source_still_present(dirs);
    finalize_status_and_actions(&mut report, attention_providers);

    match save_manifest_with_sync(&dirs.current_config_dir, &report, &manifest_sync_dir) {
        Ok(()) => {
            remove_asset_progress_if_settled(&dirs.current_config_dir, &report);
        }
        Err(err) => {
            log::warn!("Failed to persist Voquill migration manifest: {err}");
            mark_manifest_save_failure(&mut report, &err);
        }
    }

    report
}

async fn finish_startup_database_and_assets_with_sync<FP>(
    dirs: &MigrationDirs,
    report: VoquillMigrationReport,
    legacy_db_present: bool,
    promote_sync_dir: FP,
) -> VoquillMigrationReport
where
    FP: FnOnce(&Path) -> io::Result<()> + Send + 'static,
{
    finish_startup_database_and_assets_with_hooks(
        dirs,
        report,
        legacy_db_present,
        promote_sync_dir,
        sync_dir_best_effort,
    )
    .await
}

async fn finish_startup_database_and_assets(
    dirs: &MigrationDirs,
    report: VoquillMigrationReport,
    legacy_db_present: bool,
) -> VoquillMigrationReport {
    finish_startup_database_and_assets_with_sync(
        dirs,
        report,
        legacy_db_present,
        sync_dir_best_effort,
    )
    .await
}

#[derive(Debug)]
enum MarkerVerification {
    MatchesPromoted(PromotionMarker),
    MatchesRolledBackPreRetry,
    Mismatch,
    IoError(String),
}

fn verify_promoted_db_matches_marker(current_db: &Path, marker_path: &Path) -> MarkerVerification {
    let marker = match read_promotion_marker(marker_path) {
        Ok(Some(marker)) => marker,
        Ok(None) => return MarkerVerification::Mismatch,
        Err(err) => {
            return MarkerVerification::IoError(format!(
                "Could not read Voquill promotion recovery marker: {err}"
            ));
        }
    };
    if marker.staged_sha256.is_empty() {
        return MarkerVerification::Mismatch;
    }
    let actual_full = match sha256_file_hex(current_db) {
        Ok(hash) => hash,
        Err(err) => {
            return MarkerVerification::IoError(format!(
                "Could not hash mausVoice database during promotion recovery: {err}"
            ));
        }
    };
    match marker.mode.as_str() {
        "startup" => {
            if actual_full == marker.staged_sha256 {
                MarkerVerification::MatchesPromoted(marker)
            } else {
                MarkerVerification::Mismatch
            }
        }
        "retry" => {
            if actual_full == marker.staged_sha256 {
                return MarkerVerification::MatchesPromoted(marker);
            }
            let check_staged_payload = !marker.staged_payload_sha256.is_empty();
            let pre_retry_payload = marker
                .pre_retry_payload_sha256
                .as_deref()
                .filter(|hash| !hash.is_empty());
            if !check_staged_payload && pre_retry_payload.is_none() {
                return MarkerVerification::Mismatch;
            }
            let actual_payload = match sha256_db_payload_hex(current_db) {
                Ok(hash) => hash,
                Err(err) => {
                    return MarkerVerification::IoError(format!(
                        "Could not hash mausVoice database payload during promotion recovery: {err}"
                    ));
                }
            };
            if check_staged_payload && actual_payload == marker.staged_payload_sha256 {
                MarkerVerification::MatchesPromoted(marker)
            } else if pre_retry_payload == Some(actual_payload.as_str()) {
                MarkerVerification::MatchesRolledBackPreRetry
            } else {
                MarkerVerification::Mismatch
            }
        }
        _ => MarkerVerification::Mismatch,
    }
}

async fn verify_and_audit_recovered_db(
    current_db: &Path,
) -> Result<DatabaseAudit, VoquillMigrationIssue> {
    // Open strictly read-only so verification never alters the SQLite header
    // or journal mode before the recovered manifest checkpoint is durable; a
    // failed checkpoint must leave `mausvoice.db` matching `staged_sha256` on
    // the next launch.
    let pool = open_app_database_readonly_verified(current_db)
        .await
        .map_err(|err| VoquillMigrationIssue {
            category: "database".to_string(),
            code: "recovery_open_failed".to_string(),
            detail: format!(
                "Could not verify the interrupted Voquill database promotion: {}",
                err.message()
            ),
        })?;
    let audit_result = audit_migrated_database(pool.clone()).await;
    pool.close().await;
    audit_result.map_err(|err| VoquillMigrationIssue {
        category: "database".to_string(),
        code: "recovery_audit_failed".to_string(),
        detail: format!("Could not audit the recovered Voquill database: {err}"),
    })
}

async fn recover_missing_current_db_with_manifest_sync<FM>(
    dirs: &MigrationDirs,
    mut existing: VoquillMigrationReport,
    manifest_sync_dir: FM,
) -> VoquillMigrationReport
where
    FM: Fn(&Path) -> io::Result<()>,
{
    let _ = retire_promotion_marker_async(&dirs.promotion_marker_path()).await;
    existing.attempt_count = existing.attempt_count.saturating_add(1);
    let legacy_db_check = match dirs.legacy_db_path() {
        Some(path) => check_path_exists_no_follow(&path).await,
        None => Ok(false),
    };
    match legacy_db_check {
        Ok(true) => {
            finish_startup_database_and_assets_with_hooks(
                dirs,
                existing,
                true,
                sync_dir_best_effort,
                manifest_sync_dir,
            )
            .await
        }
        Ok(false) => {
            existing.database_phase = VoquillMigrationPhaseStatus::Failed;
            existing.legacy_source_preserved = legacy_source_still_present(dirs);
            existing.issues.push(VoquillMigrationIssue {
                category: "database".to_string(),
                code: "legacy_source_missing".to_string(),
                detail: "The previous Voquill import was interrupted and the Voquill database could no longer be found.".to_string(),
            });
            finalize_status_and_actions(&mut existing, Vec::new());
            existing.can_retry = false;
            rebuild_action_items(&mut existing, Vec::new());
            if let Err(save_err) =
                save_manifest_with_sync(&dirs.current_config_dir, &existing, &manifest_sync_dir)
            {
                log::warn!(
                    "Failed to persist interrupted Voquill legacy-source-missing manifest: {save_err}"
                );
                existing.issues.push(VoquillMigrationIssue {
                    category: "database".to_string(),
                    code: "manifest_save_failed".to_string(),
                    detail: format!("Could not persist Voquill migration state: {save_err}"),
                });
            }
            existing
        }
        Err(err) => {
            existing.database_phase = VoquillMigrationPhaseStatus::Failed;
            existing.legacy_source_preserved = legacy_source_still_present(dirs);
            existing.issues.push(VoquillMigrationIssue {
                category: "database".to_string(),
                code: "legacy_path_unavailable".to_string(),
                detail: format!(
                    "The previous Voquill import was interrupted and the Voquill database could not be inspected: {err}"
                ),
            });
            finalize_status_and_actions(&mut existing, Vec::new());
            existing.can_retry = true;
            if let Err(save_err) =
                save_manifest_with_sync(&dirs.current_config_dir, &existing, &manifest_sync_dir)
            {
                log::warn!(
                    "Failed to persist interrupted Voquill legacy-path-unavailable manifest: {save_err}"
                );
                existing.issues.push(VoquillMigrationIssue {
                    category: "database".to_string(),
                    code: "manifest_save_failed".to_string(),
                    detail: format!("Could not persist Voquill migration state: {save_err}"),
                });
                rebuild_action_items(&mut existing, Vec::new());
            }
            existing
        }
    }
}

fn record_recovery_verification_failure(
    config_dir: &Path,
    mut existing: VoquillMigrationReport,
    issue: VoquillMigrationIssue,
) -> VoquillMigrationReport {
    existing.issues.retain(|item| {
        !matches!(
            item.code.as_str(),
            "recovery_open_failed"
                | "recovery_audit_failed"
                | "recovery_marker_io_error"
                | "promote_sync_failed"
        )
    });
    existing.issues.push(issue);
    existing.status = VoquillMigrationStatus::Partial;
    existing.can_retry = true;
    existing.completed_at = None;
    rebuild_action_items(&mut existing, Vec::new());
    if let Err(err) = save_manifest(config_dir, &existing) {
        log::warn!("Failed to persist recovery failure manifest: {err}");
    }
    existing
}

fn reset_skipped_asset_phases_to_pending(report: &mut VoquillMigrationReport) {
    for phase in [
        &mut report.models_phase,
        &mut report.audio_phase,
        &mut report.storage_phase,
    ] {
        if *phase == VoquillMigrationPhaseStatus::Skipped {
            *phase = VoquillMigrationPhaseStatus::Pending;
        }
    }
}

fn clear_resolved_database_promotion_issues(report: &mut VoquillMigrationReport) {
    report.issues.retain(|issue| issue.category != "database");
}

fn apply_recovered_database_audit(
    report: &mut VoquillMigrationReport,
    counts: VoquillMigrationCounts,
    removed_modes_reset: Vec<String>,
) {
    report.counts = counts;
    report.removed_modes_reset = removed_modes_reset;
    report.database_phase = VoquillMigrationPhaseStatus::Migrated;
    reset_skipped_asset_phases_to_pending(report);
    report.status = VoquillMigrationStatus::Partial;
    report.can_retry = true;
    report.completed_at = None;
    clear_resolved_database_promotion_issues(report);
}

fn new_startup_report(
    detected_at: String,
    status: VoquillMigrationStatus,
    database_phase: VoquillMigrationPhaseStatus,
    assets_phase: VoquillMigrationPhaseStatus,
    can_retry: bool,
) -> VoquillMigrationReport {
    VoquillMigrationReport {
        schema_version: MANIFEST_SCHEMA_VERSION,
        status,
        legacy_detected: true,
        legacy_source_preserved: true,
        detected_at: Some(detected_at),
        completed_at: None,
        dismissed_at: None,
        attempt_count: 1,
        database_phase,
        models_phase: assets_phase,
        audio_phase: assets_phase,
        storage_phase: assets_phase,
        counts: VoquillMigrationCounts::default(),
        removed_modes_reset: Vec::new(),
        issues: Vec::new(),
        action_items: Vec::new(),
        can_retry,
    }
}

async fn recover_pending_database_migration(
    dirs: &MigrationDirs,
    existing: VoquillMigrationReport,
) -> VoquillMigrationReport {
    recover_pending_database_migration_with_manifest_sync(dirs, existing, sync_dir_best_effort)
        .await
}

async fn recover_pending_database_migration_with_manifest_sync<FM>(
    dirs: &MigrationDirs,
    mut existing: VoquillMigrationReport,
    manifest_sync_dir: FM,
) -> VoquillMigrationReport
where
    FM: Fn(&Path) -> io::Result<()>,
{
    let current_db = dirs.current_db_path();
    let marker_path = dirs.promotion_marker_path();

    if !path_exists_no_follow(&current_db).await {
        return recover_missing_current_db_with_manifest_sync(dirs, existing, manifest_sync_dir)
            .await;
    }

    // `mausvoice.db` exists while `database_phase` was not yet persisted as
    // `Migrated`. Only treat it as our promoted Voquill DB when the promotion
    // marker matches it; keep recovery pending on I/O errors, retire stale
    // rolled-back retry markers, and refuse unrelated profile databases.
    let check_db = current_db.clone();
    let check_marker = marker_path.clone();
    let verification = match tokio::task::spawn_blocking(move || {
        verify_promoted_db_matches_marker(&check_db, &check_marker)
    })
    .await
    {
        Ok(result) => result,
        Err(err) => MarkerVerification::IoError(format!(
            "Voquill promotion recovery verification task failed: {err}"
        )),
    };
    let verified_marker = match verification {
        MarkerVerification::MatchesPromoted(marker) => marker,
        MarkerVerification::MatchesRolledBackPreRetry => {
            let mut rolled_back = existing.clone();
            rolled_back.database_phase = VoquillMigrationPhaseStatus::Failed;
            for phase in [
                &mut rolled_back.models_phase,
                &mut rolled_back.audio_phase,
                &mut rolled_back.storage_phase,
            ] {
                if *phase == VoquillMigrationPhaseStatus::Pending {
                    *phase = VoquillMigrationPhaseStatus::Skipped;
                }
            }
            rolled_back
                .issues
                .retain(|issue| issue.code != "recovery_marker_io_error");
            if rolled_back.issues.is_empty() {
                rolled_back.issues.push(VoquillMigrationIssue {
                    category: "database".to_string(),
                    code: "interrupted_previous_attempt".to_string(),
                    detail: "A previous Voquill retry rolled back to the empty mausVoice database. Retry to import your Voquill profile.".to_string(),
                });
            }
            finalize_status_and_actions(&mut rolled_back, Vec::new());
            rolled_back.can_retry = true;
            // Persist the verified rolled-back manifest before retiring the
            // promotion marker so a crash or save failure keeps the marker
            // intact instead of stranding `mausvoice.db` without a manifest.
            if let Err(err) = save_manifest(&dirs.current_config_dir, &rolled_back) {
                log::warn!(
                    "Failed to persist rolled-back Voquill migration manifest; keeping recovery marker: {err}"
                );
                mark_manifest_save_failure(&mut existing, &err);
                return existing;
            }
            if let Err(err) = retire_promotion_marker_async(&marker_path).await {
                return record_recovery_verification_failure(
                    &dirs.current_config_dir,
                    rolled_back,
                    VoquillMigrationIssue {
                        category: "database".to_string(),
                        code: "recovery_marker_io_error".to_string(),
                        detail: format!(
                            "Could not retire rolled-back Voquill promotion marker: {err}"
                        ),
                    },
                );
            }
            return rolled_back;
        }
        MarkerVerification::IoError(detail) => {
            return record_recovery_verification_failure(
                &dirs.current_config_dir,
                existing,
                VoquillMigrationIssue {
                    category: "database".to_string(),
                    code: "recovery_marker_io_error".to_string(),
                    detail,
                },
            );
        }
        MarkerVerification::Mismatch => {
            remove_promotion_marker(&marker_path).await;
            return mark_existing_profile_conflict(&dirs.current_config_dir, existing);
        }
    };

    if let Some(parent) = current_db.parent().map(Path::to_path_buf) {
        let sync_res = tokio::task::spawn_blocking(move || sync_dir_best_effort(&parent))
            .await
            .map_err(|err| format!("Destination directory sync task failed: {err}"))
            .and_then(|res| res.map_err(|err| err.to_string()));
        if let Err(err) = sync_res {
            return record_recovery_verification_failure(
                &dirs.current_config_dir,
                existing,
                VoquillMigrationIssue {
                    category: "database".to_string(),
                    code: "promote_sync_failed".to_string(),
                    detail: format!(
                        "Could not sync destination directory while recovering promoted database: {err}"
                    ),
                },
            );
        }
    }

    let audit = match verify_and_audit_recovered_db(&current_db).await {
        Ok(audit) => audit,
        Err(issue) => {
            return record_recovery_verification_failure(&dirs.current_config_dir, existing, issue);
        }
    };

    apply_recovered_database_audit(
        &mut existing,
        audit.counts,
        verified_marker.removed_modes_reset,
    );

    if let Err(err) =
        save_manifest_with_sync(&dirs.current_config_dir, &existing, &manifest_sync_dir)
    {
        log::warn!(
            "Failed to checkpoint recovered Voquill migration manifest; keeping recovery marker: {err}"
        );
        existing.database_phase = VoquillMigrationPhaseStatus::Pending;
        mark_manifest_save_failure(&mut existing, &err);
        rebuild_action_items(&mut existing, Vec::new());
        return existing;
    }

    if let Err(err) = retire_promotion_marker_async(&marker_path).await {
        return record_recovery_verification_failure(
            &dirs.current_config_dir,
            existing,
            VoquillMigrationIssue {
                category: "database".to_string(),
                code: "recovery_marker_io_error".to_string(),
                detail: format!("Could not retire Voquill promotion recovery marker: {err}"),
            },
        );
    }

    let cleanup_backup_db = current_db.clone();
    let _ = tokio::task::spawn_blocking(move || remove_rollback_backup(&cleanup_backup_db)).await;

    migrate_asset_phases(dirs, &mut existing);
    existing.legacy_source_preserved = legacy_source_still_present(dirs);
    finalize_status_and_actions(&mut existing, audit.attention_providers);
    match save_manifest_with_sync(&dirs.current_config_dir, &existing, &manifest_sync_dir) {
        Ok(()) => {
            remove_asset_progress_if_settled(&dirs.current_config_dir, &existing);
        }
        Err(err) => {
            log::warn!("Failed to persist recovered Voquill migration manifest: {err}");
            mark_manifest_save_failure(&mut existing, &err);
        }
    }
    existing
}

async fn settle_lingering_promotion_marker(
    dirs: &MigrationDirs,
    existing: &mut VoquillMigrationReport,
) -> bool {
    let marker_path = dirs.promotion_marker_path();
    let current_db = dirs.current_db_path();
    let sync_db_dir = existing.database_phase == VoquillMigrationPhaseStatus::Migrated
        && path_exists_no_follow(&current_db).await;
    let db_parent = current_db.parent().map(Path::to_path_buf);
    let config_dir = dirs.current_config_dir.clone();

    let sync_res = tokio::task::spawn_blocking(move || {
        if sync_db_dir {
            if let Some(parent) = db_parent.as_deref() {
                sync_dir_best_effort(parent)?;
            }
        }
        sync_dir_best_effort(&config_dir)
    })
    .await
    .map_err(|err| io::Error::other(format!("Manifest checkpoint sync task failed: {err}")))
    .and_then(|res| res);

    if let Err(err) = sync_res {
        log::warn!(
            "Failed to sync durable checkpoint before retiring Voquill promotion marker: {err}"
        );
        existing.database_phase = VoquillMigrationPhaseStatus::Pending;
        mark_manifest_save_failure(existing, &err);
        rebuild_action_items(existing, Vec::new());
        return false;
    }

    if let Err(err) = retire_promotion_marker_async(&marker_path).await {
        log::warn!("Failed to retire lingering Voquill promotion recovery marker: {err}");
        existing.database_phase = VoquillMigrationPhaseStatus::Pending;
        existing.status = VoquillMigrationStatus::Partial;
        existing.can_retry = true;
        existing.completed_at = None;
        existing.issues.push(VoquillMigrationIssue {
            category: "database".to_string(),
            code: "recovery_marker_io_error".to_string(),
            detail: format!("Could not retire Voquill promotion recovery marker: {err}"),
        });
        rebuild_action_items(existing, Vec::new());
        return false;
    }

    true
}

async fn resume_existing_manifest(
    dirs: &MigrationDirs,
    mut existing: VoquillMigrationReport,
    had_interrupted_staging: bool,
) -> VoquillMigrationReport {
    existing.legacy_source_preserved = legacy_source_still_present(dirs);

    let has_promotion_marker = path_exists_no_follow(&dirs.promotion_marker_path()).await;

    // If a promotion marker still lingers alongside an already-written
    // `Migrated` or terminal manifest (e.g. a previous checkpoint renamed the
    // manifest but failed during `sync_dir` or marker unlink), explicitly sync
    // the directories and retire the marker before treating startup as settled.
    if has_promotion_marker
        && (existing.database_phase == VoquillMigrationPhaseStatus::Migrated
            || matches!(
                existing.status,
                VoquillMigrationStatus::SkippedExistingProfile | VoquillMigrationStatus::NotNeeded
            ))
        && !settle_lingering_promotion_marker(dirs, &mut existing).await
    {
        return existing;
    }

    // Already finished or deliberately skipped: idempotent no-op.
    if matches!(
        existing.status,
        VoquillMigrationStatus::Completed
            | VoquillMigrationStatus::SkippedExistingProfile
            | VoquillMigrationStatus::NotNeeded
    ) {
        return existing;
    }

    // Previous launch or retry was interrupted while DB promotion had not yet
    // been persisted as `Migrated`.
    if existing.database_phase == VoquillMigrationPhaseStatus::Pending
        || (existing.database_phase != VoquillMigrationPhaseStatus::Migrated
            && has_promotion_marker)
    {
        return recover_pending_database_migration(dirs, existing).await;
    }

    // Database already migrated (or absent in an asset-only import), but
    // optional asset phases were interrupted or partially failed: resume only
    // unfinished asset phases without touching mausvoice.db.
    if matches!(
        existing.database_phase,
        VoquillMigrationPhaseStatus::Migrated | VoquillMigrationPhaseStatus::NotFound
    ) && matches!(existing.status, VoquillMigrationStatus::Partial)
        && [
            existing.models_phase,
            existing.audio_phase,
            existing.storage_phase,
        ]
        .into_iter()
        .any(|phase| phase == VoquillMigrationPhaseStatus::Pending)
    {
        migrate_asset_phases(dirs, &mut existing);
        let existing_providers = existing
            .action_items
            .iter()
            .find(|item| item.kind == "reenter_api_keys")
            .map(|item| item.providers.clone())
            .unwrap_or_default();
        finalize_status_and_actions(&mut existing, existing_providers);
        match save_manifest(&dirs.current_config_dir, &existing) {
            Ok(()) => {
                remove_asset_progress_if_settled(&dirs.current_config_dir, &existing);
            }
            Err(err) => {
                log::warn!("Failed to persist resumed Voquill migration manifest: {err}");
                mark_manifest_save_failure(&mut existing, &err);
            }
        }
        return existing;
    }

    if had_interrupted_staging
        && !existing
            .issues
            .iter()
            .any(|issue| issue.code == "interrupted_previous_attempt")
    {
        existing.issues.push(VoquillMigrationIssue {
            category: "database".to_string(),
            code: "interrupted_previous_attempt".to_string(),
            detail: "A previous Voquill import attempt was interrupted before completing."
                .to_string(),
        });
        let _ = save_manifest(&dirs.current_config_dir, &existing);
    }

    existing
}

/// Runs idempotent, staged Voquill migration before `open_app_database`.
///
/// Guarantees:
/// - Never overwrites an existing mausVoice database.
/// - Never modifies or deletes legacy Voquill files.
/// - Never reports success until the database is copied with required WAL/journal
///   companions, integrity-checked, migrated cleanly, and atomically promoted.
/// - Safely recovers from leftover staging directories or interrupted mid-asset
///   runs on the next launch.
pub async fn run_startup_migration(dirs: &MigrationDirs) -> VoquillMigrationReport {
    let existing_manifest = match try_load_manifest(&dirs.current_config_dir) {
        Ok(manifest) => manifest,
        Err(detail) => {
            // Preserve the existing on-disk manifest untouched when it cannot be
            // read or parsed instead of treating it as absent and overwriting a
            // partial/retryable report with `SkippedExistingProfile`.
            return manifest_read_failed_report(dirs, detail);
        }
    };
    let dirs_for_restore = dirs.clone();
    let manifest_for_restore = existing_manifest.clone();
    let _ = tokio::task::spawn_blocking(move || {
        if let Err(err) =
            reconcile_orphaned_pre_retry_backup(&dirs_for_restore, manifest_for_restore.as_ref())
        {
            log::error!("{err}");
        }
    })
    .await;

    let staging_dir = dirs.staging_dir();
    let had_interrupted_staging = path_exists_no_follow(&staging_dir).await;
    if had_interrupted_staging {
        log::warn!(
            "Found leftover Voquill migration staging directory at {}; cleaning up interrupted attempt",
            staging_dir.display()
        );
        cleanup_staging(&staging_dir);
    }

    if let Some(existing) = existing_manifest {
        return resume_existing_manifest(dirs, existing, had_interrupted_staging).await;
    }

    // Check for an orphaned promotion recovery marker BEFORE returning
    // `NotNeeded` when legacy Voquill data is gone (e.g., power loss lost the
    // initial manifest after DB promotion and the user later removed Voquill).
    // Routing directly into marker-verified recovery lets startup settle or
    // retire the marker instead of tripping `ensure_no_pending_promotion_recovery`.
    if path_exists_no_follow(&dirs.promotion_marker_path()).await {
        let pending_recovery = new_startup_report(
            now_iso(),
            VoquillMigrationStatus::Partial,
            VoquillMigrationPhaseStatus::Pending,
            VoquillMigrationPhaseStatus::Pending,
            true,
        );
        return recover_pending_database_migration(dirs, pending_recovery).await;
    }

    if !has_any_legacy_source(dirs) {
        return VoquillMigrationReport::not_needed();
    }

    let now = now_iso();
    let legacy_db_check = match dirs.legacy_db_path() {
        Some(path) => check_path_exists_no_follow(&path).await,
        None => Ok(false),
    };
    let current_db_exists = path_exists_no_follow(&dirs.current_db_path()).await;

    // Never overwrite or copy legacy assets into an already-established mausVoice profile.
    if current_db_exists {
        let base_report = new_startup_report(
            now,
            VoquillMigrationStatus::SkippedExistingProfile,
            VoquillMigrationPhaseStatus::Skipped,
            VoquillMigrationPhaseStatus::Skipped,
            false,
        );
        return mark_existing_profile_conflict(&dirs.current_config_dir, base_report);
    }

    let legacy_db_present = match legacy_db_check {
        Ok(present) => present,
        Err(err) => {
            let mut report = new_startup_report(
                now,
                VoquillMigrationStatus::Failed,
                VoquillMigrationPhaseStatus::Failed,
                VoquillMigrationPhaseStatus::Skipped,
                true,
            );
            report.issues.push(VoquillMigrationIssue {
                category: "database".to_string(),
                code: "legacy_path_unavailable".to_string(),
                detail: format!("Could not inspect legacy Voquill database: {err}"),
            });
            finalize_status_and_actions(&mut report, Vec::new());
            report.can_retry = true;
            if let Err(save_err) = save_manifest(&dirs.current_config_dir, &report) {
                log::warn!("Failed to persist inaccessible Voquill DB manifest: {save_err}");
                mark_manifest_save_failure(&mut report, &save_err);
                rebuild_action_items(&mut report, Vec::new());
            }
            return report;
        }
    };

    let mut report = new_startup_report(
        now,
        VoquillMigrationStatus::Partial,
        if legacy_db_present {
            VoquillMigrationPhaseStatus::Pending
        } else {
            VoquillMigrationPhaseStatus::NotFound
        },
        VoquillMigrationPhaseStatus::Pending,
        true,
    );

    if had_interrupted_staging {
        report.issues.push(VoquillMigrationIssue {
            category: "database".to_string(),
            code: "interrupted_previous_attempt".to_string(),
            detail: "Cleaned up an interrupted earlier import before retrying.".to_string(),
        });
    }

    finish_startup_database_and_assets(dirs, report, legacy_db_present).await
}

/// Checks whether the currently active mausVoice database holds any user-created
/// records across every user-data table. Used to ensure retrying a failed
/// Voquill database import can never overwrite a profile the user has already
/// started configuring (including custom hotkeys, tones, or saved preferences).
pub async fn is_database_empty_of_user_data(pool: SqlitePool) -> Result<bool, String> {
    let checks = [
        "SELECT COUNT(*) FROM transcriptions",
        "SELECT COUNT(*) FROM terms",
        "SELECT COUNT(*) FROM hotkeys",
        "SELECT COUNT(*) FROM api_keys",
        "SELECT COUNT(*) FROM tones",
        "SELECT COUNT(*) FROM app_targets",
        "SELECT COUNT(*) FROM conversations",
        "SELECT COUNT(*) FROM chat_messages",
        "SELECT COUNT(*) FROM paired_remote_devices",
        "SELECT COUNT(*) FROM daily_word_activity",
        "SELECT COUNT(*) FROM daily_word_activity_events",
        "SELECT COUNT(*) FROM pill_position",
        "SELECT COUNT(*) FROM user_preferences",
        "SELECT COUNT(*) FROM user_profiles WHERE onboarded = 1 OR onboarded_at IS NOT NULL OR words_total > 0 OR TRIM(COALESCE(name, '')) != '' OR TRIM(COALESCE(bio, '')) != ''",
    ];
    for sql in checks {
        let count: i64 = sqlx::query_scalar(sql)
            .fetch_one(&pool)
            .await
            .map_err(|err| format!("failed to inspect active database state: {err}"))?;
        if count > 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Returns the live migration report, refreshing credential attention counts
/// directly from the active database so re-entering broken API keys updates
/// the report immediately.
pub async fn refresh_migration_report(
    dirs: MigrationDirs,
    pool: SqlitePool,
) -> VoquillMigrationReport {
    let mut report = match try_load_manifest(&dirs.current_config_dir) {
        Ok(Some(report)) => report,
        Ok(None) => return VoquillMigrationReport::not_needed(),
        Err(detail) => return manifest_read_failed_report(&dirs, detail),
    };

    report.legacy_source_preserved = legacy_source_still_present(&dirs);

    if report.database_phase == VoquillMigrationPhaseStatus::Migrated
        || report.status == VoquillMigrationStatus::SkippedExistingProfile
    {
        if let Ok((total, attention, providers)) = inspect_live_api_key_attention(pool).await {
            report.counts.provider_entries = total;
            report.counts.providers_needing_attention = attention;
            rebuild_action_items(&mut report, providers);
        }
    } else if matches!(
        report.database_phase,
        VoquillMigrationPhaseStatus::Failed | VoquillMigrationPhaseStatus::Pending
    ) {
        let marker_path = dirs.promotion_marker_path();
        if path_exists_no_follow(&marker_path).await {
            let check_db = dirs.current_db_path();
            let check_marker = marker_path.clone();
            let verification = match tokio::task::spawn_blocking(move || {
                verify_promoted_db_matches_marker(&check_db, &check_marker)
            })
            .await
            {
                Ok(result) => result,
                Err(err) => MarkerVerification::IoError(format!(
                    "Voquill promotion recovery verification task failed: {err}"
                )),
            };
            match verification {
                MarkerVerification::MatchesPromoted(_) => {
                    report.status = VoquillMigrationStatus::Partial;
                    report.can_retry = true;
                    if !report.issues.iter().any(|issue| {
                        matches!(
                            issue.code.as_str(),
                            "manifest_save_failed"
                                | "recovery_open_failed"
                                | "recovery_audit_failed"
                                | "recovery_marker_io_error"
                                | "promote_sync_failed"
                        )
                    }) {
                        report.issues.push(VoquillMigrationIssue {
                            category: "database".to_string(),
                            code: "manifest_save_failed".to_string(),
                            detail: "Voquill database promotion completed, but migration state could not be saved yet. Retry to finish recording migration state and remaining assets.".to_string(),
                        });
                    }
                    rebuild_action_items(&mut report, Vec::new());
                    return report;
                }
                MarkerVerification::IoError(detail) => {
                    report.status = VoquillMigrationStatus::Partial;
                    report.can_retry = true;
                    report
                        .issues
                        .retain(|issue| issue.code != "recovery_marker_io_error");
                    report.issues.push(VoquillMigrationIssue {
                        category: "database".to_string(),
                        code: "recovery_marker_io_error".to_string(),
                        detail,
                    });
                    rebuild_action_items(&mut report, Vec::new());
                    return report;
                }
                MarkerVerification::Mismatch => {
                    report.status = VoquillMigrationStatus::SkippedExistingProfile;
                    report.database_phase = VoquillMigrationPhaseStatus::Skipped;
                    report.models_phase = VoquillMigrationPhaseStatus::Skipped;
                    report.audio_phase = VoquillMigrationPhaseStatus::Skipped;
                    report.storage_phase = VoquillMigrationPhaseStatus::Skipped;
                    report.can_retry = false;
                    if !report
                        .issues
                        .iter()
                        .any(|issue| issue.code == "existing_profile_conflict")
                    {
                        report.issues.push(VoquillMigrationIssue {
                            category: "database".to_string(),
                            code: "existing_profile_conflict".to_string(),
                            detail: "An existing mausVoice database does not match the Voquill promotion recovery marker and was kept untouched.".to_string(),
                        });
                    }
                    rebuild_action_items(&mut report, Vec::new());
                    return report;
                }
                MarkerVerification::MatchesRolledBackPreRetry => {}
            }
        }
        let legacy_db_might_exist = match dirs.legacy_db_path() {
            Some(path) => !matches!(check_path_exists_no_follow(&path).await, Ok(false)),
            None => false,
        };
        report.can_retry =
            is_database_empty_of_user_data(pool).await.unwrap_or(false) && legacy_db_might_exist;
        rebuild_action_items(&mut report, Vec::new());
    }

    report
}

/// Persists one-time dismissal of the migration banner without deleting the
/// discoverable report shown in Settings -> Privacy & Data.
pub async fn dismiss_migration_notice(
    dirs: MigrationDirs,
    pool: SqlitePool,
) -> Result<VoquillMigrationReport, String> {
    dismiss_migration_notice_with_sync(dirs, pool, sync_dir_best_effort).await
}

async fn dismiss_migration_notice_with_sync<F>(
    dirs: MigrationDirs,
    pool: SqlitePool,
    sync_dir: F,
) -> Result<VoquillMigrationReport, String>
where
    F: Fn(&Path) -> io::Result<()>,
{
    let mut report = match try_load_manifest(&dirs.current_config_dir) {
        Ok(Some(report)) => report,
        Ok(None) => return Ok(VoquillMigrationReport::not_needed()),
        Err(detail) => return Err(detail),
    };
    if report.dismissed_at.is_none() {
        report.dismissed_at = Some(now_iso());
        save_manifest_with_sync(&dirs.current_config_dir, &report, &sync_dir)
            .map_err(|err| format!("Could not save migration dismissal: {err}"))?;
    } else {
        sync_dir(&dirs.current_config_dir)
            .map_err(|err| format!("Could not sync migration dismissal: {err}"))?;
    }
    Ok(refresh_migration_report(dirs, pool).await)
}

pub(crate) async fn ensure_usable_pool(
    dirs: &MigrationDirs,
    database: &OptionKeyDatabase,
) -> Result<SqlitePool, String> {
    let dirs_for_restore = dirs.clone();
    let manifest_for_restore = match try_load_manifest(&dirs.current_config_dir) {
        Ok(manifest) => manifest,
        Err(err) => {
            if has_any_pre_retry_backup(&dirs.current_db_path()) {
                return Err(err);
            }
            None
        }
    };
    tokio::task::spawn_blocking(move || {
        reconcile_orphaned_pre_retry_backup(&dirs_for_restore, manifest_for_restore.as_ref())
    })
    .await
    .map_err(|err| format!("Pre-retry backup reconciliation task failed: {err}"))??;

    let current_pool = database.pool();
    if !current_pool.is_closed() {
        return Ok(current_pool);
    }

    let reopened = open_app_database(&dirs.current_db_path())
        .await
        .map_err(|err| format!("Could not reopen current database: {err}"))?;
    let _ = database.replace_pool(reopened.clone());
    Ok(reopened)
}

async fn reopen_previous_pool(current_db_path: &Path, database: &OptionKeyDatabase) {
    if let Ok(recovered_pool) = open_app_database(current_db_path).await {
        let _ = database.replace_pool(recovered_pool);
    }
}

struct RetrySwapError {
    issue: VoquillMigrationIssue,
    restored_ok: bool,
    installed_unsynced: bool,
}

struct RetrySwapMarkerSpec {
    staged_sha256: String,
    staged_payload_sha256: String,
    removed_modes_reset: Vec<String>,
}

struct RetrySwapSyncHooks {
    marker_sync: fn(&Path) -> io::Result<()>,
    promote_sync: fn(&Path) -> io::Result<()>,
    retire_sync: fn(&Path) -> io::Result<()>,
}

fn swap_retry_database_on_disk_with_sync(
    staged_db: &Path,
    current_db: &Path,
    marker_path: &Path,
    spec: RetrySwapMarkerSpec,
    sync_hooks: RetrySwapSyncHooks,
) -> Result<Vec<&'static str>, RetrySwapError> {
    let pre_retry_payload_sha256 = sha256_db_payload_hex(current_db).ok();
    let moved_suffixes = move_current_db_to_rollback_backup(current_db)?;
    let marker = PromotionMarker {
        mode: "retry".to_string(),
        staged_sha256: spec.staged_sha256,
        staged_payload_sha256: spec.staged_payload_sha256,
        pre_retry_payload_sha256,
        removed_modes_reset: spec.removed_modes_reset,
    };
    if let Err(err) =
        write_promotion_marker_record_with_sync(marker_path, &marker, sync_hooks.marker_sync)
    {
        let backup_restored = restore_rollback_backup(current_db, &moved_suffixes).is_ok();
        let marker_retired = if err.was_published() {
            backup_restored
                && retire_promotion_marker_with_sync(marker_path, sync_hooks.retire_sync).is_ok()
        } else {
            true
        };
        return Err(RetrySwapError {
            issue: VoquillMigrationIssue {
                category: "database".to_string(),
                code: "promote_io_error".to_string(),
                detail: format!("Could not record retry promotion recovery marker: {err}"),
            },
            restored_ok: backup_restored && marker_retired,
            installed_unsynced: false,
        });
    }
    match promote_staged_file_with_sync(staged_db, current_db, sync_hooks.promote_sync) {
        Ok(()) => Ok(moved_suffixes),
        Err(PromoteError::InstalledButNotSynced(issue)) => Err(RetrySwapError {
            issue,
            restored_ok: false,
            installed_unsynced: true,
        }),
        Err(PromoteError::NotInstalled(issue)) => {
            let backup_handled = if issue.code == "existing_profile_conflict" {
                remove_rollback_backup(current_db);
                true
            } else {
                restore_rollback_backup(current_db, &moved_suffixes).is_ok()
            };
            let marker_retired = backup_handled
                && retire_promotion_marker_with_sync(marker_path, sync_hooks.retire_sync).is_ok();
            Err(RetrySwapError {
                issue,
                restored_ok: backup_handled && marker_retired,
                installed_unsynced: false,
            })
        }
    }
}

fn swap_retry_database_on_disk(
    staged_db: &Path,
    current_db: &Path,
    marker_path: &Path,
    spec: RetrySwapMarkerSpec,
) -> Result<Vec<&'static str>, RetrySwapError> {
    swap_retry_database_on_disk_with_sync(
        staged_db,
        current_db,
        marker_path,
        spec,
        RetrySwapSyncHooks {
            marker_sync: sync_dir_best_effort,
            promote_sync: sync_dir_best_effort,
            retire_sync: sync_dir_best_effort,
        },
    )
}

async fn rollback_installed_retry_database(
    current_db_path: &Path,
    marker_path: &Path,
    moved_suffixes: Vec<&'static str>,
    database: &OptionKeyDatabase,
) -> bool {
    let restore_path = current_db_path.to_path_buf();
    let restore_marker = marker_path.to_path_buf();
    let restore_ok = tokio::task::spawn_blocking(move || {
        remove_db_files(&restore_path);
        if restore_rollback_backup(&restore_path, &moved_suffixes).is_err() {
            return false;
        }
        retire_promotion_marker_sync(&restore_marker).is_ok()
    })
    .await
    .unwrap_or(false);

    if restore_ok {
        reopen_previous_pool(current_db_path, database).await;
    }
    restore_ok
}

fn record_retry_failure(
    dirs: &MigrationDirs,
    report: &mut VoquillMigrationReport,
    issue: VoquillMigrationIssue,
) {
    report.issues = vec![issue];
    finalize_status_and_actions(report, Vec::new());
    if let Err(err) = save_manifest(&dirs.current_config_dir, report) {
        log::warn!("Could not persist failed Voquill retry manifest: {err}");
    }
}

async fn retry_database_promotion(
    dirs: &MigrationDirs,
    database: &OptionKeyDatabase,
    report: &mut VoquillMigrationReport,
) -> Result<Option<Vec<String>>, String> {
    let current_pool = ensure_usable_pool(dirs, database).await?;
    if !is_database_empty_of_user_data(current_pool.clone()).await? {
        *report = mark_existing_profile_conflict(&dirs.current_config_dir, report.clone());
        return Ok(None);
    }

    // Validate & migrate completely in staging BEFORE touching the live pool,
    // so a repeated failure leaves the running app untouched.
    let staging_dir = dirs.staging_dir();
    let current_db_path = dirs.current_db_path();
    let marker_path = dirs.promotion_marker_path();
    let staging_clean = staging_dir.clone();
    let _ = tokio::task::spawn_blocking(move || cleanup_staging(&staging_clean)).await;

    let (staged_db_path, staged) = match stage_validate_in_staging_only(dirs).await {
        Ok(res) => res,
        Err(issue) => {
            let staging_err = staging_dir.clone();
            let _ = tokio::task::spawn_blocking(move || cleanup_staging(&staging_err)).await;
            report.issues = vec![issue];
            finalize_status_and_actions(report, Vec::new());
            save_manifest(&dirs.current_config_dir, report)
                .map_err(|err| format!("Could not save migration state: {err}"))?;
            return Ok(None);
        }
    };

    let staged_for_hash = staged_db_path.clone();
    let (staged_sha256, staged_payload_sha256) =
        match tokio::task::spawn_blocking(move || hash_staged_database(&staged_for_hash))
            .await
            .map_err(|err| format!("Database hash task failed: {err}"))?
        {
            Ok(hashes) => hashes,
            Err(err) => {
                let staging_err = staging_dir.clone();
                let _ = tokio::task::spawn_blocking(move || cleanup_staging(&staging_err)).await;
                record_retry_failure(
                    dirs,
                    report,
                    VoquillMigrationIssue {
                        category: "database".to_string(),
                        code: "promote_io_error".to_string(),
                        detail: format!("Could not hash staged database before retry swap: {err}"),
                    },
                );
                return Ok(None);
            }
        };

    // Close active empty pool cleanly before swapping the SQLite file, keeping
    // a rollback backup of the prior DB until the replacement opens cleanly.
    database.pool().close().await;

    let promote_src = staged_db_path.clone();
    let promote_dst = current_db_path.clone();
    let promote_marker = marker_path.clone();
    let marker_modes = staged.removed_modes_reset.clone();
    let swap_result = tokio::task::spawn_blocking(move || {
        swap_retry_database_on_disk(
            &promote_src,
            &promote_dst,
            &promote_marker,
            RetrySwapMarkerSpec {
                staged_sha256,
                staged_payload_sha256,
                removed_modes_reset: marker_modes,
            },
        )
    })
    .await
    .map_err(|err| format!("Database promotion task failed: {err}"))?;

    let moved_suffixes = match swap_result {
        Ok(suffixes) => suffixes,
        Err(swap_err) => {
            let staging_err = staging_dir.clone();
            let _ = tokio::task::spawn_blocking(move || cleanup_staging(&staging_err)).await;
            if swap_err.installed_unsynced {
                report.database_phase = VoquillMigrationPhaseStatus::Pending;
                report.status = VoquillMigrationStatus::Partial;
                report.can_retry = true;
                report.completed_at = None;
                report.issues = vec![swap_err.issue.clone()];
                rebuild_action_items(report, Vec::new());
                if let Err(err) = save_manifest(&dirs.current_config_dir, report) {
                    log::warn!("Could not persist pending Voquill retry manifest: {err}");
                }
                return Err(swap_err.issue.detail);
            }
            if swap_err.issue.code == "existing_profile_conflict" {
                *report = mark_existing_profile_conflict(&dirs.current_config_dir, report.clone());
                if !swap_err.restored_ok {
                    return Err(
                        "An existing mausVoice database appeared during retry and was kept untouched, but retiring recovery state failed.".to_string(),
                    );
                }
                reopen_previous_pool(&current_db_path, database).await;
                return Ok(None);
            }
            record_retry_failure(dirs, report, swap_err.issue);
            if !swap_err.restored_ok {
                return Err(
                    "Could not cleanly restore the previous mausVoice database backup and retire recovery state after retry swap failure; keeping recovery files untouched.".to_string(),
                );
            }
            // All moved backup files were restored cleanly; safe to reopen the original DB.
            reopen_previous_pool(&current_db_path, database).await;
            return Ok(None);
        }
    };

    let staging_done = staging_dir.clone();
    let _ = tokio::task::spawn_blocking(move || cleanup_staging(&staging_done)).await;

    let new_pool = match open_app_database_strict(&current_db_path).await {
        Ok(pool) => pool,
        Err(err) => {
            let restored_ok = rollback_installed_retry_database(
                &current_db_path,
                &marker_path,
                moved_suffixes,
                database,
            )
            .await;
            record_retry_failure(
                dirs,
                report,
                VoquillMigrationIssue {
                    category: "database".to_string(),
                    code: "reopen_failed".to_string(),
                    detail: format!("Could not reopen migrated database: {}", err.message()),
                },
            );
            if !restored_ok {
                return Err(
                    "Could not restore the previous mausVoice database backup after reopen failure; keeping backup files untouched.".to_string(),
                );
            }
            return Ok(None);
        }
    };

    report.database_phase = VoquillMigrationPhaseStatus::Migrated;
    report.models_phase = VoquillMigrationPhaseStatus::Pending;
    report.audio_phase = VoquillMigrationPhaseStatus::Pending;
    report.storage_phase = VoquillMigrationPhaseStatus::Pending;
    report.status = VoquillMigrationStatus::Partial;
    report.can_retry = true;
    report.completed_at = None;
    report.counts = staged.audit.counts;
    report.removed_modes_reset = staged.removed_modes_reset;
    report.issues.clear();

    // Persist the checkpoint BEFORE exposing `new_pool` to app writers and
    // BEFORE removing `.pre-retry.bak` or `.voquill-db-promoting`. If saving
    // fails, close `new_pool` so no writes can mutate `current_db` and drift
    // its marker digest; startup recovery can then safely verify and finish.
    if let Err(err) = save_manifest(&dirs.current_config_dir, report) {
        new_pool.close().await;
        log::warn!(
            "Failed to checkpoint retry migration manifest; preserving backup and recovery marker: {err}"
        );
        return Err(format!("Could not checkpoint retry migration state: {err}"));
    }

    let _ = database.replace_pool(new_pool);
    let backup_cleanup_path = current_db_path.clone();
    let _ = tokio::task::spawn_blocking(move || remove_rollback_backup(&backup_cleanup_path)).await;
    remove_promotion_marker(&marker_path).await;

    Ok(Some(staged.audit.attention_providers))
}

async fn recover_promoted_db_during_retry(
    dirs: &MigrationDirs,
    database: &OptionKeyDatabase,
    report: &mut VoquillMigrationReport,
) -> Result<Option<Vec<String>>, String> {
    let current_db = dirs.current_db_path();
    let marker_path = dirs.promotion_marker_path();
    let check_db = current_db.clone();
    let check_marker = marker_path.clone();
    let verification = tokio::task::spawn_blocking(move || {
        verify_promoted_db_matches_marker(&check_db, &check_marker)
    })
    .await
    .map_err(|err| format!("Promotion recovery verification task failed: {err}"))?;

    let verified_marker = match verification {
        MarkerVerification::MatchesPromoted(marker) => marker,
        MarkerVerification::MatchesRolledBackPreRetry => {
            retire_promotion_marker_async(&marker_path)
                .await
                .map_err(|err| {
                    format!("Could not retire rolled-back Voquill promotion marker: {err}")
                })?;
            return retry_database_promotion(dirs, database, report).await;
        }
        MarkerVerification::IoError(detail) => {
            return Err(detail);
        }
        MarkerVerification::Mismatch => {
            remove_promotion_marker(&marker_path).await;
            *report = mark_existing_profile_conflict(&dirs.current_config_dir, report.clone());
            return Ok(None);
        }
    };

    if let Some(parent) = current_db.parent().map(Path::to_path_buf) {
        tokio::task::spawn_blocking(move || sync_dir_best_effort(&parent))
            .await
            .map_err(|err| format!("Destination directory sync task failed: {err}"))?
            .map_err(|err| {
                format!(
                    "Could not sync destination directory while recovering promoted database: {err}"
                )
            })?;
    }

    let current_pool = database.pool();
    let (audit, newly_opened_pool) = if current_pool.is_closed() {
        let dirs_for_restore = dirs.clone();
        let manifest_for_restore = match try_load_manifest(&dirs.current_config_dir) {
            Ok(manifest) => manifest,
            Err(err) => {
                if has_any_pre_retry_backup(&dirs.current_db_path()) {
                    return Err(err);
                }
                None
            }
        };
        tokio::task::spawn_blocking(move || {
            reconcile_orphaned_pre_retry_backup(&dirs_for_restore, manifest_for_restore.as_ref())
        })
        .await
        .map_err(|err| format!("Pre-retry backup reconciliation task failed: {err}"))??;

        let opened = open_app_database_strict(&current_db).await.map_err(|err| {
            format!(
                "Could not open promoted database during retry recovery: {}",
                err.message()
            )
        })?;
        let audit = match audit_migrated_database(opened.clone()).await {
            Ok(audit) => audit,
            Err(err) => {
                opened.close().await;
                return Err(format!(
                    "Could not audit promoted database during retry recovery: {err}"
                ));
            }
        };
        (audit, Some(opened))
    } else {
        let live_pool = ensure_usable_pool(dirs, database).await?;
        let audit = audit_migrated_database(live_pool).await.map_err(|err| {
            format!("Could not audit promoted database during retry recovery: {err}")
        })?;
        (audit, None)
    };

    apply_recovered_database_audit(report, audit.counts, verified_marker.removed_modes_reset);
    if let Err(err) = save_manifest(&dirs.current_config_dir, report) {
        if let Some(pool) = newly_opened_pool {
            pool.close().await;
        }
        return Err(format!("Could not save recovered migration state: {err}"));
    }
    if let Some(pool) = newly_opened_pool {
        let _ = database.replace_pool(pool);
    }
    let cleanup_db = current_db.clone();
    let _ = tokio::task::spawn_blocking(move || remove_rollback_backup(&cleanup_db)).await;
    Ok(Some(audit.attention_providers))
}

/// Retries an incomplete (`Partial`) or `Failed` Voquill migration safely:
/// - Never duplicates rows or overwrites a database containing user data.
/// - If `database_phase == Migrated`, retries only unfinished asset phases.
/// - If `database_phase == Failed | Pending` and the active database is still
///   empty of user data, stages, validates, migrates, and swaps in the Voquill
///   DB cleanly while keeping a rollback backup until the new pool opens.
pub async fn retry_migration(
    dirs: MigrationDirs,
    database: OptionKeyDatabase,
) -> Result<VoquillMigrationReport, String> {
    let mut report = match try_load_manifest(&dirs.current_config_dir) {
        Ok(Some(report)) => report,
        Ok(None) => return Ok(VoquillMigrationReport::not_needed()),
        Err(detail) => return Err(detail),
    };

    if matches!(
        report.status,
        VoquillMigrationStatus::Completed
            | VoquillMigrationStatus::SkippedExistingProfile
            | VoquillMigrationStatus::NotNeeded
    ) {
        let live_pool = ensure_usable_pool(&dirs, &database).await?;
        return Ok(refresh_migration_report(dirs, live_pool).await);
    }

    report.attempt_count = report.attempt_count.saturating_add(1);
    report.dismissed_at = None;
    let mut attention_providers = Vec::new();

    if matches!(
        report.database_phase,
        VoquillMigrationPhaseStatus::Failed | VoquillMigrationPhaseStatus::Pending
    ) {
        let step_result = if path_exists_no_follow(&dirs.promotion_marker_path()).await
            && path_exists_no_follow(&dirs.current_db_path()).await
        {
            recover_promoted_db_during_retry(&dirs, &database, &mut report).await?
        } else {
            retry_database_promotion(&dirs, &database, &mut report).await?
        };
        match step_result {
            Some(providers) => attention_providers = providers,
            None => {
                let live_pool = ensure_usable_pool(&dirs, &database).await?;
                return Ok(refresh_migration_report(dirs, live_pool).await);
            }
        }
    }

    migrate_asset_phases(&dirs, &mut report);
    report.legacy_source_preserved = legacy_source_still_present(&dirs);

    if attention_providers.is_empty() {
        let live_pool = ensure_usable_pool(&dirs, &database).await?;
        if let Ok((total, attention, providers)) = inspect_live_api_key_attention(live_pool).await {
            report.counts.provider_entries = total;
            report.counts.providers_needing_attention = attention;
            attention_providers = providers;
        }
    }

    finalize_status_and_actions(&mut report, attention_providers);
    save_manifest(&dirs.current_config_dir, &report)
        .map_err(|err| format!("Could not save migration state: {err}"))?;
    if report.database_phase == VoquillMigrationPhaseStatus::Migrated {
        remove_promotion_marker(&dirs.promotion_marker_path()).await;
    }
    remove_asset_progress_if_settled(&dirs.current_config_dir, &report);

    let live_pool = ensure_usable_pool(&dirs, &database).await?;
    Ok(refresh_migration_report(dirs, live_pool).await)
}

async fn stage_validate_in_staging_only(
    dirs: &MigrationDirs,
) -> Result<(PathBuf, StagedDbSuccess), VoquillMigrationIssue> {
    let staging_dir = dirs.staging_dir();
    let result = stage_validate_in_staging_inner(dirs, &staging_dir).await;
    if result.is_err() {
        cleanup_staging(&staging_dir);
    }
    result
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileFingerprint {
    exists: bool,
    len: u64,
    modified: Option<std::time::SystemTime>,
    sha256: Option<String>,
}

fn fingerprint_path(path: &Path) -> io::Result<FileFingerprint> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(FileFingerprint {
            exists: true,
            len: meta.len(),
            modified: meta.modified().ok(),
            sha256: Some(sha256_file_hex(path)?),
        }),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(FileFingerprint {
            exists: false,
            len: 0,
            modified: None,
            sha256: None,
        }),
        Err(err) => Err(err),
    }
}

fn fingerprint_tracked_files(
    tracked: &[&Path],
) -> Result<Vec<FileFingerprint>, VoquillMigrationIssue> {
    tracked
        .iter()
        .map(|p| {
            fingerprint_path(p).map_err(|err| VoquillMigrationIssue {
                category: "database".to_string(),
                code: "legacy_source_busy".to_string(),
                detail: format!(
                    "Could not verify quiescence of Voquill database file while copying: {err}"
                ),
            })
        })
        .collect()
}

fn verify_staged_matches_before(
    before: &[FileFingerprint],
    staging_dir: &Path,
) -> io::Result<bool> {
    let staged_paths = [
        staging_dir.join(STAGED_DB_FILENAME),
        staging_dir.join(format!("{STAGED_DB_FILENAME}-wal")),
        staging_dir.join(format!("{STAGED_DB_FILENAME}-shm")),
        staging_dir.join(format!("{STAGED_DB_FILENAME}-journal")),
    ];
    for (idx, (fp, staged_path)) in before.iter().zip(staged_paths.iter()).enumerate() {
        // `-shm` is optional and may be skipped if absent when WAL is absent.
        if idx == 2 && !before[1].exists {
            continue;
        }
        let staged_fp = fingerprint_path(staged_path)?;
        if staged_fp.exists != fp.exists || staged_fp.sha256 != fp.sha256 {
            return Ok(false);
        }
    }
    Ok(true)
}

fn legacy_sqlite_paths(legacy_db: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let legacy_dir = legacy_db.parent().unwrap_or_else(|| Path::new(""));
    (
        legacy_dir.join(format!("{LEGACY_DB_FILENAME}-wal")),
        legacy_dir.join(format!("{LEGACY_DB_FILENAME}-shm")),
        legacy_dir.join(format!("{LEGACY_DB_FILENAME}-journal")),
    )
}

fn verify_regular_or_missing_no_symlink(
    path: &Path,
    code: &str,
    label: &str,
) -> Result<bool, VoquillMigrationIssue> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(VoquillMigrationIssue {
            category: "database".to_string(),
            code: code.to_string(),
            detail: format!("Could not copy the {label}: refusing to import a symbolic link"),
        }),
        Ok(meta) if !meta.is_file() => Err(VoquillMigrationIssue {
            category: "database".to_string(),
            code: code.to_string(),
            detail: format!("Could not copy the {label}: source path is not a regular file"),
        }),
        Ok(_) => Ok(true),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(VoquillMigrationIssue {
            category: "database".to_string(),
            code: code.to_string(),
            detail: format!("Could not inspect the {label}: {err}"),
        }),
    }
}

fn prepare_staging_and_verify_legacy_files(
    legacy_db: &Path,
    staging_dir: &Path,
) -> Result<(), VoquillMigrationIssue> {
    cleanup_staging(staging_dir);
    fs::create_dir_all(staging_dir).map_err(|err| VoquillMigrationIssue {
        category: "database".to_string(),
        code: "staging_io_error".to_string(),
        detail: format!("Could not prepare migration staging directory: {err}"),
    })?;

    if !verify_regular_or_missing_no_symlink(legacy_db, "database_copy_failed", "Voquill database")?
    {
        return Err(VoquillMigrationIssue {
            category: "database".to_string(),
            code: "database_copy_failed".to_string(),
            detail: "Could not copy the Voquill database: file not found".to_string(),
        });
    }

    let (legacy_wal, legacy_shm, legacy_journal) = legacy_sqlite_paths(legacy_db);
    verify_regular_or_missing_no_symlink(
        &legacy_wal,
        "wal_copy_failed",
        "Voquill WAL journal file",
    )?;
    verify_regular_or_missing_no_symlink(
        &legacy_shm,
        "wal_copy_failed",
        "Voquill WAL shared-memory file",
    )?;
    verify_regular_or_missing_no_symlink(
        &legacy_journal,
        "journal_copy_failed",
        "Voquill rollback journal file",
    )?;
    Ok(())
}

enum SnapshotFallback {
    Skipped(&'static str),
    Busy(String),
    Error(String),
}

fn is_sqlite_busy_or_locked(err: &sqlx::Error) -> bool {
    let msg = err.to_string().to_ascii_lowercase();
    msg.contains("locked") || msg.contains("busy")
}

fn legacy_db_uses_wal_header(legacy_db: &Path) -> bool {
    let Ok(mut file) = File::open(legacy_db) else {
        return false;
    };
    let mut header = [0u8; 20];
    file.read_exact(&mut header).is_ok() && (header[18] == 2 || header[19] == 2)
}

/// Attempts a transactionally consistent read-only SQLite `VACUUM INTO`
/// snapshot of `legacy_db` into `staged_db`. Holds a SQLite read transaction
/// across the snapshot without modifying the legacy database or its sidecar
/// files.
///
/// Skips direct SQLite open whenever WAL mode or any SQLite sidecar (`-wal`,
/// `-shm`, `-journal`) is present so SQLite can never create, recover, or map
/// `-shm` read-write in the original Voquill directory; the caller falls back
/// to the SHA-256 quiescence-verified file copy into staging.
async fn try_readonly_sqlite_snapshot(
    legacy_db: &Path,
    staged_db: &Path,
) -> Result<(), SnapshotFallback> {
    let (legacy_wal, legacy_shm, legacy_journal) = legacy_sqlite_paths(legacy_db);
    let wal_exists = path_exists_no_follow(&legacy_wal).await;
    let shm_exists = path_exists_no_follow(&legacy_shm).await;
    let journal_exists = path_exists_no_follow(&legacy_journal).await;
    let legacy_for_header = legacy_db.to_path_buf();
    let uses_wal_header =
        tokio::task::spawn_blocking(move || legacy_db_uses_wal_header(&legacy_for_header))
            .await
            .unwrap_or(false);

    if wal_exists || shm_exists || journal_exists || uses_wal_header {
        return Err(SnapshotFallback::Skipped(
            "legacy database uses WAL mode or has SQLite sidecars; using read-only file copy",
        ));
    }

    let staged_str = staged_db
        .to_str()
        .ok_or_else(|| SnapshotFallback::Error("staging path is not valid UTF-8".to_string()))?;
    let options = SqliteConnectOptions::new()
        .filename(legacy_db)
        .read_only(true)
        .create_if_missing(false)
        .busy_timeout(std::time::Duration::from_millis(0));
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|err| {
            if is_sqlite_busy_or_locked(&err) {
                SnapshotFallback::Busy(format!("read-only open busy: {err}"))
            } else {
                SnapshotFallback::Error(format!("read-only open failed: {err}"))
            }
        })?;

    let vacuum_result = sqlx::query("VACUUM INTO ?1")
        .bind(staged_str)
        .execute(&pool)
        .await;
    pool.close().await;

    vacuum_result.map(|_| ()).map_err(|err| {
        if is_sqlite_busy_or_locked(&err) {
            SnapshotFallback::Busy(format!("VACUUM INTO busy: {err}"))
        } else {
            SnapshotFallback::Error(format!("VACUUM INTO failed: {err}"))
        }
    })
}

fn copy_legacy_files_once(
    legacy_db: &Path,
    staging_dir: &Path,
) -> Result<PathBuf, VoquillMigrationIssue> {
    let staged_db = staging_dir.join(STAGED_DB_FILENAME);
    copy_file_strict_no_symlink(legacy_db, &staged_db).map_err(|detail| VoquillMigrationIssue {
        category: "database".to_string(),
        code: "database_copy_failed".to_string(),
        detail: format!("Could not copy the Voquill database: {detail}"),
    })?;

    let (legacy_wal, legacy_shm, legacy_journal) = legacy_sqlite_paths(legacy_db);

    if fs::symlink_metadata(&legacy_wal).is_ok() {
        let staged_wal = staging_dir.join(format!("{STAGED_DB_FILENAME}-wal"));
        copy_file_strict_no_symlink(&legacy_wal, &staged_wal).map_err(|detail| {
            VoquillMigrationIssue {
                category: "database".to_string(),
                code: "wal_copy_failed".to_string(),
                detail: format!("Could not copy the Voquill WAL journal file: {detail}"),
            }
        })?;
        if fs::symlink_metadata(&legacy_shm).is_ok() {
            let staged_shm = staging_dir.join(format!("{STAGED_DB_FILENAME}-shm"));
            if copy_file_strict_no_symlink(&legacy_shm, &staged_shm).is_err() {
                let _ = fs::remove_file(&staged_shm);
            }
        }
    }

    if fs::symlink_metadata(&legacy_journal).is_ok() {
        let staged_journal = staging_dir.join(format!("{STAGED_DB_FILENAME}-journal"));
        copy_file_strict_no_symlink(&legacy_journal, &staged_journal).map_err(|detail| {
            VoquillMigrationIssue {
                category: "database".to_string(),
                code: "journal_copy_failed".to_string(),
                detail: format!("Could not copy the Voquill rollback journal file: {detail}"),
            }
        })?;
    }

    Ok(staged_db)
}

/// Fallback staging when read-only SQLite `VACUUM INTO` cannot open the source
/// (e.g., an unrecovered WAL with no `-shm`, or a corrupt file). Verifies that
/// `voquill.db` and its WAL/journal sidecars remained quiescent across the copy
/// so a concurrent Voquill checkpoint cannot silently drop committed rows.
fn stage_legacy_database_files_quiescent(
    legacy_db: &Path,
    staging_dir: &Path,
) -> Result<PathBuf, VoquillMigrationIssue> {
    let (legacy_wal, legacy_shm, legacy_journal) = legacy_sqlite_paths(legacy_db);
    let tracked = [legacy_db, &legacy_wal, &legacy_shm, &legacy_journal];

    for _attempt in 0..3 {
        cleanup_staging(staging_dir);
        fs::create_dir_all(staging_dir).map_err(|err| VoquillMigrationIssue {
            category: "database".to_string(),
            code: "staging_io_error".to_string(),
            detail: format!("Could not prepare migration staging directory: {err}"),
        })?;

        let before = fingerprint_tracked_files(&tracked)?;
        let staged_db = copy_legacy_files_once(legacy_db, staging_dir)?;
        let staged_matches = verify_staged_matches_before(&before, staging_dir).map_err(|err| {
            VoquillMigrationIssue {
                category: "database".to_string(),
                code: "legacy_source_busy".to_string(),
                detail: format!("Could not verify copied Voquill database snapshot: {err}"),
            }
        })?;
        let after = fingerprint_tracked_files(&tracked)?;

        if staged_matches && before == after {
            return Ok(staged_db);
        }
    }

    Err(VoquillMigrationIssue {
        category: "database".to_string(),
        code: "legacy_source_busy".to_string(),
        detail:
            "The Voquill database changed while being copied. Close Voquill and retry migration."
                .to_string(),
    })
}

fn checkpoint_issue(detail: String) -> VoquillMigrationIssue {
    VoquillMigrationIssue {
        category: "database".to_string(),
        code: "database_checkpoint_failed".to_string(),
        detail,
    }
}

async fn checkpoint_staged_db_to_delete_mode(
    staged_db: &Path,
) -> Result<(), VoquillMigrationIssue> {
    let finalize_options = SqliteConnectOptions::new()
        .filename(staged_db)
        .create_if_missing(false)
        .busy_timeout(std::time::Duration::from_secs(5));
    let finalize_pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(finalize_options)
        .await
        .map_err(|err| {
            checkpoint_issue(format!(
                "Could not open staged database for final checkpoint: {err}"
            ))
        })?;

    let result = async {
        let (busy, log_frames, checkpointed): (i64, i64, i64) =
            sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
                .fetch_one(&finalize_pool)
                .await
                .map_err(|err| {
                    checkpoint_issue(format!("Could not checkpoint staged database WAL: {err}"))
                })?;

        if busy != 0 || (log_frames > 0 && checkpointed < log_frames) {
            return Err(checkpoint_issue(format!(
                "Staged database WAL checkpoint did not complete (busy={busy}, log={log_frames}, checkpointed={checkpointed})."
            )));
        }

        let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode = DELETE")
            .fetch_one(&finalize_pool)
            .await
            .map_err(|err| {
                checkpoint_issue(format!(
                    "Could not switch staged database to DELETE journal mode: {err}"
                ))
            })?;

        if !journal_mode.eq_ignore_ascii_case("delete") {
            return Err(checkpoint_issue(format!(
                "Staged database remained in unexpected journal mode: {journal_mode}"
            )));
        }
        Ok(())
    }
    .await;

    finalize_pool.close().await;
    result
}

async fn verify_and_audit_standalone_db(
    staged_db: &Path,
) -> Result<DatabaseAudit, VoquillMigrationIssue> {
    let verify_options = SqliteConnectOptions::new()
        .filename(staged_db)
        .read_only(true)
        .create_if_missing(false);
    let verify_pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(verify_options)
        .await
        .map_err(|err| VoquillMigrationIssue {
            category: "database".to_string(),
            code: "database_audit_failed".to_string(),
            detail: format!("Could not verify finalized database file: {err}"),
        })?;

    let result = async {
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&verify_pool)
            .await
            .map_err(|err| VoquillMigrationIssue {
                category: "database".to_string(),
                code: "corrupt_database".to_string(),
                detail: format!("Post-checkpoint integrity check failed: {err}"),
            })?;

        if !integrity.eq_ignore_ascii_case("ok") {
            return Err(VoquillMigrationIssue {
                category: "database".to_string(),
                code: "corrupt_database".to_string(),
                detail: format!("Post-checkpoint integrity check reported errors: {integrity}"),
            });
        }

        audit_migrated_database(verify_pool.clone())
            .await
            .map_err(|detail| VoquillMigrationIssue {
                category: "database".to_string(),
                code: "database_audit_failed".to_string(),
                detail,
            })
    }
    .await;

    verify_pool.close().await;
    result
}

async fn finalize_and_verify_staged_database(
    migrated_pool: SqlitePool,
    staged_db: &Path,
    staging_dir: &Path,
) -> Result<DatabaseAudit, VoquillMigrationIssue> {
    // Close the multi-connection migration pool first so the finalizing
    // connection below is the sole handle to `staged_db`; SQLite requires
    // exclusive access to switch out of WAL mode (`PRAGMA journal_mode = DELETE`)
    // without hitting SQLITE_BUSY from idle sibling pool connections.
    migrated_pool.close().await;

    checkpoint_staged_db_to_delete_mode(staged_db).await?;

    for suffix in ["-wal", "-shm", "-journal"] {
        let _ =
            tokio::fs::remove_file(staging_dir.join(format!("{STAGED_DB_FILENAME}{suffix}"))).await;
    }

    // Re-open the standalone main file read-only after checkpointing and
    // sidecar removal so both integrity check and audited counts reflect the
    // exact file being promoted.
    verify_and_audit_standalone_db(staged_db).await
}

async fn stage_validate_in_staging_inner(
    dirs: &MigrationDirs,
    staging_dir: &Path,
) -> Result<(PathBuf, StagedDbSuccess), VoquillMigrationIssue> {
    let Some(legacy_db) = dirs.legacy_db_path() else {
        return Err(VoquillMigrationIssue {
            category: "database".to_string(),
            code: "legacy_path_unavailable".to_string(),
            detail: "Legacy Voquill config directory could not be resolved.".to_string(),
        });
    };

    let verify_legacy = legacy_db.clone();
    let verify_staging = staging_dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        prepare_staging_and_verify_legacy_files(&verify_legacy, &verify_staging)
    })
    .await
    .map_err(|err| VoquillMigrationIssue {
        category: "database".to_string(),
        code: "staging_io_error".to_string(),
        detail: format!("Migration staging task failed: {err}"),
    })??;

    let staged_db = staging_dir.join(STAGED_DB_FILENAME);
    let staged_db = match try_readonly_sqlite_snapshot(&legacy_db, &staged_db).await {
        Ok(()) => staged_db,
        Err(SnapshotFallback::Busy(reason)) => {
            // Never bypass SQLite locking with a raw file copy when a live
            // writer holds an active transaction (e.g. `journal_mode=MEMORY`
            // spilling uncommitted pages to the main file without a sidecar).
            log::warn!("Voquill DB is locked by an active writer ({reason}); refusing raw copy");
            return Err(VoquillMigrationIssue {
                category: "database".to_string(),
                code: "legacy_source_busy".to_string(),
                detail:
                    "The Voquill database is currently in use. Close Voquill and retry migration."
                        .to_string(),
            });
        }
        Err(fallback) => {
            match fallback {
                SnapshotFallback::Skipped(reason) => {
                    log::debug!(
                        "Voquill DB snapshot skipped ({reason}); falling back to quiescent copy"
                    );
                }
                SnapshotFallback::Error(err) => {
                    log::warn!("Voquill DB read-only snapshot failed ({err}); falling back to quiescent copy");
                }
                SnapshotFallback::Busy(_) => unreachable!(),
            }
            let fallback_legacy = legacy_db.clone();
            let fallback_staging = staging_dir.to_path_buf();
            tokio::task::spawn_blocking(move || {
                stage_legacy_database_files_quiescent(&fallback_legacy, &fallback_staging)
            })
            .await
            .map_err(|err| VoquillMigrationIssue {
                category: "database".to_string(),
                code: "staging_io_error".to_string(),
                detail: format!("Migration staging task failed: {err}"),
            })??
        }
    };

    let removed_modes_reset =
        precheck_and_inspect_staged_db(&staged_db)
            .await
            .map_err(|(code, detail)| VoquillMigrationIssue {
                category: "database".to_string(),
                code,
                detail,
            })?;

    let migrated_pool = open_app_database_strict(&staged_db)
        .await
        .map_err(|err| match err {
            StrictOpenError::Integrity(detail) => VoquillMigrationIssue {
                category: "database".to_string(),
                code: "corrupt_database".to_string(),
                detail,
            },
            StrictOpenError::SchemaIncompatible(detail) => VoquillMigrationIssue {
                category: "database".to_string(),
                code: "incompatible_schema".to_string(),
                detail,
            },
            StrictOpenError::Other(detail) => VoquillMigrationIssue {
                category: "database".to_string(),
                code: "database_migration_failed".to_string(),
                detail,
            },
        })?;

    let audit = finalize_and_verify_staged_database(migrated_pool, &staged_db, staging_dir).await?;

    Ok((
        staged_db,
        StagedDbSuccess {
            audit,
            removed_modes_reset,
        },
    ))
}

fn remove_db_files(current_db: &Path) {
    for suffix in ["-wal", "-shm", "-journal", ""] {
        let candidate = current_db.with_file_name(format!("{DB_FILENAME}{suffix}"));
        let _ = fs::remove_file(&candidate);
    }
}

fn move_current_db_to_rollback_backup(
    current_db: &Path,
) -> Result<Vec<&'static str>, RetrySwapError> {
    let mut moved: Vec<(&'static str, PathBuf, PathBuf)> = Vec::new();
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let src = current_db.with_file_name(format!("{DB_FILENAME}{suffix}"));
        let bak =
            current_db.with_file_name(format!("{DB_FILENAME}{suffix}{PRE_RETRY_BACKUP_SUFFIX}"));
        if fs::symlink_metadata(&src).is_err() {
            continue;
        }
        if let Err(err) = fs::rename(&src, &bak) {
            let mut restored_ok = true;
            for (_, orig, prev_bak) in moved.into_iter().rev() {
                if fs::rename(prev_bak, orig).is_err() {
                    restored_ok = false;
                }
            }
            return Err(RetrySwapError {
                issue: VoquillMigrationIssue {
                    category: "database".to_string(),
                    code: "promote_io_error".to_string(),
                    detail: format!(
                        "Could not back up existing mausVoice database before retry: {err}"
                    ),
                },
                restored_ok,
                installed_unsynced: false,
            });
        }
        moved.push((suffix, src, bak));
    }
    if let Some(parent) = current_db.parent() {
        let _ = sync_dir_best_effort(parent);
    }
    Ok(moved.into_iter().map(|(suffix, _, _)| suffix).collect())
}

fn restore_rollback_backup(current_db: &Path, suffixes: &[&str]) -> io::Result<()> {
    for suffix in suffixes {
        let dst = current_db.with_file_name(format!("{DB_FILENAME}{suffix}"));
        let bak =
            current_db.with_file_name(format!("{DB_FILENAME}{suffix}{PRE_RETRY_BACKUP_SUFFIX}"));
        if fs::symlink_metadata(&bak).is_ok() {
            fs::rename(&bak, &dst)?;
        }
    }
    if let Some(parent) = current_db.parent() {
        let _ = sync_dir_best_effort(parent);
    }
    Ok(())
}

fn remove_rollback_backup(current_db: &Path) {
    let mut removed_any = false;
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let bak =
            current_db.with_file_name(format!("{DB_FILENAME}{suffix}{PRE_RETRY_BACKUP_SUFFIX}"));
        if fs::remove_file(&bak).is_ok() {
            removed_any = true;
        }
    }
    if removed_any {
        if let Some(parent) = current_db.parent() {
            let _ = sync_dir_best_effort(parent);
        }
    }
}

#[derive(Debug)]
enum PromoteError {
    NotInstalled(VoquillMigrationIssue),
    InstalledButNotSynced(VoquillMigrationIssue),
}

fn existing_profile_conflict_issue() -> VoquillMigrationIssue {
    VoquillMigrationIssue {
        category: "database".to_string(),
        code: "existing_profile_conflict".to_string(),
        detail: "An existing mausVoice database already exists and was kept untouched.".to_string(),
    }
}

fn sync_file_for_write(path: &Path) -> io::Result<()> {
    let file = OpenOptions::new().write(true).open(path)?;
    file.sync_all()
}

fn copy_file_and_sync(src: &Path, dst: &Path) -> io::Result<()> {
    match fs::remove_file(dst) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    let mut src_file = File::open(src)?;
    let mut dst_file = OpenOptions::new().write(true).create_new(true).open(dst)?;
    let copy_res = (|| -> io::Result<()> {
        io::copy(&mut src_file, &mut dst_file)?;
        dst_file.sync_all()?;
        Ok(())
    })();
    drop(dst_file);
    if let Err(err) = copy_res {
        let _ = fs::remove_file(dst);
        return Err(err);
    }
    Ok(())
}

fn publish_temp_db_no_replace_with<F>(tmp_dest: &Path, dst: &Path, link_fn: F) -> io::Result<()>
where
    F: FnOnce(&Path, &Path) -> io::Result<()>,
{
    match link_fn(tmp_dest, dst) {
        Ok(()) => {
            let _ = fs::remove_file(tmp_dest);
            Ok(())
        }
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => Err(err),
        Err(err) => {
            if fs::symlink_metadata(dst).is_ok() {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "destination database already exists",
                ));
            }
            Err(err)
        }
    }
}

fn install_file_no_replace_via_copy_fallback_with<F>(
    staged_db: &Path,
    current_db: &Path,
    primary_err: &io::Error,
    link_fn: F,
) -> Result<(), PromoteError>
where
    F: FnOnce(&Path, &Path) -> io::Result<()>,
{
    let tmp_dest = current_db.with_file_name(format!("{DB_FILENAME}{PROMOTION_TEMP_SUFFIX}"));
    if let Err(copy_err) = copy_file_and_sync(staged_db, &tmp_dest) {
        return Err(PromoteError::NotInstalled(VoquillMigrationIssue {
            category: "database".to_string(),
            code: "promote_io_error".to_string(),
            detail: format!(
                "Could not stage verified database for promotion (link: {primary_err}; copy: {copy_err})"
            ),
        }));
    }
    match publish_temp_db_no_replace_with(&tmp_dest, current_db, link_fn) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            let _ = fs::remove_file(&tmp_dest);
            Err(PromoteError::NotInstalled(existing_profile_conflict_issue()))
        }
        Err(publish_err) => {
            let _ = fs::remove_file(&tmp_dest);
            Err(PromoteError::NotInstalled(VoquillMigrationIssue {
                category: "database".to_string(),
                code: "promote_io_error".to_string(),
                detail: format!(
                    "Could not atomically promote verified database (link: {primary_err}; publish: {publish_err})"
                ),
            }))
        }
    }
}

fn hard_link_paths(src: &Path, dst: &Path) -> io::Result<()> {
    fs::hard_link(src, dst)
}

fn install_file_no_replace_via_copy_fallback(
    staged_db: &Path,
    current_db: &Path,
    primary_err: &io::Error,
) -> Result<(), PromoteError> {
    install_file_no_replace_via_copy_fallback_with(
        staged_db,
        current_db,
        primary_err,
        hard_link_paths,
    )
}

fn promote_staged_file_with_sync<F>(
    staged_db: &Path,
    current_db: &Path,
    sync_dir: F,
) -> Result<(), PromoteError>
where
    F: FnOnce(&Path) -> io::Result<()>,
{
    if let Err(sync_err) = sync_file_for_write(staged_db) {
        return Err(PromoteError::NotInstalled(VoquillMigrationIssue {
            category: "database".to_string(),
            code: "promote_io_error".to_string(),
            detail: format!("Could not sync staged database before promotion: {sync_err}"),
        }));
    }

    match fs::hard_link(staged_db, current_db) {
        Ok(()) => {
            let _ = fs::remove_file(staged_db);
        }
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            return Err(PromoteError::NotInstalled(existing_profile_conflict_issue()));
        }
        Err(link_err) => {
            install_file_no_replace_via_copy_fallback(staged_db, current_db, &link_err)?;
            let _ = fs::remove_file(staged_db);
        }
    }

    if let Some(parent) = current_db.parent() {
        sync_dir(parent).map_err(|err| {
            PromoteError::InstalledButNotSynced(VoquillMigrationIssue {
                category: "database".to_string(),
                code: "promote_sync_failed".to_string(),
                detail: format!(
                    "Could not sync destination directory after database promotion: {err}"
                ),
            })
        })?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose, Engine as _};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempWorkspace(PathBuf);

    impl std::ops::Deref for TempWorkspace {
        type Target = Path;

        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    impl Drop for TempWorkspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn unique_workspace(label: &str) -> TempWorkspace {
        let dir = std::env::temp_dir().join(format!(
            "mausvoice-voquill-mig-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("create temp workspace");
        TempWorkspace(dir)
    }

    fn make_dirs(root: &Path) -> MigrationDirs {
        let current_config_dir = root.join("config").join("com.mausinc.desktop");
        let current_data_dir = root.join("data").join("com.mausinc.desktop");
        let legacy_config_dir = root.join("config").join("com.voquill.desktop");
        let legacy_data_dir = root.join("data").join("com.voquill.desktop");
        MigrationDirs {
            current_config_dir,
            current_data_dir,
            legacy_config_dir: Some(legacy_config_dir),
            legacy_data_dir: Some(legacy_data_dir),
        }
    }

    /// Creates a real SQLite database matching an older Voquill schema
    /// (applying migrations up through `max_version`), with authentic Voquill
    /// 16-byte-salt encrypted API key rows, transcriptions, terms, hotkeys, and
    /// cloud-mode preferences.
    async fn seed_voquill_db(db_path: &Path, max_version: i64, keep_in_wal: bool) {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).expect("create legacy config dir");
        }
        let options = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("open seed voquill db");

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS _sqlx_migrations (
                version BIGINT PRIMARY KEY,
                description TEXT NOT NULL,
                installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                success BOOLEAN NOT NULL,
                checksum BLOB NOT NULL,
                execution_time BIGINT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("create migrations ledger");

        for migration in crate::db::migrations() {
            if migration.version > max_version {
                continue;
            }
            let mut tx = pool.begin().await.expect("begin migration tx");
            sqlx::raw_sql(migration.sql)
                .execute(&mut *tx)
                .await
                .unwrap_or_else(|err| {
                    panic!(
                        "migration {} ({}) failed in seed: {err}",
                        migration.version, migration.description
                    )
                });
            let checksum = crate::db::open::migration_checksum(migration.sql);
            sqlx::query(
                "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
                 VALUES (?1, ?2, TRUE, ?3, 1)",
            )
            .bind(migration.version)
            .bind(migration.description)
            .bind(checksum)
            .execute(&mut *tx)
            .await
            .expect("record migration");
            tx.commit().await.expect("commit migration");
        }

        if keep_in_wal {
            sqlx::query("PRAGMA journal_mode = WAL")
                .execute(&pool)
                .await
                .expect("enable WAL");
            sqlx::query("PRAGMA wal_autocheckpoint = 0")
                .execute(&pool)
                .await
                .expect("disable autocheckpoint");
        }

        sqlx::query(
            "INSERT INTO user_profiles (id, name, bio, onboarded)
             VALUES ('local', 'Ada Lovelace', '', 1)",
        )
        .execute(&pool)
        .await
        .expect("seed user_profiles");

        sqlx::query(
            "INSERT INTO transcriptions (id, transcript, timestamp, audio_path)
             VALUES ('tx-1', 'Private dictation content must never leak', 1700000200, '/old/voquill/tx-1.wav')",
        )
        .execute(&pool)
        .await
        .expect("seed transcription");

        sqlx::query(
            "INSERT INTO terms (id, created_at, created_by_user_id, source_value, destination_value)
             VALUES ('term-1', 1700000300, 'local', 'maus', 'mausVoice')",
        )
        .execute(&pool)
        .await
        .expect("seed term");

        sqlx::query(
            "INSERT INTO hotkeys (id, action_name, keys)
             VALUES ('hk-1', 'dictate', '[\"Alt\",\"Space\"]')",
        )
        .execute(&pool)
        .await
        .expect("seed hotkey");

        // Authentic Voquill 16-byte salt + SHA-256 XOR ciphertext (unreadable by mausVoice XChaCha20).
        let voquill_salt_b64 = general_purpose::STANDARD.encode([0x5Au8; 16]);
        let voquill_hash_b64 = general_purpose::STANDARD.encode([0x33u8; 32]);
        let voquill_cipher_b64 = general_purpose::STANDARD.encode(b"voquill-secret-ciphertext");

        sqlx::query(
            "INSERT INTO api_keys (id, name, provider, created_at, salt, key_hash, key_ciphertext, key_suffix)
             VALUES ('key-groq', 'Personal Groq', 'groq', 1700000400, ?1, ?2, ?3, '9999')",
        )
        .bind(&voquill_salt_b64)
        .bind(&voquill_hash_b64)
        .bind(&voquill_cipher_b64)
        .execute(&pool)
        .await
        .expect("seed groq api key");

        if max_version >= 16 {
            sqlx::query(
                "INSERT INTO user_preferences (user_id, transcription_mode, post_processing_mode)
                 VALUES ('local', 'cloud', 'cloud')",
            )
            .execute(&pool)
            .await
            .expect("seed user_preferences");
        } else if max_version >= 11 {
            sqlx::query(
                "UPDATE user_profiles
                 SET preferred_transcription_mode = 'cloud',
                     preferred_post_processing_mode = 'cloud'
                 WHERE id = 'local'",
            )
            .execute(&pool)
            .await
            .expect("seed legacy user_profiles cloud modes");
        }

        if keep_in_wal {
            // Drop without checkpointing by using SQLITE_CHECKPOINT bypass via
            // PRAGMA wal_autocheckpoint=0; to guarantee a live -wal exists on
            // disk even after close, keep another reader open while closing or
            // copy while open.
            sqlx::query(
                "INSERT INTO transcriptions (id, transcript, timestamp)
                 VALUES ('tx-wal-only', 'Committed inside WAL sidecar only', 1700000500)",
            )
            .execute(&pool)
            .await
            .expect("seed wal-only transcription");
        }

        if !keep_in_wal {
            pool.close().await;
        } else {
            // Avoid leaking the pool; tests needing a real WAL on disk pass
            // `pool` back via a dedicated helper.
            pool.close().await;
        }
    }

    #[tokio::test]
    async fn fresh_install_reports_not_needed_without_creating_manifest() {
        let root = unique_workspace("fresh");
        let dirs = make_dirs(&root);

        let report = run_startup_migration(&dirs).await;

        assert_eq!(report.status, VoquillMigrationStatus::NotNeeded);
        assert!(!report.legacy_detected);
        assert!(!dirs.manifest_path().exists());
        assert!(!dirs.current_db_path().exists());
    }

    #[tokio::test]
    async fn oldest_supported_voquill_profile_upgrades_and_flags_unreadable_keys() {
        let root = unique_workspace("oldest-upgrade");
        let dirs = make_dirs(&root);
        let legacy_db = dirs.legacy_db_path().unwrap();
        // Migration 15 is the earliest schema containing profiles, transcriptions,
        // terms, hotkeys, api_keys, and user_preferences.
        seed_voquill_db(&legacy_db, 15, false).await;

        // Seed optional models, audio, and storage icon assets under legacy Voquill data dir.
        let legacy_data = dirs.legacy_data_dir.as_ref().unwrap();
        fs::create_dir_all(legacy_data.join("models")).unwrap();
        fs::write(legacy_data.join("models/ggml-tiny.bin"), b"model-bytes").unwrap();
        fs::write(legacy_data.join("models/ggml-base.bin.part"), b"partial").unwrap();
        fs::create_dir_all(legacy_data.join("transcription-audio")).unwrap();
        fs::write(
            legacy_data.join("transcription-audio/tx-1.wav"),
            b"RIFFfake",
        )
        .unwrap();
        fs::create_dir_all(legacy_data.join("storage/icons")).unwrap();
        fs::write(legacy_data.join("storage/icons/app.png"), b"PNGfake").unwrap();

        let report = run_startup_migration(&dirs).await;

        assert_eq!(report.status, VoquillMigrationStatus::Completed);
        assert!(report.legacy_detected);
        assert!(report.legacy_source_preserved);
        assert_eq!(report.database_phase, VoquillMigrationPhaseStatus::Migrated);
        assert_eq!(report.models_phase, VoquillMigrationPhaseStatus::Migrated);
        assert_eq!(report.audio_phase, VoquillMigrationPhaseStatus::Migrated);
        assert_eq!(report.storage_phase, VoquillMigrationPhaseStatus::Migrated);
        assert!(report.counts.has_profile);
        assert!(report.counts.has_preferences);
        assert_eq!(report.counts.transcriptions, 1);
        assert_eq!(report.counts.dictionary_terms, 1);
        assert_eq!(report.counts.hotkeys, 1);
        assert_eq!(report.counts.provider_entries, 1);
        assert_eq!(report.counts.providers_needing_attention, 1);
        assert_eq!(report.counts.local_models_migrated, 1);
        assert_eq!(report.counts.audio_files_migrated, 1);
        assert_eq!(report.counts.storage_files_migrated, 1);
        assert!(report
            .removed_modes_reset
            .contains(&"transcription:cloud".to_string()));
        assert!(report
            .removed_modes_reset
            .contains(&"post_processing:cloud".to_string()));

        // Partial download file must NOT be migrated.
        assert!(dirs
            .current_data_dir
            .join("transcription-models/ggml-tiny.bin")
            .exists());
        assert!(!dirs
            .current_data_dir
            .join("transcription-models/ggml-base.bin.part")
            .exists());

        // Legacy Voquill files remain completely untouched.
        assert!(legacy_db.exists());
        assert!(legacy_data.join("models/ggml-tiny.bin").exists());
        assert!(legacy_data.join("transcription-audio/tx-1.wav").exists());

        // Privacy check: serialized report contains zero secrets or transcript contents.
        let report_json = serde_json::to_string(&report).unwrap();
        assert!(!report_json.contains("Private dictation content"));
        assert!(!report_json.contains("voquill-secret-ciphertext"));
        assert!(!report_json.contains("9999"));
        assert!(report_json.contains("Groq"));

        // Re-running startup migration is completely idempotent.
        let second = run_startup_migration(&dirs).await;
        assert_eq!(second.status, VoquillMigrationStatus::Completed);
        assert_eq!(second.attempt_count, 1);
        assert_eq!(second.counts.local_models_migrated, 1);

        // Live refresh updates attention count to 0 once the user re-enters the key.
        let live_pool = open_app_database(&dirs.current_db_path())
            .await
            .expect("open migrated db");
        let protected = crate::system::crypto::protect_api_key("gsk_fresh_valid_key_1234");
        sqlx::query(
            "UPDATE api_keys SET salt = ?1, key_hash = ?2, key_ciphertext = ?3, key_suffix = ?4 WHERE id = 'key-groq'",
        )
        .bind(&protected.salt_b64)
        .bind(&protected.hash_b64)
        .bind(&protected.ciphertext_b64)
        .bind(&protected.key_suffix)
        .execute(&live_pool)
        .await
        .expect("re-enter key");

        let refreshed = refresh_migration_report(dirs.clone(), live_pool.clone()).await;
        assert_eq!(refreshed.counts.providers_needing_attention, 0);
        assert!(refreshed
            .action_items
            .iter()
            .all(|item| item.kind != "reenter_api_keys"));

        // Dismissing persists dismissed_at without erasing the report.
        let dismissed = dismiss_migration_notice(dirs.clone(), live_pool.clone())
            .await
            .expect("dismiss");
        assert!(dismissed.dismissed_at.is_some());
        let reloaded = refresh_migration_report(dirs.clone(), live_pool.clone()).await;
        assert!(reloaded.dismissed_at.is_some());

        live_pool.close().await;
    }

    #[tokio::test]
    async fn wal_sidecar_transactions_are_preserved_without_modifying_legacy_source() {
        let root = unique_workspace("wal-preserve");
        let dirs = make_dirs(&root);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 68, false).await;

        // Open legacy DB in WAL mode with autocheckpoint disabled and keep a
        // reader open so SQLite keeps the new row strictly in `voquill.db-wal`.
        let writer_opts = SqliteConnectOptions::new()
            .filename(&legacy_db)
            .create_if_missing(false);
        let writer_pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(writer_opts)
            .await
            .expect("open wal pool");
        sqlx::query("PRAGMA journal_mode = WAL")
            .execute(&writer_pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA wal_autocheckpoint = 0")
            .execute(&writer_pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO transcriptions (id, transcript, timestamp)
             VALUES ('tx-wal', 'Wal transaction row', 1700000999)",
        )
        .execute(&writer_pool)
        .await
        .unwrap();

        let wal_path = legacy_db.with_file_name("voquill.db-wal");
        assert!(
            wal_path.exists() && fs::metadata(&wal_path).unwrap().len() > 0,
            "expected non-empty voquill.db-wal before migration"
        );

        let report = run_startup_migration(&dirs).await;
        writer_pool.close().await;

        assert_eq!(report.status, VoquillMigrationStatus::Completed);
        assert_eq!(report.counts.transcriptions, 2);

        let migrated_pool = open_app_database(&dirs.current_db_path()).await.unwrap();
        let wal_row_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM transcriptions WHERE id = 'tx-wal'")
                .fetch_one(&migrated_pool)
                .await
                .unwrap();
        assert_eq!(wal_row_count, 1);
        migrated_pool.close().await;
    }

    #[tokio::test]
    async fn missing_optional_files_still_complete_cleanly() {
        let root = unique_workspace("missing-optional");
        let dirs = make_dirs(&root);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 68, false).await;
        // Deliberately create NO models/, transcription-audio/, storage/, -wal, -shm, or -journal.

        let report = run_startup_migration(&dirs).await;

        assert_eq!(report.status, VoquillMigrationStatus::Completed);
        assert_eq!(report.database_phase, VoquillMigrationPhaseStatus::Migrated);
        assert_eq!(report.models_phase, VoquillMigrationPhaseStatus::NotFound);
        assert_eq!(report.audio_phase, VoquillMigrationPhaseStatus::NotFound);
        assert_eq!(report.storage_phase, VoquillMigrationPhaseStatus::NotFound);
        assert!(report.issues.is_empty());
    }

    #[tokio::test]
    async fn corrupt_legacy_db_fails_truthfully_and_recovers_on_retry() {
        let root = unique_workspace("corrupt-retry");
        let dirs = make_dirs(&root);
        let legacy_db = dirs.legacy_db_path().unwrap();
        fs::create_dir_all(legacy_db.parent().unwrap()).unwrap();
        fs::write(&legacy_db, b"not a real sqlite file at all").unwrap();

        let report = run_startup_migration(&dirs).await;

        assert_eq!(report.status, VoquillMigrationStatus::Failed);
        assert_eq!(report.database_phase, VoquillMigrationPhaseStatus::Failed);
        assert!(report.can_retry);
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.code == "corrupt_database"));
        // mausvoice.db must NOT have been polluted with corrupt bytes.
        assert!(!dirs.current_db_path().exists());

        // App boots cleanly with an empty fresh DB after failed migration.
        let empty_pool = open_app_database(&dirs.current_db_path()).await.unwrap();
        let db_state = OptionKeyDatabase::new(empty_pool);

        // User repairs / replaces the legacy DB (e.g., restores backup) and clicks Retry.
        fs::remove_file(&legacy_db).unwrap();
        seed_voquill_db(&legacy_db, 68, false).await;

        let retried = retry_migration(dirs.clone(), db_state.clone())
            .await
            .expect("retry succeeds");
        assert_eq!(retried.status, VoquillMigrationStatus::Completed);
        assert_eq!(
            retried.database_phase,
            VoquillMigrationPhaseStatus::Migrated
        );
        assert_eq!(retried.counts.transcriptions, 1);

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcriptions")
            .fetch_one(&db_state.pool())
            .await
            .unwrap();
        assert_eq!(count, 1);

        db_state.pool().close().await;
    }

    #[tokio::test]
    async fn existing_newer_mausvoice_profile_is_never_overwritten() {
        let root = unique_workspace("existing-profile");
        let dirs = make_dirs(&root);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 68, false).await;

        // Pre-create an active mausVoice database with distinct user data.
        fs::create_dir_all(&dirs.current_config_dir).unwrap();
        let existing_pool = open_app_database(&dirs.current_db_path()).await.unwrap();
        sqlx::query(
            "INSERT INTO transcriptions (id, transcript, timestamp)
             VALUES ('maus-existing', 'Newer mausVoice transcript', 1800000000)",
        )
        .execute(&existing_pool)
        .await
        .unwrap();
        existing_pool.close().await;

        let report = run_startup_migration(&dirs).await;

        assert_eq!(
            report.status,
            VoquillMigrationStatus::SkippedExistingProfile
        );
        assert_eq!(report.database_phase, VoquillMigrationPhaseStatus::Skipped);
        assert!(!report.can_retry);
        assert!(report.legacy_source_preserved);

        // Verify the existing mausVoice database was untouched.
        let check_pool = open_app_database(&dirs.current_db_path()).await.unwrap();
        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM transcriptions")
            .fetch_all(&check_pool)
            .await
            .unwrap();
        assert_eq!(ids, vec!["maus-existing".to_string()]);
        check_pool.close().await;
    }

    #[tokio::test]
    async fn retry_refuses_to_overwrite_once_user_creates_data_in_fresh_db() {
        let root = unique_workspace("retry-protects-new-data");
        let dirs = make_dirs(&root);
        let legacy_db = dirs.legacy_db_path().unwrap();
        fs::create_dir_all(legacy_db.parent().unwrap()).unwrap();
        fs::write(&legacy_db, b"corrupt").unwrap();

        let first = run_startup_migration(&dirs).await;
        assert_eq!(first.status, VoquillMigrationStatus::Failed);

        let live_pool = open_app_database(&dirs.current_db_path()).await.unwrap();
        sqlx::query(
            "INSERT INTO transcriptions (id, transcript, timestamp)
             VALUES ('new-user-tx', 'User already started using mausVoice', 1800000001)",
        )
        .execute(&live_pool)
        .await
        .unwrap();
        let db_state = OptionKeyDatabase::new(live_pool);

        // Even if legacy DB is later fixed, retry must NOT overwrite the active profile.
        fs::remove_file(&legacy_db).unwrap();
        seed_voquill_db(&legacy_db, 68, false).await;

        let retried = retry_migration(dirs.clone(), db_state.clone())
            .await
            .unwrap();
        assert_eq!(
            retried.status,
            VoquillMigrationStatus::SkippedExistingProfile
        );
        assert!(!retried.can_retry);

        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM transcriptions")
            .fetch_all(&db_state.pool())
            .await
            .unwrap();
        assert_eq!(ids, vec!["new-user-tx".to_string()]);

        db_state.pool().close().await;
    }

    #[tokio::test]
    async fn interrupted_staging_and_interrupted_asset_copy_recover_cleanly() {
        let root = unique_workspace("interrupted");
        let dirs = make_dirs(&root);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 68, false).await;

        // 1) Simulate crash during staging before DB promotion.
        fs::create_dir_all(dirs.staging_dir()).unwrap();
        fs::write(dirs.staging_dir().join(STAGED_DB_FILENAME), b"half-written").unwrap();

        let report = run_startup_migration(&dirs).await;
        assert_eq!(report.status, VoquillMigrationStatus::Completed);
        assert!(!dirs.staging_dir().exists());

        // 2) Simulate crash after DB promotion while asset phases were still Pending.
        let legacy_data = dirs.legacy_data_dir.as_ref().unwrap();
        fs::create_dir_all(legacy_data.join("transcription-audio")).unwrap();
        fs::write(
            legacy_data.join("transcription-audio/tx-1.wav"),
            b"RIFFaudio",
        )
        .unwrap();

        let mut interrupted_manifest = report.clone();
        interrupted_manifest.status = VoquillMigrationStatus::Partial;
        interrupted_manifest.audio_phase = VoquillMigrationPhaseStatus::Pending;
        interrupted_manifest.counts.audio_files_migrated = 0;
        save_manifest(&dirs.current_config_dir, &interrupted_manifest).unwrap();

        let resumed = run_startup_migration(&dirs).await;
        assert_eq!(resumed.status, VoquillMigrationStatus::Completed);
        assert_eq!(resumed.audio_phase, VoquillMigrationPhaseStatus::Migrated);
        assert_eq!(resumed.counts.audio_files_migrated, 1);
        assert!(dirs
            .current_data_dir
            .join("transcription-audio/tx-1.wav")
            .exists());
    }

    #[tokio::test]
    async fn incompatible_future_schema_fails_truthfully_without_quarantine_wipe() {
        let root = unique_workspace("incompatible-schema");
        let dirs = make_dirs(&root);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 68, false).await;

        // Inject a conflicting post-fork migration 69 checksum (e.g. upstream Voquill's 069).
        let options = SqliteConnectOptions::new()
            .filename(&legacy_db)
            .create_if_missing(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
             VALUES (69, 'remove_open_chat_hotkey', TRUE, X'deadbeef', 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let report = run_startup_migration(&dirs).await;

        assert_eq!(report.status, VoquillMigrationStatus::Failed);
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.code == "incompatible_schema"));
        assert!(!dirs.current_db_path().exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_wal_or_asset_is_refused_and_reported_truthfully() {
        use std::os::unix::fs::symlink;

        let root = unique_workspace("symlink-guard");
        let dirs = make_dirs(&root);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 68, false).await;

        // Case A: Symlinked -wal sidecar fails DB staging cleanly rather than following link.
        let decoy = root.join("decoy.txt");
        fs::write(&decoy, b"outside data").unwrap();
        let bad_wal = legacy_db.with_file_name("voquill.db-wal");
        symlink(&decoy, &bad_wal).unwrap();

        let failed = run_startup_migration(&dirs).await;
        assert_eq!(failed.status, VoquillMigrationStatus::Failed);
        assert!(failed
            .issues
            .iter()
            .any(|issue| issue.code == "wal_copy_failed"));
        assert!(!dirs.current_db_path().exists());

        // Case B: Remove bad WAL, add a symlink inside legacy audio -> DB succeeds,
        // audio phase reports Partial/Failed, retry after removing symlink completes.
        fs::remove_file(&bad_wal).unwrap();
        clear_migration_artifacts(&dirs.current_config_dir).unwrap();
        let legacy_audio = dirs
            .legacy_data_dir
            .as_ref()
            .unwrap()
            .join("transcription-audio");
        fs::create_dir_all(&legacy_audio).unwrap();
        fs::write(legacy_audio.join("good.wav"), b"RIFFok").unwrap();
        symlink(&decoy, legacy_audio.join("bad-link.wav")).unwrap();

        let partial = run_startup_migration(&dirs).await;
        assert_eq!(partial.status, VoquillMigrationStatus::Partial);
        assert_eq!(
            partial.database_phase,
            VoquillMigrationPhaseStatus::Migrated
        );
        assert_eq!(partial.audio_phase, VoquillMigrationPhaseStatus::Partial);
        assert!(partial.can_retry);
        assert_eq!(partial.counts.audio_files_migrated, 1);

        // Fix the symlink and retry: DB is untouched, status transitions to Completed.
        fs::remove_file(legacy_audio.join("bad-link.wav")).unwrap();
        let live_pool = open_app_database(&dirs.current_db_path()).await.unwrap();
        let db_state = OptionKeyDatabase::new(live_pool);
        let completed = retry_migration(dirs.clone(), db_state.clone())
            .await
            .unwrap();
        assert_eq!(completed.status, VoquillMigrationStatus::Completed);
        assert_eq!(completed.audio_phase, VoquillMigrationPhaseStatus::Migrated);
        assert!(!completed.can_retry);

        db_state.pool().close().await;
    }

    #[test]
    fn unknown_provider_name_always_maps_to_fixed_label() {
        assert_eq!(safe_provider_display_name("groq"), "Groq");
        assert_eq!(safe_provider_display_name("azure"), "Azure");
        assert_eq!(
            safe_provider_display_name("openai-compatible"),
            "OpenAI-compatible"
        );
        assert_eq!(
            safe_provider_display_name("https://internal.corp.local/v1?token=abc123"),
            "Custom provider"
        );
        assert_eq!(
            safe_provider_display_name("secret_provider_name"),
            "Custom provider"
        );
    }

    #[tokio::test]
    async fn pending_database_recovery_handles_unpromoted_promoted_and_unrelated_db() {
        // Case A: Crash before promotion (Pending manifest, no mausvoice.db) -> resumes and completes.
        let root_a = unique_workspace("pending-before-promote");
        let dirs_a = make_dirs(&root_a);
        let legacy_db_a = dirs_a.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db_a, 68, false).await;

        let pending_report = VoquillMigrationReport {
            schema_version: MANIFEST_SCHEMA_VERSION,
            status: VoquillMigrationStatus::Partial,
            legacy_detected: true,
            legacy_source_preserved: true,
            detected_at: Some(now_iso()),
            completed_at: None,
            dismissed_at: None,
            attempt_count: 1,
            database_phase: VoquillMigrationPhaseStatus::Pending,
            models_phase: VoquillMigrationPhaseStatus::Pending,
            audio_phase: VoquillMigrationPhaseStatus::Pending,
            storage_phase: VoquillMigrationPhaseStatus::Pending,
            counts: VoquillMigrationCounts::default(),
            removed_modes_reset: Vec::new(),
            issues: Vec::new(),
            action_items: Vec::new(),
            can_retry: false,
        };
        save_manifest(&dirs_a.current_config_dir, &pending_report).unwrap();

        let recovered_a = run_startup_migration(&dirs_a).await;
        assert_eq!(recovered_a.status, VoquillMigrationStatus::Completed);
        assert_eq!(
            recovered_a.database_phase,
            VoquillMigrationPhaseStatus::Migrated
        );
        assert!(dirs_a.current_db_path().exists());

        // Case B: Crash right after promotion (Pending manifest + mausvoice.db + promotion marker)
        // -> audits promoted DB, removes marker, and finishes pending asset copy.
        let root_b = unique_workspace("pending-after-promote");
        let dirs_b = make_dirs(&root_b);
        let legacy_db_b = dirs_b.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db_b, 68, false).await;
        let legacy_audio_b = dirs_b
            .legacy_data_dir
            .as_ref()
            .unwrap()
            .join("transcription-audio");
        fs::create_dir_all(&legacy_audio_b).unwrap();
        fs::write(legacy_audio_b.join("clip.wav"), b"RIFFclip").unwrap();

        // First perform a normal staging+promotion, then simulate a crash before manifest save.
        let _ = stage_validate_and_promote_database(&dirs_b).await.unwrap();
        assert!(dirs_b.promotion_marker_path().exists());
        save_manifest(&dirs_b.current_config_dir, &pending_report).unwrap();

        let recovered_b = run_startup_migration(&dirs_b).await;
        assert_eq!(recovered_b.status, VoquillMigrationStatus::Completed);
        assert_eq!(
            recovered_b.database_phase,
            VoquillMigrationPhaseStatus::Migrated
        );
        assert_eq!(
            recovered_b.audio_phase,
            VoquillMigrationPhaseStatus::Migrated
        );
        assert_eq!(recovered_b.counts.audio_files_migrated, 1);
        assert!(!dirs_b.promotion_marker_path().exists());
        assert!(dirs_b
            .current_data_dir
            .join("transcription-audio")
            .join("clip.wav")
            .exists());

        // Case C: Pending manifest + existing mausvoice.db WITHOUT promotion marker
        // -> must not replace or mix with unrelated existing DB.
        let root_c = unique_workspace("pending-unrelated-db");
        let dirs_c = make_dirs(&root_c);
        let legacy_db_c = dirs_c.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db_c, 68, false).await;
        let current_db_c = dirs_c.current_db_path();
        fs::create_dir_all(current_db_c.parent().unwrap()).unwrap();
        let unrelated_pool = open_app_database(&current_db_c).await.unwrap();
        unrelated_pool.close().await;
        save_manifest(&dirs_c.current_config_dir, &pending_report).unwrap();

        let recovered_c = run_startup_migration(&dirs_c).await;
        assert_eq!(
            recovered_c.status,
            VoquillMigrationStatus::SkippedExistingProfile
        );
        assert!(!recovered_c.can_retry);
    }

    #[tokio::test]
    async fn cleared_reset_and_existing_profile_block_asset_only_reimport() {
        // Case A: After clear_local_data calls record_migration_cleared, leftover
        // Voquill audio/storage directories are NOT automatically re-imported.
        let root_a = unique_workspace("clear-blocks-assets");
        let dirs_a = make_dirs(&root_a);
        let legacy_audio = dirs_a
            .legacy_data_dir
            .as_ref()
            .unwrap()
            .join("transcription-audio");
        fs::create_dir_all(&legacy_audio).unwrap();
        fs::write(legacy_audio.join("old.wav"), b"RIFFold").unwrap();

        record_migration_cleared(&dirs_a.current_config_dir).unwrap();
        let report_a = run_startup_migration(&dirs_a).await;
        assert_eq!(report_a.status, VoquillMigrationStatus::NotNeeded);
        assert!(!dirs_a
            .current_data_dir
            .join("transcription-audio")
            .join("old.wav")
            .exists());

        // Case B: Established mausVoice profile (existing mausvoice.db, no manifest)
        // must not absorb leftover asset-only legacy Voquill files.
        let root_b = unique_workspace("existing-profile-blocks-assets");
        let dirs_b = make_dirs(&root_b);
        let legacy_storage = dirs_b.legacy_data_dir.as_ref().unwrap().join("storage");
        fs::create_dir_all(&legacy_storage).unwrap();
        fs::write(legacy_storage.join("icon.png"), b"PNGDATA").unwrap();

        let current_db_b = dirs_b.current_db_path();
        fs::create_dir_all(current_db_b.parent().unwrap()).unwrap();
        let pool = open_app_database(&current_db_b).await.unwrap();
        pool.close().await;

        let report_b = run_startup_migration(&dirs_b).await;
        assert_eq!(
            report_b.status,
            VoquillMigrationStatus::SkippedExistingProfile
        );
        assert!(!dirs_b
            .current_data_dir
            .join("storage")
            .join("icon.png")
            .exists());
    }

    #[tokio::test]
    async fn retry_protects_saved_hotkeys_and_recovers_from_closed_pool() {
        // Case A: User saves a custom hotkey after a failed startup import ->
        // refresh & retry must protect it and refuse to overwrite mausvoice.db.
        let root_a = unique_workspace("retry-protects-hotkeys");
        let dirs_a = make_dirs(&root_a);
        let legacy_db_a = dirs_a.legacy_db_path().unwrap();
        fs::create_dir_all(legacy_db_a.parent().unwrap()).unwrap();
        fs::write(&legacy_db_a, b"corrupt-db-bytes").unwrap();

        let failed = run_startup_migration(&dirs_a).await;
        assert_eq!(failed.status, VoquillMigrationStatus::Failed);

        let live_pool = open_app_database(&dirs_a.current_db_path()).await.unwrap();
        sqlx::query(
            "INSERT INTO hotkeys (id, action_name, keys) VALUES ('hk-user', 'dictate', '[\"F9\"]')",
        )
        .execute(&live_pool)
        .await
        .unwrap();

        // Replace legacy DB with a valid one so only user data should block retry.
        fs::remove_file(&legacy_db_a).unwrap();
        seed_voquill_db(&legacy_db_a, 68, false).await;

        let refreshed = refresh_migration_report(dirs_a.clone(), live_pool.clone()).await;
        assert!(!refreshed.can_retry);

        let db_state = OptionKeyDatabase::new(live_pool);
        let after_retry = retry_migration(dirs_a.clone(), db_state.clone())
            .await
            .unwrap();
        assert_eq!(
            after_retry.status,
            VoquillMigrationStatus::SkippedExistingProfile
        );
        let hotkey_keys: String =
            sqlx::query_scalar("SELECT keys FROM hotkeys WHERE id = 'hk-user'")
                .fetch_one(&db_state.pool())
                .await
                .unwrap();
        assert_eq!(hotkey_keys, "[\"F9\"]");
        db_state.pool().close().await;

        // Case B: Retry recovers cleanly even when the managed pool was left closed
        // after an earlier failed reopen.
        let root_b = unique_workspace("retry-closed-pool-recovery");
        let dirs_b = make_dirs(&root_b);
        let legacy_db_b = dirs_b.legacy_db_path().unwrap();
        fs::create_dir_all(legacy_db_b.parent().unwrap()).unwrap();
        fs::write(&legacy_db_b, b"corrupt-db-bytes").unwrap();

        let failed_b = run_startup_migration(&dirs_b).await;
        assert_eq!(failed_b.status, VoquillMigrationStatus::Failed);

        let initial_pool = open_app_database(&dirs_b.current_db_path()).await.unwrap();
        let db_state_b = OptionKeyDatabase::new(initial_pool);
        // Simulate a closed pool left installed by an earlier failed reopen.
        db_state_b.pool().close().await;
        assert!(db_state_b.pool().is_closed());

        fs::remove_file(&legacy_db_b).unwrap();
        seed_voquill_db(&legacy_db_b, 68, false).await;

        let recovered = retry_migration(dirs_b.clone(), db_state_b.clone())
            .await
            .unwrap();
        assert_eq!(recovered.status, VoquillMigrationStatus::Completed);
        assert!(!db_state_b.pool().is_closed());
        let tx_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcriptions")
            .fetch_one(&db_state_b.pool())
            .await
            .unwrap();
        assert!(tx_count >= 1);
        db_state_b.pool().close().await;
    }

    #[tokio::test]
    async fn destination_directory_conflict_and_independent_model_copies() {
        let root = unique_workspace("dest-conflict-and-copy");
        let dirs = make_dirs(&root);
        let legacy_data = dirs.legacy_data_dir.as_ref().unwrap();
        let legacy_audio = legacy_data.join("transcription-audio");
        let legacy_models = legacy_data.join("models");
        fs::create_dir_all(&legacy_audio).unwrap();
        fs::create_dir_all(&legacy_models).unwrap();
        fs::write(legacy_audio.join("tx-1.wav"), b"RIFFaudio").unwrap();
        fs::write(legacy_models.join("ggml-tiny.bin"), b"MODEL-ORIGINAL").unwrap();

        // Pre-create a DIRECTORY at destination `tx-1.wav` -> must be reported as a conflict, NOT a skip!
        let conflicting_dir = dirs
            .current_data_dir
            .join("transcription-audio")
            .join("tx-1.wav");
        fs::create_dir_all(&conflicting_dir).unwrap();

        let report = run_startup_migration(&dirs).await;
        assert_eq!(report.status, VoquillMigrationStatus::Partial);
        assert_eq!(report.audio_phase, VoquillMigrationPhaseStatus::Failed);
        assert_eq!(report.models_phase, VoquillMigrationPhaseStatus::Migrated);
        assert!(report.can_retry);

        // Verify imported model is an independent copy, not a hard link:
        // modifying mausVoice's copy must leave Voquill's original unchanged.
        let imported_model = dirs
            .current_data_dir
            .join("transcription-models")
            .join("ggml-tiny.bin");
        fs::write(&imported_model, b"MODEL-MODIFIED-IN-MAUSVOICE").unwrap();
        assert_eq!(
            fs::read(legacy_models.join("ggml-tiny.bin")).unwrap(),
            b"MODEL-ORIGINAL"
        );
    }

    #[tokio::test]
    async fn wal_without_shm_stages_without_modifying_legacy_directory() {
        let root = unique_workspace("wal-no-shm");
        let dirs = make_dirs(&root);
        let scratch_db = root.join("scratch-voquill.db");
        seed_voquill_db(&scratch_db, 68, false).await;

        let writer_opts = SqliteConnectOptions::new()
            .filename(&scratch_db)
            .create_if_missing(false);
        let writer_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(writer_opts)
            .await
            .expect("open wal scratch pool");
        sqlx::query("PRAGMA journal_mode = WAL")
            .execute(&writer_pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA wal_autocheckpoint = 0")
            .execute(&writer_pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO transcriptions (id, transcript, timestamp)
             VALUES ('tx-wal-unrecovered', 'Wal row without shm', 1700001234)",
        )
        .execute(&writer_pool)
        .await
        .unwrap();

        // Snapshot raw DB + WAL (omitting -shm) into the legacy directory to
        // simulate an unrecovered WAL left behind without a -shm index.
        let legacy_db = dirs.legacy_db_path().unwrap();
        fs::create_dir_all(legacy_db.parent().unwrap()).unwrap();
        fs::copy(&scratch_db, &legacy_db).unwrap();
        let legacy_wal = legacy_db.with_file_name("voquill.db-wal");
        let legacy_shm = legacy_db.with_file_name("voquill.db-shm");
        fs::copy(
            scratch_db.with_file_name("scratch-voquill.db-wal"),
            &legacy_wal,
        )
        .unwrap();
        writer_pool.close().await;

        assert!(legacy_wal.exists() && fs::metadata(&legacy_wal).unwrap().len() > 0);
        assert!(!legacy_shm.exists());

        let wal_bytes_before = fs::read(&legacy_wal).unwrap();
        let db_bytes_before = fs::read(&legacy_db).unwrap();

        let report = run_startup_migration(&dirs).await;
        assert_eq!(
            report.status,
            VoquillMigrationStatus::Completed,
            "unexpected issues: {:?}",
            report.issues
        );
        assert_eq!(report.database_phase, VoquillMigrationPhaseStatus::Migrated);

        // Verify the WAL-only row survived checkpointing into mausvoice.db.
        let pool = open_app_database(&dirs.current_db_path()).await.unwrap();
        let wal_row_exists: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM transcriptions WHERE id = 'tx-wal-unrecovered'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        pool.close().await;
        assert_eq!(wal_row_exists, 1);

        // Verify original legacy directory was never mutated (no -shm created, bytes unchanged).
        assert!(!legacy_shm.exists());
        assert_eq!(fs::read(&legacy_wal).unwrap(), wal_bytes_before);
        assert_eq!(fs::read(&legacy_db).unwrap(), db_bytes_before);
    }

    #[tokio::test]
    async fn wal_and_shm_legacy_directory_is_byte_for_byte_unmodified() {
        let ws = unique_workspace("wal-and-shm-immutable");
        let dirs = make_dirs(&ws);
        let scratch_db = ws.join("scratch-wal-shm.db");
        seed_voquill_db(&scratch_db, 96, false).await;

        let writer_opts = SqliteConnectOptions::new()
            .filename(&scratch_db)
            .create_if_missing(false);
        let writer_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(writer_opts)
            .await
            .unwrap();
        sqlx::query("PRAGMA journal_mode = WAL;")
            .execute(&writer_pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA wal_autocheckpoint = 0;")
            .execute(&writer_pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO transcriptions (id, transcript, timestamp)
             VALUES ('tx-wal-with-shm', 'Wal row alongside shm', 1700004321)",
        )
        .execute(&writer_pool)
        .await
        .unwrap();

        let legacy_db = dirs.legacy_db_path().unwrap();
        fs::create_dir_all(legacy_db.parent().unwrap()).unwrap();
        fs::copy(&scratch_db, &legacy_db).unwrap();
        let legacy_wal = legacy_db.with_file_name("voquill.db-wal");
        let legacy_shm = legacy_db.with_file_name("voquill.db-shm");
        fs::copy(
            scratch_db.with_file_name("scratch-wal-shm.db-wal"),
            &legacy_wal,
        )
        .unwrap();
        fs::copy(
            scratch_db.with_file_name("scratch-wal-shm.db-shm"),
            &legacy_shm,
        )
        .unwrap();
        writer_pool.close().await;

        let db_bytes_before = fs::read(&legacy_db).unwrap();
        let wal_bytes_before = fs::read(&legacy_wal).unwrap();
        let shm_bytes_before = fs::read(&legacy_shm).unwrap();
        assert!(!wal_bytes_before.is_empty() && !shm_bytes_before.is_empty());

        let report = run_startup_migration(&dirs).await;
        assert_eq!(report.status, VoquillMigrationStatus::Completed);

        let pool = open_app_database(&dirs.current_db_path()).await.unwrap();
        let wal_row_exists: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM transcriptions WHERE id = 'tx-wal-with-shm'")
                .fetch_one(&pool)
                .await
                .unwrap();
        pool.close().await;
        assert_eq!(wal_row_exists, 1);

        // Every legacy file including `-shm` must remain byte-for-byte identical.
        assert_eq!(fs::read(&legacy_db).unwrap(), db_bytes_before);
        assert_eq!(fs::read(&legacy_wal).unwrap(), wal_bytes_before);
        assert_eq!(fs::read(&legacy_shm).unwrap(), shm_bytes_before);
    }

    #[test]
    fn quiescent_fingerprint_detects_in_place_byte_change_with_same_len_and_mtime() {
        let ws = unique_workspace("fingerprint-sha256");
        let path = ws.join("voquill.db");
        fs::write(&path, b"0123456789abcdef").unwrap();
        let before = fingerprint_path(&path).unwrap();

        // Same byte length and potentially identical coarse filesystem mtime,
        // but 1 byte changed -> SHA-256 fingerprint must still detect mutation.
        fs::write(&path, b"0123456789abcdeX").unwrap();
        let mut after = fingerprint_path(&path).unwrap();
        after.modified = before.modified;
        assert_eq!(before.len, after.len);
        assert_ne!(before, after);
    }

    #[test]
    fn quiescent_fingerprint_rejects_digest_errors_and_torn_staged_copy() {
        let ws = unique_workspace("fingerprint-errors-and-torn-copy");
        // A directory at a tracked path cannot be hashed and must return Err
        // instead of equating two failed `None` digests.
        let dir_path = ws.join("not-a-regular-file");
        fs::create_dir_all(&dir_path).unwrap();
        assert!(fingerprint_path(&dir_path).is_err());

        // Simulate a concurrent write + rollback during copy where before == after
        // on the source files, but the copied staged DB received torn bytes.
        let legacy_dir = ws.join("legacy");
        let staging_dir = ws.join("staging");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::create_dir_all(&staging_dir).unwrap();
        let legacy_db = legacy_dir.join(LEGACY_DB_FILENAME);
        fs::write(&legacy_db, b"clean-committed-pages-before-and-after").unwrap();
        let (legacy_wal, legacy_shm, legacy_journal) = legacy_sqlite_paths(&legacy_db);
        let tracked = [
            legacy_db.as_path(),
            legacy_wal.as_path(),
            legacy_shm.as_path(),
            legacy_journal.as_path(),
        ];

        let before = fingerprint_tracked_files(&tracked).unwrap();
        fs::write(
            staging_dir.join(STAGED_DB_FILENAME),
            b"torn-uncommitted-pages-mid-copy-write",
        )
        .unwrap();
        let after = fingerprint_tracked_files(&tracked).unwrap();
        assert_eq!(before, after);
        assert!(
            !verify_staged_matches_before(&before, &staging_dir).unwrap(),
            "torn staged snapshot must be rejected even when before == after"
        );
    }

    #[tokio::test]
    async fn swap_retry_database_failure_preserves_original_database_without_double_restore() {
        let ws = unique_workspace("swap-failure-single-rollback");
        let dirs = make_dirs(&ws);
        fs::create_dir_all(&dirs.current_config_dir).unwrap();
        let current_db = dirs.current_db_path();
        let initial_pool = open_app_database(&current_db).await.unwrap();
        sqlx::query(
            "INSERT INTO terms (id, created_by_user_id, source_value, destination_value, created_at)
             VALUES ('term-keep', 'local-user', 'orig', 'kept', 1700000001)",
        )
        .execute(&initial_pool)
        .await
        .unwrap();
        initial_pool.close().await;

        let original_bytes = fs::read(&current_db).unwrap();
        let missing_staged = ws.join("does-not-exist-staged.db");
        let marker_path = dirs.promotion_marker_path();

        let err = swap_retry_database_on_disk(
            &missing_staged,
            &current_db,
            &marker_path,
            RetrySwapMarkerSpec {
                staged_sha256: "deadbeef".to_string(),
                staged_payload_sha256: "cafebabe".to_string(),
                removed_modes_reset: Vec::new(),
            },
        )
        .expect_err("missing staged db must fail promotion");
        assert_eq!(err.issue.code, "promote_io_error");
        assert!(err.restored_ok);

        // Original database must remain intact on disk with no leftover backup/marker.
        assert!(current_db.exists());
        assert_eq!(fs::read(&current_db).unwrap(), original_bytes);
        assert!(!marker_path.exists());
        assert!(!current_db
            .with_file_name(format!("{DB_FILENAME}{PRE_RETRY_BACKUP_SUFFIX}"))
            .exists());

        let db_state = OptionKeyDatabase::new(open_app_database(&current_db).await.unwrap());
        db_state.pool().close().await;
        reopen_previous_pool(&current_db, &db_state).await;
        let kept: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM terms WHERE id = 'term-keep'")
            .fetch_one(&db_state.pool())
            .await
            .unwrap();
        assert_eq!(kept, 1);
    }

    #[tokio::test]
    async fn restore_failure_is_propagated_and_never_opens_fresh_database() {
        let ws = unique_workspace("restore-failure-propagates");
        let dirs = make_dirs(&ws);
        fs::create_dir_all(&dirs.current_config_dir).unwrap();

        // Create a valid pre-retry backup for the main DB, plus a non-empty
        // directory blocking `mausvoice.db-wal` so restoring the WAL sidecar
        // fails while `mausvoice.db` is missing.
        let current_db = dirs.current_db_path();
        let main_bak = current_db.with_file_name(format!("{DB_FILENAME}{PRE_RETRY_BACKUP_SUFFIX}"));
        let wal_bak =
            current_db.with_file_name(format!("{DB_FILENAME}-wal{PRE_RETRY_BACKUP_SUFFIX}"));
        let wal_dst = current_db.with_file_name(format!("{DB_FILENAME}-wal"));
        fs::write(&main_bak, b"original-db-backup-bytes").unwrap();
        fs::write(&wal_bak, b"original-wal-backup-bytes").unwrap();
        fs::create_dir_all(&wal_dst).unwrap();
        fs::write(wal_dst.join("blocker"), b"x").unwrap();

        // Verify `restore_rollback_backup` returns Err instead of silently succeeding.
        let restore_err = restore_rollback_backup(&current_db, &["-wal", ""]);
        assert!(restore_err.is_err());

        // `ensure_usable_pool` must propagate the reconciliation error and NOT
        // create a brand-new database via `open_app_database` (create_if_missing).
        let dummy_db = ws.join("closed-dummy.db");
        let dummy_pool = open_app_database(&dummy_db).await.unwrap();
        dummy_pool.close().await;
        let db_state = OptionKeyDatabase::new(dummy_pool);

        let err = ensure_usable_pool(&dirs, &db_state)
            .await
            .expect_err("failed backup restore must propagate error");
        assert!(err.contains("Could not restore pre-retry database backup"));
        assert!(main_bak.exists() || current_db.exists());
        assert!(
            wal_bak.exists(),
            "unrestored sidecar backup must remain intact"
        );
        assert!(db_state.pool().is_closed(), "must not reopen a fresh pool");
    }

    #[tokio::test]
    async fn recovery_rejects_corrupt_promoted_db_and_unrelated_db_mismatching_marker() {
        // Case A: Startup promotion marker exists, but an unrelated DB was created instead
        // (SHA-256 mismatch) -> must mark SkippedExistingProfile and never copy legacy assets.
        let ws_a = unique_workspace("recovery-mismatch-marker");
        let dirs_a = make_dirs(&ws_a);
        fs::create_dir_all(&dirs_a.current_config_dir).unwrap();
        let legacy_audio_a = dirs_a
            .legacy_data_dir
            .as_ref()
            .unwrap()
            .join(AUDIO_DIR_NAME);
        fs::create_dir_all(&legacy_audio_a).unwrap();
        fs::write(legacy_audio_a.join("clip.wav"), b"RIFFclip").unwrap();

        let unrelated_pool = open_app_database(&dirs_a.current_db_path()).await.unwrap();
        unrelated_pool.close().await;
        write_promotion_marker(
            &dirs_a.promotion_marker_path(),
            "startup",
            "0000000000000000000000000000000000000000000000000000000000000000".to_string(),
            "1111111111111111111111111111111111111111111111111111111111111111".to_string(),
            vec!["transcription:cloud".to_string()],
        )
        .unwrap();

        let pending_manifest = VoquillMigrationReport {
            schema_version: MANIFEST_SCHEMA_VERSION,
            status: VoquillMigrationStatus::Partial,
            legacy_detected: true,
            legacy_source_preserved: true,
            detected_at: Some(now_iso()),
            completed_at: None,
            dismissed_at: None,
            attempt_count: 1,
            database_phase: VoquillMigrationPhaseStatus::Pending,
            models_phase: VoquillMigrationPhaseStatus::Pending,
            audio_phase: VoquillMigrationPhaseStatus::Pending,
            storage_phase: VoquillMigrationPhaseStatus::Pending,
            counts: VoquillMigrationCounts::default(),
            removed_modes_reset: Vec::new(),
            issues: Vec::new(),
            action_items: Vec::new(),
            can_retry: true,
        };
        save_manifest(&dirs_a.current_config_dir, &pending_manifest).unwrap();

        let res_a = run_startup_migration(&dirs_a).await;
        assert_eq!(res_a.status, VoquillMigrationStatus::SkippedExistingProfile);
        assert!(res_a.removed_modes_reset.is_empty());
        assert!(!dirs_a
            .current_data_dir
            .join(AUDIO_DIR_NAME)
            .join("clip.wav")
            .exists());
        assert!(!dirs_a.promotion_marker_path().exists());

        // Case B: Marker SHA-256 matches a corrupt DB -> must NOT advance to Migrated
        // and must retain promotion marker + record recovery_open_failed.
        let ws_b = unique_workspace("recovery-corrupt-promoted");
        let dirs_b = make_dirs(&ws_b);
        fs::create_dir_all(&dirs_b.current_config_dir).unwrap();
        let corrupt_bytes = b"not a sqlite file at all";
        fs::write(dirs_b.current_db_path(), corrupt_bytes).unwrap();
        let corrupt_sha = sha256_file_hex(&dirs_b.current_db_path()).unwrap();
        write_promotion_marker(
            &dirs_b.promotion_marker_path(),
            "startup",
            corrupt_sha,
            String::new(),
            Vec::new(),
        )
        .unwrap();
        save_manifest(&dirs_b.current_config_dir, &pending_manifest).unwrap();

        let res_b = run_startup_migration(&dirs_b).await;
        assert_eq!(res_b.database_phase, VoquillMigrationPhaseStatus::Pending);
        assert_eq!(res_b.status, VoquillMigrationStatus::Partial);
        assert!(res_b.can_retry);
        assert!(res_b
            .issues
            .iter()
            .any(|issue| issue.code == "recovery_open_failed"));
        assert!(dirs_b.promotion_marker_path().exists());
    }

    #[tokio::test]
    async fn interrupted_retry_after_swap_recovers_pending_assets_on_startup() {
        // Case A: Retry promoted mausvoice.db, opened it in WAL mode (mutating
        // header bytes 18-19), left `.pre-retry.bak` on disk, and crashed before
        // persisting `database_phase = Migrated`.
        let ws = unique_workspace("interrupted-retry-recovery-with-backup");
        let dirs = make_dirs(&ws);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 96, false).await;
        let legacy_audio = dirs.legacy_data_dir.as_ref().unwrap().join(AUDIO_DIR_NAME);
        fs::create_dir_all(&legacy_audio).unwrap();
        fs::write(legacy_audio.join("retry-clip.wav"), b"RIFFretry").unwrap();

        let staged = stage_validate_and_promote_database(&dirs).await.unwrap();
        let (full_sha, payload_sha) = hash_staged_database(&dirs.current_db_path()).unwrap();
        write_promotion_marker(
            &dirs.promotion_marker_path(),
            "retry",
            full_sha,
            payload_sha,
            staged.removed_modes_reset.clone(),
        )
        .unwrap();

        // Simulate WAL open modifying SQLite header bytes after promotion while
        // `.pre-retry.bak` is still on disk.
        let opened = open_app_database_strict(&dirs.current_db_path())
            .await
            .unwrap();
        opened.close().await;
        let backup_path = dirs
            .current_db_path()
            .with_file_name(format!("{DB_FILENAME}{PRE_RETRY_BACKUP_SUFFIX}"));
        fs::write(&backup_path, b"old-empty-db-backup").unwrap();

        let failed_manifest = VoquillMigrationReport {
            schema_version: MANIFEST_SCHEMA_VERSION,
            status: VoquillMigrationStatus::Failed,
            legacy_detected: true,
            legacy_source_preserved: true,
            detected_at: Some(now_iso()),
            completed_at: None,
            dismissed_at: None,
            attempt_count: 1,
            database_phase: VoquillMigrationPhaseStatus::Failed,
            models_phase: VoquillMigrationPhaseStatus::Skipped,
            audio_phase: VoquillMigrationPhaseStatus::Skipped,
            storage_phase: VoquillMigrationPhaseStatus::Skipped,
            counts: VoquillMigrationCounts::default(),
            removed_modes_reset: Vec::new(),
            issues: vec![VoquillMigrationIssue {
                category: "database".to_string(),
                code: "legacy_source_busy".to_string(),
                detail: "Previous attempt failed".to_string(),
            }],
            action_items: Vec::new(),
            can_retry: true,
        };
        save_manifest(&dirs.current_config_dir, &failed_manifest).unwrap();

        let recovered = run_startup_migration(&dirs).await;
        assert_eq!(recovered.status, VoquillMigrationStatus::Completed);
        assert_eq!(
            recovered.database_phase,
            VoquillMigrationPhaseStatus::Migrated
        );
        assert_eq!(recovered.audio_phase, VoquillMigrationPhaseStatus::Migrated);
        assert_eq!(recovered.counts.audio_files_migrated, 1);
        assert_eq!(recovered.removed_modes_reset, staged.removed_modes_reset);
        assert!(recovered.issues.is_empty());
        assert!(!dirs.promotion_marker_path().exists());
        assert!(!backup_path.exists());
        assert!(dirs
            .current_data_dir
            .join(AUDIO_DIR_NAME)
            .join("retry-clip.wav")
            .exists());

        // Case B: Unrelated DB on disk alongside `.pre-retry.bak` and a `retry`
        // marker with a different hash must NOT be overwritten or mistaken for
        // the promoted DB.
        let ws_b = unique_workspace("interrupted-retry-unrelated-db");
        let dirs_b = make_dirs(&ws_b);
        fs::create_dir_all(&dirs_b.current_config_dir).unwrap();
        let unrelated_pool = open_app_database(&dirs_b.current_db_path()).await.unwrap();
        sqlx::query(
            "INSERT INTO terms (id, created_by_user_id, source_value, destination_value, created_at)
             VALUES ('unrelated-term', 'local-user', 'a', 'b', 1700000001)",
        )
        .execute(&unrelated_pool)
        .await
        .unwrap();
        unrelated_pool.close().await;
        let bak_b = dirs_b
            .current_db_path()
            .with_file_name(format!("{DB_FILENAME}{PRE_RETRY_BACKUP_SUFFIX}"));
        fs::write(&bak_b, b"stale-pre-retry-backup").unwrap();
        write_promotion_marker(
            &dirs_b.promotion_marker_path(),
            "retry",
            "0000000000000000000000000000000000000000000000000000000000000000".to_string(),
            "1111111111111111111111111111111111111111111111111111111111111111".to_string(),
            vec!["transcription:cloud".to_string()],
        )
        .unwrap();
        save_manifest(&dirs_b.current_config_dir, &failed_manifest).unwrap();

        let res_b = run_startup_migration(&dirs_b).await;
        assert_eq!(res_b.status, VoquillMigrationStatus::SkippedExistingProfile);
        assert!(res_b.removed_modes_reset.is_empty());
        let check_pool = open_app_database(&dirs_b.current_db_path()).await.unwrap();
        let preserved: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM terms WHERE id = 'unrelated-term'")
                .fetch_one(&check_pool)
                .await
                .unwrap();
        check_pool.close().await;
        assert_eq!(preserved, 1, "unrelated database must never be deleted");
    }

    #[tokio::test]
    async fn recovery_manifest_checkpoint_failure_returns_retryable_failure() {
        let ws = unique_workspace("recovery-checkpoint-failure");
        let dirs = make_dirs(&ws);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 96, false).await;

        let _ = stage_validate_and_promote_database(&dirs).await.unwrap();
        let (full_sha, payload_sha) = hash_staged_database(&dirs.current_db_path()).unwrap();
        write_promotion_marker(
            &dirs.promotion_marker_path(),
            "startup",
            full_sha,
            payload_sha,
            Vec::new(),
        )
        .unwrap();

        // Block manifest writes by placing a directory at the manifest path.
        let manifest_path = dirs.current_config_dir.join(MANIFEST_FILENAME);
        fs::create_dir_all(&manifest_path).unwrap();

        let pending_manifest = VoquillMigrationReport {
            schema_version: MANIFEST_SCHEMA_VERSION,
            status: VoquillMigrationStatus::Partial,
            legacy_detected: true,
            legacy_source_preserved: true,
            detected_at: Some(now_iso()),
            completed_at: None,
            dismissed_at: None,
            attempt_count: 1,
            database_phase: VoquillMigrationPhaseStatus::Pending,
            models_phase: VoquillMigrationPhaseStatus::NotFound,
            audio_phase: VoquillMigrationPhaseStatus::NotFound,
            storage_phase: VoquillMigrationPhaseStatus::NotFound,
            counts: VoquillMigrationCounts::default(),
            removed_modes_reset: Vec::new(),
            issues: Vec::new(),
            action_items: Vec::new(),
            can_retry: true,
        };

        let result = recover_pending_database_migration(&dirs, pending_manifest).await;
        assert_ne!(result.status, VoquillMigrationStatus::Completed);
        assert_eq!(result.status, VoquillMigrationStatus::Partial);
        assert!(result.can_retry);
        assert!(result
            .issues
            .iter()
            .any(|issue| issue.code == "manifest_save_failed"));
        assert!(
            dirs.promotion_marker_path().exists(),
            "promotion marker must remain on disk when manifest checkpoint fails"
        );
    }

    #[test]
    fn asset_copy_handles_migrating_tmp_names_interrupted_counts_and_symlink_ancestors() {
        let ws = unique_workspace("asset-copy-hardening");
        let dirs = make_dirs(&ws);
        fs::create_dir_all(&dirs.current_config_dir).unwrap();
        let legacy_storage = dirs
            .legacy_data_dir
            .as_ref()
            .unwrap()
            .join(STORAGE_DIR_NAME);
        let legacy_audio = dirs.legacy_data_dir.as_ref().unwrap().join(AUDIO_DIR_NAME);
        fs::create_dir_all(&legacy_storage).unwrap();
        fs::create_dir_all(&legacy_audio).unwrap();

        // Storage files including a name matching the old `.migrating.tmp` pattern.
        fs::write(legacy_storage.join("icon.png"), b"PNG-1").unwrap();
        fs::write(legacy_storage.join(".icon.png.migrating.tmp"), b"PNG-2").unwrap();

        // Audio: simulate clip1.wav already migrated by an interrupted attempt,
        // preexisting.wav NOT migrated by us, and clip2.wav still pending.
        fs::write(legacy_audio.join("clip1.wav"), b"A1").unwrap();
        fs::write(legacy_audio.join("clip2.wav"), b"A2").unwrap();
        fs::write(legacy_audio.join("preexisting.wav"), b"A3").unwrap();

        let dst_audio = dirs.current_data_dir.join(AUDIO_DIR_NAME);
        fs::create_dir_all(&dst_audio).unwrap();
        fs::write(dst_audio.join("clip1.wav"), b"A1").unwrap();
        fs::write(dst_audio.join("preexisting.wav"), b"LOCAL").unwrap();

        append_asset_progress_entry(
            &dirs.current_config_dir,
            '+',
            AssetCategory::Audio,
            "clip1.wav",
        )
        .unwrap();

        let mut report = VoquillMigrationReport {
            schema_version: MANIFEST_SCHEMA_VERSION,
            status: VoquillMigrationStatus::Partial,
            legacy_detected: true,
            legacy_source_preserved: true,
            detected_at: Some(now_iso()),
            completed_at: None,
            dismissed_at: None,
            attempt_count: 1,
            database_phase: VoquillMigrationPhaseStatus::Migrated,
            models_phase: VoquillMigrationPhaseStatus::NotFound,
            audio_phase: VoquillMigrationPhaseStatus::Pending,
            storage_phase: VoquillMigrationPhaseStatus::Pending,
            counts: VoquillMigrationCounts::default(),
            removed_modes_reset: Vec::new(),
            issues: Vec::new(),
            action_items: Vec::new(),
            can_retry: true,
        };

        migrate_asset_phases(&dirs, &mut report);

        assert_eq!(report.storage_phase, VoquillMigrationPhaseStatus::Migrated);
        assert_eq!(report.counts.storage_files_migrated, 2);
        assert_eq!(
            fs::read(
                dirs.current_data_dir
                    .join(STORAGE_DIR_NAME)
                    .join("icon.png")
            )
            .unwrap(),
            b"PNG-1"
        );
        assert_eq!(
            fs::read(
                dirs.current_data_dir
                    .join(STORAGE_DIR_NAME)
                    .join(".icon.png.migrating.tmp")
            )
            .unwrap(),
            b"PNG-2"
        );

        assert_eq!(report.audio_phase, VoquillMigrationPhaseStatus::Migrated);
        // Must count clip1.wav (from interrupted progress) + clip2.wav (newly copied) = 2,
        // without counting unrelated preexisting.wav!
        assert_eq!(report.counts.audio_files_migrated, 2);
        assert_eq!(
            fs::read(dst_audio.join("preexisting.wav")).unwrap(),
            b"LOCAL"
        );
        // Progress journal must remain on disk until the caller saves the final
        // manifest and calls `remove_asset_progress_if_settled`.
        assert!(dirs
            .current_config_dir
            .join(ASSET_PROGRESS_FILENAME)
            .exists());
        remove_asset_progress_if_settled(&dirs.current_config_dir, &report);
        assert!(!dirs
            .current_config_dir
            .join(ASSET_PROGRESS_FILENAME)
            .exists());

        // Blocking journal writes must refuse to publish unrecorded files.
        let ws_j = unique_workspace("asset-journal-write-failure");
        let dirs_j = make_dirs(&ws_j);
        fs::create_dir_all(&dirs_j.current_config_dir).unwrap();
        let legacy_audio_j = dirs_j
            .legacy_data_dir
            .as_ref()
            .unwrap()
            .join(AUDIO_DIR_NAME);
        fs::create_dir_all(&legacy_audio_j).unwrap();
        fs::write(legacy_audio_j.join("blocked.wav"), b"AUDIO").unwrap();
        fs::create_dir_all(dirs_j.current_config_dir.join(ASSET_PROGRESS_FILENAME)).unwrap();
        let mut report_j = VoquillMigrationReport {
            schema_version: MANIFEST_SCHEMA_VERSION,
            status: VoquillMigrationStatus::Partial,
            legacy_detected: true,
            legacy_source_preserved: true,
            detected_at: Some(now_iso()),
            completed_at: None,
            dismissed_at: None,
            attempt_count: 1,
            database_phase: VoquillMigrationPhaseStatus::Migrated,
            models_phase: VoquillMigrationPhaseStatus::NotFound,
            audio_phase: VoquillMigrationPhaseStatus::Pending,
            storage_phase: VoquillMigrationPhaseStatus::NotFound,
            counts: VoquillMigrationCounts::default(),
            removed_modes_reset: Vec::new(),
            issues: Vec::new(),
            action_items: Vec::new(),
            can_retry: true,
        };
        migrate_asset_phases(&dirs_j, &mut report_j);
        assert_eq!(report_j.audio_phase, VoquillMigrationPhaseStatus::Failed);
        assert!(!dirs_j
            .current_data_dir
            .join(AUDIO_DIR_NAME)
            .join("blocked.wav")
            .exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside = ws.join("outside-target");
            fs::create_dir_all(&outside).unwrap();
            let dst_root = dirs.current_data_dir.join("symlink-test");
            fs::create_dir_all(&dst_root).unwrap();
            symlink(&outside, dst_root.join("linked")).unwrap();
            let escaped = dst_root.join("linked").join("nested").join("file.txt");
            let check = ensure_destination_ancestors_no_symlink(&dst_root, &escaped);
            assert!(
                check.is_err(),
                "symlink ancestor inside destination root must be rejected"
            );
        }
    }

    #[test]
    fn duplicate_relative_model_paths_across_legacy_dirs_counted_once() {
        let ws = unique_workspace("duplicate-legacy-model-dirs");
        let dirs = make_dirs(&ws);
        fs::create_dir_all(&dirs.current_config_dir).unwrap();
        let legacy_data = dirs.legacy_data_dir.as_ref().unwrap();
        let dir_a = legacy_data.join(MODELS_DIR_NAME);
        let dir_b = legacy_data.join(LEGACY_MODELS_DIR_NAME);
        fs::create_dir_all(&dir_a).unwrap();
        fs::create_dir_all(&dir_b).unwrap();
        fs::write(dir_a.join("ggml-base.bin"), b"MODEL-A").unwrap();
        fs::write(dir_b.join("ggml-base.bin"), b"MODEL-B").unwrap();

        let mut report = VoquillMigrationReport {
            schema_version: MANIFEST_SCHEMA_VERSION,
            status: VoquillMigrationStatus::Partial,
            legacy_detected: true,
            legacy_source_preserved: true,
            detected_at: Some(now_iso()),
            completed_at: None,
            dismissed_at: None,
            attempt_count: 1,
            database_phase: VoquillMigrationPhaseStatus::Migrated,
            models_phase: VoquillMigrationPhaseStatus::Pending,
            audio_phase: VoquillMigrationPhaseStatus::NotFound,
            storage_phase: VoquillMigrationPhaseStatus::NotFound,
            counts: VoquillMigrationCounts::default(),
            removed_modes_reset: Vec::new(),
            issues: Vec::new(),
            action_items: Vec::new(),
            can_retry: true,
        };

        migrate_asset_phases(&dirs, &mut report);
        assert_eq!(report.models_phase, VoquillMigrationPhaseStatus::Migrated);
        assert_eq!(
            report.counts.local_models_migrated, 1,
            "duplicate relative path across legacy model directories must be counted once"
        );
    }

    #[tokio::test]
    async fn memory_journal_active_transaction_fails_as_busy_without_copying_uncommitted_rows() {
        let ws = unique_workspace("memory-journal-active-tx");
        let dirs = make_dirs(&ws);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 96, false).await;

        let writer_opts = SqliteConnectOptions::new()
            .filename(&legacy_db)
            .create_if_missing(false);
        let writer_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(writer_opts)
            .await
            .unwrap();
        let mut conn = writer_pool.acquire().await.unwrap();
        sqlx::query("PRAGMA journal_mode = MEMORY;")
            .execute(&mut *conn)
            .await
            .unwrap();
        sqlx::query("PRAGMA cache_size = 1;")
            .execute(&mut *conn)
            .await
            .unwrap();
        sqlx::query("BEGIN EXCLUSIVE;")
            .execute(&mut *conn)
            .await
            .unwrap();
        let payload = "uncommitted-payload-".repeat(64);
        for idx in 0..32 {
            sqlx::query(
                "INSERT INTO transcriptions (id, transcript, timestamp) VALUES (?1, ?2, ?3)",
            )
            .bind(format!("uncommitted-{idx}"))
            .bind(&payload)
            .bind(1_700_005_000_i64 + idx)
            .execute(&mut *conn)
            .await
            .unwrap();
        }

        let report = run_startup_migration(&dirs).await;
        assert_eq!(report.status, VoquillMigrationStatus::Failed);
        assert!(
            report
                .issues
                .iter()
                .any(|issue| issue.code == "legacy_source_busy"),
            "active transaction must fail as legacy_source_busy, got: {:?}",
            report.issues
        );
        assert!(!dirs.current_db_path().exists());

        sqlx::query("ROLLBACK;").execute(&mut *conn).await.unwrap();
        drop(conn);
        writer_pool.close().await;

        let empty_pool = open_app_database(&dirs.current_db_path()).await.unwrap();
        let db_state = OptionKeyDatabase::new(empty_pool);
        let retried = retry_migration(dirs.clone(), db_state.clone())
            .await
            .unwrap();
        assert_eq!(retried.status, VoquillMigrationStatus::Completed);
        let uncommitted_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM transcriptions WHERE id LIKE 'uncommitted-%'")
                .fetch_one(&db_state.pool())
                .await
                .unwrap();
        assert_eq!(uncommitted_count, 0);
    }

    #[tokio::test]
    async fn sidecar_restore_failure_remains_detectable_across_retries_and_blocks_startup_open() {
        let ws = unique_workspace("sidecar-restore-failure-repeat");
        let dirs = make_dirs(&ws);
        fs::create_dir_all(&dirs.current_config_dir).unwrap();
        let current_db = dirs.current_db_path();

        let main_bak = current_db.with_file_name(format!("{DB_FILENAME}{PRE_RETRY_BACKUP_SUFFIX}"));
        let wal_bak =
            current_db.with_file_name(format!("{DB_FILENAME}-wal{PRE_RETRY_BACKUP_SUFFIX}"));
        let wal_dst = current_db.with_file_name(format!("{DB_FILENAME}-wal"));
        fs::write(&main_bak, b"valid-main-db-bytes").unwrap();
        fs::write(&wal_bak, b"valid-wal-bytes").unwrap();
        fs::create_dir_all(&wal_dst).unwrap();
        fs::write(wal_dst.join("blocker"), b"x").unwrap();

        // First reconciliation attempt fails on WAL before restoring main DB.
        assert!(reconcile_orphaned_pre_retry_backup(&dirs, None).is_err());
        assert!(
            main_bak.exists(),
            "main backup must stay until sidecars restore"
        );
        assert!(
            wal_bak.exists(),
            "wal backup must stay after failed restore"
        );

        // Second reconciliation attempt must STILL detect the failure and startup guard must block open.
        assert!(reconcile_orphaned_pre_retry_backup(&dirs, None).is_err());
        assert!(ensure_no_unrestored_pre_retry_backup(&dirs).is_err());

        // Clearing the obstacle allows full restoration of BOTH sidecar and main DB.
        fs::remove_dir_all(&wal_dst).unwrap();
        reconcile_orphaned_pre_retry_backup(&dirs, None).unwrap();
        ensure_no_unrestored_pre_retry_backup(&dirs).unwrap();
        assert_eq!(fs::read(&current_db).unwrap(), b"valid-main-db-bytes");
        assert_eq!(fs::read(&wal_dst).unwrap(), b"valid-wal-bytes");
    }

    #[tokio::test]
    async fn retry_manifest_checkpoint_failure_retains_marker_and_recovers_on_restart() {
        let ws = unique_workspace("retry-manifest-checkpoint-failure");
        let dirs = make_dirs(&ws);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 96, false).await;
        let legacy_audio = dirs.legacy_data_dir.as_ref().unwrap().join(AUDIO_DIR_NAME);
        fs::create_dir_all(&legacy_audio).unwrap();
        fs::write(legacy_audio.join("after-retry.wav"), b"RIFFafter").unwrap();

        fs::create_dir_all(&dirs.current_config_dir).unwrap();
        let initial_pool = open_app_database(&dirs.current_db_path()).await.unwrap();
        let db_state = OptionKeyDatabase::new(initial_pool);

        // Block manifest writes with a directory so `save_manifest` fails right
        // after retry promotes and strictly opens the new DB.
        let manifest_path = dirs.current_config_dir.join(MANIFEST_FILENAME);
        fs::create_dir_all(&manifest_path).unwrap();

        let mut failed_report = VoquillMigrationReport {
            schema_version: MANIFEST_SCHEMA_VERSION,
            status: VoquillMigrationStatus::Failed,
            legacy_detected: true,
            legacy_source_preserved: true,
            detected_at: Some(now_iso()),
            completed_at: None,
            dismissed_at: None,
            attempt_count: 1,
            database_phase: VoquillMigrationPhaseStatus::Failed,
            models_phase: VoquillMigrationPhaseStatus::Skipped,
            audio_phase: VoquillMigrationPhaseStatus::Skipped,
            storage_phase: VoquillMigrationPhaseStatus::Skipped,
            counts: VoquillMigrationCounts::default(),
            removed_modes_reset: Vec::new(),
            issues: vec![VoquillMigrationIssue {
                category: "database".to_string(),
                code: "legacy_source_busy".to_string(),
                detail: "Previous failure".to_string(),
            }],
            action_items: Vec::new(),
            can_retry: true,
        };

        let err = retry_database_promotion(&dirs, &db_state, &mut failed_report)
            .await
            .expect_err("checkpoint manifest write failure must fail retry_database_promotion");
        assert!(err.contains("Could not checkpoint retry migration state"));
        assert!(
            dirs.promotion_marker_path().exists(),
            "promotion marker must remain on disk"
        );
        assert!(
            dirs.current_db_path()
                .with_file_name(format!("{DB_FILENAME}{PRE_RETRY_BACKUP_SUFFIX}"))
                .exists(),
            "pre-retry backup must remain on disk until checkpoint succeeds"
        );
        assert!(
            db_state.pool().is_closed(),
            "failed checkpoint must not expose new pool to live writers"
        );

        // Restore writable manifest file (still recording Failed from before crash)
        // and verify startup recovery completes cleanly on restart.
        fs::remove_dir_all(&manifest_path).unwrap();
        let persisted_failed = VoquillMigrationReport {
            database_phase: VoquillMigrationPhaseStatus::Failed,
            status: VoquillMigrationStatus::Failed,
            models_phase: VoquillMigrationPhaseStatus::Skipped,
            audio_phase: VoquillMigrationPhaseStatus::Skipped,
            storage_phase: VoquillMigrationPhaseStatus::Skipped,
            ..failed_report
        };
        save_manifest(&dirs.current_config_dir, &persisted_failed).unwrap();

        let recovered = run_startup_migration(&dirs).await;
        assert_eq!(recovered.status, VoquillMigrationStatus::Completed);
        assert_eq!(
            recovered.database_phase,
            VoquillMigrationPhaseStatus::Migrated
        );
        assert_eq!(recovered.audio_phase, VoquillMigrationPhaseStatus::Migrated);
        assert!(!dirs.promotion_marker_path().exists());
        assert!(!dirs
            .current_db_path()
            .with_file_name(format!("{DB_FILENAME}{PRE_RETRY_BACKUP_SUFFIX}"))
            .exists());
    }

    #[tokio::test]
    async fn refresh_migration_report_surfaces_checkpoint_failure_and_keeps_retryable_on_populated_db(
    ) {
        let ws = unique_workspace("status-after-checkpoint-failure");
        let dirs = make_dirs(&ws);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 96, false).await;
        let legacy_audio = dirs.legacy_data_dir.as_ref().unwrap().join(AUDIO_DIR_NAME);
        fs::create_dir_all(&legacy_audio).unwrap();
        fs::write(legacy_audio.join("pending.wav"), b"RIFFpending").unwrap();

        let staged = stage_validate_and_promote_database(&dirs).await.unwrap();
        let (full_sha, payload_sha) = hash_staged_database(&dirs.current_db_path()).unwrap();
        write_promotion_marker(
            &dirs.promotion_marker_path(),
            "retry",
            full_sha,
            payload_sha,
            staged.removed_modes_reset.clone(),
        )
        .unwrap();

        let pending_manifest = VoquillMigrationReport {
            schema_version: MANIFEST_SCHEMA_VERSION,
            status: VoquillMigrationStatus::Partial,
            legacy_detected: true,
            legacy_source_preserved: true,
            detected_at: Some(now_iso()),
            completed_at: None,
            dismissed_at: None,
            attempt_count: 1,
            database_phase: VoquillMigrationPhaseStatus::Pending,
            models_phase: VoquillMigrationPhaseStatus::Pending,
            audio_phase: VoquillMigrationPhaseStatus::Pending,
            storage_phase: VoquillMigrationPhaseStatus::Pending,
            counts: VoquillMigrationCounts::default(),
            removed_modes_reset: Vec::new(),
            issues: Vec::new(),
            action_items: Vec::new(),
            can_retry: false,
        };
        save_manifest(&dirs.current_config_dir, &pending_manifest).unwrap();

        let pool = open_app_database(&dirs.current_db_path()).await.unwrap();
        assert!(
            !is_database_empty_of_user_data(pool.clone()).await.unwrap(),
            "promoted DB contains migrated user data"
        );
        let status = refresh_migration_report(dirs.clone(), pool.clone()).await;
        assert!(status.can_retry);
        assert!(status
            .issues
            .iter()
            .any(|issue| issue.code == "manifest_save_failed"));

        let db_state = OptionKeyDatabase::new(pool);
        let retried = retry_migration(dirs.clone(), db_state).await.unwrap();
        assert_eq!(retried.status, VoquillMigrationStatus::Completed);
        assert_eq!(
            retried.database_phase,
            VoquillMigrationPhaseStatus::Migrated
        );
        assert_eq!(retried.audio_phase, VoquillMigrationPhaseStatus::Migrated);
        assert_eq!(retried.removed_modes_reset, staged.removed_modes_reset);
        assert!(!dirs.promotion_marker_path().exists());
    }

    #[test]
    fn sweep_orphaned_asset_copy_temp_dirs_removes_only_temp_dirs_without_following_symlinks() {
        let ws = unique_workspace("sweep-orphaned-asset-tmp");
        let data_dir = ws.join("data");
        let keep_dir = data_dir.join("models");
        let orphan_a = data_dir.join(format!("{ASSET_COPY_TEMP_PREFIX}999-0"));
        let orphan_b = data_dir.join(format!("{ASSET_COPY_TEMP_PREFIX}999-1"));
        fs::create_dir_all(&keep_dir).unwrap();
        fs::create_dir_all(&orphan_a).unwrap();
        fs::create_dir_all(&orphan_b).unwrap();
        fs::write(keep_dir.join("ggml-tiny.bin"), b"keep").unwrap();
        fs::write(orphan_a.join("copy-1.tmp"), b"stale").unwrap();
        fs::write(orphan_b.join("copy-2.tmp"), b"stale").unwrap();
        fs::write(
            data_dir.join(format!("{ASSET_COPY_TEMP_PREFIX}regular-file")),
            b"file",
        )
        .unwrap();

        #[cfg(unix)]
        let outside_dir = ws.join("outside-target");
        #[cfg(unix)]
        {
            fs::create_dir_all(&outside_dir).unwrap();
            fs::write(outside_dir.join("precious.txt"), b"do-not-delete").unwrap();
            std::os::unix::fs::symlink(
                &outside_dir,
                data_dir.join(format!("{ASSET_COPY_TEMP_PREFIX}symlink")),
            )
            .unwrap();
        }

        sweep_orphaned_asset_copy_temp_dirs(&data_dir).unwrap();

        assert!(!orphan_a.exists());
        assert!(!orphan_b.exists());
        assert!(keep_dir.join("ggml-tiny.bin").exists());
        assert!(data_dir
            .join(format!("{ASSET_COPY_TEMP_PREFIX}regular-file"))
            .exists());
        #[cfg(unix)]
        {
            assert!(
                outside_dir.join("precious.txt").exists(),
                "symlink target must never be traversed or deleted"
            );
            assert!(
                fs::symlink_metadata(data_dir.join(format!("{ASSET_COPY_TEMP_PREFIX}symlink")))
                    .is_ok(),
                "symlink entry itself must not be removed by directory sweep"
            );
        }
    }

    #[test]
    fn copy_file_non_destructive_does_not_replace_concurrent_destination_and_reverts_journal() {
        let ws = unique_workspace("no-replace-publish");
        let dirs = make_dirs(&ws);
        fs::create_dir_all(&dirs.current_config_dir).unwrap();
        let src_dir = ws.join("src");
        let dst_root = dirs.current_data_dir.join(AUDIO_DIR_NAME);
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dst_root).unwrap();
        let src_file = src_dir.join("race.wav");
        let dst_file = dst_root.join("race.wav");
        fs::write(&src_file, b"LEGACY-BYTES").unwrap();

        let temp_dir = AssetCopyTempDir::create_near(&dst_root).unwrap();
        let mut dirs_to_sync = BTreeSet::new();
        let result = copy_file_non_destructive(
            &src_file,
            &dst_root,
            &dst_file,
            &temp_dir,
            &mut dirs_to_sync,
            || {
                // Simulate a concurrent native write creating `dst_file` right
                // before publish happens.
                fs::write(&dst_file, b"NATIVE-NEW-BYTES")?;
                append_asset_progress_entry(
                    &dirs.current_config_dir,
                    '+',
                    AssetCategory::Audio,
                    "race.wav",
                )
            },
        )
        .unwrap();

        assert!(
            !result,
            "concurrently created destination must be skipped, not replaced"
        );
        assert_eq!(
            fs::read(&dst_file).unwrap(),
            b"NATIVE-NEW-BYTES",
            "existing destination bytes must remain intact"
        );

        // Now verify `revert_asset_progress_entry` undoes the `+` entry in the
        // append-only log cleanly.
        let mut progress = load_asset_progress(&dirs.current_config_dir);
        assert!(progress.audio.contains("race.wav"));
        let mut seen = HashSet::new();
        let mut ctx = AssetCopyContext {
            dst_root: &dst_root,
            temp_dir: &temp_dir,
            config_dir: &dirs.current_config_dir,
            category: AssetCategory::Audio,
            progress: &mut progress,
            seen_in_pass: &mut seen,
            dirs_to_sync: &mut dirs_to_sync,
            journal_dir_synced: false,
            sync_journal_dir: &sync_dir_best_effort,
        };
        revert_asset_progress_entry(&mut ctx, "race.wav").unwrap();
        let reloaded = load_asset_progress(&dirs.current_config_dir);
        assert!(!reloaded.audio.contains("race.wav"));
    }

    #[test]
    fn append_only_asset_progress_log_replays_entries_and_supports_legacy_json() {
        let ws = unique_workspace("append-only-progress-log");
        let config_dir = ws.join("config");
        fs::create_dir_all(&config_dir).unwrap();

        // Legacy JSON format remains readable for upgrades from earlier builds.
        fs::write(
            config_dir.join(ASSET_PROGRESS_FILENAME),
            r#"{"models":["ggml-tiny.bin"],"audio":["a.wav"],"storage":[]}"#,
        )
        .unwrap();
        let legacy = load_asset_progress(&config_dir);
        assert!(legacy.models.contains("ggml-tiny.bin"));
        assert!(legacy.audio.contains("a.wav"));

        // Append-only log format replays `+` and `-` deterministically.
        remove_asset_progress(&config_dir);
        append_asset_progress_entry(&config_dir, '+', AssetCategory::Models, "m1.bin").unwrap();
        append_asset_progress_entry(&config_dir, '+', AssetCategory::Audio, "sub/a.wav").unwrap();
        append_asset_progress_entry(&config_dir, '+', AssetCategory::Storage, "s.png").unwrap();
        append_asset_progress_entry(&config_dir, '-', AssetCategory::Audio, "sub/a.wav").unwrap();

        let replayed = load_asset_progress(&config_dir);
        assert!(replayed.models.contains("m1.bin"));
        assert!(!replayed.audio.contains("sub/a.wav"));
        assert!(replayed.storage.contains("s.png"));
    }

    #[cfg(unix)]
    #[test]
    fn unix_non_utf8_asset_filenames_do_not_collide_in_pass_or_progress_log() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        let ws = unique_workspace("unix-non-utf8-assets");
        let dirs = make_dirs(&ws);
        fs::create_dir_all(&dirs.current_config_dir).unwrap();
        let src_dir = dirs.legacy_data_dir.as_ref().unwrap().join(AUDIO_DIR_NAME);
        let dst_dir = dirs.current_data_dir.join(AUDIO_DIR_NAME);
        fs::create_dir_all(&src_dir).unwrap();

        let name_a = OsStr::from_bytes(b"clip-\xff.wav");
        let name_b = OsStr::from_bytes(b"clip-\xfe.wav");
        fs::write(src_dir.join(name_a), b"BYTES-FF").unwrap();
        fs::write(src_dir.join(name_b), b"BYTES-FE").unwrap();

        let mut progress = AssetMigrationProgress::default();
        let outcome = run_asset_category(
            &dirs,
            &[src_dir.clone()],
            &dst_dir,
            false,
            AssetCategory::Audio,
            &mut progress,
        );
        assert_eq!(outcome.copied, 2, "both distinct non-UTF-8 files must copy");
        assert_eq!(outcome.failed, 0);
        assert_eq!(fs::read(dst_dir.join(name_a)).unwrap(), b"BYTES-FF");
        assert_eq!(fs::read(dst_dir.join(name_b)).unwrap(), b"BYTES-FE");

        let reloaded = load_asset_progress(&dirs.current_config_dir);
        assert_eq!(
            reloaded.audio.len(),
            2,
            "distinct non-UTF-8 filenames must produce distinct persisted keys"
        );
    }

    #[tokio::test]
    async fn startup_aborts_on_initial_manifest_failure_and_recovers_no_manifest_with_marker() {
        // Case A: Initial manifest write fails -> must abort BEFORE promoting DB.
        let ws_a = unique_workspace("abort-on-initial-manifest-failure");
        let dirs_a = make_dirs(&ws_a);
        let legacy_db_a = dirs_a.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db_a, 96, false).await;
        let blocking_tmp_a = dirs_a
            .current_config_dir
            .join(format!("{MANIFEST_FILENAME}.tmp"));
        fs::create_dir_all(&blocking_tmp_a).unwrap();

        let res_a = run_startup_migration(&dirs_a).await;
        assert_eq!(res_a.database_phase, VoquillMigrationPhaseStatus::Failed);
        assert!(res_a
            .issues
            .iter()
            .any(|issue| issue.code == "manifest_save_failed"));
        assert!(
            !dirs_a.current_db_path().exists(),
            "DB must never be promoted if initial manifest cannot be persisted"
        );

        // Case B: Promoted DB + verified promotion marker with NO manifest file
        // -> must recover cleanly, migrate pending assets, and restore
        // `removed_modes_reset`.
        let ws_b = unique_workspace("no-manifest-verified-marker-recovery");
        let dirs_b = make_dirs(&ws_b);
        let legacy_db_b = dirs_b.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db_b, 96, false).await;
        let legacy_audio_b = dirs_b
            .legacy_data_dir
            .as_ref()
            .unwrap()
            .join(AUDIO_DIR_NAME);
        fs::create_dir_all(&legacy_audio_b).unwrap();
        fs::write(legacy_audio_b.join("recover.wav"), b"RIFFrec").unwrap();

        let staged_b = stage_validate_and_promote_database(&dirs_b).await.unwrap();
        assert!(
            !staged_b.removed_modes_reset.is_empty(),
            "seeded Voquill DB includes cloud modes that were reset"
        );
        let (full_sha, payload_sha) = hash_staged_database(&dirs_b.current_db_path()).unwrap();
        write_promotion_marker(
            &dirs_b.promotion_marker_path(),
            "startup",
            full_sha,
            payload_sha,
            staged_b.removed_modes_reset.clone(),
        )
        .unwrap();
        assert!(!dirs_b.current_config_dir.join(MANIFEST_FILENAME).exists());

        let res_b = run_startup_migration(&dirs_b).await;
        assert_eq!(res_b.status, VoquillMigrationStatus::Completed);
        assert_eq!(res_b.database_phase, VoquillMigrationPhaseStatus::Migrated);
        assert_eq!(res_b.audio_phase, VoquillMigrationPhaseStatus::Migrated);
        assert_eq!(res_b.removed_modes_reset, staged_b.removed_modes_reset);
        assert!(res_b
            .action_items
            .iter()
            .any(|item| item.kind == "review_removed_cloud_mode"));
        assert!(!dirs_b.promotion_marker_path().exists());

        // Case C: Unrelated DB + mismatched marker with NO manifest file ->
        // must still treat as `SkippedExistingProfile` and never leak marker modes.
        let ws_c = unique_workspace("no-manifest-mismatched-marker");
        let dirs_c = make_dirs(&ws_c);
        fs::create_dir_all(&dirs_c.current_config_dir).unwrap();
        let legacy_audio_c = dirs_c
            .legacy_data_dir
            .as_ref()
            .unwrap()
            .join(AUDIO_DIR_NAME);
        fs::create_dir_all(&legacy_audio_c).unwrap();
        fs::write(legacy_audio_c.join("skip.wav"), b"RIFFskip").unwrap();
        let unrelated_pool = open_app_database(&dirs_c.current_db_path()).await.unwrap();
        unrelated_pool.close().await;
        write_promotion_marker(
            &dirs_c.promotion_marker_path(),
            "startup",
            "0000000000000000000000000000000000000000000000000000000000000000".to_string(),
            String::new(),
            vec!["transcription:cloud".to_string()],
        )
        .unwrap();

        let res_c = run_startup_migration(&dirs_c).await;
        assert_eq!(res_c.status, VoquillMigrationStatus::SkippedExistingProfile);
        assert!(res_c.removed_modes_reset.is_empty());
        assert!(!dirs_c
            .current_data_dir
            .join(AUDIO_DIR_NAME)
            .join("skip.wav")
            .exists());
    }

    #[test]
    fn progress_log_skips_multibyte_and_malformed_leading_bytes_without_panicking() {
        let ws = unique_workspace("progress-log-multibyte");
        let config_dir = ws.join("config");
        fs::create_dir_all(&config_dir).unwrap();
        let progress_path = config_dir.join(ASSET_PROGRESS_FILENAME);

        let mut raw = Vec::new();
        raw.extend_from_slice("é\tnot-an-op\n".as_bytes());
        raw.extend_from_slice(b"\xff\tinvalid-utf8\n");
        raw.extend_from_slice(b"+m\tmodel.bin\n");
        raw.extend_from_slice(b"+a\tkeep.wav\n");
        raw.extend_from_slice(b"+a\tdrop.wav\n");
        raw.extend_from_slice(b"-a\tdrop.wav\n");
        fs::write(&progress_path, raw).unwrap();

        let replayed = load_asset_progress(&config_dir);
        assert!(replayed.models.contains("model.bin"));
        assert!(replayed.audio.contains("keep.wav"));
        assert!(!replayed.audio.contains("drop.wav"));
    }

    #[test]
    fn temp_sweep_syncs_data_dir_even_when_empty_and_propagates_sync_failure() {
        let ws = unique_workspace("temp-sweep-sync-error");
        let data_dir = ws.join("data");
        fs::create_dir_all(&data_dir).unwrap();

        let mut synced_paths = Vec::new();
        sweep_orphaned_asset_copy_temp_dirs_with_sync(&data_dir, |path| {
            synced_paths.push(path.to_path_buf());
            Ok(())
        })
        .unwrap();
        assert_eq!(synced_paths, vec![data_dir.clone()]);

        let err = sweep_orphaned_asset_copy_temp_dirs_with_sync(&data_dir, |_| {
            Err(io::Error::other("simulated dir sync failure"))
        })
        .expect_err("sync failure must propagate from temp sweep");
        assert!(err.contains("Failed to sync data directory after migration temp sweep"));
    }

    #[tokio::test]
    async fn retry_marker_sync_failure_retires_published_marker_or_recovers_rolled_back_db() {
        // Case A: Marker rename succeeds and dir sync fails, then retirement succeeds ->
        // marker is removed and next retry imports cleanly without SkippedExistingProfile.
        let ws_a = unique_workspace("retry-marker-sync-retire-ok");
        let dirs_a = make_dirs(&ws_a);
        let legacy_db_a = dirs_a.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db_a, 96, false).await;
        fs::create_dir_all(&dirs_a.current_config_dir).unwrap();

        let empty_pool_a = open_app_database(&dirs_a.current_db_path()).await.unwrap();
        empty_pool_a.close().await;

        let (staged_db_a, staged_a) = stage_validate_in_staging_only(&dirs_a).await.unwrap();
        let (full_sha_a, payload_sha_a) = hash_staged_database(&staged_db_a).unwrap();

        let err_a = swap_retry_database_on_disk_with_sync(
            &staged_db_a,
            &dirs_a.current_db_path(),
            &dirs_a.promotion_marker_path(),
            RetrySwapMarkerSpec {
                staged_sha256: full_sha_a,
                staged_payload_sha256: payload_sha_a,
                removed_modes_reset: staged_a.removed_modes_reset.clone(),
            },
            RetrySwapSyncHooks {
                marker_sync: |_| Err(io::Error::other("simulated marker dir sync failure")),
                promote_sync: sync_dir_best_effort,
                retire_sync: sync_dir_best_effort,
            },
        )
        .expect_err("marker dir sync failure must fail retry swap");
        assert!(err_a.restored_ok);
        assert!(!err_a.installed_unsynced);
        assert!(
            !dirs_a.promotion_marker_path().exists(),
            "published marker must be retired after successful rollback"
        );
        cleanup_staging(&dirs_a.staging_dir());

        // Case B: Marker rename succeeds, dir sync fails, AND marker retirement fails
        // (leaving the published marker with `pre_retry_payload_sha256` on disk) ->
        // Retry must recognize the rolled-back empty DB, retire the stale marker, and import.
        let ws_b = unique_workspace("retry-marker-sync-retire-fail");
        let dirs_b = make_dirs(&ws_b);
        let legacy_db_b = dirs_b.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db_b, 96, false).await;
        fs::create_dir_all(&dirs_b.current_config_dir).unwrap();

        let empty_pool_b = open_app_database(&dirs_b.current_db_path()).await.unwrap();
        empty_pool_b.close().await;

        let (staged_db_b, staged_b) = stage_validate_in_staging_only(&dirs_b).await.unwrap();
        let (full_sha_b, payload_sha_b) = hash_staged_database(&staged_db_b).unwrap();

        let err_b = swap_retry_database_on_disk_with_sync(
            &staged_db_b,
            &dirs_b.current_db_path(),
            &dirs_b.promotion_marker_path(),
            RetrySwapMarkerSpec {
                staged_sha256: full_sha_b.clone(),
                staged_payload_sha256: payload_sha_b.clone(),
                removed_modes_reset: staged_b.removed_modes_reset.clone(),
            },
            RetrySwapSyncHooks {
                marker_sync: |_| Err(io::Error::other("simulated marker dir sync failure")),
                promote_sync: sync_dir_best_effort,
                retire_sync: |_| Err(io::Error::other("simulated retire dir sync failure")),
            },
        )
        .expect_err("marker retirement sync failure must fail closed");
        assert!(!err_b.restored_ok);
        cleanup_staging(&dirs_b.staging_dir());

        // Simulate a crash resurrecting the published marker before the unlinked entry synced.
        let pre_retry_payload_b = sha256_db_payload_hex(&dirs_b.current_db_path()).unwrap();
        write_promotion_marker_record_with_sync(
            &dirs_b.promotion_marker_path(),
            &PromotionMarker {
                mode: "retry".to_string(),
                staged_sha256: full_sha_b,
                staged_payload_sha256: payload_sha_b,
                pre_retry_payload_sha256: Some(pre_retry_payload_b),
                removed_modes_reset: staged_b.removed_modes_reset.clone(),
            },
            sync_dir_best_effort,
        )
        .unwrap();

        let failed_manifest = VoquillMigrationReport {
            status: VoquillMigrationStatus::Failed,
            legacy_detected: true,
            legacy_source_preserved: true,
            database_phase: VoquillMigrationPhaseStatus::Failed,
            models_phase: VoquillMigrationPhaseStatus::Skipped,
            audio_phase: VoquillMigrationPhaseStatus::Skipped,
            storage_phase: VoquillMigrationPhaseStatus::Skipped,
            can_retry: true,
            ..VoquillMigrationReport::not_needed()
        };
        save_manifest(&dirs_b.current_config_dir, &failed_manifest).unwrap();

        let reopened_b = open_app_database(&dirs_b.current_db_path()).await.unwrap();
        let db_state_b = OptionKeyDatabase::new(reopened_b.clone());
        let refreshed = refresh_migration_report(dirs_b.clone(), reopened_b).await;
        assert_eq!(refreshed.status, VoquillMigrationStatus::Failed);
        assert!(refreshed.can_retry);

        let retried = retry_migration(dirs_b.clone(), db_state_b).await.unwrap();
        assert_eq!(retried.status, VoquillMigrationStatus::Completed);
        assert_eq!(
            retried.database_phase,
            VoquillMigrationPhaseStatus::Migrated
        );
        assert!(!dirs_b.promotion_marker_path().exists());
    }

    #[tokio::test]
    async fn unreadable_promotion_marker_keeps_recovery_pending_for_startup_and_retry() {
        let ws = unique_workspace("unreadable-marker-io-error");
        let dirs = make_dirs(&ws);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 96, false).await;

        let staged = stage_validate_and_promote_database(&dirs).await.unwrap();
        let (full_sha, payload_sha) = hash_staged_database(&dirs.current_db_path()).unwrap();
        // Replace marker file with a directory so `fs::read` returns an I/O error
        // (`EISDIR`) on all platforms even when tests run as root.
        let _ = fs::remove_file(dirs.promotion_marker_path());
        fs::create_dir_all(dirs.promotion_marker_path()).unwrap();

        let pending_manifest = VoquillMigrationReport {
            status: VoquillMigrationStatus::Partial,
            legacy_detected: true,
            legacy_source_preserved: true,
            database_phase: VoquillMigrationPhaseStatus::Pending,
            models_phase: VoquillMigrationPhaseStatus::Pending,
            audio_phase: VoquillMigrationPhaseStatus::Pending,
            storage_phase: VoquillMigrationPhaseStatus::Pending,
            can_retry: true,
            ..VoquillMigrationReport::not_needed()
        };
        save_manifest(&dirs.current_config_dir, &pending_manifest).unwrap();

        // Startup recovery must NOT delete the marker or record SkippedExistingProfile.
        let startup_res = run_startup_migration(&dirs).await;
        assert_eq!(startup_res.status, VoquillMigrationStatus::Partial);
        assert_ne!(
            startup_res.status,
            VoquillMigrationStatus::SkippedExistingProfile
        );
        assert!(startup_res.can_retry);
        assert!(startup_res
            .issues
            .iter()
            .any(|issue| issue.code == "recovery_marker_io_error"));
        assert!(dirs.promotion_marker_path().exists());
        assert!(
            ensure_no_pending_promotion_recovery(&dirs).is_err(),
            "startup must fail closed while unreadable promotion marker remains pending"
        );

        // Retry recovery must also keep the marker and return a retryable error.
        let pool = open_app_database(&dirs.current_db_path()).await.unwrap();
        let db_state = OptionKeyDatabase::new(pool);
        let retry_err = retry_migration(dirs.clone(), db_state.clone())
            .await
            .expect_err("unreadable marker must fail retry without SkippedExistingProfile");
        assert!(retry_err.contains("Could not read Voquill promotion recovery marker"));
        assert!(dirs.promotion_marker_path().exists());
        let saved_after_retry = load_manifest(&dirs.current_config_dir).unwrap();
        assert_ne!(
            saved_after_retry.status,
            VoquillMigrationStatus::SkippedExistingProfile
        );

        // Once the marker becomes readable again, retry recovery completes cleanly.
        fs::remove_dir(dirs.promotion_marker_path()).unwrap();
        write_promotion_marker(
            &dirs.promotion_marker_path(),
            "retry",
            full_sha,
            payload_sha,
            staged.removed_modes_reset.clone(),
        )
        .unwrap();
        let recovered = retry_migration(dirs.clone(), db_state).await.unwrap();
        assert_eq!(recovered.status, VoquillMigrationStatus::Completed);
        assert_eq!(
            recovered.database_phase,
            VoquillMigrationPhaseStatus::Migrated
        );
        assert!(!dirs.promotion_marker_path().exists());
        assert!(ensure_no_pending_promotion_recovery(&dirs).is_ok());
    }

    #[tokio::test]
    async fn installed_but_not_synced_database_preserves_marker_blocks_startup_and_recovers() {
        let ws = unique_workspace("installed-but-not-synced");
        let dirs = make_dirs(&ws);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 96, false).await;
        let legacy_audio = dirs.legacy_data_dir.as_ref().unwrap().join(AUDIO_DIR_NAME);
        fs::create_dir_all(&legacy_audio).unwrap();
        fs::write(legacy_audio.join("sync-recover.wav"), b"RIFFsync").unwrap();

        let initial_report = new_startup_report(
            now_iso(),
            VoquillMigrationStatus::Partial,
            VoquillMigrationPhaseStatus::Pending,
            VoquillMigrationPhaseStatus::Pending,
            false,
        );

        let res = finish_startup_database_and_assets_with_sync(&dirs, initial_report, true, |_| {
            Err(io::Error::other("simulated post-rename dir sync failure"))
        })
        .await;

        assert_eq!(res.status, VoquillMigrationStatus::Partial);
        assert_eq!(res.database_phase, VoquillMigrationPhaseStatus::Pending);
        assert!(res
            .issues
            .iter()
            .any(|issue| issue.code == "promote_sync_failed"));
        assert!(
            dirs.current_db_path().exists(),
            "renamed database must remain installed on disk"
        );
        assert!(
            dirs.promotion_marker_path().exists(),
            "promotion marker must be preserved when post-rename dir sync fails"
        );
        assert!(
            ensure_no_pending_promotion_recovery(&dirs).is_err(),
            "startup guard must refuse to open installed-but-not-synced DB for normal use"
        );
        assert!(
            !dirs
                .current_data_dir
                .join(AUDIO_DIR_NAME)
                .join("sync-recover.wav")
                .exists(),
            "assets must wait until database promotion is verified and checkpointed"
        );

        // Next launch recovers the installed DB, syncs, checkpoints, and imports assets.
        let recovered = run_startup_migration(&dirs).await;
        assert_eq!(recovered.status, VoquillMigrationStatus::Completed);
        assert_eq!(
            recovered.database_phase,
            VoquillMigrationPhaseStatus::Migrated
        );
        assert_eq!(recovered.audio_phase, VoquillMigrationPhaseStatus::Migrated);
        assert!(!dirs.promotion_marker_path().exists());
        assert!(ensure_no_pending_promotion_recovery(&dirs).is_ok());
        assert!(dirs
            .current_data_dir
            .join(AUDIO_DIR_NAME)
            .join("sync-recover.wav")
            .exists());
    }

    #[tokio::test]
    async fn malformed_promotion_marker_json_keeps_recovery_pending_for_startup_and_retry() {
        let ws = unique_workspace("malformed-marker-json");
        let dirs = make_dirs(&ws);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 96, false).await;

        let staged = stage_validate_and_promote_database(&dirs).await.unwrap();
        let (full_sha, payload_sha) = hash_staged_database(&dirs.current_db_path()).unwrap();
        fs::write(dirs.promotion_marker_path(), b"{\"mode\":\"startup\"").unwrap();

        let pending_manifest = VoquillMigrationReport {
            status: VoquillMigrationStatus::Partial,
            legacy_detected: true,
            legacy_source_preserved: true,
            database_phase: VoquillMigrationPhaseStatus::Pending,
            models_phase: VoquillMigrationPhaseStatus::Pending,
            audio_phase: VoquillMigrationPhaseStatus::Pending,
            storage_phase: VoquillMigrationPhaseStatus::Pending,
            can_retry: true,
            ..VoquillMigrationReport::not_needed()
        };
        save_manifest(&dirs.current_config_dir, &pending_manifest).unwrap();

        let startup_res = run_startup_migration(&dirs).await;
        assert_eq!(startup_res.status, VoquillMigrationStatus::Partial);
        assert!(startup_res.can_retry);
        assert!(startup_res
            .issues
            .iter()
            .any(|issue| issue.code == "recovery_marker_io_error"));
        assert!(dirs.promotion_marker_path().exists());
        assert!(ensure_no_pending_promotion_recovery(&dirs).is_err());

        let pool = open_app_database(&dirs.current_db_path()).await.unwrap();
        let db_state = OptionKeyDatabase::new(pool);
        let retry_err = retry_migration(dirs.clone(), db_state.clone())
            .await
            .expect_err("malformed marker JSON must fail retry without SkippedExistingProfile");
        assert!(retry_err.contains("Malformed Voquill promotion marker JSON"));
        assert!(dirs.promotion_marker_path().exists());
        let saved_after_retry = load_manifest(&dirs.current_config_dir).unwrap();
        assert_ne!(
            saved_after_retry.status,
            VoquillMigrationStatus::SkippedExistingProfile
        );

        write_promotion_marker(
            &dirs.promotion_marker_path(),
            "retry",
            full_sha,
            payload_sha,
            staged.removed_modes_reset,
        )
        .unwrap();
        let recovered = retry_migration(dirs.clone(), db_state).await.unwrap();
        assert_eq!(recovered.status, VoquillMigrationStatus::Completed);
        assert_eq!(
            recovered.database_phase,
            VoquillMigrationPhaseStatus::Migrated
        );
        assert!(!dirs.promotion_marker_path().exists());
    }

    #[test]
    fn record_migration_cleared_removes_promotion_temp_file_and_propagates_failure() {
        let ws = unique_workspace("clear-removes-migrating-tmp");
        let config_dir = ws.join("config");
        fs::create_dir_all(&config_dir).unwrap();

        let tmp_db = config_dir.join(format!("{DB_FILENAME}{PROMOTION_TEMP_SUFFIX}"));
        fs::write(&tmp_db, b"staged-db-copy").unwrap();
        record_migration_cleared(&config_dir).unwrap();
        assert!(
            !tmp_db.exists(),
            "clear must remove mausvoice.db.migrating.tmp"
        );

        fs::create_dir_all(&tmp_db).unwrap();
        record_migration_cleared(&config_dir)
            .expect_err("directory blocking mausvoice.db.migrating.tmp must propagate error");
        fs::remove_dir(&tmp_db).unwrap();
    }

    #[tokio::test]
    async fn recover_missing_current_db_clears_promote_sync_failed_and_keeps_asset_issues() {
        // Case A: Re-promotion succeeds with a real current audio copy failure ->
        // `promote_sync_failed` must be cleared while the current audio issue is kept.
        let ws = unique_workspace("missing-db-clears-promote-sync");
        let dirs = make_dirs(&ws);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 96, false).await;
        let legacy_audio = dirs.legacy_data_dir.as_ref().unwrap().join(AUDIO_DIR_NAME);
        fs::create_dir_all(&legacy_audio).unwrap();
        fs::write(legacy_audio.join("blocked.wav"), b"RIFFblocked").unwrap();
        let blocked_dst = dirs
            .current_data_dir
            .join(AUDIO_DIR_NAME)
            .join("blocked.wav");
        fs::create_dir_all(&blocked_dst).unwrap();

        let initial_report = new_startup_report(
            now_iso(),
            VoquillMigrationStatus::Partial,
            VoquillMigrationPhaseStatus::Pending,
            VoquillMigrationPhaseStatus::Pending,
            false,
        );
        let unsynced =
            finish_startup_database_and_assets_with_sync(&dirs, initial_report, true, |_| {
                Err(io::Error::other("simulated post-rename dir sync failure"))
            })
            .await;
        assert!(unsynced
            .issues
            .iter()
            .any(|issue| issue.code == "promote_sync_failed"));

        // Simulate crash loss of the unsynced DB entry before next launch.
        fs::remove_file(dirs.current_db_path()).unwrap();

        let recovered = run_startup_migration(&dirs).await;
        assert_eq!(recovered.status, VoquillMigrationStatus::Partial);
        assert_eq!(
            recovered.database_phase,
            VoquillMigrationPhaseStatus::Migrated
        );
        assert!(
            !recovered
                .issues
                .iter()
                .any(|issue| issue.code == "promote_sync_failed"),
            "successful re-promotion must clear resolved promote_sync_failed issue"
        );
        assert!(
            recovered
                .issues
                .iter()
                .any(|issue| issue.category == "audio" && issue.code == "partial_asset_copy"),
            "current asset errors must be preserved"
        );

        // Case B: Re-promotion succeeds with no asset errors -> `Completed` with no stale issue.
        let ws_b = unique_workspace("missing-db-clears-promote-sync-clean");
        let dirs_b = make_dirs(&ws_b);
        let legacy_db_b = dirs_b.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db_b, 96, false).await;
        let initial_b = new_startup_report(
            now_iso(),
            VoquillMigrationStatus::Partial,
            VoquillMigrationPhaseStatus::Pending,
            VoquillMigrationPhaseStatus::Pending,
            false,
        );
        let unsynced_b =
            finish_startup_database_and_assets_with_sync(&dirs_b, initial_b, true, |_| {
                Err(io::Error::other("simulated post-rename dir sync failure"))
            })
            .await;
        assert!(unsynced_b
            .issues
            .iter()
            .any(|issue| issue.code == "promote_sync_failed"));
        fs::remove_file(dirs_b.current_db_path()).unwrap();

        let completed_b = run_startup_migration(&dirs_b).await;
        assert_eq!(completed_b.status, VoquillMigrationStatus::Completed);
        assert!(completed_b.issues.is_empty());
    }

    #[tokio::test]
    async fn rolled_back_recovery_persists_manifest_before_retiring_marker_and_resumes_cleanly() {
        let ws = unique_workspace("rollback-manifest-before-retire");
        let dirs = make_dirs(&ws);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 96, false).await;
        fs::create_dir_all(&dirs.current_config_dir).unwrap();

        let empty_pool = open_app_database(&dirs.current_db_path()).await.unwrap();
        empty_pool.close().await;
        let pre_retry_payload = sha256_db_payload_hex(&dirs.current_db_path()).unwrap();

        let rollback_marker = PromotionMarker {
            mode: "retry".to_string(),
            staged_sha256: "a".repeat(64),
            staged_payload_sha256: "b".repeat(64),
            pre_retry_payload_sha256: Some(pre_retry_payload),
            removed_modes_reset: Vec::new(),
        };
        write_promotion_marker_record_with_sync(
            &dirs.promotion_marker_path(),
            &rollback_marker,
            sync_dir_best_effort,
        )
        .unwrap();

        // Block manifest creation so `save_manifest` fails; marker must remain on disk.
        let blocking_tmp = dirs
            .current_config_dir
            .join(format!("{MANIFEST_FILENAME}.tmp"));
        fs::create_dir_all(&blocking_tmp).unwrap();
        let failed_save = run_startup_migration(&dirs).await;
        assert_eq!(failed_save.status, VoquillMigrationStatus::Partial);
        assert!(failed_save
            .issues
            .iter()
            .any(|issue| issue.code == "manifest_save_failed"));
        assert!(
            dirs.promotion_marker_path().exists(),
            "marker must remain when rolled-back manifest save fails"
        );
        assert!(ensure_no_pending_promotion_recovery(&dirs).is_err());

        // Unblock manifest save -> startup saves rolled-back manifest and retires marker.
        fs::remove_dir(&blocking_tmp).unwrap();
        let recovered = run_startup_migration(&dirs).await;
        assert_eq!(recovered.status, VoquillMigrationStatus::Failed);
        assert_eq!(
            recovered.database_phase,
            VoquillMigrationPhaseStatus::Failed
        );
        assert!(recovered.can_retry);
        assert!(!dirs.promotion_marker_path().exists());
        assert!(ensure_no_pending_promotion_recovery(&dirs).is_ok());

        // Simulate crash between `save_manifest` and marker retirement (both exist on disk).
        write_promotion_marker_record_with_sync(
            &dirs.promotion_marker_path(),
            &rollback_marker,
            sync_dir_best_effort,
        )
        .unwrap();
        let resumed = run_startup_migration(&dirs).await;
        assert_eq!(resumed.status, VoquillMigrationStatus::Failed);
        assert_eq!(resumed.database_phase, VoquillMigrationPhaseStatus::Failed);
        assert!(resumed.can_retry);
        assert!(!dirs.promotion_marker_path().exists());
    }

    #[tokio::test]
    async fn refresh_migration_report_handles_all_marker_verification_outcomes() {
        let ws = unique_workspace("refresh-marker-outcomes");
        let dirs = make_dirs(&ws);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 96, false).await;
        fs::create_dir_all(&dirs.current_config_dir).unwrap();

        let pool = open_app_database(&dirs.current_db_path()).await.unwrap();
        let (full_sha, payload_sha) = hash_staged_database(&dirs.current_db_path()).unwrap();

        let pending_manifest = VoquillMigrationReport {
            status: VoquillMigrationStatus::Partial,
            legacy_detected: true,
            legacy_source_preserved: true,
            database_phase: VoquillMigrationPhaseStatus::Pending,
            models_phase: VoquillMigrationPhaseStatus::Pending,
            audio_phase: VoquillMigrationPhaseStatus::Pending,
            storage_phase: VoquillMigrationPhaseStatus::Pending,
            can_retry: true,
            ..VoquillMigrationReport::not_needed()
        };
        save_manifest(&dirs.current_config_dir, &pending_manifest).unwrap();

        // Case A: MatchesPromoted -> reports manifest_save_failed + Partial.
        write_promotion_marker(
            &dirs.promotion_marker_path(),
            "startup",
            full_sha,
            payload_sha.clone(),
            Vec::new(),
        )
        .unwrap();
        let matched = refresh_migration_report(dirs.clone(), pool.clone()).await;
        assert_eq!(matched.status, VoquillMigrationStatus::Partial);
        assert!(matched.can_retry);
        assert!(matched
            .issues
            .iter()
            .any(|issue| issue.code == "manifest_save_failed"));

        // Case B: IoError (malformed marker) -> reports recovery_marker_io_error, NOT manifest_save_failed.
        fs::write(dirs.promotion_marker_path(), b"{truncated").unwrap();
        let io_err = refresh_migration_report(dirs.clone(), pool.clone()).await;
        assert_eq!(io_err.status, VoquillMigrationStatus::Partial);
        assert!(io_err.can_retry);
        assert!(io_err
            .issues
            .iter()
            .any(|issue| issue.code == "recovery_marker_io_error"));
        assert!(!io_err
            .issues
            .iter()
            .any(|issue| issue.code == "manifest_save_failed"));

        // Case C: Mismatch -> reports SkippedExistingProfile + existing_profile_conflict.
        write_promotion_marker(
            &dirs.promotion_marker_path(),
            "startup",
            "0".repeat(64),
            String::new(),
            Vec::new(),
        )
        .unwrap();
        let mismatch = refresh_migration_report(dirs.clone(), pool.clone()).await;
        assert_eq!(
            mismatch.status,
            VoquillMigrationStatus::SkippedExistingProfile
        );
        assert!(!mismatch.can_retry);
        assert!(mismatch
            .issues
            .iter()
            .any(|issue| issue.code == "existing_profile_conflict"));
        assert!(!mismatch
            .issues
            .iter()
            .any(|issue| issue.code == "manifest_save_failed"));

        // Case D: MatchesRolledBackPreRetry -> stays retryable without falsely claiming promotion completed.
        write_promotion_marker_record_with_sync(
            &dirs.promotion_marker_path(),
            &PromotionMarker {
                mode: "retry".to_string(),
                staged_sha256: "1".repeat(64),
                staged_payload_sha256: "2".repeat(64),
                pre_retry_payload_sha256: Some(payload_sha),
                removed_modes_reset: Vec::new(),
            },
            sync_dir_best_effort,
        )
        .unwrap();
        let rolled_back = refresh_migration_report(dirs.clone(), pool.clone()).await;
        assert!(rolled_back.can_retry);
        assert!(!rolled_back
            .issues
            .iter()
            .any(|issue| issue.code == "manifest_save_failed"));
        pool.close().await;
    }

    #[test]
    fn promote_staged_file_never_replaces_existing_destination_on_primary_or_fallback_path() {
        let ws = unique_workspace("promote-no-replace");
        let staging_dir = ws.join("staging");
        let config_dir = ws.join("config");
        fs::create_dir_all(&staging_dir).unwrap();
        fs::create_dir_all(&config_dir).unwrap();

        let staged_db = staging_dir.join(STAGED_DB_FILENAME);
        let current_db = config_dir.join(DB_FILENAME);
        let tmp_dest = config_dir.join(format!("{DB_FILENAME}{PROMOTION_TEMP_SUFFIX}"));
        fs::write(&staged_db, b"staged-voquill-bytes").unwrap();
        fs::write(&current_db, b"existing-profile-bytes").unwrap();

        // Primary path must fail with existing_profile_conflict and keep current_db untouched.
        let primary_err =
            promote_staged_file_with_sync(&staged_db, &current_db, sync_dir_best_effort)
                .expect_err("primary promote must never replace an existing database");
        match primary_err {
            PromoteError::NotInstalled(issue) => {
                assert_eq!(issue.code, "existing_profile_conflict");
            }
            PromoteError::InstalledButNotSynced(_) => {
                panic!("expected NotInstalled(existing_profile_conflict)");
            }
        }
        assert_eq!(fs::read(&current_db).unwrap(), b"existing-profile-bytes");

        // Copy fallback path must also refuse to replace an existing database and clean tmp_dest.
        let simulated_xdev = io::Error::other("simulated cross-device link");
        let fallback_err =
            install_file_no_replace_via_copy_fallback(&staged_db, &current_db, &simulated_xdev)
                .expect_err("copy fallback must never replace an existing database");
        match fallback_err {
            PromoteError::NotInstalled(issue) => {
                assert_eq!(issue.code, "existing_profile_conflict");
            }
            PromoteError::InstalledButNotSynced(_) => {
                panic!("expected NotInstalled(existing_profile_conflict)");
            }
        }
        assert_eq!(fs::read(&current_db).unwrap(), b"existing-profile-bytes");
        assert!(!tmp_dest.exists());

        // When current_db is absent, copy fallback installs cleanly and removes tmp_dest.
        fs::remove_file(&current_db).unwrap();
        install_file_no_replace_via_copy_fallback(&staged_db, &current_db, &simulated_xdev)
            .unwrap();
        assert_eq!(fs::read(&current_db).unwrap(), b"staged-voquill-bytes");
        assert!(!tmp_dest.exists());

        // When current_db is absent and dir sync fails, primary path reports InstalledButNotSynced.
        fs::remove_file(&current_db).unwrap();
        fs::write(&staged_db, b"staged-voquill-bytes-2").unwrap();
        let sync_err = promote_staged_file_with_sync(&staged_db, &current_db, |_| {
            Err(io::Error::other("simulated dir sync failure"))
        })
        .expect_err("dir sync failure must report InstalledButNotSynced");
        match sync_err {
            PromoteError::InstalledButNotSynced(issue) => {
                assert_eq!(issue.code, "promote_sync_failed");
            }
            PromoteError::NotInstalled(_) => {
                panic!("expected InstalledButNotSynced(promote_sync_failed)");
            }
        }
        assert_eq!(fs::read(&current_db).unwrap(), b"staged-voquill-bytes-2");
    }

    #[tokio::test]
    async fn ensure_usable_pool_recovers_closed_pool_after_unsynced_retry_for_clear() {
        let ws = unique_workspace("closed-pool-recovery-for-clear");
        let dirs = make_dirs(&ws);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 96, false).await;
        fs::create_dir_all(&dirs.current_config_dir).unwrap();

        let initial_pool = open_app_database(&dirs.current_db_path()).await.unwrap();
        let db_state = OptionKeyDatabase::new(initial_pool);
        let (staged_db, staged) = stage_validate_in_staging_only(&dirs).await.unwrap();
        let (full_sha, payload_sha) = hash_staged_database(&staged_db).unwrap();

        // Simulate retry closing the pool and failing on post-install dir sync.
        db_state.pool().close().await;
        let swap_err = swap_retry_database_on_disk_with_sync(
            &staged_db,
            &dirs.current_db_path(),
            &dirs.promotion_marker_path(),
            RetrySwapMarkerSpec {
                staged_sha256: full_sha,
                staged_payload_sha256: payload_sha,
                removed_modes_reset: staged.removed_modes_reset,
            },
            RetrySwapSyncHooks {
                marker_sync: sync_dir_best_effort,
                promote_sync: |_| Err(io::Error::other("simulated retry dir sync failure")),
                retire_sync: sync_dir_best_effort,
            },
        )
        .expect_err("retry promote sync failure must return error");
        assert!(swap_err.installed_unsynced);
        assert!(db_state.pool().is_closed());
        cleanup_staging(&dirs.staging_dir());

        // Clear local data's recovery path reopens the database under the clear lock.
        let recovered_pool = ensure_usable_pool(&dirs, &db_state).await.unwrap();
        assert!(!recovered_pool.is_closed());
        assert!(!db_state.pool().is_closed());
        let ping: i64 = sqlx::query_scalar("SELECT 1")
            .fetch_one(&recovered_pool)
            .await
            .unwrap();
        assert_eq!(ping, 1);
        recovered_pool.close().await;
    }

    #[tokio::test]
    async fn dismiss_migration_notice_retries_dir_sync_when_timestamp_already_visible() {
        let ws = unique_workspace("dismiss-retry-dir-sync");
        let dirs = make_dirs(&ws);
        fs::create_dir_all(&dirs.current_config_dir).unwrap();
        let pool = open_app_database(&dirs.current_db_path()).await.unwrap();

        let completed = VoquillMigrationReport {
            schema_version: MANIFEST_SCHEMA_VERSION,
            status: VoquillMigrationStatus::Completed,
            legacy_detected: true,
            legacy_source_preserved: true,
            detected_at: Some(now_iso()),
            completed_at: Some(now_iso()),
            dismissed_at: None,
            attempt_count: 1,
            database_phase: VoquillMigrationPhaseStatus::Migrated,
            models_phase: VoquillMigrationPhaseStatus::NotFound,
            audio_phase: VoquillMigrationPhaseStatus::NotFound,
            storage_phase: VoquillMigrationPhaseStatus::NotFound,
            counts: VoquillMigrationCounts::default(),
            removed_modes_reset: Vec::new(),
            issues: Vec::new(),
            action_items: Vec::new(),
            can_retry: false,
        };
        save_manifest(&dirs.current_config_dir, &completed).unwrap();

        let err1 = dismiss_migration_notice_with_sync(dirs.clone(), pool.clone(), |_| {
            Err(io::Error::other("simulated config dir sync failure 1"))
        })
        .await
        .expect_err("first dismiss must fail when dir sync fails");
        assert!(err1.contains("simulated config dir sync failure 1"));

        let saved_first = load_manifest(&dirs.current_config_dir).unwrap();
        let first_ts = saved_first.dismissed_at.unwrap();

        let err2 = dismiss_migration_notice_with_sync(dirs.clone(), pool.clone(), |_| {
            Err(io::Error::other("simulated config dir sync failure 2"))
        })
        .await
        .expect_err("second dismiss must retry dir sync and propagate failure");
        assert!(err2.contains("simulated config dir sync failure 2"));

        let saved = load_manifest(&dirs.current_config_dir).unwrap();
        assert_eq!(saved.dismissed_at.as_deref(), Some(first_ts.as_str()));

        let ok_report =
            dismiss_migration_notice_with_sync(dirs.clone(), pool.clone(), sync_dir_best_effort)
                .await
                .unwrap();
        assert_eq!(ok_report.dismissed_at.as_deref(), Some(first_ts.as_str()));
        pool.close().await;
    }

    #[tokio::test]
    async fn startup_recovers_orphaned_promotion_marker_when_legacy_source_removed() {
        // Case A: DB was promoted and marker written, manifest was lost, and
        // legacy Voquill files were deleted before relaunch.
        let ws_a = unique_workspace("orphan-marker-no-legacy-promoted");
        let dirs_a = make_dirs(&ws_a);
        let legacy_db = dirs_a.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 96, false).await;
        let (staged_db, staged) = stage_validate_in_staging_only(&dirs_a).await.unwrap();
        let (full_sha, payload_sha) = hash_staged_database(&staged_db).unwrap();
        fs::create_dir_all(&dirs_a.current_config_dir).unwrap();
        write_promotion_marker(
            &dirs_a.promotion_marker_path(),
            "startup",
            full_sha,
            payload_sha,
            staged.removed_modes_reset.clone(),
        )
        .unwrap();
        fs::copy(&staged_db, dirs_a.current_db_path()).unwrap();
        cleanup_staging(&dirs_a.staging_dir());
        fs::remove_dir_all(dirs_a.legacy_config_dir.as_ref().unwrap()).unwrap();
        assert!(!has_any_legacy_source(&dirs_a));

        let recovered_a = run_startup_migration(&dirs_a).await;
        assert_eq!(recovered_a.status, VoquillMigrationStatus::Completed);
        assert_eq!(
            recovered_a.database_phase,
            VoquillMigrationPhaseStatus::Migrated
        );
        assert!(!recovered_a.legacy_source_preserved);
        assert!(!dirs_a.promotion_marker_path().exists());
        ensure_no_pending_promotion_recovery(&dirs_a).unwrap();

        // Case B: Marker exists without current_db, manifest, or legacy source.
        let ws_b = unique_workspace("orphan-marker-no-legacy-missing-db");
        let dirs_b = make_dirs(&ws_b);
        fs::create_dir_all(&dirs_b.current_config_dir).unwrap();
        write_promotion_marker(
            &dirs_b.promotion_marker_path(),
            "startup",
            "0000000000000000000000000000000000000000000000000000000000000000".to_string(),
            "1111111111111111111111111111111111111111111111111111111111111111".to_string(),
            Vec::new(),
        )
        .unwrap();

        let recovered_b = run_startup_migration(&dirs_b).await;
        assert_eq!(recovered_b.status, VoquillMigrationStatus::Failed);
        assert!(!recovered_b.can_retry);
        assert!(recovered_b
            .issues
            .iter()
            .any(|issue| issue.code == "legacy_source_missing"));
        assert!(!dirs_b.promotion_marker_path().exists());
        ensure_no_pending_promotion_recovery(&dirs_b).unwrap();
    }

    #[test]
    fn copy_fallback_clears_stale_temp_and_never_creates_live_db_when_atomic_link_unavailable() {
        let ws = unique_workspace("copy-fallback-atomic-no-replace");
        let config_dir = ws.join("config");
        let staging_dir = ws.join("staging");
        fs::create_dir_all(&config_dir).unwrap();
        fs::create_dir_all(&staging_dir).unwrap();

        let staged_db = staging_dir.join(DB_FILENAME);
        let current_db = config_dir.join(DB_FILENAME);
        let tmp_dest = config_dir.join(format!("{DB_FILENAME}{PROMOTION_TEMP_SUFFIX}"));
        let simulated_xdev = io::Error::other("simulated cross-device link");
        fs::write(&staged_db, b"verified-staged-bytes").unwrap();

        // Stale leftover temp file from an interrupted run must be replaced cleanly.
        fs::write(&tmp_dest, b"stale-temp-bytes").unwrap();
        install_file_no_replace_via_copy_fallback(&staged_db, &current_db, &simulated_xdev)
            .unwrap();
        assert_eq!(fs::read(&current_db).unwrap(), b"verified-staged-bytes");
        assert!(!tmp_dest.exists());

        // On Unix, a symlink at the temp path must be unlinked without truncating its target.
        #[cfg(unix)]
        {
            fs::remove_file(&current_db).unwrap();
            let sentinel = ws.join("sentinel.txt");
            fs::write(&sentinel, b"must-not-be-truncated").unwrap();
            std::os::unix::fs::symlink(&sentinel, &tmp_dest).unwrap();
            install_file_no_replace_via_copy_fallback(&staged_db, &current_db, &simulated_xdev)
                .unwrap();
            assert_eq!(fs::read(&sentinel).unwrap(), b"must-not-be-truncated");
            assert_eq!(fs::read(&current_db).unwrap(), b"verified-staged-bytes");
            assert!(!tmp_dest.exists());
        }

        // If atomic no-replace publication is unsupported and current_db is absent,
        // fail BEFORE creating current_db rather than copying into the live path.
        fs::remove_file(&current_db).unwrap();
        let unsupported_err = install_file_no_replace_via_copy_fallback_with(
            &staged_db,
            &current_db,
            &simulated_xdev,
            |_, _| Err(io::Error::new(io::ErrorKind::Unsupported, "no hard links")),
        )
        .expect_err("unsupported atomic link must fail without creating live db");
        match unsupported_err {
            PromoteError::NotInstalled(issue) => assert_eq!(issue.code, "promote_io_error"),
            PromoteError::InstalledButNotSynced(_) => panic!("expected NotInstalled"),
        }
        assert!(!current_db.exists());
        assert!(!tmp_dest.exists());

        // If atomic no-replace publication is unsupported while current_db exists,
        // preserve existing_profile_conflict and keep current_db untouched.
        fs::write(&current_db, b"existing-profile-bytes").unwrap();
        let conflict_err = install_file_no_replace_via_copy_fallback_with(
            &staged_db,
            &current_db,
            &simulated_xdev,
            |_, _| Err(io::Error::new(io::ErrorKind::Unsupported, "no hard links")),
        )
        .expect_err("existing destination must still report conflict");
        match conflict_err {
            PromoteError::NotInstalled(issue) => {
                assert_eq!(issue.code, "existing_profile_conflict");
            }
            PromoteError::InstalledButNotSynced(_) => panic!("expected NotInstalled"),
        }
        assert_eq!(fs::read(&current_db).unwrap(), b"existing-profile-bytes");
        assert!(!tmp_dest.exists());
    }

    #[test]
    fn asset_progress_journal_ignores_unterminated_tail_and_repairs_before_append() {
        let ws = unique_workspace("progress-journal-tail-repair");
        let config_dir = ws.join("config");
        fs::create_dir_all(&config_dir).unwrap();
        let progress_path = config_dir.join(ASSET_PROGRESS_FILENAME);

        // Complete record followed by an interrupted `+a` fragment without `\n`.
        fs::write(&progress_path, b"+a\tprior.wav\n+a").unwrap();
        let replayed = load_asset_progress(&config_dir);
        assert!(replayed.audio.contains("prior.wav"));
        assert_eq!(replayed.audio.len(), 1);

        // Appending must discard the unterminated `+a` tail instead of producing
        // `+a+a\tclip.wav`, while keeping all earlier complete records intact.
        append_asset_progress_entry(&config_dir, '+', AssetCategory::Audio, "clip.wav").unwrap();
        let repaired = fs::read_to_string(&progress_path).unwrap();
        assert_eq!(repaired, "+a\tprior.wav\n+a\tclip.wav\n");
        let reloaded = load_asset_progress(&config_dir);
        assert!(reloaded.audio.contains("prior.wav"));
        assert!(reloaded.audio.contains("clip.wav"));

        // An unterminated lone record without any newline must not replay and
        // must be discarded before the next append.
        fs::write(&progress_path, b"+a\tpartial.wav").unwrap();
        assert!(load_asset_progress(&config_dir).audio.is_empty());
        append_asset_progress_entry(&config_dir, '+', AssetCategory::Audio, "fresh.wav").unwrap();
        assert_eq!(
            fs::read_to_string(&progress_path).unwrap(),
            "+a\tfresh.wav\n"
        );

        // Legacy JSON snapshot upgraded cleanly on append without losing prior items.
        fs::write(
            &progress_path,
            r#"{"models":["m.bin"],"audio":["old.wav"],"storage":[]}"#,
        )
        .unwrap();
        append_asset_progress_entry(&config_dir, '+', AssetCategory::Audio, "new.wav").unwrap();
        let upgraded = load_asset_progress(&config_dir);
        assert!(upgraded.models.contains("m.bin"));
        assert!(upgraded.audio.contains("old.wav"));
        assert!(upgraded.audio.contains("new.wav"));
    }

    #[tokio::test]
    async fn startup_guard_blocks_open_when_recovered_checkpoint_sync_fails_after_rename() {
        let ws = unique_workspace("recovery-sync-fail-after-rename");
        let dirs = make_dirs(&ws);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 96, false).await;
        let legacy_audio = dirs.legacy_data_dir.as_ref().unwrap().join(AUDIO_DIR_NAME);
        fs::create_dir_all(&legacy_audio).unwrap();
        fs::write(legacy_audio.join("after-sync.wav"), b"RIFFsync").unwrap();

        let staged = stage_validate_and_promote_database(&dirs).await.unwrap();
        let (full_sha, payload_sha) = hash_staged_database(&dirs.current_db_path()).unwrap();
        write_promotion_marker(
            &dirs.promotion_marker_path(),
            "startup",
            full_sha,
            payload_sha,
            staged.removed_modes_reset,
        )
        .unwrap();

        let pending_manifest = new_startup_report(
            now_iso(),
            VoquillMigrationStatus::Partial,
            VoquillMigrationPhaseStatus::Pending,
            VoquillMigrationPhaseStatus::Pending,
            true,
        );

        // Simulate `save_manifest` succeeding at `fs::rename` (so on-disk JSON
        // now reads `Migrated`) and then failing in `sync_dir`.
        let failed =
            recover_pending_database_migration_with_manifest_sync(&dirs, pending_manifest, |_| {
                Err(io::Error::other("simulated manifest dir sync failure"))
            })
            .await;

        assert_eq!(failed.database_phase, VoquillMigrationPhaseStatus::Pending);
        assert!(failed
            .issues
            .iter()
            .any(|issue| issue.code == "manifest_save_failed"));
        assert_eq!(
            load_manifest(&dirs.current_config_dir)
                .expect("rename published un-synced manifest")
                .database_phase,
            VoquillMigrationPhaseStatus::Migrated
        );
        assert!(dirs.promotion_marker_path().exists());
        assert!(
            ensure_no_pending_promotion_recovery(&dirs).is_err(),
            "startup guard must refuse normal DB open while un-synced checkpoint marker remains"
        );

        // Next launch syncs directories, retires the marker, imports assets,
        // and unblocks normal DB opening.
        let settled = run_startup_migration(&dirs).await;
        assert_eq!(settled.status, VoquillMigrationStatus::Completed);
        assert_eq!(
            settled.database_phase,
            VoquillMigrationPhaseStatus::Migrated
        );
        assert_eq!(settled.audio_phase, VoquillMigrationPhaseStatus::Migrated);
        assert!(!dirs.promotion_marker_path().exists());
        assert!(ensure_no_pending_promotion_recovery(&dirs).is_ok());
        assert!(dirs
            .current_data_dir
            .join(AUDIO_DIR_NAME)
            .join("after-sync.wav")
            .exists());
    }

    #[tokio::test]
    async fn asset_only_import_checkpoints_before_copy_resumes_and_blocks_db_on_initial_failure() {
        // Case A: Initial checkpoint fails -> aborts before copying assets and
        // blocks startup from creating a fresh DB that would mask the import.
        let ws_a = unique_workspace("asset-only-initial-checkpoint-fail");
        let dirs_a = make_dirs(&ws_a);
        let legacy_audio_a = dirs_a
            .legacy_data_dir
            .as_ref()
            .unwrap()
            .join(AUDIO_DIR_NAME);
        fs::create_dir_all(&legacy_audio_a).unwrap();
        fs::write(legacy_audio_a.join("clip-a.wav"), b"RIFFa").unwrap();
        let blocking_tmp_a = dirs_a
            .current_config_dir
            .join(format!("{MANIFEST_FILENAME}.tmp"));
        fs::create_dir_all(&blocking_tmp_a).unwrap();

        let report_a = run_startup_migration(&dirs_a).await;
        assert!(report_a.legacy_detected);
        assert_eq!(report_a.status, VoquillMigrationStatus::Partial);
        assert!(report_a
            .issues
            .iter()
            .any(|issue| issue.code == "manifest_save_failed"));
        assert!(!dirs_a
            .current_data_dir
            .join(AUDIO_DIR_NAME)
            .join("clip-a.wav")
            .exists());
        assert!(
            ensure_no_uncheckpointed_initial_migration(&dirs_a, &report_a).is_err(),
            "startup must refuse to create mausvoice.db when initial asset-only checkpoint failed"
        );

        // Case B: Initial checkpoint succeeds, an asset copy fails, and final
        // manifest save also fails -> durable checkpoint remains on disk, fresh
        // DB creation is allowed, and next launch resumes assets without
        // replacing the DB or reporting SkippedExistingProfile.
        let ws_b = unique_workspace("asset-only-checkpoint-resume");
        let dirs_b = make_dirs(&ws_b);
        let legacy_audio_b = dirs_b
            .legacy_data_dir
            .as_ref()
            .unwrap()
            .join(AUDIO_DIR_NAME);
        fs::create_dir_all(&legacy_audio_b).unwrap();
        fs::write(legacy_audio_b.join("clip-b.wav"), b"RIFFb").unwrap();

        // Block asset copy by placing a regular file where the destination audio dir belongs.
        fs::create_dir_all(&dirs_b.current_data_dir).unwrap();
        let blocked_audio_dst = dirs_b.current_data_dir.join(AUDIO_DIR_NAME);
        fs::write(&blocked_audio_dst, b"blocking-file").unwrap();

        let initial_b = new_startup_report(
            now_iso(),
            VoquillMigrationStatus::Partial,
            VoquillMigrationPhaseStatus::NotFound,
            VoquillMigrationPhaseStatus::Pending,
            true,
        );
        let save_calls = std::sync::atomic::AtomicUsize::new(0);
        let failed_b = finish_startup_database_and_assets_with_hooks(
            &dirs_b,
            initial_b,
            false,
            sync_dir_best_effort,
            |dir| {
                if save_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    sync_dir_best_effort(dir)
                } else {
                    Err(io::Error::other("simulated final manifest sync failure"))
                }
            },
        )
        .await;
        assert_eq!(failed_b.status, VoquillMigrationStatus::Partial);
        assert_eq!(failed_b.audio_phase, VoquillMigrationPhaseStatus::Failed);
        assert!(ensure_no_uncheckpointed_initial_migration(&dirs_b, &failed_b).is_ok());

        // Create mausvoice.db as setup does and verify status is NOT NotNeeded.
        let pool_b = open_app_database(&dirs_b.current_db_path()).await.unwrap();
        let status_b = refresh_migration_report(dirs_b.clone(), pool_b.clone()).await;
        assert_eq!(status_b.status, VoquillMigrationStatus::Partial);
        assert!(status_b.can_retry);
        pool_b.close().await;
        let db_bytes_before = fs::read(dirs_b.current_db_path()).unwrap();

        // Unblock destination audio dir; simulate persisted pending checkpoint
        // (as when final manifest write failed before rename) and verify next
        // startup resumes without replacing mausvoice.db.
        fs::remove_file(&blocked_audio_dst).unwrap();
        let pending_checkpoint = new_startup_report(
            now_iso(),
            VoquillMigrationStatus::Partial,
            VoquillMigrationPhaseStatus::NotFound,
            VoquillMigrationPhaseStatus::Pending,
            true,
        );
        save_manifest(&dirs_b.current_config_dir, &pending_checkpoint).unwrap();

        let resumed_b = run_startup_migration(&dirs_b).await;
        assert_eq!(resumed_b.status, VoquillMigrationStatus::Completed);
        assert_eq!(
            resumed_b.database_phase,
            VoquillMigrationPhaseStatus::NotFound
        );
        assert_eq!(resumed_b.audio_phase, VoquillMigrationPhaseStatus::Migrated);
        assert_eq!(fs::read(dirs_b.current_db_path()).unwrap(), db_bytes_before);
        assert_eq!(
            fs::read(blocked_audio_dst.join("clip-b.wav")).unwrap(),
            b"RIFFb"
        );

        // Case C: Existing profile with NO migration checkpoint is still skipped.
        let ws_c = unique_workspace("asset-only-existing-profile-guard");
        let dirs_c = make_dirs(&ws_c);
        let legacy_audio_c = dirs_c
            .legacy_data_dir
            .as_ref()
            .unwrap()
            .join(AUDIO_DIR_NAME);
        fs::create_dir_all(&legacy_audio_c).unwrap();
        fs::write(legacy_audio_c.join("clip-c.wav"), b"RIFFc").unwrap();
        fs::create_dir_all(&dirs_c.current_config_dir).unwrap();
        let pool_c = open_app_database(&dirs_c.current_db_path()).await.unwrap();
        pool_c.close().await;

        let report_c = run_startup_migration(&dirs_c).await;
        assert_eq!(
            report_c.status,
            VoquillMigrationStatus::SkippedExistingProfile
        );
        assert!(ensure_no_uncheckpointed_initial_migration(&dirs_c, &report_c).is_ok());
        assert!(!dirs_c
            .current_data_dir
            .join(AUDIO_DIR_NAME)
            .join("clip-c.wav")
            .exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn inaccessible_legacy_db_is_not_treated_as_absent_for_asset_only_import() {
        use std::os::unix::fs::PermissionsExt;

        struct RestoreDirMode(PathBuf);
        impl Drop for RestoreDirMode {
            fn drop(&mut self) {
                let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
            }
        }

        let ws = unique_workspace("inaccessible-legacy-db");
        let dirs = make_dirs(&ws);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 96, false).await;
        let legacy_audio = dirs.legacy_data_dir.as_ref().unwrap().join(AUDIO_DIR_NAME);
        fs::create_dir_all(&legacy_audio).unwrap();
        fs::write(legacy_audio.join("recording.wav"), b"RIFFrec").unwrap();

        let legacy_config_dir = dirs.legacy_config_dir.clone().unwrap();
        let _restore = RestoreDirMode(legacy_config_dir.clone());
        fs::set_permissions(&legacy_config_dir, fs::Permissions::from_mode(0o000)).unwrap();

        // Skip if running with privileges that bypass chmod 000 (e.g. root).
        let is_denied = matches!(
            fs::symlink_metadata(&legacy_db),
            Err(err) if err.kind() == io::ErrorKind::PermissionDenied
        );
        if !is_denied {
            return;
        }

        let failed = run_startup_migration(&dirs).await;
        assert_eq!(failed.status, VoquillMigrationStatus::Failed);
        assert_eq!(failed.database_phase, VoquillMigrationPhaseStatus::Failed);
        assert!(failed.can_retry);
        assert!(failed
            .issues
            .iter()
            .any(|issue| issue.code == "legacy_path_unavailable"));
        assert!(!dirs
            .current_data_dir
            .join(AUDIO_DIR_NAME)
            .join("recording.wav")
            .exists());

        // Live status refresh must keep retry available while DB remains inaccessible.
        let empty_pool = open_app_database(&dirs.current_db_path()).await.unwrap();
        let refreshed = refresh_migration_report(dirs.clone(), empty_pool.clone()).await;
        assert!(refreshed.can_retry);

        // Restoring access allows retry to import both the Voquill DB and recordings.
        fs::set_permissions(&legacy_config_dir, fs::Permissions::from_mode(0o755)).unwrap();
        let db_state = OptionKeyDatabase::new(empty_pool);
        let retried = retry_migration(dirs.clone(), db_state).await.unwrap();
        assert_eq!(retried.status, VoquillMigrationStatus::Completed);
        assert_eq!(
            retried.database_phase,
            VoquillMigrationPhaseStatus::Migrated
        );
        assert_eq!(retried.audio_phase, VoquillMigrationPhaseStatus::Migrated);
        assert_eq!(retried.counts.transcriptions, 1);
        assert!(dirs
            .current_data_dir
            .join(AUDIO_DIR_NAME)
            .join("recording.wav")
            .exists());
    }

    #[test]
    fn journal_dir_sync_runs_before_publish_even_for_replayed_journal_entries() {
        let ws = unique_workspace("journal-dir-sync-replayed");
        let dirs = make_dirs(&ws);
        let src_dir = dirs.legacy_data_dir.as_ref().unwrap().join(AUDIO_DIR_NAME);
        let dst_dir = dirs.current_data_dir.join(AUDIO_DIR_NAME);
        fs::create_dir_all(&src_dir).unwrap();
        fs::write(src_dir.join("clip.wav"), b"RIFFclip").unwrap();

        // Attempt 1: journal creation writes the record, then config_dir sync fails.
        let mut progress1 = load_asset_progress(&dirs.current_config_dir);
        let fail_sync = |_: &Path| Err(io::Error::other("simulated config_dir sync failure"));
        let outcome1 = run_asset_category_with_journal_sync(
            &dirs,
            std::slice::from_ref(&src_dir),
            &dst_dir,
            false,
            AssetCategory::Audio,
            &mut progress1,
            &fail_sync,
        );
        assert!(outcome1.failed > 0);
        assert!(!dst_dir.join("clip.wav").exists());

        // Attempt 2: replayed intent marks clip.wav as pending, yet config_dir sync
        // still fails, so publication must remain blocked.
        let mut progress2 = load_asset_progress(&dirs.current_config_dir);
        assert!(!progress2.audio.contains("clip.wav"));
        assert!(progress2.audio_pending.contains_key("clip.wav"));
        let outcome2 = run_asset_category_with_journal_sync(
            &dirs,
            std::slice::from_ref(&src_dir),
            &dst_dir,
            false,
            AssetCategory::Audio,
            &mut progress2,
            &fail_sync,
        );
        assert!(outcome2.failed > 0);
        assert!(!dst_dir.join("clip.wav").exists());

        // Attempt 3: once config_dir sync succeeds, publication proceeds cleanly.
        let mut progress3 = load_asset_progress(&dirs.current_config_dir);
        let outcome3 = run_asset_category_with_journal_sync(
            &dirs,
            std::slice::from_ref(&src_dir),
            &dst_dir,
            false,
            AssetCategory::Audio,
            &mut progress3,
            &sync_dir_best_effort,
        );
        assert_eq!(outcome3.failed, 0);
        assert_eq!(outcome3.copied, 1);
        assert_eq!(fs::read(dst_dir.join("clip.wav")).unwrap(), b"RIFFclip");
    }

    #[test]
    fn append_asset_progress_entry_truncates_multi_chunk_unterminated_tail() {
        let ws = unique_workspace("journal-multi-chunk-tail");
        let config_dir = ws.join("config");
        fs::create_dir_all(&config_dir).unwrap();
        let journal_path = config_dir.join(ASSET_PROGRESS_FILENAME);

        let mut initial = String::new();
        for idx in 0..300 {
            let line = format!("+a\tclip-{idx:04}.wav\n");
            initial.push_str(&line);
        }
        let valid_prefix_len = initial.len();
        initial.push_str("+a\t");
        initial.push_str(&"x".repeat(6000));
        fs::write(&journal_path, &initial).unwrap();

        append_asset_progress_entry(&config_dir, '+', AssetCategory::Audio, "after-tail.wav")
            .unwrap();

        let final_raw = fs::read_to_string(&journal_path).unwrap();
        assert!(final_raw.len() < valid_prefix_len + 64);
        assert!(final_raw.ends_with("+a\tafter-tail.wav\n"));

        let loaded = load_asset_progress(&config_dir);
        assert_eq!(loaded.audio.len(), 301);
        assert!(loaded.audio.contains("clip-0000.wav"));
        assert!(loaded.audio.contains("clip-0299.wav"));
        assert!(loaded.audio.contains("after-tail.wav"));
    }

    #[tokio::test]
    async fn recovered_db_verification_preserves_digest_after_pre_rename_failure() {
        let ws = unique_workspace("recovery-readonly-preserves-digest");
        let dirs = make_dirs(&ws);
        let legacy_db = dirs.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db, 108, false).await;
        let legacy_audio = dirs.legacy_data_dir.as_ref().unwrap().join(AUDIO_DIR_NAME);
        fs::create_dir_all(&legacy_audio).unwrap();
        fs::write(legacy_audio.join("kept.wav"), b"RIFFkept").unwrap();

        let (staged_db, staged) = stage_validate_in_staging_only(&dirs).await.unwrap();
        let full_sha = sha256_file_hex(&staged_db).unwrap();
        let payload_sha = sha256_db_payload_hex(&staged_db).unwrap();
        fs::create_dir_all(&dirs.current_config_dir).unwrap();
        fs::rename(&staged_db, dirs.current_db_path()).unwrap();
        write_promotion_marker(
            &dirs.promotion_marker_path(),
            "startup",
            full_sha.clone(),
            payload_sha,
            staged.removed_modes_reset,
        )
        .unwrap();

        let pending_manifest = new_startup_report(
            now_iso(),
            VoquillMigrationStatus::Partial,
            VoquillMigrationPhaseStatus::Pending,
            VoquillMigrationPhaseStatus::Pending,
            true,
        );
        save_manifest(&dirs.current_config_dir, &pending_manifest).unwrap();

        // Force `save_manifest_with_sync` to fail BEFORE `fs::rename` so the
        // on-disk manifest stays `Pending` while `verify_and_audit_recovered_db`
        // runs against `mausvoice.db`.
        let blocking_tmp = dirs
            .current_config_dir
            .join(format!("{MANIFEST_FILENAME}.tmp"));
        fs::create_dir_all(&blocking_tmp).unwrap();

        let failed = recover_pending_database_migration(&dirs, pending_manifest).await;
        assert_eq!(failed.database_phase, VoquillMigrationPhaseStatus::Pending);
        assert!(failed
            .issues
            .iter()
            .any(|issue| issue.code == "manifest_save_failed"));
        assert!(dirs.promotion_marker_path().exists());
        assert_eq!(
            sha256_file_hex(&dirs.current_db_path()).unwrap(),
            full_sha,
            "read-only recovery verification must not mutate mausvoice.db"
        );
        assert!(!dirs
            .current_config_dir
            .join(format!("{DB_FILENAME}-wal"))
            .exists());

        // Removing the manifest-tmp blocker lets the next launch verify the
        // unchanged file digest, checkpoint `Migrated`, and import assets.
        fs::remove_dir_all(&blocking_tmp).unwrap();
        let rec = run_startup_migration(&dirs).await;
        assert_eq!(rec.status, VoquillMigrationStatus::Completed);
        assert_eq!(rec.database_phase, VoquillMigrationPhaseStatus::Migrated);
        assert_eq!(rec.audio_phase, VoquillMigrationPhaseStatus::Migrated);
        assert!(!dirs.promotion_marker_path().exists());
        assert!(dirs
            .current_data_dir
            .join(AUDIO_DIR_NAME)
            .join("kept.wav")
            .exists());
    }

    #[tokio::test]
    async fn recover_missing_current_db_blocks_fresh_db_when_failure_manifest_save_fails() {
        // Case A: legacy_source_missing with unpersisted failure report keeps
        // `can_retry = false` and blocks fresh DB creation while on-disk
        // manifest remains `Pending`.
        let ws_a = unique_workspace("recover-missing-db-save-fail-missing");
        let dirs_a = make_dirs(&ws_a);
        fs::create_dir_all(&dirs_a.current_config_dir).unwrap();
        let pending_a = new_startup_report(
            now_iso(),
            VoquillMigrationStatus::Partial,
            VoquillMigrationPhaseStatus::Pending,
            VoquillMigrationPhaseStatus::Pending,
            true,
        );
        save_manifest(&dirs_a.current_config_dir, &pending_a).unwrap();
        let blocking_tmp_a = dirs_a
            .current_config_dir
            .join(format!("{MANIFEST_FILENAME}.tmp"));
        fs::create_dir_all(&blocking_tmp_a).unwrap();

        let rep_a = recover_pending_database_migration(&dirs_a, pending_a).await;
        assert_eq!(rep_a.status, VoquillMigrationStatus::Failed);
        assert_eq!(rep_a.database_phase, VoquillMigrationPhaseStatus::Failed);
        assert!(!rep_a.can_retry);
        assert!(rep_a
            .issues
            .iter()
            .any(|issue| issue.code == "legacy_source_missing"));
        assert!(rep_a
            .issues
            .iter()
            .any(|issue| issue.code == "manifest_save_failed"));
        assert!(ensure_no_uncheckpointed_initial_migration(&dirs_a, &rep_a).is_err());

        // Case B (Unix): legacy_path_unavailable with unpersisted failure
        // report keeps `can_retry = true` and also blocks fresh DB creation.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            struct RestoreDirMode(PathBuf);
            impl Drop for RestoreDirMode {
                fn drop(&mut self) {
                    let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
                }
            }

            let ws_b = unique_workspace("recover-missing-db-save-fail-unavail");
            let dirs_b = make_dirs(&ws_b);
            let legacy_db_b = dirs_b.legacy_db_path().unwrap();
            seed_voquill_db(&legacy_db_b, 109, false).await;
            fs::create_dir_all(&dirs_b.current_config_dir).unwrap();
            let pending_b = new_startup_report(
                now_iso(),
                VoquillMigrationStatus::Partial,
                VoquillMigrationPhaseStatus::Pending,
                VoquillMigrationPhaseStatus::Pending,
                true,
            );
            save_manifest(&dirs_b.current_config_dir, &pending_b).unwrap();
            let blocking_tmp_b = dirs_b
                .current_config_dir
                .join(format!("{MANIFEST_FILENAME}.tmp"));
            fs::create_dir_all(&blocking_tmp_b).unwrap();

            let legacy_config_dir = dirs_b.legacy_config_dir.clone().unwrap();
            let _restore = RestoreDirMode(legacy_config_dir.clone());
            fs::set_permissions(&legacy_config_dir, fs::Permissions::from_mode(0o000)).unwrap();

            let is_denied = matches!(
                fs::symlink_metadata(&legacy_db_b),
                Err(err) if err.kind() == io::ErrorKind::PermissionDenied
            );
            if is_denied {
                let rep_b = recover_pending_database_migration(&dirs_b, pending_b).await;
                let phase_b = rep_b.database_phase;
                assert_eq!(rep_b.status, VoquillMigrationStatus::Failed);
                assert_eq!(phase_b, VoquillMigrationPhaseStatus::Failed);
                assert!(rep_b.can_retry);
                assert!(rep_b
                    .issues
                    .iter()
                    .any(|issue| issue.code == "legacy_path_unavailable"));
                assert!(rep_b
                    .issues
                    .iter()
                    .any(|issue| issue.code == "manifest_save_failed"));
                assert!(ensure_no_uncheckpointed_initial_migration(&dirs_b, &rep_b).is_err());
            }
        }
    }

    #[tokio::test]
    async fn startup_preserves_unreadable_partial_manifest_instead_of_overwriting_with_skipped() {
        // Case A: malformed manifest must be preserved on disk rather than
        // overwritten with `SkippedExistingProfile`.
        let ws_a = unique_workspace("preserve-malformed-manifest");
        let dirs_a = make_dirs(&ws_a);
        let legacy_db_a = dirs_a.legacy_db_path().unwrap();
        seed_voquill_db(&legacy_db_a, 110, false).await;
        fs::create_dir_all(&dirs_a.current_config_dir).unwrap();
        fs::write(dirs_a.current_db_path(), b"existing-migrated-db").unwrap();
        let manifest_path_a = dirs_a.current_config_dir.join(MANIFEST_FILENAME);
        fs::write(&manifest_path_a, b"{not valid json").unwrap();

        let report_a = run_startup_migration(&dirs_a).await;
        assert_eq!(report_a.status, VoquillMigrationStatus::Partial);
        assert!(report_a.can_retry);
        assert!(report_a
            .issues
            .iter()
            .any(|issue| issue.code == "manifest_read_failed"));
        assert_eq!(
            fs::read(&manifest_path_a).unwrap(),
            b"{not valid json",
            "startup must not overwrite a malformed manifest with SkippedExistingProfile"
        );

        // Case B (Unix): unreadable partial manifest while config_dir remains
        // writable must stay intact so restoring permissions restores Retry.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            struct RestoreFileMode(PathBuf);
            impl Drop for RestoreFileMode {
                fn drop(&mut self) {
                    let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o644));
                }
            }

            let ws_b = unique_workspace("preserve-unreadable-partial-manifest");
            let dirs_b = make_dirs(&ws_b);
            let legacy_db_b = dirs_b.legacy_db_path().unwrap();
            seed_voquill_db(&legacy_db_b, 111, false).await;
            let legacy_audio = dirs_b
                .legacy_data_dir
                .as_ref()
                .unwrap()
                .join(AUDIO_DIR_NAME);
            fs::create_dir_all(&legacy_audio).unwrap();
            fs::write(legacy_audio.join("later.wav"), b"RIFFlater").unwrap();

            let mut partial = new_startup_report(
                now_iso(),
                VoquillMigrationStatus::Partial,
                VoquillMigrationPhaseStatus::Migrated,
                VoquillMigrationPhaseStatus::Partial,
                true,
            );
            partial.models_phase = VoquillMigrationPhaseStatus::NotFound;
            partial.storage_phase = VoquillMigrationPhaseStatus::NotFound;
            save_manifest(&dirs_b.current_config_dir, &partial).unwrap();
            let pool = open_app_database(&dirs_b.current_db_path()).await.unwrap();
            pool.close().await;

            let manifest_path_b = dirs_b.current_config_dir.join(MANIFEST_FILENAME);
            let original_bytes = fs::read(&manifest_path_b).unwrap();
            let _restore = RestoreFileMode(manifest_path_b.clone());
            fs::set_permissions(&manifest_path_b, fs::Permissions::from_mode(0o000)).unwrap();

            let unreadable = matches!(
                fs::read(&manifest_path_b),
                Err(err) if err.kind() == io::ErrorKind::PermissionDenied
            );
            if unreadable {
                let startup_rep = run_startup_migration(&dirs_b).await;
                assert_eq!(startup_rep.status, VoquillMigrationStatus::Partial);
                assert!(startup_rep.can_retry);
                assert!(startup_rep
                    .issues
                    .iter()
                    .any(|issue| issue.code == "manifest_read_failed"));

                fs::set_permissions(&manifest_path_b, fs::Permissions::from_mode(0o644)).unwrap();
                assert_eq!(
                    fs::read(&manifest_path_b).unwrap(),
                    original_bytes,
                    "original partial manifest bytes must be preserved untouched"
                );
                let restored = run_startup_migration(&dirs_b).await;
                assert_eq!(restored.status, VoquillMigrationStatus::Partial);
                assert!(restored.can_retry);
                assert!(!restored
                    .issues
                    .iter()
                    .any(|issue| issue.code == "manifest_read_failed"));

                let live_pool = open_app_database(&dirs_b.current_db_path()).await.unwrap();
                let db_state = OptionKeyDatabase::new(live_pool);
                let retried = retry_migration(dirs_b.clone(), db_state).await.unwrap();
                assert_eq!(retried.status, VoquillMigrationStatus::Completed);
                assert_eq!(retried.audio_phase, VoquillMigrationPhaseStatus::Migrated);
                assert_eq!(retried.counts.audio_files_migrated, 1);
                assert_eq!(
                    fs::read(
                        dirs_b
                            .current_data_dir
                            .join(AUDIO_DIR_NAME)
                            .join("later.wav")
                    )
                    .unwrap(),
                    b"RIFFlater"
                );
            }
        }
    }

    #[test]
    fn replayed_asset_intent_does_not_count_unrelated_destination_file_as_migrated() {
        let ws = unique_workspace("replayed-intent-unrelated-dst");
        let dirs = make_dirs(&ws);
        let src_dir = dirs.legacy_data_dir.as_ref().unwrap().join(AUDIO_DIR_NAME);
        let dst_dir = dirs.current_data_dir.join(AUDIO_DIR_NAME);
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dst_dir).unwrap();
        fs::write(src_dir.join("clip.wav"), b"VOQUILL-AUDIO-BYTES").unwrap();
        fs::write(src_dir.join("published.wav"), b"VOQUILL-PUBLISHED-BYTES").unwrap();

        let clip_sha = sha256_file_hex(&src_dir.join("clip.wav")).unwrap();
        let published_sha = sha256_file_hex(&src_dir.join("published.wav")).unwrap();

        // Simulate crash right after syncing intents:
        // - `clip.wav` was NOT published by migration; another process created an
        //   unrelated `clip.wav` before retry.
        // - `published.wav` WAS published by migration before crash, prior to `+`.
        append_asset_progress_record_with_sync(
            &dirs.current_config_dir,
            '?',
            AssetCategory::Audio,
            "clip.wav",
            Some(&clip_sha),
            &sync_dir_best_effort,
        )
        .unwrap();
        append_asset_progress_record_with_sync(
            &dirs.current_config_dir,
            '?',
            AssetCategory::Audio,
            "published.wav",
            Some(&published_sha),
            &sync_dir_best_effort,
        )
        .unwrap();
        fs::write(dst_dir.join("clip.wav"), b"UNRELATED-NATIVE-AUDIO").unwrap();
        fs::write(dst_dir.join("published.wav"), b"VOQUILL-PUBLISHED-BYTES").unwrap();

        let mut progress = load_asset_progress(&dirs.current_config_dir);
        let outcome = run_asset_category(
            &dirs,
            std::slice::from_ref(&src_dir),
            &dst_dir,
            false,
            AssetCategory::Audio,
            &mut progress,
        );

        assert_eq!(outcome.failed, 0);
        assert_eq!(outcome.copied, 0);
        assert_eq!(
            outcome.previously_migrated, 1,
            "only the digest-verified published file may count as migrated"
        );
        assert_eq!(outcome.skipped_existing, 1);
        assert_eq!(
            fs::read(dst_dir.join("clip.wav")).unwrap(),
            b"UNRELATED-NATIVE-AUDIO",
            "unrelated destination file must remain untouched"
        );
        let reloaded = load_asset_progress(&dirs.current_config_dir);
        assert!(!reloaded.audio.contains("clip.wav"));
        assert!(!reloaded.audio_pending.contains_key("clip.wav"));
        assert!(reloaded.audio.contains("published.wav"));
        assert!(!reloaded.audio_pending.contains_key("published.wav"));
    }

    #[test]
    fn retry_preserves_confirmed_audio_count_when_legacy_audio_dir_is_removed() {
        let ws = unique_workspace("confirmed-audio-after-legacy-removed");
        let dirs = make_dirs(&ws);
        let src_dir = dirs.legacy_data_dir.as_ref().unwrap().join(AUDIO_DIR_NAME);
        let dst_dir = dirs.current_data_dir.join(AUDIO_DIR_NAME);
        fs::create_dir_all(&src_dir).unwrap();
        fs::write(src_dir.join("clip.wav"), b"VOQUILL-IMPORTED-CLIP").unwrap();

        // Pass 1: copy `clip.wav` and confirm it in the progress journal.
        let mut progress1 = load_asset_progress(&dirs.current_config_dir);
        let outcome1 = run_asset_category(
            &dirs,
            std::slice::from_ref(&src_dir),
            &dst_dir,
            false,
            AssetCategory::Audio,
            &mut progress1,
        );
        assert_eq!(outcome1.migrated_total(), 1);

        // Unrelated native recording created in destination must NOT be counted.
        fs::write(dst_dir.join("native-recording.wav"), b"NATIVE-RECORDING").unwrap();

        // User moves/removes the legacy audio directory before Retry.
        fs::remove_dir_all(&src_dir).unwrap();

        let mut report = new_startup_report(
            now_iso(),
            VoquillMigrationStatus::Partial,
            VoquillMigrationPhaseStatus::Migrated,
            VoquillMigrationPhaseStatus::NotFound,
            true,
        );
        report.audio_phase = VoquillMigrationPhaseStatus::Partial;
        report.counts.audio_files_migrated = 1;

        migrate_asset_phases(&dirs, &mut report);

        assert_eq!(report.audio_phase, VoquillMigrationPhaseStatus::Migrated);
        assert_eq!(
            report.counts.audio_files_migrated, 1,
            "confirmed imported recording must remain counted after legacy source removal"
        );
    }
}
