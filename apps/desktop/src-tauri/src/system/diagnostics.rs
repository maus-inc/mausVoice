use std::fs;
use std::io::Write;
use std::path::Path;

/// Maximum total size (in bytes) the log directory is allowed to occupy
/// before `purge_old_logs` starts deleting the oldest files. The file-level
/// rotation in `app.rs` already keeps the active file under
/// `MAX_LOG_FILE_SIZE`; this cap is a backstop for the historical files
/// (250 MB ≈ 10 × 25 MB).
pub const MAX_LOG_DIR_SIZE: u64 = 250 * 1024 * 1024;

/// Number of most-recent log files `purge_old_logs` always keeps, even if
/// they push the directory past `MAX_LOG_DIR_SIZE`. Matches the
/// `RotationStrategy::KeepSome(MAX_LOG_FILES)` configured in `app.rs`.
pub const MIN_KEEP_RECENT_FILES: usize = 10;

pub fn purge_old_logs(app: &tauri::AppHandle) {
    let logs_dir = match crate::system::paths::logs_dir(app) {
        Ok(dir) => dir,
        Err(err) => {
            log::error!("Failed to get logs dir for purge: {err}");
            return;
        }
    };
    purge_old_logs_in(&logs_dir);
}

fn purge_old_logs_in(logs_dir: &Path) {
    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime, u64)> =
        match fs::read_dir(logs_dir) {
            Ok(entries) => entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_file())
                .filter_map(|e| {
                    let metadata = e.metadata().ok()?;
                    let modified = metadata.modified().ok()?;
                    let size = metadata.len();
                    Some((e.path(), modified, size))
                })
                .collect(),
            Err(err) => {
                log::error!("Failed to read logs dir for purge: {err}");
                return;
            }
        };

    let total_size: u64 = files.iter().map(|(_, _, size)| size).sum();
    if files.len() <= MIN_KEEP_RECENT_FILES && total_size <= MAX_LOG_DIR_SIZE {
        return;
    }

    files.sort_by_key(|(_, modified, _)| std::cmp::Reverse(*modified));

    let mut removed = 0usize;
    let mut bytes_freed: u64 = 0;

    for (idx, (path, _, size)) in files.iter().enumerate() {
        if idx < MIN_KEEP_RECENT_FILES && total_size - bytes_freed <= MAX_LOG_DIR_SIZE {
            continue;
        }
        match fs::remove_file(path) {
            Ok(()) => {
                removed += 1;
                bytes_freed += size;
            }
            Err(err) => {
                log::warn!("Failed to purge old log file {}: {err}", path.display());
            }
        }
    }

    if removed > 0 {
        log::info!(
            "Purged {} old log file(s), freed {} bytes",
            removed,
            bytes_freed
        );
    }
}

/// Write startup diagnostics to a log file for debugging purposes.
/// This is particularly useful for diagnosing crashes on specific hardware configurations.
pub fn write_startup_diagnostics(app: &tauri::AppHandle) {
    let log_path = match crate::system::paths::startup_diagnostics_path(app) {
        Ok(path) => path,
        Err(err) => {
            log::error!("Failed to get diagnostics log path: {err}");
            return;
        }
    };

    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

    let mut log_content = String::new();
    log_content.push_str("=== mausVoice Startup Diagnostics ===\n");
    log_content.push_str(&format!("Timestamp: {}\n", timestamp));
    log_content.push_str(&format!("Version: {}\n", env!("CARGO_PKG_VERSION")));
    log_content.push_str(&format!("OS: {}\n", std::env::consts::OS));
    log_content.push_str(&format!("Arch: {}\n", std::env::consts::ARCH));
    log_content.push_str(&format!("Family: {}\n", std::env::consts::FAMILY));
    log_content.push('\n');

    log_content.push_str("=== GPU Detection ===\n");
    log_content.push('\n');

    log_content.push_str("=== System Information ===\n");
    if let Ok(hostname) = hostname::get() {
        if let Some(hostname_str) = hostname.to_str() {
            log_content.push_str(&format!("Hostname: {}\n", hostname_str));
        }
    }

    match fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        Ok(mut file) => {
            if let Err(err) = file.write_all(log_content.as_bytes()) {
                log::error!("Failed to write to diagnostics log: {err}");
            } else {
                log::info!("Startup diagnostics written to: {}", log_path.display());
            }
        }
        Err(err) => {
            log::error!("Failed to open diagnostics log file: {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{purge_old_logs_in, MAX_LOG_DIR_SIZE, MIN_KEEP_RECENT_FILES};
    use std::fs;
    use std::path::PathBuf;
    use std::thread::sleep;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn unique_tmp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mausvoice-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock must be after the Unix epoch")
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("failed to create tmp dir");
        dir
    }

    fn write_file_with_size(path: &std::path::Path, size_bytes: usize) {
        let payload = vec![b'x'; size_bytes];
        fs::write(path, &payload).expect("failed to write tmp log file");
    }

    fn total_size(dir: &std::path::Path) -> u64 {
        let mut total = 0u64;
        for entry in fs::read_dir(dir).expect("failed to read dir") {
            let entry = entry.expect("failed to read dir entry");
            if entry.path().is_file() {
                total += entry.metadata().expect("failed to read metadata").len();
            }
        }
        total
    }

    fn count_files(dir: &std::path::Path) -> usize {
        fs::read_dir(dir)
            .expect("failed to read dir")
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file())
            .count()
    }

    #[test]
    fn purge_is_noop_when_under_caps() {
        let dir = unique_tmp_dir("purge-noop");
        write_file_with_size(&dir.join("mausvoice_a.log"), 1024);
        write_file_with_size(&dir.join("mausvoice_b.log"), 2048);

        purge_old_logs_in(&dir);

        assert_eq!(count_files(&dir), 2);
        assert!(total_size(&dir) <= 4096);
        fs::remove_dir_all(&dir).expect("failed to clean up");
    }

    #[test]
    fn purge_trims_to_min_recent_count() {
        let dir = unique_tmp_dir("purge-count");
        for idx in 0..(MIN_KEEP_RECENT_FILES + 5) {
            write_file_with_size(&dir.join(format!("mausvoice_{idx:02}.log")), 64);
            sleep(Duration::from_millis(2));
        }

        purge_old_logs_in(&dir);

        assert_eq!(count_files(&dir), MIN_KEEP_RECENT_FILES);
        fs::remove_dir_all(&dir).expect("failed to clean up");
    }

    #[test]
    fn purge_enforces_total_size_cap() {
        let dir = unique_tmp_dir("purge-size");
        let chunk = 1024usize;
        let chunks_per_file = 64usize;
        let file_size = chunk * chunks_per_file;

        for idx in 0..30 {
            write_file_with_size(
                &dir.join(format!("mausvoice_{idx:02}.log")),
                file_size,
            );
            sleep(Duration::from_millis(2));
        }

        let initial_size = total_size(&dir);
        assert!(initial_size > MAX_LOG_DIR_SIZE);

        purge_old_logs_in(&dir);

        let final_size = total_size(&dir);
        assert!(
            final_size <= MAX_LOG_DIR_SIZE,
            "log dir size {final_size} exceeded cap {MAX_LOG_DIR_SIZE}"
        );
        assert!(count_files(&dir) >= MIN_KEEP_RECENT_FILES);
        fs::remove_dir_all(&dir).expect("failed to clean up");
    }

    #[test]
    fn purge_keeps_newest_files() {
        let dir = unique_tmp_dir("purge-newest");
        for idx in 0..15 {
            let path = dir.join(format!("mausvoice_{idx:02}.log"));
            write_file_with_size(&path, 1024);
            let mtime = SystemTime::now() + Duration::from_secs(idx as u64);
            let mtime_ft = filetime::FileTime::from_system_time(mtime);
            filetime::set_file_mtime(&path, mtime_ft).expect("failed to set mtime");
        }

        purge_old_logs_in(&dir);

        let survivors: Vec<String> = fs::read_dir(&dir)
            .expect("failed to read dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();

        for idx in 5..15 {
            let expected = format!("mausvoice_{idx:02}.log");
            assert!(
                survivors.contains(&expected),
                "expected newest file {expected} to survive purge, got {survivors:?}"
            );
        }
        fs::remove_dir_all(&dir).expect("failed to clean up");
    }
}
