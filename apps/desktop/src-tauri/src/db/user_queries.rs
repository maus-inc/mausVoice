use sqlx::{Row, SqlitePool};

use crate::domain::User;

/// Every `user_profiles` column, in the order `upsert_user` binds its `?N`
/// placeholders.
///
/// The writer's column list, the writer's `ON CONFLICT` assignments and the
/// reader's SELECT are all generated from this one list, so a column cannot be
/// written by one statement and silently dropped by the others.
const USER_PROFILE_COLUMNS: &[&str] = &[
    "id",
    "name",
    "bio",
    "company",
    "title",
    "onboarded",
    "preferred_microphone",
    "preferred_language",
    "words_this_month",
    "words_this_month_month",
    "words_total",
    "play_interaction_chime",
    "interaction_feedback_volume",
    "has_finished_tutorial",
    "has_migrated_preferred_microphone",
    "cohort",
    "styling_mode",
    "selected_tone_id",
    "active_tone_ids",
    "streak",
    "streak_recorded_at",
    "referral_source",
    "created_at",
    "onboarded_at",
];

/// The conflict key, so the one column `ON CONFLICT` must not assign: it is
/// the row's identity rather than a value to overwrite.
const CONFLICT_KEY: &str = "id";

fn user_profile_column_list() -> String {
    USER_PROFILE_COLUMNS.join(",\n         ")
}

fn user_profile_conflict_assignments() -> String {
    USER_PROFILE_COLUMNS
        .iter()
        .filter(|column| **column != CONFLICT_KEY)
        .map(|column| format!("{column} = excluded.{column}"))
        .collect::<Vec<_>>()
        .join(",\n        ")
}

/// `?1, ?2, ... ?n` for a positional bind of `count` values.
fn positional_placeholders(count: usize) -> String {
    (1..=count)
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Insert or update a user profile row, clamping the optional thock
/// volume into the canonical safe window before it reaches SQLite.
///
/// The stored row is read back out of the same statement rather than
/// answered with the input: the clamp happens on the way in, so a caller that
/// got its own value back kept an out-of-range volume in memory until the
/// next reload, and the frontend renders that value on the volume slider.
pub async fn upsert_user(pool: SqlitePool, user: &User) -> Result<User, sqlx::Error> {
    // The primary key bounds this to one row. Drain RETURNING through
    // completion before reporting success, including any final statement
    // error.
    let mut rows = sqlx::query(&format!(
        "INSERT INTO user_profiles ({})
     VALUES ({})
     ON CONFLICT(id) DO UPDATE SET
        {}
     RETURNING *",
        user_profile_column_list(),
        positional_placeholders(USER_PROFILE_COLUMNS.len()),
        user_profile_conflict_assignments(),
    ))
    .bind(&user.id)
    .bind(&user.name)
    .bind(&user.bio)
    .bind(&user.company)
    .bind(&user.title)
    .bind(if user.onboarded { 1 } else { 0 })
    .bind(&user.preferred_microphone)
    .bind(&user.preferred_language)
    .bind(user.words_this_month)
    .bind(&user.words_this_month_month)
    .bind(user.words_total)
    .bind(if user.play_interaction_chime { 1 } else { 0 })
    .bind(
        // Enforce the canonical safe window at the persistence boundary:
        // a restored or synced payload carrying an out-of-range value is
        // clamped before it can reach SQLite, matching the sink-side
        // clamp so what is stored is always what would be played.
        user.interaction_feedback_volume
            .unwrap_or(crate::domain::user::DEFAULT_INTERACTION_FEEDBACK_VOLUME)
            .clamp(0.05, 0.5) as f64,
    )
    .bind(if user.has_finished_tutorial { 1 } else { 0 })
    .bind(if user.has_migrated_preferred_microphone { 1 } else { 0 })
    .bind(&user.cohort)
    .bind(&user.styling_mode)
    .bind(&user.selected_tone_id)
    .bind(&user.active_tone_ids)
    .bind(user.streak)
    .bind(&user.streak_recorded_at)
    .bind(&user.referral_source)
    .bind(&user.created_at)
    .bind(&user.onboarded_at)
    .fetch_all(&pool)
    .await?;

    // An upsert always returns its row, so the fallback is unreachable. It is
    // here so this cannot quietly start handing the caller's input back
    // again, which is the bug RETURNING was added to remove.
    Ok(rows
        .pop()
        .as_ref()
        .map(user_from_row)
        .unwrap_or_else(|| user.clone()))
}

/// The one place a `user_profiles` row becomes a [`User`], so the writer's
/// `RETURNING` row and the reader's `SELECT` cannot decode the same row two
/// different ways.
fn user_from_row(row: &sqlx::sqlite::SqliteRow) -> User {
    let onboarded_raw = row.get::<i64, _>("onboarded");
    let play_interaction_raw = row.try_get::<i64, _>("play_interaction_chime").unwrap_or(1);
    let tutorial_finished_raw = row.try_get::<i64, _>("has_finished_tutorial").unwrap_or(0);
    let migrated_microphone_raw = row
        .try_get::<i64, _>("has_migrated_preferred_microphone")
        .unwrap_or(0);
    User {
        id: row.get::<String, _>("id"),
        name: row.get::<String, _>("name"),
        bio: row.get::<String, _>("bio"),
        company: row.try_get::<Option<String>, _>("company").unwrap_or(None),
        title: row.try_get::<Option<String>, _>("title").unwrap_or(None),
        onboarded: onboarded_raw != 0,
        preferred_microphone: row.get::<Option<String>, _>("preferred_microphone"),
        preferred_language: row.get::<Option<String>, _>("preferred_language"),
        words_this_month: row.try_get::<i64, _>("words_this_month").unwrap_or(0),
        words_this_month_month: row
            .try_get::<Option<String>, _>("words_this_month_month")
            .unwrap_or(None),
        words_total: row.try_get::<i64, _>("words_total").unwrap_or(0),
        play_interaction_chime: play_interaction_raw != 0,
        interaction_feedback_volume: row
            .try_get::<Option<f64>, _>("interaction_feedback_volume")
            .ok()
            .flatten()
            .map(|v| v as f32),
        has_finished_tutorial: tutorial_finished_raw != 0,
        has_migrated_preferred_microphone: migrated_microphone_raw != 0,
        cohort: row.try_get::<Option<String>, _>("cohort").unwrap_or(None),
        styling_mode: row
            .try_get::<Option<String>, _>("styling_mode")
            .unwrap_or(None),
        selected_tone_id: row
            .try_get::<Option<String>, _>("selected_tone_id")
            .unwrap_or(None),
        active_tone_ids: row
            .try_get::<Option<String>, _>("active_tone_ids")
            .unwrap_or(None),
        streak: row.try_get::<Option<i64>, _>("streak").unwrap_or(None),
        streak_recorded_at: row
            .try_get::<Option<String>, _>("streak_recorded_at")
            .unwrap_or(None),
        referral_source: row
            .try_get::<Option<String>, _>("referral_source")
            .unwrap_or(None),
        created_at: row
            .try_get::<Option<String>, _>("created_at")
            .unwrap_or(None),
        onboarded_at: row
            .try_get::<Option<String>, _>("onboarded_at")
            .unwrap_or(None),
    }
}

pub async fn fetch_user(pool: SqlitePool) -> Result<Option<User>, sqlx::Error> {
    let row = sqlx::query(&format!(
        "SELECT {}
         FROM user_profiles
         LIMIT 1",
        user_profile_column_list(),
    ))
    .fetch_optional(&pool)
    .await?;

    Ok(row.as_ref().map(user_from_row))
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

    fn user(volume: Option<f64>) -> User {
        serde_json::from_value(serde_json::json!({
            "id": "u-1",
            "name": "Test",
            "bio": "",
            "onboarded": true,
            "interactionFeedbackVolume": volume,
        }))
        .expect("deserialize user")
    }

    /// The write clamps the volume into `[0.05, 0.5]` on the way into
    /// SQLite. The command hands its return value straight back to the
    /// frontend, so answering with the caller's own value left an
    /// out-of-range number on the volume slider until the next reload, even
    /// though the database had the clamped one.
    #[tokio::test]
    async fn upsert_returns_the_clamped_volume_that_was_stored() {
        let pool = migrated_pool().await;

        for (input, expected) in [(9.0, 0.5_f32), (0.0, 0.05_f32), (0.3, 0.3_f32)] {
            let saved = upsert_user(pool.clone(), &user(Some(input)))
                .await
                .expect("save the user");

            assert_eq!(
                saved.interaction_feedback_volume,
                Some(expected),
                "input {input} is clamped to {expected} before it is stored"
            );
            assert_eq!(
                fetch_user(pool.clone())
                    .await
                    .expect("load the user")
                    .expect("a user exists")
                    .interaction_feedback_volume,
                Some(expected),
                "the value the caller received and the value on disk must agree"
            );
        }
    }

    /// A missing volume is written as the canonical default, so the row that
    /// comes back is a complete user rather than a half-populated one.
    #[tokio::test]
    async fn upsert_returns_the_default_volume_when_none_was_given() {
        let pool = migrated_pool().await;
        let saved = upsert_user(pool.clone(), &user(None))
            .await
            .expect("save the user");

        assert_eq!(
            saved.interaction_feedback_volume,
            Some(crate::domain::user::DEFAULT_INTERACTION_FEEDBACK_VOLUME)
        );
    }

    #[tokio::test]
    async fn upsert_overwrites_an_existing_row() {
        let pool = migrated_pool().await;
        upsert_user(pool.clone(), &user(Some(0.2)))
            .await
            .expect("insert the user");
        let mut renamed = user(Some(0.4));
        renamed.name = "Renamed".to_string();

        let saved = upsert_user(pool.clone(), &renamed)
            .await
            .expect("update the user");

        assert_eq!(saved.name, "Renamed");
        assert_eq!(saved.interaction_feedback_volume, Some(0.4));
        assert_eq!(
            fetch_user(pool).await.expect("load").expect("a user exists").name,
            "Renamed"
        );
    }
}
