use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha384};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

use super::migrations;

/// SHA-384 of the migration SQL, matching sqlx / tauri-plugin-sql.
/// Canonicalizes CRLF to LF so checkout line endings do not alter the checksum.
pub fn migration_checksum(sql: &str) -> Vec<u8> {
    let normalized = sql.replace("\r\n", "\n");
    Sha384::digest(normalized.as_bytes()).to_vec()
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
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true)
}

const SQLITE_SIDECARS: &[&str] = &["-journal", "-wal", "-shm"];

fn rename_all_or_restore(moves: &[(PathBuf, PathBuf)]) -> std::io::Result<()> {
    let mut completed = Vec::new();
    for (from, to) in moves {
        if let Err(err) = std::fs::rename(from, to) {
            for (done_from, done_to) in completed.into_iter().rev() {
                let _ = std::fs::rename(done_to, done_from);
            }
            return Err(err);
        }
        completed.push((from, to));
    }
    Ok(())
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
    let mut moves = Vec::new();
    if path.exists() {
        moves.push((path.to_path_buf(), dest.clone()));
    }
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        for suffix in SQLITE_SIDECARS {
            let side = path.with_file_name(format!("{name}{suffix}"));
            if side.exists() {
                moves.push((side, dir.join(format!("mausvoice.db{suffix}"))));
            }
        }
    }
    if let Err(err) = rename_all_or_restore(&moves) {
        let _ = std::fs::remove_dir(&dir);
        return Err(err);
    }
    Ok(dest)
}

/// Remove every quarantined broken database backup created by `quarantine_sqlite_file`.
/// Invoked on an explicit user-directed privacy wipe (`clear_local_data`) so old
/// transcriptions, settings, and credentials do not linger in `mausvoice.broken-*`.
pub fn delete_quarantined_databases(parent_or_db: &Path) -> std::io::Result<usize> {
    let mut deleted = 0;
    let parent = if parent_or_db.is_file() {
        parent_or_db.parent().unwrap_or(parent_or_db)
    } else {
        parent_or_db
    };
    if !parent.is_dir() {
        return Ok(0);
    }
    for entry in std::fs::read_dir(parent)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with("mausvoice.broken-") {
            let path = entry.path();
            if path.is_dir() {
                std::fs::remove_dir_all(&path)?;
                deleted += 1;
            } else if path.is_file() {
                std::fs::remove_file(&path)?;
                deleted += 1;
            }
        }
    }
    Ok(deleted)
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

async fn retire_consolidated_migrations(
    connection: &mut sqlx::SqliteConnection,
    versions: &[i64],
) -> Result<(), sqlx::Error> {
    for version in versions {
        sqlx::query("DELETE FROM _sqlx_migrations WHERE version = ?1")
            .bind(version)
            .execute(&mut *connection)
            .await?;
    }
    Ok(())
}

/// Every migration version any ref in this repository used in the range 070 to
/// 088, all of which the 0.1.6 consolidation folded into this build's target
/// schema.
///
/// The numbers sit above the consolidation step (069) on purpose: the
/// individual steps were written and shipped first, and the consolidation was
/// numbered 069 afterwards, so "the steps between 069 and 089" is the numeric
/// description of this list. 089 arrived after the consolidation and is still
/// applied, so it is not retired. Intermediate builds recorded these steps
/// individually, so their ledger rows retire on open instead of being reported
/// as a downgrade.
///
/// This is an explicit list on purpose. The previous `71..=88` range also
/// retired 080 and 088, and no ref in this repository has ever used either
/// number, so a future legitimate `080_*.sql` or `088_*.sql` would have had its
/// ledger row hard-deleted instead of surfacing as a downgrade. Adding a
/// version here is now a deliberate edit and can never be a side effect of
/// widening a number.
///
/// The list is exactly what `git log --all --diff-filter=A --name-only` shows
/// for `src/db/migrations/`, which is a `NNN_*.sql` file for every entry here
/// and nothing for 070, 080 or 088. A ledger row for one of those three is
/// therefore never retired and still surfaces as a downgrade. The header of
/// `migrations/069_consolidated_v0_1_6_schema.sql` names the same 16 steps,
/// `expansion_flags` included, because that column arrived on the 075 step
/// rather than on a step of its own.
/// `consolidated_intermediate_migration_rows_are_retired` below exercises the
/// retirement path, and
/// `unretired_consolidation_era_numbers_surface_as_a_downgrade` covers the
/// three gaps.
const RETIRED_CONSOLIDATION_ERA_VERSIONS: &[i64] = &[
    71, 72, 73, 74, 75, 76, 77, 78, 79, 81, 82, 83, 84, 85, 86, 87,
];

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
    let mut retired: Vec<i64> = Vec::new();
    for version in applied_checksums.keys() {
        if !configured.contains(version) {
            // The individual migrations that the 0.1.6 release folded into the
            // single post-0.1.5 consolidation step (69). Databases written by
            // intermediate builds recorded those steps individually; that
            // schema is already part of this build's target, so those rows are
            // retired below instead of failing the open as a downgrade. Only
            // the versions a real build actually shipped are listed, so any
            // other unconfigured version keeps the strict behavior: a database
            // from a genuinely newer release must surface loudly, not be
            // rewritten underneath it.
            if RETIRED_CONSOLIDATION_ERA_VERSIONS.contains(version) {
                retired.push(*version);
                continue;
            }
            // A version recorded in `_sqlx_migrations` that this build does not
            // ship means the database was written by a newer release (a normal
            // downgrade/rollback). The file is perfectly readable, so this is
            // not corruption: classify it as `Other` so the failure is surfaced
            // to the user instead of `Integrity`, which would quarantine the
            // file and silently discard the user's transcriptions, keys and
            // preferences.
            return Err(OpenError::Other(format!(
                "migration {version} is recorded but is not in the current migration set; \
                 the database was likely created by a newer version of the app"
            )));
        }
    }
    retired.sort_unstable();
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
        }
    }

    for migration in migrations() {
        if !matches!(migration.kind, tauri_plugin_sql::MigrationKind::Up)
            || applied_checksums.contains_key(&migration.version)
        {
            continue;
        }
        let version = migration.version;
        let expected = migration_checksum(migration.sql);
        let started = std::time::Instant::now();
        let mut transaction = pool
            .begin()
            .await
            .map_err(|err| classify_sqlx("begin migration transaction", err))?;
        let result = async {
            if version == 69 {
                super::consolidation::apply(&mut transaction).await?;
                retire_consolidated_migrations(&mut transaction, &retired).await?;
            } else {
                sqlx::raw_sql(migration.sql)
                    .execute(&mut *transaction)
                    .await?;
            }
            Ok::<(), sqlx::Error>(())
        }
        .await;
        if let Err(err) = result {
            let classified = classify_sqlx(&format!("migration {version}"), err);
            if let Err(rollback_err) = transaction.rollback().await {
                let message = format!("{}; rollback failed: {rollback_err}", classified.message());
                return Err(match classified {
                    OpenError::Integrity(_) => OpenError::Integrity(message),
                    OpenError::Other(_) => OpenError::Other(message),
                });
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
        if version == 69 {
            retired.clear();
        }
    }

    // Already-consolidated profiles may retain old ledger rows. Validate every
    // known checksum above before changing even these redundant records.
    if !retired.is_empty() {
        let mut transaction = pool
            .begin()
            .await
            .map_err(|err| classify_sqlx("begin retirement transaction", err))?;
        retire_consolidated_migrations(&mut transaction, &retired)
            .await
            .map_err(|err| classify_sqlx("retire consolidated migrations", err))?;
        transaction
            .commit()
            .await
            .map_err(|err| classify_sqlx("commit retirement transaction", err))?;
    }

    Ok(())
}

/// Open the app database, applying migrations. Integrity failures (checksum
/// mismatch, a half-applied migration, or a corrupt file) quarantine the
/// broken file and open a fresh database. Transient errors such as a lock or
/// a permission failure, a buggy new migration, and a database written by a
/// newer version of the app are returned as-is, leaving the file untouched.
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
        let journal = path.with_file_name("mausvoice.db-journal");
        let wal = path.with_file_name("mausvoice.db-wal");
        std::fs::write(&journal, b"journal").unwrap();
        std::fs::write(&wal, b"wal").unwrap();
        let dest = quarantine_sqlite_file(path).unwrap();
        assert!(!path.exists());
        assert!(!journal.exists());
        assert!(!wal.exists());
        assert!(dest.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"broken");
        assert_eq!(
            std::fs::read(dest.with_file_name("mausvoice.db-journal")).unwrap(),
            b"journal"
        );
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

    #[test]
    fn delete_quarantined_databases_removes_broken_directories_and_files() {
        let temp = TempDb::new();
        let broken_dir = temp.dir.join("mausvoice.broken-12345");
        let broken_file = temp.dir.join("mausvoice.broken-67890.bak");
        let untouched_db = temp.dir.join("mausvoice.db");
        std::fs::create_dir(&broken_dir).unwrap();
        std::fs::write(broken_dir.join("mausvoice.db"), b"broken").unwrap();
        std::fs::write(&broken_file, b"broken").unwrap();
        std::fs::write(&untouched_db, b"keep").unwrap();

        let removed = delete_quarantined_databases(&temp.dir).unwrap();
        assert_eq!(removed, 2);
        assert!(!broken_dir.exists());
        assert!(!broken_file.exists());
        assert!(untouched_db.exists());
    }

    #[test]
    fn quarantine_restores_moved_files_if_a_sidecar_rename_fails() {
        let temp = TempDb::new();
        let path = &temp.path;
        std::fs::write(path, b"db").unwrap();
        let journal = path.with_file_name("mausvoice.db-journal");
        std::fs::write(&journal, b"journal").unwrap();
        let dest_dir = temp.dir.join("dest");
        std::fs::create_dir(&dest_dir).unwrap();
        std::fs::create_dir(dest_dir.join("mausvoice.db-journal")).unwrap();
        rename_all_or_restore(&[
            (path.clone(), dest_dir.join("mausvoice.db")),
            (journal.clone(), dest_dir.join("mausvoice.db-journal")),
        ])
        .unwrap_err();
        assert!(path.exists());
        assert!(journal.exists());
        assert_eq!(std::fs::read(path).unwrap(), b"db");
        assert_eq!(std::fs::read(&journal).unwrap(), b"journal");
    }

    #[tokio::test]
    async fn corrupt_sqlite_file_is_quarantined_and_reopened() {
        let temp = TempDb::new();
        std::fs::write(&temp.path, b"this is not a sqlite database").unwrap();

        let recovered = open_app_database(&temp.path)
            .await
            .expect("corrupt bytes should quarantine and reopen");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&recovered)
            .await
            .unwrap();
        assert_eq!(count, migrations().len() as i64);
        recovered.close().await;
        assert!(std::fs::read_dir(&temp.dir)
            .unwrap()
            .flatten()
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("mausvoice.broken-")));
    }

    #[tokio::test]
    async fn unknown_recorded_migration_version_is_surfaced_not_quarantined() {
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

        // A version this build does not ship (a newer release wrote it) is a
        // forward-compatible downgrade, not corruption: the open must fail
        // loudly but leave the user's database file untouched.
        let result = open_app_database(path).await;
        assert!(
            result.is_err(),
            "newer-schema database must be surfaced, not silently opened"
        );
        assert!(
            std::fs::read_dir(&temp.dir)
                .unwrap()
                .flatten()
                .all(|entry| !entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("mausvoice.broken-")),
            "a newer-schema database must never be quarantined"
        );
        assert!(path.exists(), "the original database must be preserved");
    }

    #[tokio::test]
    async fn existing_database_is_upgraded_to_head_without_quarantine() {
        let temp = TempDb::new();
        let path = &temp.path;
        let up_migrations: Vec<_> = migrations()
            .into_iter()
            .filter(|migration| matches!(migration.kind, tauri_plugin_sql::MigrationKind::Up))
            .collect();
        assert!(
            up_migrations.len() >= 2,
            "test needs at least two migrations"
        );

        // Reproduce the state every existing user's database is in before an
        // upgrade: all but the newest migration applied, with each recorded in
        // `_sqlx_migrations` exactly as the previous (tauri-plugin-sql) migrator
        // wrote them.
        {
            let pool = connect_pool(path).await.expect("connect");
            sqlx::query(
                "CREATE TABLE _sqlx_migrations (
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
            .expect("create _sqlx_migrations");
            for migration in &up_migrations[..up_migrations.len() - 1] {
                let checksum = migration_checksum(migration.sql);
                sqlx::raw_sql(migration.sql)
                    .execute(&pool)
                    .await
                    .expect("apply prior migration");
                sqlx::query(
                    "INSERT INTO _sqlx_migrations
                     (version, description, success, checksum, execution_time)
                     VALUES (?1, ?2, true, ?3, 0)",
                )
                .bind(migration.version)
                .bind(migration.description)
                .bind(&checksum)
                .execute(&pool)
                .await
                .expect("record prior migration");
            }
            pool.close().await;
        }

        let upgraded = open_app_database(path)
            .await
            .expect("an existing database must upgrade, not fail");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&upgraded)
            .await
            .unwrap();
        assert_eq!(
            count,
            up_migrations.len() as i64,
            "the remaining migration must be applied on upgrade"
        );
        upgraded.close().await;
        assert!(
            std::fs::read_dir(&temp.dir)
                .unwrap()
                .flatten()
                .all(|entry| !entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("mausvoice.broken-")),
            "a routine upgrade must never quarantine the database"
        );
    }

    #[tokio::test]
    async fn multiple_unknown_recorded_migration_versions_preserve_the_database() {
        let temp = TempDb::new();
        let path = &temp.path;
        let pool = try_open(path).await.expect("initial migrate");
        // The recorded set must be a realistic mix: shipped versions, plus
        // two newer-release versions interleaved with the existing applied
        // set. Iteration order over the applied HashMap is non-deterministic,
        // so this test exercises every position the unknown rows can land in.
        sqlx::query(
            "INSERT INTO _sqlx_migrations
             (version, description, success, checksum, execution_time)
             VALUES (9998, 'future_a', true, x'deadbeef', 0),
                    (9999, 'future_b', true, x'feedface', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let result = open_app_database(path).await;
        assert!(
            result.is_err(),
            "a database with newer-release migrations must be surfaced, not silently opened"
        );
        assert!(
            std::fs::read_dir(&temp.dir)
                .unwrap()
                .flatten()
                .all(|entry| !entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("mausvoice.broken-")),
            "a downgrade with multiple newer versions must never quarantine the database"
        );
        assert!(
            path.exists(),
            "the original database must be preserved regardless of how many newer versions are present"
        );
    }

    #[test]
    fn migration_checksum_is_stable_across_lf_and_crlf() {
        let lf_sql = "CREATE TABLE test (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL\n);\n";
        let crlf_sql =
            "CREATE TABLE test (\r\n  id INTEGER PRIMARY KEY,\r\n  name TEXT NOT NULL\r\n);\r\n";
        let lf_hash = migration_checksum(lf_sql);
        let crlf_hash = migration_checksum(crlf_sql);
        assert_eq!(
            lf_hash, crlf_hash,
            "CRLF and LF must produce identical SHA-384 checksums"
        );
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
        assert!(std::fs::read_dir(&temp.dir)
            .unwrap()
            .flatten()
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("mausvoice.broken-")));
    }

    #[tokio::test]
    async fn delete_quarantined_databases_removes_all_broken_archives() {
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
            .expect("recovery creates broken archive");
        recovered.close().await;

        assert!(
            std::fs::read_dir(&temp.dir)
                .unwrap()
                .flatten()
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("mausvoice.broken-")),
            "broken archive must exist after recovery"
        );

        let removed =
            delete_quarantined_databases(&temp.dir).expect("quarantine deletion succeeds");
        assert!(
            removed >= 1,
            "must delete at least one quarantined directory"
        );

        assert!(
            std::fs::read_dir(&temp.dir)
                .unwrap()
                .flatten()
                .all(|entry| !entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("mausvoice.broken-")),
            "no broken archives should remain after explicit deletion"
        );
    }

    async fn pre_consolidation_pool(path: &Path) -> SqlitePool {
        let pool = connect_pool(path).await.expect("connect to fresh db");

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
        .unwrap();

        // Everything the 0.1.5 release shipped, applied and recorded exactly
        // as the previous migrator wrote it; only step 69 stays pending.
        for migration in migrations() {
            if migration.version >= 69 {
                continue;
            }
            sqlx::raw_sql(migration.sql)
                .execute(&pool)
                .await
                .expect("apply 0.1.5-era migration");
            let checksum = migration_checksum(migration.sql);
            sqlx::query(
                "INSERT INTO _sqlx_migrations
                 (version, description, success, checksum, execution_time)
                 VALUES (?1, ?2, 1, ?3, 0)",
            )
            .bind(migration.version)
            .bind(migration.description)
            .bind(&checksum)
            .execute(&pool)
            .await
            .unwrap();
        }

        pool
    }

    #[tokio::test]
    async fn migration_69_upgrades_legacy_1_5_x_db() {
        // Simulate a user upgrading from a 0.1.5 build (its last migration
        // was 68): apply and record every earlier migration for real, seed
        // era-typical rows, then open. The single consolidated step 69 must
        // rebuild the post-0.1.5 tables, preserve the rows, materialize the
        // new defaults, and drop the retired is_enterprise column.
        let temp = TempDb::new();
        let path = &temp.path;
        let pool = pre_consolidation_pool(path).await;

        // Era-typical rows that must survive the rebuild.
        sqlx::query(
            "INSERT INTO user_preferences (user_id, transcription_mode, is_enterprise)
             VALUES ('legacy-user', char(99, 108, 111, 117, 100), 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO transcriptions (id, transcript, timestamp)
             VALUES ('legacy', 'old', 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO user_profiles (id, name, bio)
             VALUES ('legacy-user', 'Legacy', '')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO api_keys (id, name, provider, created_at, salt, key_hash, key_ciphertext)
             VALUES ('k1', 'Key', 'openai', 1, 'salt', 'hash', 'cipher')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO tones (id, name, prompt_template, created_at)
             VALUES ('tone1', 'Casual', 'be casual', 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        // Reopen: the consolidated step 69 runs. A failing upgrade would fail
        // the try_open call below.
        let pool = try_open(path).await.expect("upgrade opens");

        // Step 69 recorded exactly once; the recorded set matches the build.
        let recorded: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM _sqlx_migrations WHERE version = 69 AND success = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(recorded, 1);
        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(total, migrations().len() as i64);

        // Cloud preference was rewritten and the row survived the rebuild;
        // consolidated columns arrived at their defaults.
        let prefs = sqlx::query(
            "SELECT transcription_mode, update_channel, expansion_flags,
                    pill_reset_monitor_strategy, spoken_commands_enabled
             FROM user_preferences WHERE user_id = 'legacy-user'",
        )
        .fetch_one(&pool)
        .await
        .expect("legacy preferences row survives");
        assert_eq!(
            prefs.try_get::<String, _>("transcription_mode").unwrap(),
            "local"
        );
        assert_eq!(
            prefs.try_get::<String, _>("update_channel").unwrap(),
            "stable"
        );
        assert_eq!(prefs.try_get::<String, _>("expansion_flags").unwrap(), "{}");
        assert_eq!(
            prefs
                .try_get::<String, _>("pill_reset_monitor_strategy")
                .unwrap(),
            "current"
        );
        assert!(prefs.try_get::<i64, _>("spoken_commands_enabled").unwrap() == 1);

        // is_enterprise is gone.
        let enterprise: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('user_preferences')
             WHERE name = 'is_enterprise'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(enterprise, 0);

        // Legacy transcription row survives; new columns exist as NULLs and
        // accept writes.
        let legacy = sqlx::query(
            "SELECT post_process_provider, post_process_failed, post_process_error
             FROM transcriptions WHERE id = 'legacy'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            legacy
                .try_get::<Option<String>, _>("post_process_provider")
                .unwrap(),
            None
        );
        assert_eq!(
            legacy
                .try_get::<Option<i64>, _>("post_process_failed")
                .unwrap(),
            None
        );
        sqlx::query(
            "INSERT INTO transcriptions
                (id, transcript, timestamp,
                 post_process_provider, post_process_failed, post_process_error, post_process_model)
             VALUES ('new', 'new', 2, 'cerebras', 1, '402 out of credit', 'whisper-large')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // interaction_feedback_volume materialized on the pre-upgrade profile.
        let volume = sqlx::query(
            "SELECT interaction_feedback_volume FROM user_profiles WHERE id = 'legacy-user'",
        )
        .fetch_one(&pool)
        .await
        .expect("legacy profile row survives")
        .try_get::<f64, _>("interaction_feedback_volume")
        .unwrap();
        let expected = f64::from(crate::domain::user::DEFAULT_INTERACTION_FEEDBACK_VOLUME);
        assert!(
            (volume - expected).abs() < 1e-6,
            "volume default {volume} != {expected}"
        );

        // api_keys.transcription_path and tones structured fields exist.
        let key_path_null: Option<String> =
            sqlx::query("SELECT transcription_path FROM api_keys WHERE id = 'k1'")
                .fetch_one(&pool)
                .await
                .unwrap()
                .try_get("transcription_path")
                .unwrap();
        assert_eq!(key_path_null, None);
        let tone = sqlx::query("SELECT category, name FROM tones WHERE id = 'tone1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(tone.try_get::<Option<String>, _>("category").unwrap(), None);
        assert_eq!(tone.try_get::<String, _>("name").unwrap(), "Casual");

        // Verify post-069 onboarded CHECK constraint: accepts 0 and 1, rejects invalid integers like 2.
        sqlx::query(
            "INSERT INTO user_profiles (id, name, bio, onboarded)
             VALUES ('valid-0', 'Valid Zero', '', 0)",
        )
        .execute(&pool)
        .await
        .expect("onboarded=0 accepted");

        sqlx::query(
            "INSERT INTO user_profiles (id, name, bio, onboarded)
             VALUES ('valid-1', 'Valid One', '', 1)",
        )
        .execute(&pool)
        .await
        .expect("onboarded=1 accepted");

        let reject_two = sqlx::query(
            "INSERT INTO user_profiles (id, name, bio, onboarded)
             VALUES ('invalid-2', 'Invalid Two', '', 2)",
        )
        .execute(&pool)
        .await;
        assert!(
            reject_two.is_err(),
            "CHECK (onboarded IN (0, 1)) must reject onboarded=2",
        );

        pool.close().await;
    }

    async fn intermediate_pool(path: &Path) -> SqlitePool {
        let pool = pre_consolidation_pool(path).await;
        sqlx::raw_sql(include_str!("fixtures/intermediate_profile.sql"))
            .execute(&pool)
            .await
            .expect("seed intermediate profile");
        pool
    }

    async fn profile_snapshots(pool: &SqlitePool) -> Vec<(String, Vec<String>)> {
        let mut snapshots = Vec::new();
        for table in [
            "user_preferences",
            "tones",
            "transcriptions",
            "user_profiles",
            "api_keys",
        ] {
            let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info(?1)")
                .bind(table)
                .fetch_all(pool)
                .await
                .unwrap();
            let fields = columns
                .iter()
                .filter(|column| {
                    // Consolidation intentionally removes enterprise state and
                    // rewrites these three cloud modes. Assert those separately.
                    table != "user_preferences"
                        || !matches!(
                            column.as_str(),
                            "is_enterprise"
                                | "transcription_mode"
                                | "post_processing_mode"
                                | "agent_mode"
                        )
                })
                .map(|column| {
                    format!(
                        "'{}', \"{}\"",
                        column.replace('\'', "''"),
                        column.replace('"', "\"\"")
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            let key = if table == "user_preferences" {
                "user_id"
            } else {
                "id"
            };
            let query = format!("SELECT json_object({fields}) FROM {table} ORDER BY {key}");
            let rows = sqlx::query_scalar(&query).fetch_all(pool).await.unwrap();
            snapshots.push((query, rows));
        }
        snapshots
    }

    async fn assert_profile_snapshots(pool: &SqlitePool, snapshots: &[(String, Vec<String>)]) {
        for (query, before) in snapshots {
            let after: Vec<String> = sqlx::query_scalar(query).fetch_all(pool).await.unwrap();
            assert_eq!(&after, before, "profile changed for {query}");
        }
    }

    #[tokio::test]
    async fn consolidation_preserves_intermediate_values_and_reopens() {
        let temp = TempDb::new();
        let pool = intermediate_pool(&temp.path).await;
        let snapshots = profile_snapshots(&pool).await;
        pool.close().await;

        let upgraded = open_app_database(&temp.path)
            .await
            .expect("upgrade intermediate profile");
        assert_profile_snapshots(&upgraded, &snapshots).await;
        let modes: (String, String, String) = sqlx::query_as(
            "SELECT transcription_mode, post_processing_mode, agent_mode
             FROM user_preferences WHERE user_id = 'intermediate-user'",
        )
        .fetch_one(&upgraded)
        .await
        .unwrap();
        assert_eq!(modes, ("local".into(), "none".into(), "none".into()));
        let retired: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE version IN (75, 87)")
                .fetch_one(&upgraded)
                .await
                .unwrap();
        assert_eq!(retired, 0);
        let checksum: Vec<u8> =
            sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = 69")
                .fetch_one(&upgraded)
                .await
                .unwrap();
        assert_eq!(
            checksum,
            migration_checksum(super::super::CONSOLIDATED_V0_1_6_MIGRATION_SQL)
        );
        upgraded.close().await;

        let reopened = open_app_database(&temp.path)
            .await
            .expect("reopen consolidated profile");
        assert_profile_snapshots(&reopened, &snapshots).await;
        reopened.close().await;
    }

    #[tokio::test]
    async fn consolidation_preserves_partial_intermediate_schema() {
        let temp = TempDb::new();
        let pool = pre_consolidation_pool(&temp.path).await;
        sqlx::raw_sql(
            "ALTER TABLE tones ADD COLUMN category TEXT;
            INSERT INTO tones (id, name, prompt_template, created_at, category)
            VALUES ('partial-style', 'Partial', 'Keep it', 1, 'Existing category');",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
        let upgraded = open_app_database(&temp.path)
            .await
            .expect("upgrade partial profile");
        let fields: (String, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT category, output_length, example_input_output FROM tones WHERE id = 'partial-style'",
        ).fetch_one(&upgraded).await.unwrap();
        assert_eq!(fields, ("Existing category".into(), None, None));
        upgraded.close().await;
    }

    #[tokio::test]
    async fn failed_consolidation_preserves_values_and_migration_records_for_retry() {
        let temp = TempDb::new();
        let pool = intermediate_pool(&temp.path).await;
        let snapshots = profile_snapshots(&pool).await;
        // Fail after rebuilding tables, while retiring the old migration rows.
        sqlx::raw_sql(
            "CREATE TRIGGER reject_retirement BEFORE DELETE ON _sqlx_migrations
            WHEN OLD.version = 87 BEGIN SELECT RAISE(ABORT, 'retirement blocked'); END;",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
        let error = open_app_database(&temp.path)
            .await
            .expect_err("retirement must fail");
        assert!(error.contains("retirement blocked"), "{error}");

        let original = connect_pool(&temp.path).await.unwrap();
        assert_profile_snapshots(&original, &snapshots).await;
        let versions: Vec<i64> = sqlx::query_scalar(
            "SELECT version FROM _sqlx_migrations WHERE version IN (69, 75, 87) ORDER BY version",
        )
        .fetch_all(&original)
        .await
        .unwrap();
        assert_eq!(versions, vec![75, 87]);
        let mode: String = sqlx::query_scalar(
            "SELECT transcription_mode FROM user_preferences WHERE user_id = 'intermediate-user'",
        )
        .fetch_one(&original)
        .await
        .unwrap();
        assert_eq!(mode, "cloud");
        sqlx::query("DROP TRIGGER reject_retirement")
            .execute(&original)
            .await
            .unwrap();
        original.close().await;

        let retried = open_app_database(&temp.path)
            .await
            .expect("retry consolidation");
        assert_profile_snapshots(&retried, &snapshots).await;
        retried.close().await;
    }

    #[tokio::test]
    async fn checksum_failure_does_not_retire_intermediate_records() {
        let temp = TempDb::new();
        let pool = intermediate_pool(&temp.path).await;
        sqlx::query("UPDATE _sqlx_migrations SET checksum = x'badbad' WHERE version = 1")
            .execute(&pool)
            .await
            .unwrap();
        let error = apply_migrations(&pool).await.expect_err("invalid checksum");
        assert!(matches!(error, OpenError::Integrity(_)));
        let versions: Vec<i64> = sqlx::query_scalar(
            "SELECT version FROM _sqlx_migrations WHERE version IN (69, 75, 87) ORDER BY version",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(versions, vec![75, 87]);
        pool.close().await;
    }

    #[tokio::test]
    async fn consolidated_intermediate_migration_rows_are_retired() {
        // Databases written by intermediate builds recorded the individual
        // migrations (71-87) that the 0.1.6 release folded into step 69.
        // Those rows must retire silently on open — not surface as a
        // downgrade and not quarantine the file.
        let temp = TempDb::new();
        let path = &temp.path;
        let pool = try_open(path).await.expect("initial migrate");
        sqlx::query(
            "INSERT INTO _sqlx_migrations
             (version, description, success, checksum, execution_time)
             VALUES (75, 'add_tone_structured_fields', true, x'deadbeef', 0),
                    (87, 'add_eleven_labs_keyterms_enabled', true, x'feedface', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let reopened = open_app_database(path)
            .await
            .expect("intermediate rows retire cleanly");
        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&reopened)
            .await
            .unwrap();
        assert_eq!(total, migrations().len() as i64, "retired rows are gone");
        let ghosts: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE version IN (75, 87)")
                .fetch_one(&reopened)
                .await
                .unwrap();
        assert_eq!(ghosts, 0);
        reopened.close().await;
        assert!(
            std::fs::read_dir(&temp.dir)
                .unwrap()
                .flatten()
                .all(|entry| !entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("mausvoice.broken-")),
            "retiring consolidation-era rows must never quarantine the database"
        );
    }

    #[tokio::test]
    async fn unretired_consolidation_era_numbers_surface_as_a_downgrade() {
        // 070, 080 and 088 are the three numbers in the 070 to 088 range that
        // no ref in this repository ever used. A ledger row for one of them is
        // not a folded consolidation step, so it must be surfaced and left in
        // place. Hard-deleting it would hide a database written by a release
        // this build knows nothing about, which is what widening the retired
        // list back to a range would do.
        for version in [70_i64, 80, 88] {
            let temp = TempDb::new();
            let path = &temp.path;
            let pool = try_open(path).await.expect("initial migrate");
            sqlx::query(
                "INSERT INTO _sqlx_migrations
                 (version, description, success, checksum, execution_time)
                 VALUES (?1, 'never_shipped', true, x'deadbeef', 0)",
            )
            .bind(version)
            .execute(&pool)
            .await
            .unwrap();
            pool.close().await;

            let error = open_app_database(path)
                .await
                .expect_err("an unused version must not open silently");
            assert!(
                error.contains(&format!("migration {version} is recorded"))
                    && error.contains("not in the current migration set"),
                "version {version} must surface as a downgrade, got: {error}"
            );

            let check = connect_pool(path).await.expect("reconnect");
            let survivors: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE version = ?1")
                    .bind(version)
                    .fetch_one(&check)
                    .await
                    .unwrap();
            assert_eq!(
                survivors, 1,
                "the row for version {version} must survive, not be deleted"
            );
            check.close().await;
            assert!(
                std::fs::read_dir(&temp.dir)
                    .unwrap()
                    .flatten()
                    .all(|entry| !entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("mausvoice.broken-")),
                "surfacing version {version} must never quarantine the database"
            );
        }
    }

    #[tokio::test]
    async fn non_integrity_errors_do_not_quarantine() {
        let temp = TempDb::new();
        // A non-integrity failure: pass a directory as the database path.
        let dir_as_db = temp.dir.join("not-a-file");
        std::fs::create_dir_all(&dir_as_db).unwrap();
        let result = open_app_database(&dir_as_db).await;
        assert!(result.is_err());
        assert!(std::fs::read_dir(&temp.dir)
            .unwrap()
            .flatten()
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .starts_with("mausvoice.broken-")));
    }
}
