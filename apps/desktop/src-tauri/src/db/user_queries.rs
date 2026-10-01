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
pub async fn upsert_user(pool: SqlitePool, user: &User) -> Result<User, sqlx::Error> {
    sqlx::query(&format!(
        "INSERT INTO user_profiles ({})
     VALUES ({})
     ON CONFLICT(id) DO UPDATE SET
        {}",
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
    .execute(&pool)
    .await?;

    Ok(user.clone())
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

    let user = match row {
        Some(row) => {
            let onboarded_raw = row.get::<i64, _>("onboarded");
            let play_interaction_raw = row.try_get::<i64, _>("play_interaction_chime").unwrap_or(1);
            let tutorial_finished_raw = row.try_get::<i64, _>("has_finished_tutorial").unwrap_or(0);
            let migrated_microphone_raw = row
                .try_get::<i64, _>("has_migrated_preferred_microphone")
                .unwrap_or(0);
            Some(User {
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
            })
        }
        None => None,
    };

    Ok(user)
}
