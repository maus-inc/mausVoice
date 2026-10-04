use std::fs;
use std::io::Write;
use std::path::Path;

/// Maximum total size (in bytes) the log directory is allowed to occupy
/// before `purge_old_logs` starts deleting the oldest files. The file-level
/// rotation in `app.rs` already keeps the active file under
/// `MAX_LOG_FILE_SIZE`; this cap is a backstop for the historical files
/// (250 MB ≈ 10 × 25 MB).
pub const MAX_LOG_DIR_SIZE: u64 = 250 * 1024 * 1024;

/// Name prefix the rotating writer gives its log files (`app.rs`), used to tell
/// the writer's own files from anything else that shares the log directory.
const ACTIVE_LOG_NAME_PREFIX: &str = "mausvoice_";

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

/// One regular file in the log directory, carrying the two fields purging needs
/// to order the directory and to tell the active log from its rotated history.
struct LogFile {
    path: std::path::PathBuf,
    modified: std::time::SystemTime,
    name: std::ffi::OsString,
    size: u64,
}

fn purge_old_logs_in_with_cap(logs_dir: &Path, cap: u64) {
    let mut files: Vec<LogFile> = match fs::read_dir(logs_dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file())
            .filter_map(|e| {
                let metadata = e.metadata().ok()?;
                let modified = metadata.modified().ok()?;
                let size = metadata.len();
                let name = e.file_name();
                Some(LogFile {
                    path: e.path(),
                    modified,
                    name,
                    size,
                })
            })
            .collect(),
        Err(err) => {
            log::error!("Failed to read logs dir for purge: {err}");
            return;
        }
    };

    let total_size: u64 = files.iter().map(|file| file.size).sum();
    if total_size <= cap {
        return;
    }

    // Oldest first, so deletion walks from the oldest file upward while the
    // directory stays over the cap. There is no recency floor: a directory
    // holding few huge legacy logs (the #468 case) still has to shrink, so once
    // the cap is exceeded it wins over keeping recent files, and trimming stops
    // the moment the cap is met rather than deleting more than it must.
    // Ties on mtime break on the file name so the order never depends on the
    // order `read_dir` happened to return.
    files.sort_by(|a, b| {
        a.modified
            .cmp(&b.modified)
            .then_with(|| a.name.cmp(&b.name))
    });

    // Exactly one file is exempt: the active log the rotating writer holds
    // open. Deleting it fails with a sharing violation on Windows, and on Unix
    // it unlinks the file that is still being appended to, so those writes go
    // nowhere. It is identified by NAME rather than by its mtime value, and
    // only among the rotating writer's own files. Log file names are
    // `mausvoice_%Y-%m-%d_%H%M%S` (`app.rs`), a zero-padded second-resolution
    // stamp, so the newest `mausvoice_` file by name is the one just created
    // and therefore the active one.
    //
    // Neither half of that is optional. Keying on the mtime value instead would
    // exempt every file sharing the newest mtime, which is what a rotation burst
    // inside a single second produces on a volume with coarse timestamps (FAT32
    // or exFAT, so a USB stick or an external macOS volume): the directory could
    // then never shrink, because the files that had to go were all exempt. And
    // taking the newest by name over *every* file in the directory is wrong in
    // the other direction, because this directory is not the writer's alone —
    // `startup_diagnostics.log` lands here too, and `s` sorts after every `m`,
    // so a tie with the live log hands the exemption to the diagnostics file and
    // unlinks the log that is still open. Any stray file with a newer mtime
    // (a crash dump, a `.DS_Store`) wins it outright.
    let active_log = files
        .iter()
        .filter(|file| {
            file.name
                .to_string_lossy()
                .starts_with(ACTIVE_LOG_NAME_PREFIX)
        })
        .map(|file| &file.name)
        .max()
        .cloned();
    // No rotating log present, so nothing is held open and nothing is exempt:
    // the cap still has to be enforceable.
    let is_active = |file: &LogFile| Some(&file.name) == active_log.as_ref();

    let mut removed = 0usize;
    let mut running_total = total_size;

    for file in &files {
        if running_total <= cap {
            break;
        }
        if is_active(file) {
            continue;
        }
        match fs::remove_file(&file.path) {
            Ok(()) => {
                removed += 1;
                running_total -= file.size;
            }
            Err(err) => {
                log::warn!(
                    "Failed to purge old log file {}: {err}",
                    file.path.display()
                );
            }
        }
    }

    if removed > 0 {
        log::info!("Purged {removed} old log file(s), log dir now at {running_total} bytes");
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
    log_content.push_str(&format!("Timestamp: {timestamp}\n"));
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
            log_content.push_str(&format!("Hostname: {hostname_str}\n"));
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
    use super::{purge_old_logs_in, purge_old_logs_in_with_cap};
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
        // Exactly the 15 oldest files are deleted: 30 files of 65_536 are
        // 1_966_080 bytes against a cap of 983_040, and trimming stops the
        // moment the cap is met. Written as a literal so it pins how much is
        // purged rather than merely that something was.
        assert_eq!(
            count_files(&dir),
            15,
            "expected exactly the 15 oldest files to be purged"
        );
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
        // There is no recency floor: the cap wins outright, so the directory
        // may shrink to just the active log.
        assert!(
            total_size(&dir) <= 8 * 1024,
            "expected size to shrink to the cap, got {}",
            total_size(&dir)
        );
        fs::remove_dir_all(&dir).expect("failed to clean up");
    }

    // Regression test for #468: a directory holding few files but huge
    // legacy logs (the 63 GB case) must still shrink. An earlier recency
    // floor protected the 10 newest files, so a directory of 10 files or
    // fewer that was over the cap was never trimmed at all.
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

    // A rotation burst inside one second leaves several log files sharing an
    // mtime on a volume with coarse timestamps (FAT32, exFAT). Every one of
    // them is NOT the active log: the name carries a second-resolution stamp,
    // so only the newest file by name is the one the writer holds open. Pinning
    // the whole tied group, as an mtime comparison does, leaves the directory
    // unable to shrink however far over the cap it is — the files that had to
    // go were all exempt.
    #[test]
    fn purge_pins_only_the_newest_named_file_among_files_sharing_the_newest_mtime() {
        let dir = unique_tmp_dir("purge-newest-tie");
        let now = SystemTime::now();
        let old = filetime::FileTime::from_system_time(now - Duration::from_secs(60));
        let newest = filetime::FileTime::from_system_time(now - Duration::from_secs(1));

        for (name, mtime) in [
            ("mausvoice_2026-01-01_110000.log", old),
            ("mausvoice_2026-01-01_110100.log", old),
            ("mausvoice_2026-01-01_115900.log", newest),
            ("mausvoice_2026-01-01_120000.log", newest),
        ] {
            let path = dir.join(name);
            write_file_with_size(&path, 2048);
            filetime::set_file_mtime(&path, mtime).expect("failed to set mtime");
        }

        // A quarter of the directory, so the cap cannot be met without purging
        // from inside the tied group.
        purge_old_logs_in_with_cap(&dir, 1024);

        let survivors: Vec<String> = fs::read_dir(&dir)
            .expect("failed to read dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            survivors
                .iter()
                .any(|n| n == "mausvoice_2026-01-01_120000.log"),
            "the newest file by name shares the newest mtime and must survive, got {survivors:?}",
        );
        assert!(
            survivors
                .iter()
                .all(|n| n != "mausvoice_2026-01-01_115900.log"),
            "only the newest file by name may be exempt, so 115900 must be purgeable, got {survivors:?}",
        );
        assert!(
            survivors
                .iter()
                .all(|n| n != "mausvoice_2026-01-01_110000.log")
                && survivors
                    .iter()
                    .all(|n| n != "mausvoice_2026-01-01_110100.log"),
            "expected both older files to be purged, got {survivors:?}",
        );
        // The active log alone is left: 4 x 2048 is 8192 and the cap is 1024,
        // so only exempting one file can get within a factor of two of it.
        assert_eq!(
            count_files(&dir),
            1,
            "expected only the active log to survive, got {survivors:?}"
        );
        fs::remove_dir_all(&dir).expect("failed to clean up");
    }

    // `startup_diagnostics.log` is written into this same directory
    // (`system/paths.rs`), and `s` sorts after every `m`. Exempting "the newest
    // file by (mtime, name)" therefore exempts the diagnostics file instead of
    // the log the rotating writer holds open whenever their mtimes tie — which
    // is what a fast restart produces on the coarse-timestamp volumes the mtime
    // ordering exists for — and the loop then unlinks the live log. The same
    // hole hands the exemption to any stray file with a newer mtime.
    #[test]
    fn the_exempt_file_is_the_newest_named_log_not_merely_the_newest_file() {
        let now = SystemTime::now();
        let log_mtime = filetime::FileTime::from_system_time(now - Duration::from_secs(1));
        // Both shapes that beat a mtime-first ordering: an exact tie broken on
        // the name, and a stray file that is simply newer.
        let stray_mtimes = [
            ("tied with the log", log_mtime),
            (
                "newer than the log",
                filetime::FileTime::from_system_time(now),
            ),
        ];

        for (label, stray_mtime) in stray_mtimes {
            let dir = unique_tmp_dir("purge-stray-exempt");
            let active_log = dir.join("mausvoice_2026-01-01_120000.log");
            let stray = dir.join("startup_diagnostics.log");
            write_file_with_size(&active_log, 2048);
            write_file_with_size(&stray, 2048);
            filetime::set_file_mtime(&active_log, log_mtime).expect("failed to set mtime");
            filetime::set_file_mtime(&stray, stray_mtime).expect("failed to set mtime");

            // Over the cap, so which file is exempt decides which one survives.
            purge_old_logs_in_with_cap(&dir, 1024);

            let survivors: Vec<String> = fs::read_dir(&dir)
                .expect("failed to read dir")
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            assert!(
                active_log.exists(),
                "the rotating log the writer holds open was purged with a stray file \
                 {label}: {survivors:?}"
            );
            assert!(
                !stray.exists(),
                "a non-log file must never hold the active-log exemption: {survivors:?}"
            );
            fs::remove_dir_all(&dir).expect("failed to clean up");
        }
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
