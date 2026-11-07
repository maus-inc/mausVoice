use sqlx::{Row, SqliteConnection, SqlitePool};

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

/// The action name of the primary dictation shortcut.
const PRIMARY_DICTATION_ACTION: &str = "dictate";

/// The action-name prefix that marks an additional dictation language.
const ADDITIONAL_LANGUAGE_PREFIX: &str = "additional-language:";

/// Compare the rows the caller believes it is replacing with the rows the
/// database holds. A concurrent edit from another window, or a save that
/// already landed, changes the group, and a replacement computed from the older
/// snapshot would silently drop it. The compare runs inside the same
/// transaction as the write, so a passed check cannot go stale before the
/// delete commits.
async fn verify_hotkey_snapshot(
    connection: &mut SqliteConnection,
    prefix: &str,
    include_dictate: bool,
    expected: Option<&[Hotkey]>,
    conflict: &str,
) -> Result<(), sqlx::Error> {
    // A caller that does not hold a snapshot of the group it is replacing is
    // asking for a plain atomic replace: the delete and the insert still happen
    // in one transaction, so no reader sees a partial group. Only a caller that
    // edited a snapshot it read earlier can assert what the group held, and
    // that assertion is what catches a concurrent edit from another dialog.
    let Some(expected) = expected else {
        return Ok(());
    };
    let rows = sqlx::query(
        "SELECT id, action_name, keys FROM hotkeys
         WHERE (?2 AND action_name = 'dictate') OR instr(action_name, ?1) = 1 ORDER BY id",
    )
    .bind(prefix)
    .bind(include_dictate)
    .fetch_all(connection)
    .await?;
    let current = rows
        .into_iter()
        .map(|row| {
            Ok(Hotkey {
                id: row.get("id"),
                action_name: row.get("action_name"),
                keys: deserialize_keys(row.get("keys"))?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    let mut expected = expected.to_vec();
    expected.sort_by(|left, right| left.id.cmp(&right.id));
    if current != expected {
        return Err(sqlx::Error::Protocol(conflict.into()));
    }
    Ok(())
}

/// A replacement row may only take an action name inside the group it replaces.
fn verify_replacement_hotkey(hotkey: &Hotkey, prefix: &str) -> Result<(), sqlx::Error> {
    if !hotkey.action_name.starts_with(prefix) || hotkey.action_name.len() == prefix.len() {
        return Err(sqlx::Error::Protocol("Invalid replacement hotkey".into()));
    }
    Ok(())
}

/// The dictation group is the primary `dictate` shortcut plus the additional
/// language shortcuts. A shortcut row holds one key combination, and the
/// shortcuts dialog lets a user add more than one row for the same action, so
/// the replacement may carry extra `dictate` rows alongside the language rows.
/// Rejecting them would delete a binding the caller never asked to remove.
fn verify_dictation_replacement_hotkey(hotkey: &Hotkey) -> Result<(), sqlx::Error> {
    if hotkey.action_name == PRIMARY_DICTATION_ACTION {
        return Ok(());
    }
    verify_replacement_hotkey(hotkey, ADDITIONAL_LANGUAGE_PREFIX)
}

async fn insert_hotkeys(
    connection: &mut SqliteConnection,
    hotkeys: &[Hotkey],
) -> Result<(), sqlx::Error> {
    for hotkey in hotkeys {
        let keys_json = serialize_keys(&hotkey.keys)?;
        sqlx::query("INSERT INTO hotkeys (id, action_name, keys) VALUES (?1, ?2, ?3)")
            .bind(&hotkey.id)
            .bind(&hotkey.action_name)
            .bind(keys_json)
            .execute(&mut *connection)
            .await?;
    }
    Ok(())
}

/// Save the primary dictate shortcut and replace additional language shortcuts
/// as one transaction. Colliding IDs outside this group must never be changed.
///
/// `additional` carries every row of the group except `primary`, which includes
/// extra `dictate` rows for users who bound a second combination to dictation.
pub async fn replace_dictation_language_hotkeys(
    pool: SqlitePool,
    primary: &Hotkey,
    additional: &[Hotkey],
    expected: Option<&[Hotkey]>,
) -> Result<(), sqlx::Error> {
    if primary.action_name != PRIMARY_DICTATION_ACTION {
        return Err(sqlx::Error::Protocol("Invalid dictation hotkey".into()));
    }
    for hotkey in additional {
        verify_dictation_replacement_hotkey(hotkey)?;
        if hotkey.id == primary.id {
            return Err(sqlx::Error::Protocol(
                "Duplicate dictation hotkey id".into(),
            ));
        }
    }

    let mut tx = pool.begin().await?;
    verify_hotkey_snapshot(
        &mut tx,
        ADDITIONAL_LANGUAGE_PREFIX,
        true,
        expected,
        "DICTATION_HOTKEYS_CHANGED",
    )
    .await?;
    sqlx::query("DELETE FROM hotkeys WHERE action_name = ?1 OR instr(action_name, ?2) = 1")
        .bind(PRIMARY_DICTATION_ACTION)
        .bind(ADDITIONAL_LANGUAGE_PREFIX)
        .execute(&mut *tx)
        .await?;
    insert_hotkeys(&mut tx, std::slice::from_ref(primary)).await?;
    insert_hotkeys(&mut tx, additional).await?;
    tx.commit().await?;

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
    expected: Option<&[Hotkey]>,
) -> Result<Vec<Hotkey>, sqlx::Error> {
    if prefix.is_empty() {
        return Err(sqlx::Error::Protocol(
            "hotkey prefix must not be empty".into(),
        ));
    }
    for hotkey in hotkeys {
        verify_replacement_hotkey(hotkey, prefix)?;
    }

    let mut tx = pool.begin().await?;
    verify_hotkey_snapshot(&mut tx, prefix, false, expected, "STYLE_HOTKEYS_CHANGED").await?;
    sqlx::query("DELETE FROM hotkeys WHERE instr(action_name, ?1) = 1")
        .bind(prefix)
        .execute(&mut *tx)
        .await?;
    insert_hotkeys(&mut tx, hotkeys).await?;
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

    /// The rows a caller believes it is replacing, in the id order the
    /// snapshot check compares against.
    async fn group_snapshot(pool: &SqlitePool, prefix: &str, include_dictate: bool) -> Vec<Hotkey> {
        let mut hotkeys: Vec<_> = fetch_hotkeys(pool.clone())
            .await
            .expect("read hotkeys")
            .into_iter()
            .filter(|hotkey| {
                (include_dictate && hotkey.action_name == PRIMARY_DICTATION_ACTION)
                    || hotkey.action_name.starts_with(prefix)
            })
            .collect();
        hotkeys.sort_by(|left, right| left.id.cmp(&right.id));
        hotkeys
    }

    fn shortcut(id: &str, action: &str, key: &str) -> Hotkey {
        Hotkey {
            id: id.to_string(),
            action_name: action.to_string(),
            keys: vec![key.to_string()],
        }
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

        let expected = group_snapshot(&pool, "switch-to-style:", false).await;
        let replacement = vec![Hotkey {
            id: "new".to_string(),
            action_name: "switch-to-style:casual".to_string(),
            keys: vec!["Control".to_string()],
        }];
        replace_hotkeys_by_prefix(
            pool.clone(),
            "switch-to-style:",
            &replacement,
            Some(expected.as_slice()),
        )
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

        let expected = group_snapshot(&pool, "style%_", false).await;
        replace_hotkeys_by_prefix(pool.clone(), "style%_", &[], Some(expected.as_slice()))
            .await
            .expect("replace literal prefix");

        assert_eq!(
            action_names(&pool).await,
            vec!["styleXYcasual".to_string()],
            "only the literal prefix may be deleted"
        );
    }

    #[tokio::test]
    async fn an_empty_replacement_removes_every_prefixed_shortcut_and_keeps_others() {
        let pool = migrated_pool().await;
        seed(&pool, "a", "switch-to-style:one").await;
        seed(&pool, "b", "switch-to-style:two").await;
        seed(&pool, "plain", "unrelated").await;
        seed(&pool, "suffix", "x-switch-to-style:three").await;
        let expected = group_snapshot(&pool, "switch-to-style:", false).await;
        assert_eq!(expected.len(), 2);

        let saved = replace_hotkeys_by_prefix(
            pool.clone(),
            "switch-to-style:",
            &[],
            Some(expected.as_slice()),
        )
        .await
        .unwrap();
        assert!(saved.is_empty());
        let names = action_names(&pool).await;
        assert!(!names.iter().any(|name| name == "switch-to-style:one"));
        assert!(!names.iter().any(|name| name == "switch-to-style:two"));
        assert!(names.iter().any(|name| name == "unrelated"));
        assert!(names.iter().any(|name| name == "x-switch-to-style:three"));

        // A cleared group is a valid starting point for the next replacement.
        assert!(
            replace_hotkeys_by_prefix(pool.clone(), "switch-to-style:", &[], Some(&[]))
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(action_names(&pool).await, names);
    }

    #[tokio::test]
    async fn a_caller_without_a_snapshot_still_replaces_the_whole_prefix() {
        let pool = migrated_pool().await;
        seed(&pool, "a", "switch-to-style:a").await;
        seed(&pool, "b", "switch-to-style:b").await;
        seed(&pool, "keep", "dictate").await;

        let saved = replace_hotkeys_by_prefix(
            pool.clone(),
            "switch-to-style:",
            &[shortcut("c", "switch-to-style:c", "C")],
            None,
        )
        .await
        .unwrap();

        assert_eq!(saved.len(), 1);
        assert_eq!(
            action_names(&pool).await,
            vec!["dictate".to_string(), "switch-to-style:c".to_string()]
        );
    }

    #[tokio::test]
    async fn an_empty_prefix_is_rejected() {
        let pool = migrated_pool().await;
        assert!(replace_hotkeys_by_prefix(pool, "", &[], Some(&[]))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn style_replacement_rejects_stale_invalid_and_colliding_edits() {
        let pool = migrated_pool().await;
        seed(&pool, "old", "switch-to-style:one").await;
        seed(&pool, "other", "unrelated").await;
        let expected = group_snapshot(&pool, "switch-to-style:", false).await;
        let newer = shortcut("newer", "switch-to-style:two", "N");
        upsert_hotkey(pool.clone(), &newer).await.unwrap();
        let after = fetch_hotkeys(pool.clone()).await.unwrap();
        let err = replace_hotkeys_by_prefix(
            pool.clone(),
            "switch-to-style:",
            &[],
            Some(expected.as_slice()),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("STYLE_HOTKEYS_CHANGED"));
        assert_eq!(fetch_hotkeys(pool.clone()).await.unwrap(), after);
        let current = group_snapshot(&pool, "switch-to-style:", false).await;
        for invalid in [
            shortcut("bad", "unrelated", "B"),
            shortcut("other", "switch-to-style:bad", "B"),
        ] {
            assert!(replace_hotkeys_by_prefix(
                pool.clone(),
                "switch-to-style:",
                &[invalid],
                Some(&current)
            )
            .await
            .is_err());
            assert_eq!(fetch_hotkeys(pool.clone()).await.unwrap(), after);
        }
    }

    #[tokio::test]
    async fn competing_style_edits_cannot_commit_over_a_stale_sqlite_snapshot() {
        use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
        use std::time::{Duration, SystemTime, UNIX_EPOCH};
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("maus-hotkey-race-{}-{unique}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let options = SqliteConnectOptions::new()
            .filename(directory.join("hotkeys.db"))
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(2));
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::raw_sql(crate::db::HOTKEYS_MIGRATION_SQL)
            .execute(&pool)
            .await
            .unwrap();
        seed(&pool, "old", "switch-to-style:old").await;
        let expected = group_snapshot(&pool, "switch-to-style:", false).await;
        let mut stale_tx = pool.begin().await.unwrap();
        verify_hotkey_snapshot(
            &mut stale_tx,
            "switch-to-style:",
            false,
            Some(expected.as_slice()),
            "STYLE_HOTKEYS_CHANGED",
        )
        .await
        .unwrap();
        let newer = shortcut("newer", "switch-to-style:newer", "N");
        replace_hotkeys_by_prefix(
            pool.clone(),
            "switch-to-style:",
            std::slice::from_ref(&newer),
            Some(expected.as_slice()),
        )
        .await
        .unwrap();
        assert!(
            sqlx::query("DELETE FROM hotkeys WHERE instr(action_name, ?1) = 1")
                .bind("switch-to-style:")
                .execute(&mut *stale_tx)
                .await
                .is_err()
        );
        stale_tx.rollback().await.unwrap();
        assert_eq!(fetch_hotkeys(pool.clone()).await.unwrap(), vec![newer]);
        pool.close().await;
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn language_replacement_is_atomic_and_preserves_other_hotkeys() {
        let pool = migrated_pool().await;
        seed(&pool, "primary", PRIMARY_DICTATION_ACTION).await;
        seed(&pool, "fr", "additional-language:fr").await;
        seed(&pool, "unrelated", "other-action").await;
        let expected = group_snapshot(&pool, ADDITIONAL_LANGUAGE_PREFIX, true).await;
        assert_eq!(expected.len(), 2);

        let primary = shortcut("primary", PRIMARY_DICTATION_ACTION, "D");
        let additional = vec![
            shortcut("fr", "additional-language:fr", "F"),
            shortcut("de", "additional-language:de", "G"),
        ];
        replace_dictation_language_hotkeys(
            pool.clone(),
            &primary,
            &additional,
            Some(expected.as_slice()),
        )
        .await
        .expect("replace dictation language hotkeys");

        assert_eq!(
            action_names(&pool).await,
            vec![
                "additional-language:de".to_string(),
                "additional-language:fr".to_string(),
                "dictate".to_string(),
                "other-action".to_string(),
            ]
        );
        let saved = fetch_hotkeys(pool.clone()).await.unwrap();
        let fr = saved
            .iter()
            .find(|hotkey| hotkey.id == "fr")
            .expect("rewritten language hotkey");
        assert_eq!(fr.keys, vec!["F".to_string()]);
    }

    /// The shortcuts dialog lets a user bind a second combination to dictation.
    /// The language dialog replaces the whole group, so those extra rows have to
    /// travel back through `additional` or saving the dialog deletes them.
    #[tokio::test]
    async fn language_replacement_keeps_an_extra_primary_binding() {
        let pool = migrated_pool().await;
        seed(&pool, "primary", PRIMARY_DICTATION_ACTION).await;
        seed(&pool, "primary-alt", PRIMARY_DICTATION_ACTION).await;
        seed(&pool, "fr", "additional-language:fr").await;
        seed(&pool, "unrelated", "other-action").await;
        let expected = group_snapshot(&pool, ADDITIONAL_LANGUAGE_PREFIX, true).await;
        assert_eq!(expected.len(), 3);

        let primary = shortcut("primary", PRIMARY_DICTATION_ACTION, "D");
        let additional = vec![
            shortcut("primary-alt", PRIMARY_DICTATION_ACTION, "Y"),
            shortcut("fr", "additional-language:fr", "F"),
        ];
        replace_dictation_language_hotkeys(
            pool.clone(),
            &primary,
            &additional,
            Some(expected.as_slice()),
        )
        .await
        .expect("replace dictation language hotkeys");

        let saved = fetch_hotkeys(pool.clone()).await.unwrap();
        let bindings: Vec<_> = saved
            .iter()
            .filter(|hotkey| hotkey.action_name == PRIMARY_DICTATION_ACTION)
            .map(|hotkey| (hotkey.id.as_str(), hotkey.keys.as_slice()))
            .collect();
        assert_eq!(
            bindings,
            vec![
                ("primary", ["D".to_string()].as_slice()),
                ("primary-alt", ["Y".to_string()].as_slice())
            ]
        );
        assert!(saved
            .iter()
            .any(|hotkey| hotkey.action_name == "other-action"));
    }

    #[tokio::test]
    async fn language_replacement_rejects_a_reused_primary_id() {
        let pool = migrated_pool().await;
        seed(&pool, "primary", PRIMARY_DICTATION_ACTION).await;
        let expected = group_snapshot(&pool, ADDITIONAL_LANGUAGE_PREFIX, true).await;
        let before = fetch_hotkeys(pool.clone()).await.unwrap();

        let primary = shortcut("primary", PRIMARY_DICTATION_ACTION, "D");
        let err = replace_dictation_language_hotkeys(
            pool.clone(),
            &primary,
            &[shortcut("primary", PRIMARY_DICTATION_ACTION, "Y")],
            Some(expected.as_slice()),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("Duplicate dictation hotkey id"));
        assert_eq!(fetch_hotkeys(pool.clone()).await.unwrap(), before);
    }

    #[tokio::test]
    async fn language_replacement_rolls_back_on_invalid_action_or_colliding_id() {
        let pool = migrated_pool().await;
        seed(&pool, "primary", PRIMARY_DICTATION_ACTION).await;
        seed(&pool, "fr", "additional-language:fr").await;
        seed(&pool, "unrelated", "other-action").await;
        let expected = group_snapshot(&pool, ADDITIONAL_LANGUAGE_PREFIX, true).await;
        let before = fetch_hotkeys(pool.clone()).await.unwrap();

        let primary = shortcut("primary", PRIMARY_DICTATION_ACTION, "D");
        // An additional shortcut must name a language, and a primary shortcut
        // must stay the dictate action.
        for (primary, additional) in [
            (primary.clone(), vec![shortcut("bad", "other-action", "B")]),
            (
                shortcut("primary", "other-action", "D"),
                vec![shortcut("fr", "additional-language:fr", "F")],
            ),
            (
                primary.clone(),
                // Reusing the id of a row outside the group would rewrite a
                // shortcut the caller never sent.
                vec![shortcut("unrelated", "additional-language:es", "E")],
            ),
        ] {
            assert!(replace_dictation_language_hotkeys(
                pool.clone(),
                &primary,
                &additional,
                Some(expected.as_slice())
            )
            .await
            .is_err());
            assert_eq!(fetch_hotkeys(pool.clone()).await.unwrap(), before);
        }
    }

    #[tokio::test]
    async fn language_replacement_rejects_a_stale_snapshot() {
        let pool = migrated_pool().await;
        seed(&pool, "primary", PRIMARY_DICTATION_ACTION).await;
        seed(&pool, "fr", "additional-language:fr").await;
        let expected = group_snapshot(&pool, ADDITIONAL_LANGUAGE_PREFIX, true).await;
        upsert_hotkey(pool.clone(), &shortcut("es", "additional-language:es", "E"))
            .await
            .unwrap();
        let after = fetch_hotkeys(pool.clone()).await.unwrap();

        let err = replace_dictation_language_hotkeys(
            pool.clone(),
            &shortcut("primary", PRIMARY_DICTATION_ACTION, "D"),
            &[shortcut("fr", "additional-language:fr", "F")],
            Some(expected.as_slice()),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("DICTATION_HOTKEYS_CHANGED"));
        assert_eq!(fetch_hotkeys(pool.clone()).await.unwrap(), after);
    }
}
