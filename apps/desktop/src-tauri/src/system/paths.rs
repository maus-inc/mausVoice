use std::{
    fs, io,
    path::{Path, PathBuf},
};
use tauri::Manager;

use super::models::WhisperModelSize;

const MODELS_DIR_NAME: &str = "transcription-models";
const LEGACY_MODELS_DIR_NAME: &str = "models";
pub(crate) const STORAGE_DIR_NAME: &str = "storage";

// Pre-rebrand values: the app identifier and database filename changed when
// the product was renamed from Voquill to mausVoice. Tauri derives the config
// and data directories from the bundle identifier, so we pair each mausVoice
// flavor only with its matching Voquill flavor to avoid cross-flavor leakage.
pub(crate) const LEGACY_PROD_IDENTIFIER: &str = "com.voquill.desktop";
const LEGACY_DEV_IDENTIFIER: &str = "com.voquill.desktop.dev";
const LEGACY_LOCAL_IDENTIFIER: &str = "com.voquill.desktop.local";
pub(crate) const LEGACY_DB_FILENAME: &str = "voquill.db";

pub(crate) fn legacy_identifier_for(current_identifier: &str) -> Option<&'static str> {
    match current_identifier {
        "com.mausinc.desktop" => Some(LEGACY_PROD_IDENTIFIER),
        "com.mausinc.desktop.dev" => Some(LEGACY_DEV_IDENTIFIER),
        "com.mausinc.desktop.local" => Some(LEGACY_LOCAL_IDENTIFIER),
        _ => None,
    }
}

pub(crate) fn sibling_legacy_dir(current_dir: &Path) -> Option<PathBuf> {
    let leaf = current_dir.file_name()?.to_str()?;
    let legacy_leaf = legacy_identifier_for(leaf)?;
    current_dir.parent().map(|base| base.join(legacy_leaf))
}

pub fn database_path(app: &tauri::AppHandle) -> io::Result<PathBuf> {
    let mut path = app
        .path()
        .app_config_dir()
        .map_err(|err| io::Error::other(err.to_string()))?;
    fs::create_dir_all(&path)?;
    path.push(crate::db::DB_FILENAME);
    Ok(path)
}

pub(crate) fn legacy_voquill_config_dir(app: &tauri::AppHandle) -> io::Result<Option<PathBuf>> {
    let current_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| io::Error::other(error.to_string()))?;
    Ok(sibling_legacy_dir(&current_config_dir))
}

pub(crate) fn legacy_voquill_data_dir(app: &tauri::AppHandle) -> io::Result<Option<PathBuf>> {
    let current_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| io::Error::other(error.to_string()))?;
    Ok(sibling_legacy_dir(&current_data_dir))
}

/// Delete the previous-brand database and SQLite sidecars during an explicit
/// local-data clear. Normal migration preserves the legacy source untouched so
/// users can recover or verify their old data; explicit local-data clear
/// removes both the current database and the legacy database files so wiped
/// user data does not remain behind on disk.
pub fn delete_legacy_database(app: &tauri::AppHandle) -> io::Result<usize> {
    let Some(legacy_dir) = legacy_voquill_config_dir(app)? else {
        return Ok(0);
    };
    delete_legacy_database_files_in(&legacy_dir)
}

fn delete_legacy_database_files_in(legacy_dir: &Path) -> io::Result<usize> {
    let mut deleted = 0;
    for suffix in ["-journal", "-wal", "-shm", ""] {
        let path = legacy_dir.join(format!("{LEGACY_DB_FILENAME}{suffix}"));
        match fs::remove_file(path) {
            Ok(()) => deleted += 1,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(deleted)
}

fn resolved_app_data_dir(app: &tauri::AppHandle) -> io::Result<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|err| io::Error::other(err.to_string()))
}

pub fn whisper_model_path(app: &tauri::AppHandle, size: WhisperModelSize) -> io::Result<PathBuf> {
    let mut path = models_dir(app)?;
    path.push(size.filename());
    Ok(path)
}

/// Move model files from the pre-sidecar `app-data/models` directory into the
/// current shared directory without overwriting files already migrated or
/// downloaded there. This is intentionally idempotent so it is safe to run at
/// every application startup.
pub fn migrate_legacy_models(app: &tauri::AppHandle) -> io::Result<()> {
    let app_data_dir = resolved_app_data_dir(app)?;
    let current_dir = app_data_dir.join(MODELS_DIR_NAME);
    let legacy_dir = app_data_dir.join(LEGACY_MODELS_DIR_NAME);

    fs::create_dir_all(&current_dir)?;
    let migrated = migrate_model_files(&legacy_dir, &current_dir)?;
    if migrated > 0 {
        log::info!(
            "Migrated {migrated} local transcription model file(s) from {legacy_dir:?} to {current_dir:?}"
        );
    }

    Ok(())
}

pub fn models_dir(app: &tauri::AppHandle) -> io::Result<PathBuf> {
    let app_data_dir = resolved_app_data_dir(app)?;
    let path = app_data_dir.join(MODELS_DIR_NAME);
    fs::create_dir_all(&path)?;
    migrate_model_files(&app_data_dir.join(LEGACY_MODELS_DIR_NAME), &path)?;
    Ok(path)
}

fn migrate_model_files(legacy_dir: &Path, current_dir: &Path) -> io::Result<usize> {
    if !legacy_dir.is_dir() {
        return Ok(0);
    }

    let mut migrated = 0;
    for entry in fs::read_dir(legacy_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }

        let source = entry.path();
        let destination = current_dir.join(entry.file_name());
        if destination.exists() {
            continue;
        }

        match fs::rename(&source, &destination) {
            Ok(()) => {}
            Err(rename_error) => {
                fs::copy(&source, &destination).map_err(|copy_error| {
                    io::Error::new(
                        copy_error.kind(),
                        format!(
                            "failed to migrate model file {source:?} after rename error ({rename_error}): {copy_error}"
                        ),
                    )
                })?;
                fs::remove_file(&source)?;
            }
        }
        migrated += 1;
    }

    Ok(migrated)
}

pub fn storage_dir(app: &tauri::AppHandle) -> io::Result<PathBuf> {
    let _storage = crate::system::audio_store::open_storage_dir(app)?;
    let mut path = app
        .path()
        .app_data_dir()
        .map_err(|err| io::Error::other(err.to_string()))?;
    path.push(STORAGE_DIR_NAME);
    Ok(path)
}

pub fn logs_dir(app: &tauri::AppHandle) -> io::Result<PathBuf> {
    let path = app
        .path()
        .app_log_dir()
        .map_err(|err| io::Error::other(err.to_string()))?;
    fs::create_dir_all(&path)?;
    Ok(path)
}

pub fn startup_diagnostics_path(app: &tauri::AppHandle) -> io::Result<PathBuf> {
    let mut path = logs_dir(app)?;
    path.push("startup_diagnostics.log");
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::{delete_legacy_database_files_in, migrate_model_files};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn deleting_legacy_database_removes_only_its_sqlite_files() {
        let root = std::env::temp_dir().join(format!(
            "mausvoice-legacy-db-clear-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock must be after the Unix epoch")
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("failed to create test directory");
        for suffix in ["", "-journal", "-wal", "-shm"] {
            fs::write(root.join(format!("voquill.db{suffix}")), b"legacy database")
                .expect("failed to write legacy database fixture");
        }
        fs::write(root.join("keep.txt"), b"unrelated data")
            .expect("failed to write unrelated fixture");

        assert_eq!(delete_legacy_database_files_in(&root).unwrap(), 4);
        for suffix in ["", "-journal", "-wal", "-shm"] {
            assert!(!root.join(format!("voquill.db{suffix}")).exists());
        }
        assert_eq!(fs::read(root.join("keep.txt")).unwrap(), b"unrelated data");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn migrates_legacy_files_without_overwriting_current_files() {
        let root = std::env::temp_dir().join(format!(
            "mausvoice-model-migration-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock must be after the Unix epoch")
                .as_nanos()
        ));
        let legacy = root.join("models");
        let current = root.join("transcription-models");
        fs::create_dir_all(&legacy).expect("failed to create legacy model directory");
        fs::create_dir_all(&current).expect("failed to create current model directory");
        fs::write(legacy.join("ggml-tiny.bin"), b"legacy tiny")
            .expect("failed to write legacy model");
        fs::write(legacy.join("ggml-base.bin"), b"legacy base")
            .expect("failed to write second legacy model");
        fs::write(current.join("ggml-base.bin"), b"current base")
            .expect("failed to write current model");

        let migrated = migrate_model_files(&legacy, &current).expect("migration failed");

        assert_eq!(migrated, 1);
        assert_eq!(
            fs::read(current.join("ggml-tiny.bin")).unwrap().as_slice(),
            b"legacy tiny"
        );
        assert_eq!(
            fs::read(current.join("ggml-base.bin")).unwrap().as_slice(),
            b"current base"
        );
        assert!(!legacy.join("ggml-tiny.bin").exists());
        assert!(legacy.join("ggml-base.bin").exists());

        fs::remove_dir_all(root).expect("failed to clean up migration test directory");
    }
}
