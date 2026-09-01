use std::{fs, io, path::{Path, PathBuf}};
use tauri::Manager;

use super::models::WhisperModelSize;

const MODELS_DIR_NAME: &str = "transcription-models";
const LEGACY_MODELS_DIR_NAME: &str = "models";
const STORAGE_DIR_NAME: &str = "storage";

// Pre-rebrand values: the app identifier and database filename changed when
// the product was renamed from Voquill to mausVoice. Tauri derives the config
// directory from the identifier, so an upgraded install opens a brand-new
// directory and a brand-new database. Copy the legacy database (plus any
// WAL/SHM side files) into the current location once, idempotently, so
// existing users keep their transcriptions, preferences, and stored API keys.
const LEGACY_CONFIG_DIR_NAME: &str = "com.voquill.desktop";
const LEGACY_DB_FILENAME: &str = "voquill.db";

pub fn database_path(app: &tauri::AppHandle) -> io::Result<PathBuf> {
    let mut path = app
        .path()
        .app_config_dir()
        .map_err(|err| io::Error::other(err.to_string()))?;
    fs::create_dir_all(&path)?;
    path.push(crate::db::DB_FILENAME);

    if !path.exists() {
        migrate_legacy_database(app, &path)?;
    }

    Ok(path)
}

fn migrate_legacy_database(app: &tauri::AppHandle, current_path: &Path) -> io::Result<()> {
    let legacy_dir = match app.path().app_config_dir() {
        Ok(dir) => dir
            .parent()
            .map(|base| base.join(LEGACY_CONFIG_DIR_NAME)),
        Err(_) => None,
    };
    let Some(legacy_dir) = legacy_dir else {
        return Ok(());
    };
    if !legacy_dir.is_dir() {
        return Ok(());
    }

    let legacy_db = legacy_dir.join(LEGACY_DB_FILENAME);
    if !legacy_db.exists() {
        return Ok(());
    }

    if let Some(parent) = current_path.parent() {
        fs::create_dir_all(parent)?;
    }

    fs::copy(&legacy_db, current_path)?;
    for sidecar in ["-wal", "-shm"] {
        let legacy_sidecar = legacy_dir.join(format!("{LEGACY_DB_FILENAME}{sidecar}"));
        if legacy_sidecar.exists() {
            let _ = fs::copy(&legacy_sidecar, current_path.with_file_name(format!(
                "{}{sidecar}",
                crate::db::DB_FILENAME
            )));
        }
    }
    log::info!(
        "Migrated legacy database from {:?} to {:?}",
        legacy_db,
        current_path
    );

    Ok(())
}

pub fn database_url(app: &tauri::AppHandle) -> io::Result<String> {
    let path = database_path(app)?;
    let path_str = path
        .to_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Invalid database path"))?;
    Ok(format!("sqlite:{path_str}"))
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
            "Migrated {migrated} local transcription model file(s) from {:?} to {:?}",
            legacy_dir,
            current_dir
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
                            "failed to migrate model file {:?} after rename error ({rename_error}): {copy_error}",
                            source
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
    let mut path = app
        .path()
        .app_data_dir()
        .map_err(|err| io::Error::other(err.to_string()))?;
    path.push(STORAGE_DIR_NAME);
    fs::create_dir_all(&path)?;
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
    use super::migrate_model_files;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

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
