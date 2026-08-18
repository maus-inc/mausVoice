use sqlx::{Row, SqlitePool};

use crate::domain::Hotkey;

fn serialize_keys(keys: &[String]) -> Result<String, sqlx::Error> {
    serde_json::to_string(keys).map_err(|err| sqlx::Error::Decode(Box::new(err)))
}

fn deserialize_keys(keys: String) -> Result<Vec<String>, sqlx::Error> {
    serde_json::from_str(&keys).map_err(|err| sqlx::Error::Decode(Box::new(err)))
}

pub async fn upsert_hotkey(pool: SqlitePool, hotkey: &Hotkey) -> Result<Hotkey, sqlx::Error> {
    let keys_json = serialize_keys(&hotkey.keys)?;

    sqlx::query(
        "INSERT INTO hotkeys (id, action_name, keys)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET action_name = excluded.action_name, keys = excluded.keys",
    )
    .bind(&hotkey.id)
    .bind(&hotkey.action_name)
    .bind(keys_json)
    .execute(&pool)
    .await?;

    Ok(hotkey.clone())
}

pub async fn fetch_hotkeys(pool: SqlitePool) -> Result<Vec<Hotkey>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, action_name, keys
         FROM hotkeys
         ORDER BY action_name ASC, id ASC",
    )
    .fetch_all(&pool)
    .await?;

    rows.into_iter()
        .map(|row| {
            let keys_json = row.get::<String, _>("keys");
            let keys = deserialize_keys(keys_json)?;
            Ok(Hotkey {
                id: row.get::<String, _>("id"),
                action_name: row.get::<String, _>("action_name"),
                keys,
            })
        })
        .collect()
}

pub async fn delete_hotkey(pool: SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM hotkeys WHERE id = ?1")
        .bind(id)
        .execute(&pool)
        .await?;

    Ok(())
}

/// Replaces every hotkey whose `action_name` starts with `prefix` with
/// `hotkeys` inside a single SQLite transaction, so a failed insert cannot
/// leave the previous shortcuts partially deleted.
pub async fn replace_hotkeys_by_prefix(
    pool: SqlitePool,
    prefix: &str,
    hotkeys: &[Hotkey],
) -> Result<Vec<Hotkey>, sqlx::Error> {
    let escaped_prefix: String = prefix
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("{escaped_prefix}%");

    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM hotkeys WHERE action_name LIKE ?1 ESCAPE '\\'")
        .bind(pattern)
        .execute(&mut *tx)
        .await?;
    for hotkey in hotkeys {
        let keys_json = serialize_keys(&hotkey.keys)?;
        sqlx::query(
            "INSERT INTO hotkeys (id, action_name, keys) VALUES (?1, ?2, ?3)",
        )
        .bind(&hotkey.id)
        .bind(&hotkey.action_name)
        .bind(keys_json)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    Ok(hotkeys.to_vec())
}
