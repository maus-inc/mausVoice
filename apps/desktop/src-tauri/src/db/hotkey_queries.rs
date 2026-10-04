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
///
/// The prefix match is case-sensitive. `LIKE` is case-insensitive for ASCII,
/// so a `LIKE` predicate also matched `Switch-to-style:...` when the caller
/// asked for `switch-to-style:`, and the replace deleted a group it was never
/// given. `instr(...) = 1` is the plain starts-with test the doc comment
/// describes, and it needs no wildcard escaping, so a prefix containing `%`
/// or `_` is matched literally instead of being read as a pattern.
pub async fn replace_hotkeys_by_prefix(
    pool: SqlitePool,
    prefix: &str,
    hotkeys: &[Hotkey],
) -> Result<Vec<Hotkey>, sqlx::Error> {
    if prefix.is_empty() {
        return Err(sqlx::Error::Protocol(
            "hotkey prefix must not be empty".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM hotkeys WHERE instr(action_name, ?1) = 1")
        .bind(prefix)
        .execute(&mut *tx)
        .await?;
    for hotkey in hotkeys {
        let keys_json = serialize_keys(&hotkey.keys)?;
        sqlx::query("INSERT INTO hotkeys (id, action_name, keys) VALUES (?1, ?2, ?3)")
            .bind(&hotkey.id)
            .bind(&hotkey.action_name)
            .bind(keys_json)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    Ok(hotkeys.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn migrated_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect to in-memory database");

        for migration in crate::db::migrations() {
            sqlx::raw_sql(migration.sql)
                .execute(&pool)
                .await
                .unwrap_or_else(|error| {
                    panic!(
                        "apply migration {} ({}): {error}",
                        migration.version, migration.description
                    )
                });
        }

        pool
    }

    async fn seed(pool: &SqlitePool, id: &str, action_name: &str) {
        sqlx::query("INSERT INTO hotkeys (id, action_name, keys) VALUES (?1, ?2, ?3)")
            .bind(id)
            .bind(action_name)
            .bind(r#"["Control","Shift"]"#)
            .execute(pool)
            .await
            .expect("seed hotkey");
    }

    async fn action_names(pool: &SqlitePool) -> Vec<String> {
        sqlx::query("SELECT action_name FROM hotkeys ORDER BY action_name")
            .fetch_all(pool)
            .await
            .expect("read hotkeys")
            .into_iter()
            .map(|row| row.get::<String, _>("action_name"))
            .collect()
    }

    /// `replace_hotkeys_by_prefix` documents itself as replacing what
    /// *starts with* the prefix. SQLite's `LIKE` is case-insensitive for
    /// ASCII, so the lowercased style group the frontend sends also matched
    /// and deleted a differently-cased hotkey the caller never named.
    #[tokio::test]
    async fn replacing_a_prefix_leaves_a_differently_cased_group_alone() {
        let pool = migrated_pool().await;
        seed(&pool, "a", "switch-to-style:casual").await;
        seed(&pool, "b", "Switch-to-style:formal").await;
        seed(&pool, "c", "other-action").await;

        let replacement = vec![Hotkey {
            id: "new".to_string(),
            action_name: "switch-to-style:casual".to_string(),
            keys: vec!["Control".to_string()],
        }];
        replace_hotkeys_by_prefix(pool.clone(), "switch-to-style:", &replacement)
            .await
            .expect("replace style hotkeys");

        assert_eq!(
            action_names(&pool).await,
            vec![
                "Switch-to-style:formal".to_string(),
                "other-action".to_string(),
                "switch-to-style:casual".to_string(),
            ],
            "the capitalised group is a distinct hotkey and must survive"
        );
    }

    /// The prefix is a literal, not a `LIKE` pattern. The old code escaped
    /// `%` and `_` by hand, which is exactly the class of bug that a plain
    /// string comparison removes.
    #[tokio::test]
    async fn a_wildcard_character_in_the_prefix_is_matched_literally() {
        let pool = migrated_pool().await;
        seed(&pool, "a", "style%_casual").await;
        seed(&pool, "b", "styleXYcasual").await;

        replace_hotkeys_by_prefix(pool.clone(), "style%_", &[])
            .await
            .expect("replace literal prefix");

        assert_eq!(
            action_names(&pool).await,
            vec!["styleXYcasual".to_string()],
            "only the literal prefix may be deleted"
        );
    }

    #[tokio::test]
    async fn an_empty_prefix_is_rejected() {
        let pool = migrated_pool().await;
        assert!(replace_hotkeys_by_prefix(pool, "", &[]).await.is_err());
    }
}
