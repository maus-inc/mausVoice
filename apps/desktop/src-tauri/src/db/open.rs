use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha384};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

use super::migrations;

/// SHA-384 of the migration SQL, matching sqlx / tauri-plugin-sql.
pub fn migration_checksum(sql: &str) -> Vec<u8> {
    Sha384::digest(sql.as_bytes()).to_vec()
}

#[derive(Debug)]
enum OpenError {
    Integrity(String),
    Other(String),
}

impl OpenError {
    fn message(&self) -> &str {
        match self {
            Self::Integrity(message) | Self::Other(message) => message,
        }
    }
}

pub fn is_integrity_failure(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("previously applied but has been modified")
        || normalized.contains("previously failed; database needs recovery")
        || normalized.contains("database disk image is malformed")
        || normalized.contains("file is not a database")
        || normalized.contains("sqlite_corrupt")
        || normalized.contains("sqlite_notadb")
        || normalized.contains("not a database")
}

fn classify_sqlx(context: &str, err: impl std::fmt::Display) -> OpenError {
    let detail = err.to_string();
    let message = format!("{context}: {detail}");
    if is_integrity_failure(&detail) || is_integrity_failure(&message) {
        OpenError::Integrity(message)
    } else {
        OpenError::Other(message)
    }
}

fn sqlite_connect_options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path.to_path_buf())
        .create_if_missing(true)
        .foreign_keys(true)
}

pub fn quarantine_sqlite_file(path: &Path) -> std::io::Result<PathBuf> {
    let parent = path.parent().unwrap_or(path);
    let mut stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = loop {
        let candidate = parent.join(format!("mausvoice.broken-{stamp}"));
        match std::fs::create_dir(&candidate) {
            Ok(()) => break candidate,
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                stamp = stamp.saturating_add(1);
            }
            Err(err) => return Err(err),
        }
    };
    let dest = dir.join("mausvoice.db");
    if path.exists() {
        std::fs::rename(path, &dest)?;
    }
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        for suffix in ["-wal", "-shm"] {
            let side = path.with_file_name(format!("{name}{suffix}"));
            if side.exists() {
                std::fs::rename(&side, dir.join(format!("mausvoice.db{suffix}")))?;
            }
        }
    }
    Ok(dest)
}

async fn connect_pool(path: &Path) -> Result<SqlitePool, OpenError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| OpenError::Other(err.to_string()))?;
    }
    SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(sqlite_connect_options(path))
        .await
        .map_err(|err| classify_sqlx("connect", err))
}

async fn apply_migrations(pool: &SqlitePool) -> Result<(), OpenError> {
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
    .execute(pool)
    .await
    .map_err(|err| classify_sqlx("create _sqlx_migrations", err))?;

    let failed: Option<i64> = sqlx::query_scalar(
        "SELECT version FROM _sqlx_migrations WHERE success = false ORDER BY version LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|err| classify_sqlx("read failed migrations", err))?;
    if let Some(version) = failed {
        return Err(OpenError::Integrity(format!(
            "migration {version} previously failed; database needs recovery"
        )));
    }

    let applied = sqlx::query("SELECT version, checksum FROM _sqlx_migrations ORDER BY version")
        .fetch_all(pool)
        .await
        .map_err(|err| classify_sqlx("read applied migrations", err))?;

    let mut applied_checksums = std::collections::HashMap::new();
    for row in applied {
        let version: i64 = row.get("version");
        let checksum: Vec<u8> = row.get("checksum");
        applied_checksums.insert(version, checksum);
    }

    let configured: std::collections::HashSet<i64> = migrations()
        .into_iter()
        .filter(|migration| matches!(migration.kind, tauri_plugin_sql::MigrationKind::Up))
        .map(|migration| migration.version)
        .collect();
    for version in applied_checksums.keys() {
        if !configured.contains(version) {
            return Err(OpenError::Integrity(format!(
                "migration {version} is recorded but is not in the current migration set"
            )));
        }
    }

    for migration in migrations() {
        if !matches!(migration.kind, tauri_plugin_sql::MigrationKind::Up) {
            continue;
        }
        let version = migration.version;
        let expected = migration_checksum(migration.sql);
        if let Some(stored) = applied_checksums.get(&version) {
            if stored.as_slice() != expected.as_slice() {
                return Err(OpenError::Integrity(format!(
                    "migration {version} ({}) was previously applied but has been modified",
                    migration.description
                )));
            }
            continue;
        }

        let started = std::time::Instant::now();
        let mut transaction = pool
            .begin()
            .await
            .map_err(|err| classify_sqlx("begin migration transaction", err))?;
        if let Err(err) = sqlx::raw_sql(migration.sql)
            .execute(&mut *transaction)
            .await
        {
            let classified = classify_sqlx(&format!("migration {version}"), err);
            if let Err(rollback_err) = transaction.rollback().await {
                return Err(OpenError::Other(format!(
                    "{}; rollback failed: {rollback_err}",
                    classified.message()
                )));
            }
            return Err(classified);
        }
        let execution_time = i64::try_from(started.elapsed().as_nanos()).unwrap_or(i64::MAX);
        sqlx::query(
            "INSERT INTO _sqlx_migrations
             (version, description, success, checksum, execution_time)
             VALUES (?1, ?2, true, ?3, ?4)",
        )
        .bind(version)
        .bind(migration.description)
        .bind(&expected)
        .bind(execution_time)
        .execute(&mut *transaction)
        .await
        .map_err(|err| classify_sqlx("record migration", err))?;
        transaction
            .commit()
            .await
            .map_err(|err| classify_sqlx("commit migration", err))?;
    }

    Ok(())
}

/// Open the app database, applying migrations. Integrity failures (checksum
/// mismatch, a half-applied migration, or a corrupt file) quarantine the
/// broken file and open a fresh database. Transient errors such as a lock,
/// a permission failure, or a buggy new migration are returned as-is.
pub async fn open_app_database(path: &Path) -> Result<SqlitePool, String> {
    match try_open(path).await {
        Ok(pool) => Ok(pool),
        Err(OpenError::Other(message)) => Err(message),
        Err(OpenError::Integrity(first_error)) => {
            log::error!(
                "Database at {} is unusable ({first_error}); quarantining and opening a fresh file",
                path.display()
            );
            match quarantine_sqlite_file(path) {
                Ok(backup) => log::warn!("Moved broken database to {}", backup.display()),
                Err(err) => {
                    return Err(format!(
                        "failed to quarantine broken database after {first_error}: {err}"
                    ));
                }
            }
            try_open(path).await.map_err(|retry_error| {
                format!(
                    "database recovery failed after {first_error}; retry error: {}",
                    retry_error.message()
                )
            })
        }
    }
}

async fn try_open(path: &Path) -> Result<SqlitePool, OpenError> {
    let pool = connect_pool(path).await?;
    if let Err(err) = apply_migrations(&pool).await {
        pool.close().await;
        return Err(err);
    }
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDb {
        dir: PathBuf,
        path: PathBuf,
    }

    impl TempDb {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "mausvoice-open-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self {
                path: dir.join("mausvoice.db"),
                dir,
            }
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn checksum_matches_sqlx_sha384_vector() {
        // Independent SHA-384 of b"SELECT 1;" (same digest sqlx stores).
        let expected = hex_literal(
            "26e71cc37450b183fb5bb72ec4f644ed27de1b55fad3d4d6cfb0ca0d71f42ca990911d74649814105a190325e15d2092",
        );
        assert_eq!(migration_checksum("SELECT 1;"), expected);
        assert_ne!(migration_checksum("SELECT 2;"), expected);
    }

    fn hex_literal(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn integrity_classifier_does_not_treat_locks_as_corruption() {
        assert!(is_integrity_failure(
            "migration 1 (create_users_table) was previously applied but has been modified"
        ));
        assert!(is_integrity_failure("database disk image is malformed"));
        assert!(!is_integrity_failure("database is locked"));
        assert!(!is_integrity_failure("migration 77 failed: syntax error"));
    }

    #[test]
    fn quarantine_renames_db_and_sidecars() {
        let temp = TempDb::new();
        let path = &temp.path;
        std::fs::write(path, b"broken").unwrap();
        let wal = path.with_file_name("mausvoice.db-wal");
        std::fs::write(&wal, b"wal").unwrap();
        let dest = quarantine_sqlite_file(path).unwrap();
        assert!(!path.exists());
        assert!(!wal.exists());
        assert!(dest.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"broken");
        assert_eq!(
            std::fs::read(dest.with_file_name("mausvoice.db-wal")).unwrap(),
            b"wal"
        );
        assert!(dest
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("mausvoice.broken-"));
    }

    #[tokio::test]
    async fn unknown_recorded_migration_version_is_an_integrity_failure() {
        let temp = TempDb::new();
        let path = &temp.path;
        let pool = try_open(path).await.expect("initial migrate");
        sqlx::query(
            "INSERT INTO _sqlx_migrations
             (version, description, success, checksum, execution_time)
             VALUES (9999, 'ghost', true, x'deadbeef', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let recovered = open_app_database(path)
            .await
            .expect("unknown history should quarantine and reopen");
        let ghost: Option<i64> = sqlx::query_scalar(
            "SELECT version FROM _sqlx_migrations WHERE version = 9999",
        )
        .fetch_optional(&recovered)
        .await
        .unwrap();
        assert!(ghost.is_none());
        recovered.close().await;
    }

    #[tokio::test]
    async fn checksum_mismatch_is_recovered_with_a_fresh_database() {
        let temp = TempDb::new();
        let path = &temp.path;
        let pool = try_open(path).await.expect("initial migrate");
        sqlx::query("UPDATE _sqlx_migrations SET checksum = x'deadbeef' WHERE version = 1")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        let recovered = open_app_database(path)
            .await
            .expect("recovery should open a fresh database");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&recovered)
            .await
            .unwrap();
        assert_eq!(count, migrations().len() as i64);
        recovered.close().await;
        assert!(
            std::fs::read_dir(&temp.dir)
                .unwrap()
                .flatten()
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("mausvoice.broken-"))
        );
    }

    #[tokio::test]
    async fn non_integrity_errors_do_not_quarantine() {
        let temp = TempDb::new();
        // A non-integrity failure: pass a directory as the database path.
        let dir_as_db = temp.dir.join("not-a-file");
        std::fs::create_dir_all(&dir_as_db).unwrap();
        let result = open_app_database(&dir_as_db).await;
        assert!(result.is_err());
        assert!(
            std::fs::read_dir(&temp.dir)
                .unwrap()
                .flatten()
                .all(|entry| !entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("mausvoice.broken-"))
        );
    }
}
