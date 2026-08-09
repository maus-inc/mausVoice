use std::{fs, io, path::{Path, PathBuf}};
use tauri::Manager;

use super::models::WhisperModelSize;

const MODELS_DIR_NAME: &str = "models";
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

pub fn whisper_model_path(app: &tauri::AppHandle, size: WhisperModelSize) -> io::Result<PathBuf> {
    let mut path = models_dir(app)?;
    path.push(size.filename());
    Ok(path)
}

pub fn models_dir(app: &tauri::AppHandle) -> io::Result<PathBuf> {
    let mut path = app
        .path()
        .app_data_dir()
        .map_err(|err| io::Error::other(err.to_string()))?;
    path.push(MODELS_DIR_NAME);
    fs::create_dir_all(&path)?;
    Ok(path)
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
