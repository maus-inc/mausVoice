use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha384};
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::{Row, SqlitePool};

use super::migrations;

/// SHA-384 of the migration SQL, matching sqlx / tauri-plugin-sql.
pub fn migration_checksum(sql: &str) -> Vec<u8> {
    Sha384::digest(sql.as_bytes()).to_vec()
}

fn sqlite_url(path: &Path) -> Result<String, String> {
    let path_str = path
        .to_str()
        .ok_or_else(|| "Invalid database path".to_string())?;
    Ok(format!("sqlite:{path_str}?mode=rwc"))
}

pub fn quarantine_sqlite_file(path: &Path) -> std::io::Result<PathBuf> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dest = path.with_file_name(format!("mausvoice.broken-{nanos}.db"));
    if path.exists() {
        std::fs::rename(path, &dest)?;
    }
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        for suffix in ["-wal", "-shm"] {
            let side = path.with_file_name(format!("{name}{suffix}"));
            if side.exists() {
                if let Some(dest_name) = dest.file_name().and_then(|n| n.to_str()) {
                    let _ = std::fs::rename(
                        &side,
                        dest.with_file_name(format!("{dest_name}{suffix}")),
                    );
                }
            }
        }
    }
    Ok(dest)
}

async fn connect_pool(path: &Path) -> Result<SqlitePool, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let url = sqlite_url(path)?;
    SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .map_err(|err| err.to_string())
}

async fn apply_migrations(pool: &SqlitePool) -> Result<(), String> {
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
    .map_err(|err| err.to_string())?;

    let failed: Option<i64> = sqlx::query_scalar(
        "SELECT version FROM _sqlx_migrations WHERE success = false ORDER BY version LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|err| err.to_string())?;
    if let Some(version) = failed {
        return Err(format!(
            "migration {version} previously failed; database needs recovery"
        ));
    }

    let applied = sqlx::query("SELECT version, checksum FROM _sqlx_migrations ORDER BY version")
        .fetch_all(pool)
        .await
        .map_err(|err| err.to_string())?;

    let mut applied_checksums = std::collections::HashMap::new();
    for row in applied {
        let version: i64 = row.get("version");
        let checksum: Vec<u8> = row.get("checksum");
        applied_checksums.insert(version, checksum);
    }

    for migration in migrations() {
        let version = migration.version as i64;
        let expected = migration_checksum(migration.sql);
        if let Some(stored) = applied_checksums.get(&version) {
            if stored.as_slice() != expected.as_slice() {
                return Err(format!(
                    "migration {version} ({}) was previously applied but has been modified",
                    migration.description
                ));
            }
            continue;
        }

        let started = std::time::Instant::now();
        sqlx::raw_sql(migration.sql)
            .execute(pool)
            .await
            .map_err(|err| format!("migration {version} failed: {err}"))?;
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
        .execute(pool)
        .await
        .map_err(|err| err.to_string())?;
    }

    Ok(())
}

/// Open the app database, applying migrations. If the file is corrupt or an
/// already-applied migration checksum no longer matches, the broken file is
/// moved aside and a fresh database is created so the app can still open.
pub async fn open_app_database(path: &Path) -> Result<SqlitePool, String> {
    match try_open(path).await {
        Ok(pool) => Ok(pool),
        Err(first_error) => {
            log::error!(
                "Database at {} is unusable ({first_error}); quarantining and opening a fresh file",
                path.display()
            );
            let pool = connect_pool(path).await;
            if let Ok(pool) = pool {
                pool.close().await;
            }
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
                    "database recovery failed after {first_error}; retry error: {retry_error}"
                )
            })
        }
    }
}

async fn try_open(path: &Path) -> Result<SqlitePool, String> {
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

    fn temp_db() -> PathBuf {
        std::env::temp_dir().join(format!(
            "mausvoice-open-{}-{}.db",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn checksum_is_stable_sha384() {
        let a = migration_checksum("SELECT 1;");
        let b = migration_checksum("SELECT 1;");
        let c = migration_checksum("SELECT 2;");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 48);
    }

    #[test]
    fn quarantine_renames_db_and_sidecars() {
        let path = temp_db();
        std::fs::write(&path, b"broken").unwrap();
        std::fs::write(path.with_file_name(format!("{}-wal", path.file_name().unwrap().to_str().unwrap())), b"wal").unwrap();
        let dest = quarantine_sqlite_file(&path).unwrap();
        assert!(!path.exists());
        assert!(dest.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"broken");
        let _ = std::fs::remove_file(&dest);
        let _ = std::fs::remove_file(dest.with_file_name(format!(
            "{}-wal",
            dest.file_name().unwrap().to_str().unwrap()
        )));
    }

    #[tokio::test]
    async fn checksum_mismatch_is_recovered_with_a_fresh_database() {
        let path = temp_db();
        let pool = try_open(&path).await.expect("initial migrate");
        sqlx::query("UPDATE _sqlx_migrations SET checksum = x'deadbeef' WHERE version = 1")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        let recovered = open_app_database(&path)
            .await
            .expect("recovery should open a fresh database");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&recovered)
            .await
            .unwrap();
        assert_eq!(count, migrations().len() as i64);
        recovered.close().await;

        let parent = path.parent().unwrap();
        for entry in std::fs::read_dir(parent).unwrap().flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.contains("mausvoice-open-") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}
