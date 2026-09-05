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
    purge_old_logs_in_with_cap(logs_dir, MAX_LOG_DIR_SIZE);
}

fn purge_old_logs_in_with_cap(logs_dir: &Path, cap: u64) {
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
    if total_size <= cap {
        return;
    }

    // Oldest first, so deletion walks from the oldest file upward while
    // the directory stays over the cap. The final entry is the newest
    // file and is kept unconditionally: it is the active log the rotating
    // writer currently holds open (deleting it on Windows fails with a
    // sharing violation anyway). Trimming ignores the MIN_KEEP_RECENT_FILES
    // recency floor once over the cap, so a directory with few huge legacy
    // logs (the #468 case) still shrinks.
    files.sort_by_key(|(_, modified, _)| *modified);

    let mut removed = 0usize;
    let newest_idx = files.len() - 1;
    let mut running_total = total_size;

    for (idx, (path, _, size)) in files.iter().enumerate() {
        if idx == newest_idx {
            continue;
        }
        if running_total <= cap {
            break;
        }
        match fs::remove_file(path) {
            Ok(()) => {
                removed += 1;
                running_total -= size;
            }
            Err(err) => {
                log::warn!("Failed to purge old log file {}: {err}", path.display());
            }
        }
    }

    if removed > 0 {
        log::info!(
            "Purged {} old log file(s), log dir now at {} bytes",
            removed,
            running_total
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

    let mut log_content = String::default();
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
    use super::{purge_old_logs_in, purge_old_logs_in_with_cap, MIN_KEEP_RECENT_FILES};
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

        assert!(count_files(&dir) >= MIN_KEEP_RECENT_FILES);
        fs::remove_dir_all(&dir).expect("failed to clean up");
    }

    #[test]
    fn purge_enforces_total_size_cap() {
        let dir = unique_tmp_dir("purge-size");
        let chunk = 1024usize;
        let chunks_per_file = 64usize;
        let file_size = chunk * chunks_per_file;

        for idx in 0..30 {
            write_file_with_size(&dir.join(format!("mausvoice_{idx:02}.log")), file_size);
            sleep(Duration::from_millis(2));
        }

        let test_cap = (file_size as u64) * 15;
        let initial_size = total_size(&dir);
        assert!(initial_size > test_cap);

        purge_old_logs_in_with_cap(&dir, test_cap);

        let final_size = total_size(&dir);
        assert!(
            final_size <= test_cap,
            "log dir size {final_size} exceeded cap {test_cap}"
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

        // 15 KB of logs is well under the 250 MB cap, so we use a custom
        // cap of 8 KB to actually exercise the count trim path.
        purge_old_logs_in_with_cap(&dir, 8 * 1024);

        let survivors: Vec<String> = fs::read_dir(&dir)
            .expect("failed to read dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();

        assert!(
            survivors.iter().any(|n| n == "mausvoice_14.log"),
            "expected newest file to survive purge, got {survivors:?}"
        );
        assert!(
            survivors.iter().all(|n| n != "mausvoice_00.log"),
            "expected oldest file to be purged, got {survivors:?}"
        );
        // The recency floor only applies while under the cap; once the
        // directory is over it, the cap wins and the directory may drop
        // below MIN_KEEP_RECENT_FILES.
        assert!(
            total_size(&dir) <= 8 * 1024,
            "expected size to shrink to the cap, got {}",
            total_size(&dir)
        );
        fs::remove_dir_all(&dir).expect("failed to clean up");
    }

    // Regression test for #468: a directory holding few files but huge
    // legacy logs (the 63 GB case) must still shrink. The old recency
    // floor protected every file inside MIN_KEEP_RECENT_FILES, so a
    // <=10-file directory over the cap was never trimmed.
    #[test]
    fn purge_shrinks_small_dir_over_cap() {
        let dir = unique_tmp_dir("purge-small-dir-over-cap");
        for idx in 0..5 {
            let path = dir.join(format!("mausvoice_{idx:02}.log"));
            write_file_with_size(&path, 2048);
            let mtime = SystemTime::now() + Duration::from_secs(idx as u64);
            let mtime_ft = filetime::FileTime::from_system_time(mtime);
            filetime::set_file_mtime(&path, mtime_ft).expect("failed to set mtime");
        }

        purge_old_logs_in_with_cap(&dir, 4 * 1024);

        assert!(
            total_size(&dir) <= 4 * 1024,
            "expected dir to shrink to cap, got {}",
            total_size(&dir)
        );
        let survivors: Vec<String> = fs::read_dir(&dir)
            .expect("failed to read dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            survivors.iter().any(|n| n == "mausvoice_04.log"),
            "expected newest file to survive, got {survivors:?}"
        );
        fs::remove_dir_all(&dir).expect("failed to clean up");
    }

    // A single oversized file that is also the newest is left alone: it is
    // the active log the rotating writer holds open (deletion fails with a
    // sharing violation on Windows), and it ages out through normal
    // rotation.
    #[test]
    fn purge_single_newest_oversized_file_is_preserved() {
        let dir = unique_tmp_dir("purge-single-huge");
        write_file_with_size(&dir.join("mausvoice_huge.log"), 8 * 1024);

        purge_old_logs_in_with_cap(&dir, 4 * 1024);

        assert_eq!(count_files(&dir), 1);
        assert_eq!(total_size(&dir), 8 * 1024);
        fs::remove_dir_all(&dir).expect("failed to clean up");
    }
}
