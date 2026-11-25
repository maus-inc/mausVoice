use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Row, SqlitePool,
};
use tauri::Manager;

use crate::{
    db::{
        api_key_queries,
        open::{open_app_database, open_app_database_strict, StrictOpenError},
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
const STAGING_DIR_NAME: &str = ".voquill-migration-staging";
const STAGED_DB_FILENAME: &str = "staged.db";
const SQLITE_HEADER_MAGIC: &[u8; 16] = b"SQLite format 3\0";
const SQLITE_MIN_HEADER_BYTES: usize = 100;

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
}

/// Maps a provider slug to a safe, secret-free display name for migration
/// notices. Unknown slugs are normalized to a safe ASCII identifier without
/// ever including user-entered secrets or URLs.
pub fn safe_provider_display_name(provider: &str) -> String {
    match provider.trim().to_ascii_lowercase().as_str() {
        "groq" => "Groq".to_string(),
        "deepgram" => "Deepgram".to_string(),
        "openai" => "OpenAI".to_string(),
        "anthropic" => "Anthropic".to_string(),
        "google" | "gemini" => "Google Gemini".to_string(),
        "openrouter" => "OpenRouter".to_string(),
        "azure" => "Azure Speech".to_string(),
        "elevenlabs" => "ElevenLabs".to_string(),
        "assemblyai" => "AssemblyAI".to_string(),
        "aldea" => "Aldea".to_string(),
        "ollama" => "Ollama".to_string(),
        "speaches" => "Speaches".to_string(),
        "openai-compatible" => "OpenAI-compatible".to_string(),
        other => {
            let safe: String = other
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
                .take(32)
                .collect();
            if safe.is_empty() {
                "Custom provider".to_string()
            } else {
                safe
            }
        }
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

fn save_manifest(config_dir: &Path, report: &VoquillMigrationReport) -> io::Result<()> {
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
    Ok(())
}

fn load_manifest(config_dir: &Path) -> Option<VoquillMigrationReport> {
    let path = config_dir.join(MANIFEST_FILENAME);
    let raw = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return None,
        Err(err) => {
            log::warn!(
                "Unable to read Voquill migration manifest {}: {err}",
                path.display()
            );
            return None;
        }
    };

    match serde_json::from_slice::<VoquillMigrationReport>(&raw) {
        Ok(report) => Some(report),
        Err(err) => {
            log::warn!(
                "Voquill migration manifest {} is malformed and will be ignored: {err}",
                path.display()
            );
            None
        }
    }
}

/// Remove migration manifest and any leftover staging directory during an
/// explicit local-data clear.
pub fn clear_migration_artifacts(config_dir: &Path) -> io::Result<()> {
    for filename in [MANIFEST_FILENAME, "voquill-migration-state.json.tmp"] {
        let path = config_dir.join(filename);
        match fs::remove_file(&path) {
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

fn is_real_directory(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(meta) => !meta.file_type().is_symlink() && meta.is_dir(),
        Err(_) => false,
    }
}

fn has_any_legacy_source(dirs: &MigrationDirs) -> bool {
    if let Some(legacy_db) = dirs.legacy_db_path() {
        if fs::symlink_metadata(&legacy_db).is_ok() {
            return true;
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

fn dir_has_any_entry(dir: &Path) -> bool {
    if !is_real_directory(dir) {
        return false;
    }
    fs::read_dir(dir)
        .ok()
        .and_then(|mut iter| iter.next())
        .is_some()
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
    fs::copy(src, dst).map_err(|err| format!("failed to copy file: {err}"))?;
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

    if prefs_exists > 0 {
        let columns: BTreeSet<String> =
            sqlx::query("SELECT name FROM pragma_table_info('user_preferences')")
                .fetch_all(&pool)
                .await
                .unwrap_or_default()
                .into_iter()
                .filter_map(|row| row.try_get::<String, _>("name").ok())
                .collect();

        for (column, label) in [
            ("transcription_mode", "transcription:cloud"),
            ("post_processing_mode", "post_processing:cloud"),
            ("agent_mode", "agent:cloud"),
        ] {
            if columns.contains(column) {
                let query = format!(
                    "SELECT DISTINCT lower(trim({column})) FROM user_preferences \
                     WHERE {column} IS NOT NULL"
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
    } else {
        // Older Voquill schemas (versions 10-15) stored AI modes directly on
        // user_profiles before 015_user_preferences migrated them.
        let columns: BTreeSet<String> =
            sqlx::query("SELECT name FROM pragma_table_info('user_profiles')")
                .fetch_all(&pool)
                .await
                .unwrap_or_default()
                .into_iter()
                .filter_map(|row| row.try_get::<String, _>("name").ok())
                .collect();

        for (column, label) in [
            ("preferred_transcription_mode", "transcription:cloud"),
            ("preferred_post_processing_mode", "post_processing:cloud"),
        ] {
            if columns.contains(column) {
                let query = format!(
                    "SELECT DISTINCT lower(trim({column})) FROM user_profiles \
                     WHERE {column} IS NOT NULL"
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

async fn stage_validate_and_promote_database(
    dirs: &MigrationDirs,
) -> Result<StagedDbSuccess, VoquillMigrationIssue> {
    let staging_dir = dirs.staging_dir();
    let (staged_db, staged) = stage_validate_in_staging_only(dirs).await?;

    let current_db = dirs.current_db_path();
    if current_db.exists() {
        cleanup_staging(&staging_dir);
        return Err(VoquillMigrationIssue {
            category: "database".to_string(),
            code: "existing_profile_conflict".to_string(),
            detail: "An existing mausVoice database already exists and was kept untouched."
                .to_string(),
        });
    }

    if let Some(parent) = current_db.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            cleanup_staging(&staging_dir);
            return Err(VoquillMigrationIssue {
                category: "database".to_string(),
                code: "promote_io_error".to_string(),
                detail: format!("Could not prepare mausVoice config directory: {err}"),
            });
        }
    }

    if let Err(issue) = promote_staged_file(&staged_db, &current_db, false) {
        cleanup_staging(&staging_dir);
        return Err(issue);
    }

    cleanup_staging(&staging_dir);
    Ok(staged)
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
    skipped_existing: u32,
    failed: u32,
    source_present: bool,
    first_error: Option<String>,
}

impl AssetCopyOutcome {
    fn phase_status(&self) -> VoquillMigrationPhaseStatus {
        if !self.source_present {
            return VoquillMigrationPhaseStatus::NotFound;
        }
        if self.failed == 0 {
            if self.copied > 0 || self.skipped_existing > 0 {
                VoquillMigrationPhaseStatus::Migrated
            } else {
                VoquillMigrationPhaseStatus::NotFound
            }
        } else if self.copied > 0 || self.skipped_existing > 0 {
            VoquillMigrationPhaseStatus::Partial
        } else {
            VoquillMigrationPhaseStatus::Failed
        }
    }
}

fn copy_file_non_destructive(src: &Path, dst: &Path, prefer_hardlink: bool) -> io::Result<bool> {
    if dst.exists() {
        return Ok(false);
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }

    if prefer_hardlink && fs::hard_link(src, dst).is_ok() {
        return Ok(true);
    }

    let tmp_name = format!(
        ".{}.migrating.tmp",
        dst.file_name().and_then(|n| n.to_str()).unwrap_or("asset")
    );
    let tmp_dst = dst.with_file_name(tmp_name);
    let copy_result = (|| -> io::Result<()> {
        fs::copy(src, &tmp_dst)?;
        File::open(&tmp_dst)?.sync_all()?;
        if dst.exists() {
            let _ = fs::remove_file(&tmp_dst);
            return Ok(());
        }
        fs::rename(&tmp_dst, dst)?;
        Ok(())
    })();

    if let Err(err) = copy_result {
        let _ = fs::remove_file(&tmp_dst);
        return Err(err);
    }

    Ok(true)
}

fn copy_directory_tree_non_destructive(
    src_dir: &Path,
    dst_dir: &Path,
    prefer_hardlink: bool,
    skip_partial_downloads: bool,
    outcome: &mut AssetCopyOutcome,
) {
    let meta = match fs::symlink_metadata(src_dir) {
        Ok(meta) => meta,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return,
        Err(err) => {
            outcome.source_present = true;
            outcome.failed = outcome.failed.saturating_add(1);
            if outcome.first_error.is_none() {
                outcome.first_error = Some(format!("could not inspect directory: {err}"));
            }
            return;
        }
    };

    if meta.file_type().is_symlink() || !meta.is_dir() {
        outcome.source_present = true;
        outcome.failed = outcome.failed.saturating_add(1);
        if outcome.first_error.is_none() {
            outcome.first_error = Some("refused symbolic link or non-directory source".to_string());
        }
        return;
    }

    let entries = match fs::read_dir(src_dir) {
        Ok(entries) => entries,
        Err(err) => {
            outcome.source_present = true;
            outcome.failed = outcome.failed.saturating_add(1);
            if outcome.first_error.is_none() {
                outcome.first_error = Some(format!("could not read directory: {err}"));
            }
            return;
        }
    };

    for entry_result in entries {
        let entry = match entry_result {
            Ok(entry) => entry,
            Err(err) => {
                outcome.source_present = true;
                outcome.failed = outcome.failed.saturating_add(1);
                if outcome.first_error.is_none() {
                    outcome.first_error = Some(format!("could not read directory entry: {err}"));
                }
                continue;
            }
        };

        let name = entry.file_name();
        if skip_partial_downloads && is_partial_download_name(&name) {
            continue;
        }

        let src_path = entry.path();
        let dst_path = dst_dir.join(&name);

        let entry_meta = match fs::symlink_metadata(&src_path) {
            Ok(meta) => meta,
            Err(err) => {
                outcome.source_present = true;
                outcome.failed = outcome.failed.saturating_add(1);
                if outcome.first_error.is_none() {
                    outcome.first_error = Some(format!("could not inspect entry: {err}"));
                }
                continue;
            }
        };

        if entry_meta.file_type().is_symlink() {
            outcome.source_present = true;
            outcome.failed = outcome.failed.saturating_add(1);
            if outcome.first_error.is_none() {
                outcome.first_error = Some("skipped symbolic link in legacy directory".to_string());
            }
            continue;
        }

        if entry_meta.is_dir() {
            copy_directory_tree_non_destructive(
                &src_path,
                &dst_path,
                prefer_hardlink,
                skip_partial_downloads,
                outcome,
            );
            continue;
        }

        if !entry_meta.is_file() {
            continue;
        }

        // Skip zero-byte incomplete model files so they don't mask real downloads.
        if skip_partial_downloads && entry_meta.len() == 0 {
            continue;
        }

        outcome.source_present = true;
        match copy_file_non_destructive(&src_path, &dst_path, prefer_hardlink) {
            Ok(true) => outcome.copied = outcome.copied.saturating_add(1),
            Ok(false) => outcome.skipped_existing = outcome.skipped_existing.saturating_add(1),
            Err(err) => {
                outcome.failed = outcome.failed.saturating_add(1);
                if outcome.first_error.is_none() {
                    outcome.first_error = Some(format!("could not copy file: {err}"));
                }
            }
        }
    }
}

fn migrate_asset_phases(dirs: &MigrationDirs, report: &mut VoquillMigrationReport) {
    let Some(legacy_data) = dirs.legacy_data_dir.as_ref() else {
        if matches!(report.models_phase, VoquillMigrationPhaseStatus::Pending) {
            report.models_phase = VoquillMigrationPhaseStatus::NotFound;
        }
        if matches!(report.audio_phase, VoquillMigrationPhaseStatus::Pending) {
            report.audio_phase = VoquillMigrationPhaseStatus::NotFound;
        }
        if matches!(report.storage_phase, VoquillMigrationPhaseStatus::Pending) {
            report.storage_phase = VoquillMigrationPhaseStatus::NotFound;
        }
        return;
    };

    // Keep database issues intact while refreshing asset issues for this run.
    report
        .issues
        .retain(|issue| !matches!(issue.category.as_str(), "models" | "audio" | "storage"));

    if matches!(
        report.models_phase,
        VoquillMigrationPhaseStatus::Pending
            | VoquillMigrationPhaseStatus::Partial
            | VoquillMigrationPhaseStatus::Failed
    ) {
        let mut outcome = AssetCopyOutcome::default();
        let target_models_dir = dirs.current_data_dir.join(MODELS_DIR_NAME);
        for legacy_sub in [MODELS_DIR_NAME, LEGACY_MODELS_DIR_NAME] {
            copy_directory_tree_non_destructive(
                &legacy_data.join(legacy_sub),
                &target_models_dir,
                true,
                true,
                &mut outcome,
            );
        }
        report.models_phase = outcome.phase_status();
        report.counts.local_models_migrated = report
            .counts
            .local_models_migrated
            .saturating_add(outcome.copied);
        if outcome.failed > 0 {
            report.issues.push(VoquillMigrationIssue {
                category: "models".to_string(),
                code: "partial_asset_copy".to_string(),
                detail: format!(
                    "{} local model file(s) could not be imported ({}).",
                    outcome.failed,
                    outcome.first_error.as_deref().unwrap_or("filesystem error")
                ),
            });
        }
    }

    if matches!(
        report.audio_phase,
        VoquillMigrationPhaseStatus::Pending
            | VoquillMigrationPhaseStatus::Partial
            | VoquillMigrationPhaseStatus::Failed
    ) {
        let mut outcome = AssetCopyOutcome::default();
        copy_directory_tree_non_destructive(
            &legacy_data.join(AUDIO_DIR_NAME),
            &dirs.current_data_dir.join(AUDIO_DIR_NAME),
            false,
            false,
            &mut outcome,
        );
        report.audio_phase = outcome.phase_status();
        report.counts.audio_files_migrated = report
            .counts
            .audio_files_migrated
            .saturating_add(outcome.copied);
        if outcome.failed > 0 {
            report.issues.push(VoquillMigrationIssue {
                category: "audio".to_string(),
                code: "partial_asset_copy".to_string(),
                detail: format!(
                    "{} audio recording(s) could not be copied ({}).",
                    outcome.failed,
                    outcome.first_error.as_deref().unwrap_or("filesystem error")
                ),
            });
        }
    }

    if matches!(
        report.storage_phase,
        VoquillMigrationPhaseStatus::Pending
            | VoquillMigrationPhaseStatus::Partial
            | VoquillMigrationPhaseStatus::Failed
    ) {
        let mut outcome = AssetCopyOutcome::default();
        copy_directory_tree_non_destructive(
            &legacy_data.join(STORAGE_DIR_NAME),
            &dirs.current_data_dir.join(STORAGE_DIR_NAME),
            false,
            false,
            &mut outcome,
        );
        report.storage_phase = outcome.phase_status();
        report.counts.storage_files_migrated = report
            .counts
            .storage_files_migrated
            .saturating_add(outcome.copied);
        if outcome.failed > 0 {
            report.issues.push(VoquillMigrationIssue {
                category: "storage".to_string(),
                code: "partial_asset_copy".to_string(),
                detail: format!(
                    "{} app icon or storage file(s) could not be copied ({}).",
                    outcome.failed,
                    outcome.first_error.as_deref().unwrap_or("filesystem error")
                ),
            });
        }
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
    let staging_dir = dirs.staging_dir();
    let had_interrupted_staging = staging_dir.exists();
    if had_interrupted_staging {
        log::warn!(
            "Found leftover Voquill migration staging directory at {}; cleaning up interrupted attempt",
            staging_dir.display()
        );
        cleanup_staging(&staging_dir);
    }

    if let Some(mut existing) = load_manifest(&dirs.current_config_dir) {
        existing.legacy_source_preserved = legacy_source_still_present(dirs);

        // Already finished or deliberately skipped: idempotent no-op.
        if matches!(
            existing.status,
            VoquillMigrationStatus::Completed
                | VoquillMigrationStatus::SkippedExistingProfile
                | VoquillMigrationStatus::NotNeeded
        ) {
            return existing;
        }

        // Database already migrated, but optional asset phases were interrupted
        // or partially failed: resume only unfinished asset phases without
        // touching mausvoice.db.
        if existing.database_phase == VoquillMigrationPhaseStatus::Migrated
            && matches!(existing.status, VoquillMigrationStatus::Partial)
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
            if let Err(err) = save_manifest(&dirs.current_config_dir, &existing) {
                log::warn!("Failed to persist resumed Voquill migration manifest: {err}");
            }
            return existing;
        }

        // Previous attempt failed (e.g. locked/corrupt DB) or asset copy failed
        // after completion. Keep the truthful state visible for explicit user
        // retry rather than silently overwriting an active mausvoice.db.
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
        return existing;
    }

    if !has_any_legacy_source(dirs) {
        return VoquillMigrationReport::not_needed();
    }

    let now = now_iso();
    let legacy_db_present = dirs
        .legacy_db_path()
        .as_ref()
        .is_some_and(|path| fs::symlink_metadata(path).is_ok());
    let current_db_exists = dirs.current_db_path().exists();

    // Never blindly overwrite an existing mausVoice profile.
    if legacy_db_present && current_db_exists {
        let mut report = VoquillMigrationReport {
            schema_version: MANIFEST_SCHEMA_VERSION,
            status: VoquillMigrationStatus::SkippedExistingProfile,
            legacy_detected: true,
            legacy_source_preserved: true,
            detected_at: Some(now),
            completed_at: None,
            dismissed_at: None,
            attempt_count: 1,
            database_phase: VoquillMigrationPhaseStatus::Skipped,
            models_phase: VoquillMigrationPhaseStatus::Skipped,
            audio_phase: VoquillMigrationPhaseStatus::Skipped,
            storage_phase: VoquillMigrationPhaseStatus::Skipped,
            counts: VoquillMigrationCounts::default(),
            removed_modes_reset: Vec::new(),
            issues: vec![VoquillMigrationIssue {
                category: "database".to_string(),
                code: "existing_profile_conflict".to_string(),
                detail: "An existing mausVoice profile was found, so the older Voquill profile was not imported over it.".to_string(),
            }],
            action_items: Vec::new(),
            can_retry: false,
        };
        finalize_status_and_actions(&mut report, Vec::new());
        if let Err(err) = save_manifest(&dirs.current_config_dir, &report) {
            log::warn!("Failed to persist skipped-profile migration manifest: {err}");
        }
        return report;
    }

    let mut report = VoquillMigrationReport {
        schema_version: MANIFEST_SCHEMA_VERSION,
        status: VoquillMigrationStatus::Partial,
        legacy_detected: true,
        legacy_source_preserved: true,
        detected_at: Some(now),
        completed_at: None,
        dismissed_at: None,
        attempt_count: 1,
        database_phase: if legacy_db_present {
            VoquillMigrationPhaseStatus::Pending
        } else {
            VoquillMigrationPhaseStatus::NotFound
        },
        models_phase: VoquillMigrationPhaseStatus::Pending,
        audio_phase: VoquillMigrationPhaseStatus::Pending,
        storage_phase: VoquillMigrationPhaseStatus::Pending,
        counts: VoquillMigrationCounts::default(),
        removed_modes_reset: Vec::new(),
        issues: Vec::new(),
        action_items: Vec::new(),
        can_retry: false,
    };

    if had_interrupted_staging {
        report.issues.push(VoquillMigrationIssue {
            category: "database".to_string(),
            code: "interrupted_previous_attempt".to_string(),
            detail: "Cleaned up an interrupted earlier import before retrying.".to_string(),
        });
    }

    let mut attention_providers = Vec::new();

    if legacy_db_present {
        // Persist in-progress state before staging so crashes remain observable.
        let _ = save_manifest(&dirs.current_config_dir, &report);

        match stage_validate_and_promote_database(dirs).await {
            Ok(staged) => {
                report.database_phase = VoquillMigrationPhaseStatus::Migrated;
                report.counts = staged.audit.counts;
                report.removed_modes_reset = staged.removed_modes_reset;
                attention_providers = staged.audit.attention_providers;
                // Remove transient interrupted-attempt notice once DB succeeds cleanly.
                report
                    .issues
                    .retain(|issue| issue.code != "interrupted_previous_attempt");
                // Checkpoint DB completion before asset phases so an interrupted
                // asset copy never retries DB import.
                let _ = save_manifest(&dirs.current_config_dir, &report);
            }
            Err(issue) => {
                report.database_phase = VoquillMigrationPhaseStatus::Failed;
                report.models_phase = VoquillMigrationPhaseStatus::Skipped;
                report.audio_phase = VoquillMigrationPhaseStatus::Skipped;
                report.storage_phase = VoquillMigrationPhaseStatus::Skipped;
                report.issues.push(issue);
                finalize_status_and_actions(&mut report, Vec::new());
                if let Err(err) = save_manifest(&dirs.current_config_dir, &report) {
                    log::warn!("Failed to persist failed Voquill migration manifest: {err}");
                }
                return report;
            }
        }
    }

    migrate_asset_phases(dirs, &mut report);
    report.legacy_source_preserved = legacy_source_still_present(dirs);
    finalize_status_and_actions(&mut report, attention_providers);

    if report.status != VoquillMigrationStatus::NotNeeded {
        if let Err(err) = save_manifest(&dirs.current_config_dir, &report) {
            log::warn!("Failed to persist Voquill migration manifest: {err}");
        }
    }

    report
}

/// Checks whether the currently active mausVoice database holds any user-created
/// records. Used to ensure retrying a failed Voquill database import can never
/// overwrite a profile the user has already started using.
pub async fn is_database_empty_of_user_data(pool: SqlitePool) -> Result<bool, String> {
    let checks = [
        "SELECT COUNT(*) FROM transcriptions",
        "SELECT COUNT(*) FROM terms",
        "SELECT COUNT(*) FROM api_keys",
        "SELECT COUNT(*) FROM app_targets",
        "SELECT COUNT(*) FROM conversations",
        "SELECT COUNT(*) FROM paired_remote_devices",
        "SELECT COUNT(*) FROM user_profiles WHERE onboarded = 1 OR onboarded_at IS NOT NULL OR words_total > 0",
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
    let Some(mut report) = load_manifest(&dirs.current_config_dir) else {
        return VoquillMigrationReport::not_needed();
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
    } else if report.status == VoquillMigrationStatus::Failed {
        report.can_retry = is_database_empty_of_user_data(pool).await.unwrap_or(false)
            && dirs
                .legacy_db_path()
                .as_ref()
                .is_some_and(|path| fs::symlink_metadata(path).is_ok());
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
    let Some(mut report) = load_manifest(&dirs.current_config_dir) else {
        return Ok(VoquillMigrationReport::not_needed());
    };
    if report.dismissed_at.is_none() {
        report.dismissed_at = Some(now_iso());
        save_manifest(&dirs.current_config_dir, &report)
            .map_err(|err| format!("Could not save migration dismissal: {err}"))?;
    }
    Ok(refresh_migration_report(dirs, pool).await)
}

/// Retries an incomplete (`Partial`) or `Failed` Voquill migration safely:
/// - Never duplicates rows or overwrites a database containing user data.
/// - If `database_phase == Migrated`, retries only unfinished asset phases.
/// - If `database_phase == Failed` and the active database is still empty of
///   user data, stages, validates, migrates, and swaps in the Voquill DB cleanly.
pub async fn retry_migration(
    dirs: MigrationDirs,
    database: OptionKeyDatabase,
) -> Result<VoquillMigrationReport, String> {
    let Some(mut report) = load_manifest(&dirs.current_config_dir) else {
        return Ok(VoquillMigrationReport::not_needed());
    };

    if matches!(
        report.status,
        VoquillMigrationStatus::Completed
            | VoquillMigrationStatus::SkippedExistingProfile
            | VoquillMigrationStatus::NotNeeded
    ) {
        return Ok(refresh_migration_report(dirs, database.pool()).await);
    }

    report.attempt_count = report.attempt_count.saturating_add(1);
    report.dismissed_at = None;
    let mut attention_providers = Vec::new();

    if report.database_phase == VoquillMigrationPhaseStatus::Failed {
        let current_pool = database.pool();
        let is_empty = is_database_empty_of_user_data(current_pool.clone()).await?;
        if !is_empty {
            report.database_phase = VoquillMigrationPhaseStatus::Skipped;
            report.models_phase = VoquillMigrationPhaseStatus::Skipped;
            report.audio_phase = VoquillMigrationPhaseStatus::Skipped;
            report.storage_phase = VoquillMigrationPhaseStatus::Skipped;
            report.issues = vec![VoquillMigrationIssue {
                category: "database".to_string(),
                code: "existing_profile_conflict".to_string(),
                detail: "Your current mausVoice profile already has saved data, so the Voquill profile was not imported over it.".to_string(),
            }];
            finalize_status_and_actions(&mut report, Vec::new());
            save_manifest(&dirs.current_config_dir, &report)
                .map_err(|err| format!("Could not save migration state: {err}"))?;
            return Ok(refresh_migration_report(dirs, current_pool).await);
        }

        // First validate & migrate completely in staging BEFORE touching the
        // live pool, so a repeated failure leaves the running app untouched.
        let staging_dir = dirs.staging_dir();
        let current_db_path = dirs.current_db_path();
        cleanup_staging(&staging_dir);
        let staged_probe = stage_validate_in_staging_only(&dirs).await;
        match staged_probe {
            Ok((staged_db_path, staged)) => {
                // Close active empty pool cleanly before replacing the SQLite file.
                let old_pool = database.pool();
                old_pool.close().await;

                if let Err(issue) = promote_staged_file(&staged_db_path, &current_db_path, true) {
                    // Reopen existing/fresh DB so the app stays operational.
                    if let Ok(recovered_pool) = open_app_database(&current_db_path).await {
                        let _ = database.replace_pool(recovered_pool);
                    }
                    cleanup_staging(&staging_dir);
                    report.issues = vec![issue];
                    finalize_status_and_actions(&mut report, Vec::new());
                    let _ = save_manifest(&dirs.current_config_dir, &report);
                    return Ok(report);
                }

                cleanup_staging(&staging_dir);

                let new_pool = open_app_database(&current_db_path)
                    .await
                    .map_err(|err| format!("Could not reopen migrated database: {err}"))?;
                let _ = database.replace_pool(new_pool);

                report.database_phase = VoquillMigrationPhaseStatus::Migrated;
                report.models_phase = VoquillMigrationPhaseStatus::Pending;
                report.audio_phase = VoquillMigrationPhaseStatus::Pending;
                report.storage_phase = VoquillMigrationPhaseStatus::Pending;
                report.counts = staged.audit.counts;
                report.removed_modes_reset = staged.removed_modes_reset;
                report.issues.clear();
                attention_providers = staged.audit.attention_providers;
                let _ = save_manifest(&dirs.current_config_dir, &report);
            }
            Err(issue) => {
                cleanup_staging(&staging_dir);
                report.issues = vec![issue];
                finalize_status_and_actions(&mut report, Vec::new());
                save_manifest(&dirs.current_config_dir, &report)
                    .map_err(|err| format!("Could not save migration state: {err}"))?;
                return Ok(report);
            }
        }
    }

    migrate_asset_phases(&dirs, &mut report);
    report.legacy_source_preserved = legacy_source_still_present(&dirs);

    if attention_providers.is_empty() {
        let live_pool = database.pool();
        if let Ok((total, attention, providers)) = inspect_live_api_key_attention(live_pool).await {
            report.counts.provider_entries = total;
            report.counts.providers_needing_attention = attention;
            attention_providers = providers;
        }
    }

    finalize_status_and_actions(&mut report, attention_providers);
    save_manifest(&dirs.current_config_dir, &report)
        .map_err(|err| format!("Could not save migration state: {err}"))?;

    Ok(refresh_migration_report(dirs, database.pool()).await)
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

    cleanup_staging(staging_dir);
    fs::create_dir_all(staging_dir).map_err(|err| VoquillMigrationIssue {
        category: "database".to_string(),
        code: "staging_io_error".to_string(),
        detail: format!("Could not prepare migration staging directory: {err}"),
    })?;

    let staged_db = staging_dir.join(STAGED_DB_FILENAME);
    copy_file_strict_no_symlink(&legacy_db, &staged_db).map_err(|detail| {
        VoquillMigrationIssue {
            category: "database".to_string(),
            code: "database_copy_failed".to_string(),
            detail: format!("Could not copy the Voquill database: {detail}"),
        }
    })?;

    let legacy_dir = legacy_db.parent().unwrap_or_else(|| Path::new(""));
    let legacy_wal = legacy_dir.join(format!("{LEGACY_DB_FILENAME}-wal"));
    let legacy_shm = legacy_dir.join(format!("{LEGACY_DB_FILENAME}-shm"));
    let legacy_journal = legacy_dir.join(format!("{LEGACY_DB_FILENAME}-journal"));

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

    let audit = audit_migrated_database(migrated_pool.clone())
        .await
        .map_err(|detail| VoquillMigrationIssue {
            category: "database".to_string(),
            code: "database_audit_failed".to_string(),
            detail,
        })?;

    let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&migrated_pool)
        .await;
    let _ = sqlx::query("PRAGMA journal_mode = DELETE")
        .execute(&migrated_pool)
        .await;
    migrated_pool.close().await;

    for suffix in ["-wal", "-shm", "-journal"] {
        let _ = fs::remove_file(staging_dir.join(format!("{STAGED_DB_FILENAME}{suffix}")));
    }

    Ok((
        staged_db,
        StagedDbSuccess {
            audit,
            removed_modes_reset,
        },
    ))
}

fn promote_staged_file(
    staged_db: &Path,
    current_db: &Path,
    replace_existing: bool,
) -> Result<(), VoquillMigrationIssue> {
    if replace_existing {
        for suffix in ["-wal", "-shm", "-journal", ""] {
            let path = current_db.with_file_name(format!("{DB_FILENAME}{suffix}"));
            if let Err(err) = fs::remove_file(&path) {
                if err.kind() != io::ErrorKind::NotFound {
                    return Err(VoquillMigrationIssue {
                        category: "database".to_string(),
                        code: "promote_io_error".to_string(),
                        detail: format!("Could not replace empty mausVoice database: {err}"),
                    });
                }
            }
        }
    }

    if let Err(rename_err) = fs::rename(staged_db, current_db) {
        let tmp_dest = current_db.with_file_name(format!("{DB_FILENAME}.migrating.tmp"));
        fs::copy(staged_db, &tmp_dest)
            .and_then(|_| File::open(&tmp_dest).and_then(|f| f.sync_all()))
            .and_then(|_| fs::rename(&tmp_dest, current_db))
            .map_err(|copy_err| {
                let _ = fs::remove_file(&tmp_dest);
                VoquillMigrationIssue {
                    category: "database".to_string(),
                    code: "promote_io_error".to_string(),
                    detail: format!(
                        "Could not promote verified database (rename: {rename_err}; copy: {copy_err})"
                    ),
                }
            })?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose, Engine as _};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_workspace(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mausvoice-voquill-mig-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("create temp workspace");
        dir
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
            // Leave pool open briefly? No — drop without checkpointing by
            // using SQLITE_CHECKPOINT bypass via PRAGMA wal_autocheckpoint=0;
            // to guarantee a live -wal exists on disk even after close, keep
            // another reader open while closing or copy while open.
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
            // Intentionally forget closing pool? No — better: leak nothing,
            // just keep a second connection? Even cleaner: tests needing a
            // real WAL on disk pass `pool` back via a dedicated helper.
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

        let _ = fs::remove_dir_all(&root);
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
        let _ = fs::remove_dir_all(&root);
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

        let _ = fs::remove_dir_all(&root);
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

        let _ = fs::remove_dir_all(&root);
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
        let _ = fs::remove_dir_all(&root);
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

        let _ = fs::remove_dir_all(&root);
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
        let _ = fs::remove_dir_all(&root);
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

        let _ = fs::remove_dir_all(&root);
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

        let _ = fs::remove_dir_all(&root);
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
        let _ = fs::remove_dir_all(&root);
    }
}
