use sqlx::{Row, SqlitePool};

use crate::domain::PairedRemoteDevice;

pub async fn upsert_paired_remote_device(
    pool: SqlitePool,
    device: &PairedRemoteDevice,
) -> Result<PairedRemoteDevice, sqlx::Error> {
    sqlx::query(
        "INSERT INTO paired_remote_devices (
            id,
            name,
            platform,
            role,
            shared_secret,
            paired_at,
            last_seen_at,
            last_known_address,
            trusted
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            platform = excluded.platform,
            role = excluded.role,
            shared_secret = excluded.shared_secret,
            paired_at = excluded.paired_at,
            last_seen_at = excluded.last_seen_at,
            last_known_address = excluded.last_known_address,
            trusted = excluded.trusted",
    )
    .bind(&device.id)
    .bind(&device.name)
    .bind(&device.platform)
    .bind(&device.role)
    .bind(&device.shared_secret)
    .bind(&device.paired_at)
    .bind(&device.last_seen_at)
    .bind(&device.last_known_address)
    .bind(device.trusted)
    .execute(&pool)
    .await?;

    Ok(device.clone())
}

pub async fn fetch_paired_remote_devices(
    pool: SqlitePool,
) -> Result<Vec<PairedRemoteDevice>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT
            id,
            name,
            platform,
            role,
            shared_secret,
            paired_at,
            last_seen_at,
            last_known_address,
            trusted
         FROM paired_remote_devices
         ORDER BY paired_at DESC",
    )
    .fetch_all(&pool)
    .await?;

    let mut devices = Vec::with_capacity(rows.len());
    for row in rows {
        devices.push(PairedRemoteDevice {
            id: row.get("id"),
            name: row.get("name"),
            platform: row.get("platform"),
            role: row.get("role"),
            shared_secret: row.get("shared_secret"),
            paired_at: row.get("paired_at"),
            last_seen_at: row.try_get("last_seen_at")?,
            last_known_address: row.try_get("last_known_address")?,
            // `unwrap_or(false)`, not `true`. A decode failure on a security flag must
            // not report the permissive value: `''` and `'maybe'` both land in this
            // `INTEGER NOT NULL` column as `text`, because integer affinity cannot convert
            // them, the i64 decode then fails, and `unwrap_or(true)` reported the device as
            // TRUSTED. Every writer here binds a bool so nothing should produce that -- which
            // is exactly why the fallback is the wrong side to be wrong on. A migration, a
            // direct SQL write or a restored backup can.
            trusted: row
                .try_get::<i64, _>("trusted")
                .map(|value| value != 0)
                .unwrap_or(false),
        });
    }

    Ok(devices)
}

pub async fn fetch_paired_remote_device_by_id(
    pool: SqlitePool,
    id: &str,
) -> Result<Option<PairedRemoteDevice>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT
            id,
            name,
            platform,
            role,
            shared_secret,
            paired_at,
            last_seen_at,
            last_known_address,
            trusted
         FROM paired_remote_devices
         WHERE id = ?1
         LIMIT 1",
    )
    .bind(id)
    .fetch_optional(&pool)
    .await?;

    Ok(row.map(|row| PairedRemoteDevice {
        id: row.get("id"),
        name: row.get("name"),
        platform: row.get("platform"),
        role: row.get("role"),
        shared_secret: row.get("shared_secret"),
        paired_at: row.get("paired_at"),
        last_seen_at: row.try_get("last_seen_at").unwrap_or(None),
        last_known_address: row.try_get("last_known_address").unwrap_or(None),
        // Fail closed, for the reason given at the other site above.
        trusted: row
            .try_get::<i64, _>("trusted")
            .map(|value| value != 0)
            .unwrap_or(false),
    }))
}

pub async fn delete_paired_remote_device(pool: SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM paired_remote_devices WHERE id = ?1")
        .bind(id)
        .execute(&pool)
        .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{fetch_paired_remote_device_by_id, fetch_paired_remote_devices};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::SqlitePool;

    async fn device_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            // `in_memory(true)`, NOT `.filename("sqlite::memory:")`: the latter takes the
            // string as a literal path and SQLite answers code 14, "unable to open database
            // file". `SqlitePoolOptions::connect` is what special-cases that value.
            .connect_with(
                SqliteConnectOptions::new()
                    .in_memory(true)
                    .foreign_keys(true),
            )
            .await
            .expect("connect");
        sqlx::query(
            "CREATE TABLE paired_remote_devices (
                id TEXT PRIMARY KEY,
                name TEXT,
                platform TEXT,
                role TEXT,
                shared_secret TEXT,
                paired_at TEXT,
                last_seen_at TEXT,
                last_known_address TEXT,
                trusted INTEGER NOT NULL DEFAULT 1
            )",
        )
        .execute(&pool)
        .await
        .expect("create paired_remote_device");
        pool
    }

    /// The regression. Both rows hold a value no writer in this codebase produces -- the
    /// point is what a decode failure reports, not how it gets there. `''` and `'maybe'`
    /// both store as `text` under an INTEGER affinity, so the i64 decode fails for each.
    ///
    /// `trustworthy` is a permission: it decides whether a remote peer is believed. A value
    /// this code cannot read is not evidence the peer is trusted, and the previous fallback
    /// said it was.
    #[tokio::test]
    async fn a_trusted_flag_that_cannot_be_decoded_is_not_treated_as_trusted() {
        let pool = device_pool().await;
        for (id, value) in [("blank", ""), ("word", "maybe")] {
            sqlx::query("INSERT INTO paired_remote_devices (id, trusted) VALUES (?1, ?2)")
                .bind(id)
                .bind(value)
                .execute(&pool)
                .await
                .expect("insert");
        }

        let devices = fetch_paired_remote_devices(pool.clone())
            .await
            .expect("list");

        assert_eq!(devices.len(), 2, "both rows must be readable as rows");
        for device in &devices {
            assert!(
                !device.trusted,
                "device {:?} holds an undecodable `trusted` value and must not be trusted",
                device.id
            );
        }
    }

    /// The same property on the OTHER of the two sites, which carries its own copy of the
    /// decode. One test for the list function leaves this line unpinned: reverting only the
    /// `fetch_paired_remote_device_by_id` fallback would leave everything above green.
    #[tokio::test]
    async fn the_single_device_query_also_fails_closed() {
        let pool = device_pool().await;
        sqlx::query("INSERT INTO paired_remote_devices (id, trusted) VALUES ('word', 'maybe')")
            .execute(&pool)
            .await
            .expect("insert");

        let device = fetch_paired_remote_device_by_id(pool.clone(), "word")
            .await
            .expect("fetch")
            .expect("the row exists");
        assert!(
            !device.trusted,
            "an undecodable trusted value must not read as trusted on the single-device query either"
        );
    }

    /// The control: the ordinary decodable values still report what they say, so the case
    /// above is not passing because nothing is ever trusted.
    #[tokio::test]
    async fn a_decodable_trusted_flag_reports_its_value() {
        let pool = device_pool().await;
        for (id, value) in [("yes", 1_i64), ("no", 0_i64)] {
            sqlx::query("INSERT INTO paired_remote_devices (id, trusted) VALUES (?1, ?2)")
                .bind(id)
                .bind(value)
                .execute(&pool)
                .await
                .expect("insert");
        }

        let devices = fetch_paired_remote_devices(pool.clone())
            .await
            .expect("list");
        let by_id: std::collections::HashMap<_, _> =
            devices.iter().map(|d| (d.id.as_str(), d.trusted)).collect();

        assert_eq!(by_id.get("yes"), Some(&true));
        assert_eq!(by_id.get("no"), Some(&false));
    }
}
