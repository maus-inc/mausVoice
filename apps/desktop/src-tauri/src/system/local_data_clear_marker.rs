use std::{
    fs, io,
    path::{Path, PathBuf},
};

use tauri::{AppHandle, Manager};

const MARKER_FILE_NAME: &str = "local-data-clear.pending";

fn marker_path(config_dir: &Path) -> PathBuf {
    config_dir.join(MARKER_FILE_NAME)
}

pub(crate) fn app_marker_path(app: &AppHandle) -> io::Result<PathBuf> {
    app.path()
        .app_config_dir()
        .map(|config_dir| marker_path(&config_dir))
        .map_err(|error| io::Error::other(error.to_string()))
}

fn mark_pending_at(config_dir: &Path) -> io::Result<()> {
    fs::create_dir_all(config_dir)?;
    fs::write(marker_path(config_dir), b"pending\n")
}

fn is_pending_at(config_dir: &Path) -> bool {
    marker_path(config_dir).is_file()
}

fn clear_pending_at(config_dir: &Path) -> io::Result<()> {
    match fs::remove_file(marker_path(config_dir)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

pub(crate) fn mark_pending(app: &AppHandle) -> io::Result<()> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| io::Error::other(error.to_string()))?;
    mark_pending_at(&config_dir)
}

pub(crate) fn is_pending(app: &AppHandle) -> io::Result<bool> {
    let path = app_marker_path(app)?;
    Ok(path.is_file())
}

pub(crate) fn clear_pending(app: &AppHandle) -> io::Result<()> {
    let path = app_marker_path(app)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::{clear_pending_at, is_pending_at, mark_pending_at};
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TestConfigDir(std::path::PathBuf);

    impl TestConfigDir {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock must be after the Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "mausvoice-clear-marker-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("test config dir must be creatable");
            Self(path)
        }
    }

    impl Drop for TestConfigDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn marker_survives_restart_and_is_removed_only_after_completion() {
        let config_dir = TestConfigDir::new();
        assert!(!is_pending_at(&config_dir.0));

        mark_pending_at(&config_dir.0).expect("marker should be written");
        assert!(is_pending_at(&config_dir.0));
        assert!(
            is_pending_at(&config_dir.0),
            "a new process sees the same marker"
        );

        clear_pending_at(&config_dir.0).expect("completion should remove the marker");
        assert!(!is_pending_at(&config_dir.0));
        clear_pending_at(&config_dir.0).expect("completion should be idempotent");
    }
}
