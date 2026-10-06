use std::collections::BTreeMap;
use std::sync::OnceLock;

use chrono::{Local, NaiveDate, TimeZone, Utc};
use sqlx::{Row, Sqlite, SqlitePool, Transaction};

use crate::domain::{DailyWordActivity, User};

const FAILED_TRANSCRIPTION_MARKER: &str = "[Transcription Failed]";
const LOCAL_USER_ID: &str = super::preferences_queries::LOCAL_USER_ID;
const BROAD_BACKFILL_LOOKBACK_DAYS: i64 = 190;

/// Serializes the one-time backfill within this process. SQLite still protects
/// the transaction across processes; this lock avoids two same-process readers
/// both observing an incomplete marker before either can write it.
static BACKFILL_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn invalid_input(message: impl Into<String>) -> sqlx::Error {
    sqlx::Error::Protocol(message.into())
}

fn parse_local_date(value: &str) -> Result<NaiveDate, sqlx::Error> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| invalid_input("activity date must use YYYY-MM-DD"))?;
    if date.format("%Y-%m-%d").to_string() != value {
        return Err(invalid_input("activity date must use YYYY-MM-DD"));
    }
    Ok(date)
}

/// ECMAScript's `\s` set, used by the shared TypeScript `countWords` helper.
/// Rust's `char::is_whitespace` differs at U+0085 and does not include the BOM,
/// so spelling the set out keeps historical backfill counts in parity.
fn is_javascript_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    ) || ('\u{2000}'..='\u{200A}').contains(&character)
}

/// Rust equivalent of `@maus-inc/utilities`'s `countWords` implementation:
/// split on ECMAScript whitespace, then count each 100 UTF-16 code units as a
/// word. The latter deliberately matches JavaScript's `String.length` rather
/// than Rust's UTF-8 byte length or Unicode scalar count.
fn count_words(text: &str) -> i64 {
    let mut total = 0_i64;
    let mut token_utf16_units = 0_usize;

    for character in text.chars() {
        if is_javascript_whitespace(character) {
            if token_utf16_units > 0 {
                total += token_utf16_units.div_ceil(100) as i64;
                token_utf16_units = 0;
            }
        } else {
            token_utf16_units += character.len_utf16();
        }
    }

    if token_utf16_units > 0 {
        total += token_utf16_units.div_ceil(100) as i64;
    }

    total
}

fn timestamp_to_local_date(timestamp_ms: i64) -> Option<String> {
    Local
        .timestamp_millis_opt(timestamp_ms)
        .single()
        .map(|timestamp| timestamp.format("%Y-%m-%d").to_string())
}

async fn ensure_backfill_state(
    transaction: &mut Transaction<'_, Sqlite>,
) -> Result<(i64, bool), sqlx::Error> {
    let existing = sqlx::query(
        "SELECT cutoff_timestamp_ms, completed
         FROM daily_word_activity_backfill_state
         WHERE id = 1",
    )
    .fetch_optional(&mut **transaction)
    .await?;

    if let Some(row) = existing {
        return Ok((row.get("cutoff_timestamp_ms"), row.get::<i64, _>("completed") != 0));
    }

    // `clear_local_data` intentionally keeps this non-user control row, but
    // rebuilding it makes recovery from a partial/manual database cleanup safe.
    let cutoff = Utc::now().timestamp_millis();
    sqlx::query(
        "INSERT OR IGNORE INTO daily_word_activity_backfill_state
             (id, cutoff_timestamp_ms, completed)
         VALUES (1, ?1, 0)",
    )
    .bind(cutoff)
    .execute(&mut **transaction)
    .await?;

    let row = sqlx::query(
        "SELECT cutoff_timestamp_ms, completed
         FROM daily_word_activity_backfill_state
         WHERE id = 1",
    )
    .fetch_one(&mut **transaction)
    .await?;
    Ok((row.get("cutoff_timestamp_ms"), row.get::<i64, _>("completed") != 0))
}

async fn add_daily_words(
    transaction: &mut Transaction<'_, Sqlite>,
    local_date: &str,
    word_count: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO daily_word_activity (local_date, word_count)
         VALUES (?1, ?2)
         ON CONFLICT(local_date) DO UPDATE SET
             word_count = daily_word_activity.word_count + excluded.word_count",
    )
    .bind(local_date)
    .bind(word_count)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn ensure_backfilled(pool: SqlitePool) -> Result<(), sqlx::Error> {
    let _guard = BACKFILL_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    let mut transaction = pool.begin().await?;
    let (cutoff_timestamp_ms, completed) = ensure_backfill_state(&mut transaction).await?;
    if completed {
        transaction.commit().await?;
        return Ok(());
    }

    // The SQL bound is intentionally wider than the visible 26-week calendar:
    // it keeps the query index-backed while leaving room for the local UTC
    // offset. Every eligible retained row in that bounded window is grouped by
    // its local date; the requested range is applied only when reading the view.
    let broad_lower_bound = Utc::now().timestamp_millis()
        - BROAD_BACKFILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    let rows = sqlx::query(
        "SELECT transcript, timestamp
         FROM transcriptions
         WHERE timestamp >= ?1
           AND timestamp < ?2
           AND (remote_status IS NULL OR remote_status != 'received')
         ORDER BY timestamp ASC",
    )
    .bind(broad_lower_bound)
    .bind(cutoff_timestamp_ms)
    .fetch_all(&mut *transaction)
    .await?;

    let mut totals_by_date = BTreeMap::<String, i64>::new();
    for row in rows {
        let transcript: String = row.get("transcript");
        if transcript == FAILED_TRANSCRIPTION_MARKER {
            continue;
        }
        let timestamp_ms: i64 = row.get("timestamp");
        let Some(local_date) = timestamp_to_local_date(timestamp_ms) else {
            continue;
        };
        let words = count_words(&transcript);
        if words <= 0 {
            continue;
        }
        *totals_by_date.entry(local_date).or_default() += words;
    }

    // Backfill and new live events may share a date. Accumulating in this
    // transaction preserves those new counts, while the completion marker makes
    // the retained-record contribution apply exactly once.
    for (local_date, word_count) in totals_by_date {
        add_daily_words(&mut transaction, &local_date, word_count).await?;
    }

    sqlx::query(
        "UPDATE daily_word_activity_backfill_state
         SET completed = 1
         WHERE id = 1",
    )
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

pub async fn list_daily_word_activity(
    pool: SqlitePool,
    start_date: &str,
    end_date: &str,
) -> Result<Vec<DailyWordActivity>, sqlx::Error> {
    // Revalidate before the backfill and query; comparisons below are lexical
    // only because every accepted date has a fixed-width ISO representation.
    let start = parse_local_date(start_date)?;
    let end = parse_local_date(end_date)?;
    if start > end {
        return Err(invalid_input("activity start date must not follow end date"));
    }
    ensure_backfilled(pool.clone()).await?;

    let rows = sqlx::query(
        "SELECT local_date, word_count
         FROM daily_word_activity
         WHERE local_date >= ?1 AND local_date <= ?2
         ORDER BY local_date ASC",
    )
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| DailyWordActivity {
            local_date: row.get("local_date"),
            word_count: row.get("word_count"),
        })
        .collect())
}

/// Idempotently record one eligible dictation. The event ID is local-only and
/// contains no transcript text. The unique insert, daily rollup, monthly/lifetime
/// counters, and returned user row all commit or roll back together.
pub async fn record_usage_words(
    pool: SqlitePool,
    event_id: &str,
    local_date: &str,
    word_count: i64,
) -> Result<User, sqlx::Error> {
    parse_local_date(local_date)?;
    if event_id.trim().is_empty() {
        return Err(invalid_input("usage event ID must not be empty"));
    }
    if word_count <= 0 {
        return Err(invalid_input("usage word count must be positive"));
    }

    let month = &local_date[..7];
    let mut transaction = pool.begin().await?;
    let inserted = sqlx::query(
        "INSERT OR IGNORE INTO daily_word_activity_events
             (event_id, local_date, word_count)
         VALUES (?1, ?2, ?3)",
    )
    .bind(event_id)
    .bind(local_date)
    .bind(word_count)
    .execute(&mut *transaction)
    .await?
    .rows_affected()
        == 1;

    if !inserted {
        let prior = sqlx::query(
            "SELECT local_date, word_count
             FROM daily_word_activity_events
             WHERE event_id = ?1",
        )
        .bind(event_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;
        let prior_date: String = prior.get("local_date");
        let prior_words: i64 = prior.get("word_count");
        if prior_date != local_date || prior_words != word_count {
            return Err(invalid_input(
                "usage event ID was reused with different activity data",
            ));
        }
        let user_row = sqlx::query("SELECT * FROM user_profiles WHERE id = ?1")
            .bind(LOCAL_USER_ID)
            .fetch_optional(&mut *transaction)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;
        let user = super::user_queries::user_from_row(&user_row);
        transaction.commit().await?;
        return Ok(user);
    }

    add_daily_words(&mut transaction, local_date, word_count).await?;

    let user_row = sqlx::query(
        "UPDATE user_profiles
         SET words_this_month =
                 CASE WHEN words_this_month_month = ?1
                      THEN words_this_month ELSE 0 END + ?2,
             words_this_month_month = ?1,
             words_total = words_total + ?2
         WHERE id = ?3
         RETURNING *",
    )
    .bind(month)
    .bind(word_count)
    .bind(LOCAL_USER_ID)
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(sqlx::Error::RowNotFound)?;

    let user = super::user_queries::user_from_row(&user_row);
    transaction.commit().await?;
    Ok(user)
}

#[cfg(test)]
mod tests {
    use super::{
        count_words, list_daily_word_activity, record_usage_words, FAILED_TRANSCRIPTION_MARKER,
    };
    use crate::domain::User;
    use chrono::{Datelike, Days, Local, NaiveDate, TimeZone};
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::{Row, SqlitePool};

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

    fn user() -> User {
        serde_json::from_value(serde_json::json!({
            "id": "local-user-id",
            "name": "Test",
            "bio": "",
            "onboarded": true,
            "wordsThisMonth": 4,
            "wordsThisMonthMonth": "2026-10",
            "wordsTotal": 40,
        }))
        .expect("deserialize user")
    }

    async fn seed_user(pool: &SqlitePool) {
        crate::db::user_queries::upsert_user(pool.clone(), &user())
            .await
            .expect("seed local user");
    }

    fn date_key(date: NaiveDate) -> String {
        date.format("%Y-%m-%d").to_string()
    }

    fn local_timestamp_ms(date: NaiveDate) -> i64 {
        Local
            .with_ymd_and_hms(date.year(), date.month(), date.day(), 12, 0, 0)
            .single()
            .expect("local noon exists")
            .timestamp_millis()
    }

    fn local_start_of_day_ms(date: NaiveDate) -> i64 {
        Local
            .with_ymd_and_hms(date.year(), date.month(), date.day(), 0, 0, 0)
            .single()
            .expect("local midnight exists")
            .timestamp_millis()
    }

    #[test]
    fn count_words_matches_the_shared_javascript_word_counter() {
        assert_eq!(count_words("Hello world"), 2);
        assert_eq!(count_words("  Hello\tworld\n"), 2);
        assert_eq!(count_words("x".repeat(101).as_str()), 2);
        assert_eq!(count_words(&"😀".repeat(50)), 1);
        assert_eq!(count_words(&"😀".repeat(51)), 2);
        assert_eq!(count_words("\u{FEFF}hello\u{FEFF}world\u{FEFF}"), 2);
        assert_eq!(count_words("\u{0085}"), 1);
        assert_eq!(count_words("\u{3000} "), 0);
    }

    #[tokio::test]
    async fn first_insert_and_same_day_events_accumulate_once() {
        let pool = migrated_pool().await;
        seed_user(&pool).await;
        let date = "2026-10-06";

        let first = record_usage_words(pool.clone(), "event-a", date, 3)
            .await
            .expect("record first event");
        assert_eq!(first.words_this_month, 7);
        assert_eq!(first.words_total, 43);

        let duplicate = record_usage_words(pool.clone(), "event-a", date, 3)
            .await
            .expect("duplicate event is idempotent");
        assert_eq!(duplicate.words_this_month, 7);
        assert_eq!(duplicate.words_total, 43);

        let second = record_usage_words(pool.clone(), "event-b", date, 5)
            .await
            .expect("record second event");
        assert_eq!(second.words_this_month, 12);
        assert_eq!(second.words_total, 48);

        let activity = list_daily_word_activity(pool, date, date)
            .await
            .expect("load activity");
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].word_count, 8);
    }

    #[tokio::test]
    async fn usage_crossing_a_month_boundary_resets_only_the_month_counter() {
        let pool = migrated_pool().await;
        seed_user(&pool).await;

        let october = record_usage_words(pool.clone(), "october", "2026-10-31", 2)
            .await
            .expect("record in October");
        assert_eq!(october.words_this_month, 6);
        assert_eq!(october.words_this_month_month.as_deref(), Some("2026-10"));

        let november = record_usage_words(pool, "november", "2026-11-01", 7)
            .await
            .expect("record in November");
        assert_eq!(november.words_this_month, 7);
        assert_eq!(november.words_this_month_month.as_deref(), Some("2026-11"));
        assert_eq!(november.words_total, 49);
    }

    #[tokio::test]
    async fn backfill_is_idempotent_and_never_changes_profile_totals() {
        let pool = migrated_pool().await;
        seed_user(&pool).await;
        let date = Local::now()
            .date_naive()
            .checked_sub_days(Days::new(2))
            .expect("recent date");
        let date = date_key(date);
        let timestamp = local_timestamp_ms(
            NaiveDate::parse_from_str(&date, "%Y-%m-%d").expect("valid date"),
        );

        sqlx::query("INSERT INTO transcriptions (id, transcript, timestamp) VALUES (?1, ?2, ?3)")
            .bind("old-a")
            .bind("one two")
            .bind(timestamp)
            .execute(&pool)
            .await
            .expect("insert retained row");
        sqlx::query("INSERT INTO transcriptions (id, transcript, timestamp) VALUES (?1, ?2, ?3)")
            .bind("old-b")
            .bind("three")
            .bind(timestamp + 1)
            .execute(&pool)
            .await
            .expect("insert second retained row");
        sqlx::query("INSERT INTO transcriptions (id, transcript, timestamp) VALUES (?1, ?2, ?3)")
            .bind("failed")
            .bind(FAILED_TRANSCRIPTION_MARKER)
            .bind(timestamp + 2)
            .execute(&pool)
            .await
            .expect("insert failed-transcription marker");
        sqlx::query(
            "INSERT INTO transcriptions (id, transcript, timestamp, remote_status)
             VALUES (?1, ?2, ?3, ?4)",
        )
        .bind("remote-received")
        .bind("not included in local usage stats")
        .bind(timestamp + 3)
        .bind("received")
        .execute(&pool)
        .await
        .expect("insert remote transcript");

        let first = list_daily_word_activity(pool.clone(), &date, &date)
            .await
            .expect("backfill retained rows");
        let second = list_daily_word_activity(pool.clone(), &date, &date)
            .await
            .expect("read already-backfilled rows");
        assert_eq!(first, second);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].word_count, 3);

        let profile = crate::db::user_queries::fetch_user(pool)
            .await
            .expect("read profile")
            .expect("profile exists");
        assert_eq!(profile.words_this_month, 4);
        assert_eq!(profile.words_total, 40);
    }

    #[tokio::test]
    async fn live_events_before_first_backfill_are_preserved_and_not_backfilled_twice() {
        let pool = migrated_pool().await;
        seed_user(&pool).await;
        let date = Local::now().date_naive();
        let timestamp = local_start_of_day_ms(date);
        let date = date_key(date);
        sqlx::query("INSERT INTO transcriptions (id, transcript, timestamp) VALUES (?1, ?2, ?3)")
            .bind("old-row")
            .bind("saved words")
            .bind(timestamp)
            .execute(&pool)
            .await
            .expect("insert pre-feature retained row");

        // A post-migration transcription must be excluded from backfill. Its
        // matching live usage event is counted only by the event path.
        let live_timestamp = chrono::Utc::now().timestamp_millis();
        sqlx::query("INSERT INTO transcriptions (id, transcript, timestamp) VALUES (?1, ?2, ?3)")
            .bind("new-row")
            .bind("live words")
            .bind(live_timestamp)
            .execute(&pool)
            .await
            .expect("insert post-feature row");
        record_usage_words(pool.clone(), "new-row", &date, 2)
            .await
            .expect("record live event");

        let activity = list_daily_word_activity(pool, &date, &date)
            .await
            .expect("backfill old row and retain live event");
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].word_count, 4);
    }

    #[tokio::test]
    async fn invalid_or_conflicting_usage_data_does_not_partially_update_counts() {
        let pool = migrated_pool().await;
        seed_user(&pool).await;
        record_usage_words(pool.clone(), "same", "2026-10-06", 2)
            .await
            .expect("record first event");

        assert!(record_usage_words(pool.clone(), "same", "2026-10-06", 3)
            .await
            .is_err());
        assert!(record_usage_words(pool.clone(), "bad-date", "not-a-date", 3)
            .await
            .is_err());

        let profile = crate::db::user_queries::fetch_user(pool.clone())
            .await
            .expect("read profile")
            .expect("profile exists");
        assert_eq!(profile.words_total, 42);
        let activity = list_daily_word_activity(pool, "2026-10-06", "2026-10-06")
            .await
            .expect("read activity");
        assert_eq!(activity[0].word_count, 2);
    }
}
