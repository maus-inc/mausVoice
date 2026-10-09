use std::sync::LazyLock;

use chrono::{Local, NaiveDate, TimeZone};
use sqlx::{Row, Sqlite, SqlitePool, Transaction};

use crate::domain::DailyWordActivity;

const MAX_SAFE_JS_INTEGER: i64 = 9_007_199_254_740_991;
const BACKFILL_BATCH_SIZE: i64 = 500;
const UTC_RANGE_PADDING_MILLIS: i64 = 2 * 24 * 60 * 60 * 1000;
const FAILED_TRANSCRIPTION_MARKER: &str = "[Transcription Failed]";
const BACKFILL_EVENT_SOURCE: &str = "backfill";

/// Serializes each backfill batch, live meter, and local-data wipe inside the
/// desktop process. The event table's primary key remains the cross-process boundary.
static ACTIVITY_WRITE_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

pub(crate) async fn lock_activity_writes() -> tokio::sync::MutexGuard<'static, ()> {
    ACTIVITY_WRITE_LOCK.lock().await
}

fn protocol_error(message: impl Into<String>) -> sqlx::Error {
    sqlx::Error::Protocol(message.into())
}

fn parse_local_date(value: &str) -> Result<NaiveDate, sqlx::Error> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| protocol_error("Expected a valid local date in YYYY-MM-DD format"))?;
    if date.format("%Y-%m-%d").to_string() != value {
        return Err(protocol_error(
            "Expected a valid local date in YYYY-MM-DD format",
        ));
    }
    Ok(date)
}

/// ECMAScript's `\s` set. Rust's `char::is_whitespace` includes U+0085, which
/// JavaScript does not, so using it would make a historical backfill disagree
/// with the existing `countWords` helper.
fn is_ecmascript_whitespace(character: char) -> bool {
    matches!(
        character as u32,
        0x0009..=0x000D
            | 0x0020
            | 0x00A0
            | 0x1680
            | 0x2000..=0x200A
            | 0x2028..=0x2029
            | 0x202F
            | 0x205F
            | 0x3000
            | 0xFEFF
    )
}

/// Mirrors `packages/utilities/src/string.ts`: split on ECMAScript whitespace,
/// then add `ceil(token.length / 100)`, where JavaScript `length` counts UTF-16
/// code units rather than Unicode scalar values or UTF-8 bytes.
fn count_words(text: &str) -> Result<i64, sqlx::Error> {
    text.split(is_ecmascript_whitespace)
        .filter(|token| !token.is_empty())
        .try_fold(0_i64, |total, token| {
            let utf16_units = u64::try_from(token.encode_utf16().count())
                .map_err(|_| protocol_error("Transcription word count is out of range"))?;
            let token_words = utf16_units.div_ceil(100);
            let token_words = i64::try_from(token_words)
                .map_err(|_| protocol_error("Transcription word count is out of range"))?;
            let next = total
                .checked_add(token_words)
                .filter(|count| *count <= MAX_SAFE_JS_INTEGER)
                .ok_or_else(|| protocol_error("Transcription word count is out of range"))?;
            Ok(next)
        })
}

fn local_date_from_timestamp(timestamp_ms: i64) -> Option<String> {
    Local
        .timestamp_millis_opt(timestamp_ms)
        .single()
        .map(|timestamp| timestamp.format("%Y-%m-%d").to_string())
}

fn backfill_timestamp_bounds(start_date: NaiveDate, end_date: NaiveDate) -> (i64, i64) {
    let start_utc = start_date
        .and_hms_opt(0, 0, 0)
        .expect("midnight is a valid naive time")
        .and_utc()
        .timestamp_millis();
    let end_utc = end_date
        .succ_opt()
        .map(|next_date| {
            next_date
                .and_hms_opt(0, 0, 0)
                .expect("midnight is a valid naive time")
                .and_utc()
                .timestamp_millis()
        })
        .unwrap_or(i64::MAX);
    (
        start_utc.saturating_sub(UTC_RANGE_PADDING_MILLIS),
        end_utc.saturating_add(UTC_RANGE_PADDING_MILLIS),
    )
}

async fn add_daily_words(
    transaction: &mut Transaction<'_, Sqlite>,
    local_date: &str,
    word_count: i64,
) -> Result<(), sqlx::Error> {
    if word_count == 0 {
        return Ok(());
    }

    let result = sqlx::query(
        "INSERT INTO daily_word_activity (local_date, word_count)
         VALUES (?1, ?2)
         ON CONFLICT(local_date) DO UPDATE SET
             word_count = daily_word_activity.word_count + excluded.word_count
         WHERE daily_word_activity.word_count <= ?3 - excluded.word_count",
    )
    .bind(local_date)
    .bind(word_count)
    .bind(MAX_SAFE_JS_INTEGER)
    .execute(&mut **transaction)
    .await?;

    if result.rows_affected() != 1 {
        return Err(protocol_error(
            "Daily activity total exceeds the JavaScript safe-integer range",
        ));
    }
    Ok(())
}

async fn remove_daily_words(
    transaction: &mut Transaction<'_, Sqlite>,
    local_date: &str,
    word_count: i64,
) -> Result<(), sqlx::Error> {
    if word_count == 0 {
        return Ok(());
    }

    let removed = sqlx::query(
        "UPDATE daily_word_activity
         SET word_count = word_count - ?1
         WHERE local_date = ?2 AND word_count >= ?1",
    )
    .bind(word_count)
    .bind(local_date)
    .execute(&mut **transaction)
    .await?;
    if removed.rows_affected() != 1 {
        return Err(protocol_error(
            "Daily activity aggregate is inconsistent with its event ledger",
        ));
    }

    sqlx::query("DELETE FROM daily_word_activity WHERE local_date = ?1 AND word_count = 0")
        .bind(local_date)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

/// Backfill missing events from the requested local-date range. UTC bounds use
/// a two-day margin so local offsets cannot exclude boundary timestamps; each
/// row is then checked against the exact local dates. This repairs chart totals
/// without scanning history outside the visible range or changing profile
/// counters.
async fn backfill_missing_transcriptions(
    pool: &SqlitePool,
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> Result<(), sqlx::Error> {
    let (start_timestamp, end_timestamp) = backfill_timestamp_bounds(start_date, end_date);
    let batch_size = usize::try_from(BACKFILL_BATCH_SIZE).expect("positive batch size fits usize");
    let mut cursor: Option<(i64, String)> = None;

    loop {
        // Acquire the write lock before reading the page. Otherwise a concurrent
        // clear_local_data could delete history after this query, then a stale
        // page could recreate its aggregate rows after the clear commits.
        let _guard = lock_activity_writes().await;
        let cursor_timestamp = cursor.as_ref().map(|(timestamp, _)| *timestamp);
        let cursor_id = cursor.as_ref().map(|(_, id)| id.as_str());
        let rows = sqlx::query(
            "SELECT transcription.id, transcription.transcript, transcription.timestamp
             FROM transcriptions AS transcription
             WHERE (?1 IS NULL
                    OR transcription.timestamp > ?1
                    OR (transcription.timestamp = ?1 AND transcription.id > ?2))
               AND transcription.timestamp >= ?3
               AND transcription.timestamp < ?4
               AND COALESCE(transcription.remote_status, '') != 'received'
               AND transcription.transcript != ?5
               AND NOT EXISTS (
                   SELECT 1
                   FROM daily_word_activity_events AS event
                   WHERE event.event_id = transcription.id
               )
             ORDER BY transcription.timestamp ASC, transcription.id ASC
             LIMIT ?6",
        )
        .bind(cursor_timestamp)
        .bind(cursor_id)
        .bind(start_timestamp)
        .bind(end_timestamp)
        .bind(FAILED_TRANSCRIPTION_MARKER)
        .bind(BACKFILL_BATCH_SIZE)
        .fetch_all(pool)
        .await?;

        if rows.is_empty() {
            break;
        }

        let mut transaction = pool.begin().await?;
        for row in &rows {
            let event_id: String = row.try_get("id")?;
            let transcript: String = row.try_get("transcript")?;
            let timestamp: i64 = row.try_get("timestamp")?;
            let Some(local_date) = local_date_from_timestamp(timestamp) else {
                // A corrupt or out-of-range timestamp cannot be assigned to a
                // local calendar day. Do not invent one or count its text.
                continue;
            };
            let parsed_local_date = parse_local_date(&local_date)?;
            if parsed_local_date < start_date || parsed_local_date > end_date {
                continue;
            }
            let word_count = count_words(&transcript)?;

            // Another process may have recorded the live event after the page
            // query. The primary key decides which writer owns the aggregate.
            let inserted = sqlx::query(
                "INSERT INTO daily_word_activity_events
                     (event_id, local_date, word_count, source)
                 VALUES (?1, ?2, ?3, 'backfill')
                 ON CONFLICT(event_id) DO NOTHING",
            )
            .bind(&event_id)
            .bind(&local_date)
            .bind(word_count)
            .execute(&mut *transaction)
            .await?;

            if inserted.rows_affected() == 1 {
                add_daily_words(&mut transaction, &local_date, word_count).await?;
            }
        }

        let last_row = rows.last().expect("non-empty rows checked above");
        cursor = Some((last_row.try_get("timestamp")?, last_row.try_get("id")?));
        transaction.commit().await?;

        if rows.len() < batch_size {
            break;
        }
    }

    Ok(())
}

/// Record a live dictation or opted-in incognito event exactly once, update the
/// legacy monthly/lifetime profile totals in the same transaction, and return
/// the stored profile. If backfill saw an edited transcript before the live
/// meter arrived, promotion replaces that estimate with the original live count.
pub async fn record_usage_words(
    pool: SqlitePool,
    event_id: &str,
    local_date: &str,
    word_count: i64,
) -> Result<crate::domain::User, sqlx::Error> {
    if event_id.trim().is_empty() {
        return Err(protocol_error("Usage event id must not be empty"));
    }
    if !(1..=MAX_SAFE_JS_INTEGER).contains(&word_count) {
        return Err(protocol_error("Usage word count is out of range"));
    }
    let local_date = parse_local_date(local_date)?;
    let local_date = local_date.format("%Y-%m-%d").to_string();
    let month = local_date[..7].to_string();

    let _guard = lock_activity_writes().await;
    let mut transaction = pool.begin().await?;
    let inserted = sqlx::query(
        "INSERT INTO daily_word_activity_events
             (event_id, local_date, word_count, source)
         VALUES (?1, ?2, ?3, 'live')
         ON CONFLICT(event_id) DO NOTHING",
    )
    .bind(event_id)
    .bind(&local_date)
    .bind(word_count)
    .execute(&mut *transaction)
    .await?;

    let should_update_profile = if inserted.rows_affected() == 1 {
        add_daily_words(&mut transaction, &local_date, word_count).await?;
        true
    } else {
        let existing = sqlx::query(
            "SELECT local_date, word_count, source
             FROM daily_word_activity_events
             WHERE event_id = ?1",
        )
        .bind(event_id)
        .fetch_one(&mut *transaction)
        .await?;
        let existing_date: String = existing.try_get("local_date")?;
        let existing_word_count: i64 = existing.try_get("word_count")?;
        let existing_source: String = existing.try_get("source")?;

        if existing_source == BACKFILL_EVENT_SOURCE {
            let promoted = sqlx::query(
                "UPDATE daily_word_activity_events
                 SET local_date = ?2, word_count = ?3, source = 'live'
                 WHERE event_id = ?1
                   AND source = 'backfill'
                   AND local_date = ?4
                   AND word_count = ?5",
            )
            .bind(event_id)
            .bind(&local_date)
            .bind(word_count)
            .bind(&existing_date)
            .bind(existing_word_count)
            .execute(&mut *transaction)
            .await?;
            if promoted.rows_affected() == 1 {
                // Backfill can only estimate a legacy row from the text it sees
                // at read time. The original live count is authoritative when
                // its delayed meter arrives, so reconcile both affected dates.
                if existing_date != local_date || existing_word_count != word_count {
                    remove_daily_words(&mut transaction, &existing_date, existing_word_count)
                        .await?;
                    add_daily_words(&mut transaction, &local_date, word_count).await?;
                }
                true
            } else {
                // Another app process promoted this event after our SELECT.
                // Only the process that changes backfill -> live owns the
                // one profile increment.
                false
            }
        } else {
            if existing_date != local_date || existing_word_count != word_count {
                return Err(protocol_error(
                    "Usage event id was already recorded with different data",
                ));
            }
            false
        }
    };

    if should_update_profile {
        let updated = sqlx::query(
            "UPDATE user_profiles
             SET words_total = words_total + ?1,
                 words_this_month = CASE
                     WHEN words_this_month_month = ?2
                         THEN words_this_month + ?1
                     WHEN words_this_month_month IS NULL
                          OR words_this_month_month < ?2
                         THEN ?1
                     ELSE words_this_month
                 END,
                 words_this_month_month = CASE
                     WHEN words_this_month_month IS NULL
                          OR words_this_month_month < ?2
                         THEN ?2
                     ELSE words_this_month_month
                 END
             WHERE id = (SELECT id FROM user_profiles LIMIT 1)
               AND words_total >= 0
               AND words_total <= ?3 - ?1
               AND (
                   words_this_month_month IS NOT ?2
                   OR (
                       words_this_month >= 0
                       AND words_this_month <= ?3 - ?1
                   )
               )
             RETURNING id",
        )
        .bind(word_count)
        .bind(&month)
        .bind(MAX_SAFE_JS_INTEGER)
        .fetch_optional(&mut *transaction)
        .await?;
        if updated.is_none() {
            let profile_exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_profiles")
                .fetch_one(&mut *transaction)
                .await?;
            if profile_exists == 0 {
                return Err(sqlx::Error::RowNotFound);
            }
            return Err(protocol_error(
                "Usage totals exceed the JavaScript safe-integer range",
            ));
        }
    }

    transaction.commit().await?;
    drop(_guard);
    crate::db::user_queries::fetch_user(pool)
        .await?
        .ok_or(sqlx::Error::RowNotFound)
}

/// Fetch inclusive local-date totals, repairing any saved transcriptions that
/// have not yet been represented in the event ledger first.
pub async fn fetch_daily_activity(
    pool: SqlitePool,
    start_date: &str,
    end_date: &str,
) -> Result<Vec<DailyWordActivity>, sqlx::Error> {
    let start = parse_local_date(start_date)?;
    let end = parse_local_date(end_date)?;
    if start > end {
        return Err(protocol_error("Start date must not be after end date"));
    }

    backfill_missing_transcriptions(&pool, start, end).await?;
    let rows = sqlx::query(
        "SELECT local_date, word_count
         FROM daily_word_activity
         WHERE local_date >= ?1 AND local_date <= ?2
         ORDER BY local_date ASC",
    )
    .bind(start.format("%Y-%m-%d").to_string())
    .bind(end.format("%Y-%m-%d").to_string())
    .fetch_all(&pool)
    .await?;

    rows.into_iter()
        .map(|row| {
            Ok(DailyWordActivity {
                local_date: row.try_get("local_date")?,
                word_count: row.try_get("word_count")?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        count_words, fetch_daily_activity, local_date_from_timestamp, parse_local_date,
        record_usage_words, MAX_SAFE_JS_INTEGER,
    };
    use crate::db::user_queries::{fetch_user, upsert_user};
    use crate::domain::User;
    use chrono::{Local, TimeZone};
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

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

    fn user(month: Option<&str>, words_this_month: i64, words_total: i64) -> User {
        serde_json::from_value(serde_json::json!({
            "id": "local-user-id",
            "name": "Test",
            "bio": "",
            "onboarded": true,
            "wordsThisMonth": words_this_month,
            "wordsThisMonthMonth": month,
            "wordsTotal": words_total,
        }))
        .expect("deserialize test user")
    }

    async fn seed_user(pool: &SqlitePool, month: Option<&str>, words: i64, total: i64) {
        upsert_user(pool.clone(), &user(month, words, total))
            .await
            .expect("insert test profile");
    }

    async fn insert_transcription(
        pool: &SqlitePool,
        id: &str,
        transcript: &str,
        timestamp: i64,
        remote_status: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO transcriptions (id, transcript, timestamp, remote_status)
             VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(id)
        .bind(transcript)
        .bind(timestamp)
        .bind(remote_status)
        .execute(pool)
        .await
        .expect("insert test transcription");
    }

    #[test]
    fn word_count_matches_javascript_whitespace_and_utf16_length() {
        assert_eq!(count_words("").unwrap(), 0);
        assert_eq!(count_words(" \t\n ").unwrap(), 0);
        assert_eq!(count_words("one\u{00A0}two\u{FEFF}three").unwrap(), 3);
        assert_eq!(count_words(&"a".repeat(100)).unwrap(), 1);
        assert_eq!(count_words(&"a".repeat(101)).unwrap(), 2);
        // An astral character occupies two UTF-16 code units in JavaScript.
        assert_eq!(count_words(&"😀".repeat(50)).unwrap(), 1);
        // U+0085 is not part of ECMAScript's whitespace set.
        assert_eq!(count_words("one\u{0085}two").unwrap(), 1);
    }

    #[test]
    fn local_dates_are_strict_and_calendar_valid() {
        assert!(parse_local_date("2024-02-29").is_ok());
        assert!(parse_local_date("2025-02-29").is_err());
        assert!(parse_local_date("2025-2-03").is_err());
        assert!(parse_local_date("2025-01-01 ").is_err());
    }

    #[tokio::test]
    async fn live_events_are_idempotent_and_update_monthly_and_lifetime_totals() {
        let pool = migrated_pool().await;
        seed_user(&pool, Some("2025-12"), 25, 100).await;

        let first = record_usage_words(pool.clone(), "transcription-1", "2026-01-02", 8)
            .await
            .expect("record live usage");
        assert_eq!(first.words_total, 108);
        assert_eq!(first.words_this_month, 8);
        assert_eq!(first.words_this_month_month.as_deref(), Some("2026-01"));

        let duplicate = record_usage_words(pool.clone(), "transcription-1", "2026-01-02", 8)
            .await
            .expect("duplicate delivery is a no-op");
        assert_eq!(duplicate.words_total, 108);
        assert_eq!(duplicate.words_this_month, 8);

        let activity = fetch_daily_activity(pool, "2026-01-01", "2026-01-31")
            .await
            .expect("read activity");
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].local_date, "2026-01-02");
        assert_eq!(activity[0].word_count, 8);
    }

    #[tokio::test]
    async fn late_usage_from_an_older_month_does_not_regress_the_monthly_profile() {
        let pool = migrated_pool().await;
        seed_user(&pool, Some("2026-02"), 75, 100).await;

        let profile = record_usage_words(pool, "late-january", "2026-01-31", 8)
            .await
            .expect("record late usage");

        assert_eq!(profile.words_total, 108);
        assert_eq!(profile.words_this_month, 75);
        assert_eq!(profile.words_this_month_month.as_deref(), Some("2026-02"));
    }

    #[tokio::test]
    async fn backfill_paginates_same_timestamp_rows_without_skipping_tie_breaker_ids() {
        let pool = migrated_pool().await;
        let timestamp = Local
            .with_ymd_and_hms(2026, 1, 2, 12, 0, 0)
            .single()
            .expect("valid local timestamp")
            .timestamp_millis();
        sqlx::query(
            "WITH RECURSIVE sequence(n) AS (
                 SELECT 1
                 UNION ALL SELECT n + 1 FROM sequence WHERE n < 501
             )
             INSERT INTO transcriptions (id, transcript, timestamp)
             SELECT printf('pagination-%04d', n), 'one', ?1 FROM sequence",
        )
        .bind(timestamp)
        .execute(&pool)
        .await
        .expect("insert history across two batches");
        let transcription_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcriptions")
            .fetch_one(&pool)
            .await
            .expect("count seeded history");
        assert_eq!(transcription_count, 501);

        let date = local_date_from_timestamp(timestamp).expect("local date");
        let activity = fetch_daily_activity(pool.clone(), &date, &date)
            .await
            .expect("backfill both pages");
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].word_count, 501);

        let event_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM daily_word_activity_events")
                .fetch_one(&pool)
                .await
                .expect("count paginated events");
        assert_eq!(event_count, 501);
    }

    #[tokio::test]
    async fn backfill_skips_remote_and_failed_rows_and_does_not_repeat_totals() {
        let pool = migrated_pool().await;
        seed_user(&pool, Some("2025-12"), 0, 0).await;
        let timestamp = Local
            .with_ymd_and_hms(2026, 1, 2, 12, 0, 0)
            .single()
            .expect("valid local timestamp")
            .timestamp_millis();
        insert_transcription(&pool, "local", "hello there", timestamp, None).await;
        insert_transcription(&pool, "remote", "remote words", timestamp, Some("received")).await;
        insert_transcription(&pool, "failed", "[Transcription Failed]", timestamp, None).await;

        for _ in 0..2 {
            let activity = fetch_daily_activity(pool.clone(), "2026-01-02", "2026-01-02")
                .await
                .expect("backfill and read");
            assert_eq!(activity.len(), 1);
            assert_eq!(activity[0].word_count, 2);
        }
        let profile = fetch_user(pool.clone())
            .await
            .expect("read profile")
            .expect("profile exists");
        // Backfill fills the chart only. Existing month/total counters already
        // represent legacy history and must not be incremented a second time.
        assert_eq!(profile.words_total, 0);
        assert_eq!(profile.words_this_month, 0);
        let event_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM daily_word_activity_events WHERE source = 'backfill'",
        )
        .fetch_one(&pool)
        .await
        .expect("count backfill events");
        assert_eq!(event_count, 1);
    }

    #[tokio::test]
    async fn later_transcript_edits_do_not_rewrite_backfilled_usage() {
        let pool = migrated_pool().await;
        let timestamp = Local
            .with_ymd_and_hms(2026, 1, 2, 12, 0, 0)
            .single()
            .expect("valid local timestamp")
            .timestamp_millis();
        let date = local_date_from_timestamp(timestamp).expect("local date");
        insert_transcription(
            &pool,
            "edited-after-backfill",
            "original words",
            timestamp,
            None,
        )
        .await;

        let initial = fetch_daily_activity(pool.clone(), &date, &date)
            .await
            .expect("backfill saved row");
        assert_eq!(initial[0].word_count, 2);

        sqlx::query("UPDATE transcriptions SET transcript = ?1 WHERE id = ?2")
            .bind("a corrected transcript with more words")
            .bind("edited-after-backfill")
            .execute(&pool)
            .await
            .expect("edit saved transcript");

        let after_edit = fetch_daily_activity(pool, &date, &date)
            .await
            .expect("read immutable usage event");
        assert_eq!(after_edit[0].word_count, 2);
    }

    #[tokio::test]
    async fn backfill_only_counts_rows_in_the_requested_local_date_range() {
        let pool = migrated_pool().await;
        seed_user(&pool, Some("2026-01"), 0, 0).await;
        let outside_timestamp = Local
            .with_ymd_and_hms(2026, 1, 1, 12, 0, 0)
            .single()
            .expect("valid local timestamp")
            .timestamp_millis();
        let inside_timestamp = Local
            .with_ymd_and_hms(2026, 1, 2, 12, 0, 0)
            .single()
            .expect("valid local timestamp")
            .timestamp_millis();
        let outside_date = local_date_from_timestamp(outside_timestamp).expect("local date");
        let inside_date = local_date_from_timestamp(inside_timestamp).expect("local date");
        insert_transcription(&pool, "outside-range", "old words", outside_timestamp, None).await;
        insert_transcription(&pool, "inside-range", "chart words", inside_timestamp, None).await;

        let activity = fetch_daily_activity(pool.clone(), &inside_date, &inside_date)
            .await
            .expect("backfill requested date");

        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].local_date, inside_date);
        assert_eq!(activity[0].word_count, 2);
        let outside_event_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM daily_word_activity_events WHERE event_id = 'outside-range'",
        )
        .fetch_one(&pool)
        .await
        .expect("count out-of-range events");
        assert_eq!(outside_event_count, 0);
    }

    #[tokio::test]
    async fn live_meter_promotes_a_backfilled_event_without_double_counting_activity() {
        let pool = migrated_pool().await;
        seed_user(&pool, Some("2026-01"), 0, 0).await;
        let timestamp = Local
            .with_ymd_and_hms(2026, 1, 2, 12, 0, 0)
            .single()
            .expect("valid local timestamp")
            .timestamp_millis();
        insert_transcription(&pool, "new-transcription", "hello world", timestamp, None).await;

        let date = local_date_from_timestamp(timestamp).expect("local date");
        let backfilled = fetch_daily_activity(pool.clone(), &date, &date)
            .await
            .expect("backfill saved row");
        assert_eq!(backfilled[0].word_count, 2);

        let profile = record_usage_words(pool.clone(), "new-transcription", &date, 2)
            .await
            .expect("promote and account live event");
        assert_eq!(profile.words_total, 2);
        assert_eq!(profile.words_this_month, 2);

        let duplicate = record_usage_words(pool.clone(), "new-transcription", &date, 2)
            .await
            .expect("repeat live event");
        assert_eq!(duplicate.words_total, 2);
        let activity = fetch_daily_activity(pool, &date, &date)
            .await
            .expect("read activity");
        assert_eq!(activity[0].word_count, 2);
    }

    #[tokio::test]
    async fn live_meter_reconciles_a_backfill_estimate_after_a_transcript_edit() {
        let pool = migrated_pool().await;
        seed_user(&pool, Some("2026-01"), 0, 0).await;
        let timestamp = Local
            .with_ymd_and_hms(2026, 1, 2, 12, 0, 0)
            .single()
            .expect("valid local timestamp")
            .timestamp_millis();
        let date = local_date_from_timestamp(timestamp).expect("local date");
        insert_transcription(&pool, "edited-before-meter", "one two", timestamp, None).await;

        // The history row can be corrected while the asynchronous live meter
        // is queued. Backfill sees the corrected text, but usage still reflects
        // the transcript that was delivered at dictation time.
        sqlx::query("UPDATE transcriptions SET transcript = ?1 WHERE id = ?2")
            .bind("corrected transcript has many more words now")
            .bind("edited-before-meter")
            .execute(&pool)
            .await
            .expect("edit saved transcript");
        let estimated = fetch_daily_activity(pool.clone(), &date, &date)
            .await
            .expect("backfill corrected row");
        assert_eq!(estimated[0].word_count, 7);

        let profile = record_usage_words(pool.clone(), "edited-before-meter", &date, 2)
            .await
            .expect("promote event with original live count");
        assert_eq!(profile.words_total, 2);
        assert_eq!(profile.words_this_month, 2);

        let activity = fetch_daily_activity(pool.clone(), &date, &date)
            .await
            .expect("read reconciled activity");
        assert_eq!(activity[0].word_count, 2);
        let event: (i64, String) = sqlx::query_as(
            "SELECT word_count, source FROM daily_word_activity_events
             WHERE event_id = 'edited-before-meter'",
        )
        .fetch_one(&pool)
        .await
        .expect("read promoted event");
        assert_eq!(event, (2, "live".to_string()));
    }

    #[tokio::test]
    async fn live_meter_moves_a_backfilled_event_to_the_authoritative_date() {
        let pool = migrated_pool().await;
        seed_user(&pool, Some("2026-01"), 0, 0).await;
        let original_timestamp = Local
            .with_ymd_and_hms(2026, 1, 2, 12, 0, 0)
            .single()
            .expect("valid original local timestamp")
            .timestamp_millis();
        let original_date = local_date_from_timestamp(original_timestamp).expect("local date");
        let authoritative_date = Local
            .with_ymd_and_hms(2026, 1, 3, 12, 0, 0)
            .single()
            .expect("valid authoritative local timestamp")
            .format("%Y-%m-%d")
            .to_string();
        insert_transcription(
            &pool,
            "moved-before-meter",
            "one two",
            original_timestamp,
            None,
        )
        .await;

        let estimated = fetch_daily_activity(pool.clone(), &original_date, &original_date)
            .await
            .expect("backfill original date");
        assert_eq!(estimated[0].word_count, 2);

        let profile =
            record_usage_words(pool.clone(), "moved-before-meter", &authoritative_date, 3)
                .await
                .expect("promote event on authoritative date");
        assert_eq!(profile.words_total, 3);
        assert_eq!(profile.words_this_month, 3);

        assert!(
            fetch_daily_activity(pool.clone(), &original_date, &original_date)
                .await
                .expect("read original date after promotion")
                .is_empty()
        );
        let moved = fetch_daily_activity(pool.clone(), &authoritative_date, &authoritative_date)
            .await
            .expect("read authoritative date");
        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].word_count, 3);

        let event: (String, i64, String) = sqlx::query_as(
            "SELECT local_date, word_count, source FROM daily_word_activity_events
             WHERE event_id = 'moved-before-meter'",
        )
        .fetch_one(&pool)
        .await
        .expect("read moved event");
        assert_eq!(event, (authoritative_date, 3, "live".to_string()));
    }

    #[tokio::test]
    async fn repaired_live_event_is_found_after_a_missing_initial_meter_call() {
        let pool = migrated_pool().await;
        seed_user(&pool, Some("2026-01"), 0, 0).await;
        let timestamp = Local
            .with_ymd_and_hms(2026, 1, 2, 12, 0, 0)
            .single()
            .expect("valid local timestamp")
            .timestamp_millis();
        insert_transcription(&pool, "missed-live-call", "recover this", timestamp, None).await;
        let date = local_date_from_timestamp(timestamp).expect("local date");

        fetch_daily_activity(pool.clone(), &date, &date)
            .await
            .expect("repair chart activity");
        // The normal live call can arrive after a dashboard refresh repaired
        // the event. It still updates the profile once.
        let profile = record_usage_words(pool, "missed-live-call", &date, 2)
            .await
            .expect("promote repaired event");
        assert_eq!(profile.words_total, 2);
    }

    #[tokio::test]
    async fn bad_or_conflicting_live_events_do_not_change_the_profile() {
        let pool = migrated_pool().await;
        seed_user(&pool, Some("2026-01"), 0, 0).await;

        assert!(record_usage_words(pool.clone(), "", "2026-01-02", 1)
            .await
            .is_err());
        assert!(
            record_usage_words(pool.clone(), "bad-date", "2026-02-30", 1)
                .await
                .is_err()
        );
        assert!(
            record_usage_words(pool.clone(), "too-many", "2026-01-02", 0)
                .await
                .is_err()
        );
        assert!(record_usage_words(
            pool.clone(),
            "too-large",
            "2026-01-02",
            MAX_SAFE_JS_INTEGER + 1
        )
        .await
        .is_err());

        record_usage_words(pool.clone(), "one-id", "2026-01-02", 1)
            .await
            .expect("first write");
        assert!(record_usage_words(pool.clone(), "one-id", "2026-01-02", 2)
            .await
            .is_err());
        let profile = fetch_user(pool)
            .await
            .expect("read profile")
            .expect("profile exists");
        assert_eq!(profile.words_total, 1);
    }

    #[tokio::test]
    async fn date_range_is_inclusive_and_must_be_ordered() {
        let pool = migrated_pool().await;
        seed_user(&pool, Some("2026-01"), 0, 0).await;
        record_usage_words(pool.clone(), "first", "2026-01-01", 3)
            .await
            .expect("record first date");
        record_usage_words(pool.clone(), "last", "2026-01-03", 4)
            .await
            .expect("record last date");

        let inclusive = fetch_daily_activity(pool.clone(), "2026-01-01", "2026-01-03")
            .await
            .expect("inclusive range");
        assert_eq!(inclusive.len(), 2);
        assert_eq!(inclusive[0].word_count, 3);
        assert_eq!(inclusive[1].word_count, 4);
        assert!(fetch_daily_activity(pool, "2026-01-03", "2026-01-01")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn updates_reject_a_profile_total_that_would_exceed_safe_integer_precision() {
        let pool = migrated_pool().await;
        seed_user(&pool, Some("2026-01"), 0, MAX_SAFE_JS_INTEGER).await;

        assert!(
            record_usage_words(pool.clone(), "overflow", "2026-01-02", 1)
                .await
                .is_err()
        );
        let event_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM daily_word_activity_events WHERE event_id = 'overflow'",
        )
        .fetch_one(&pool)
        .await
        .expect("read event count");
        assert_eq!(event_count, 0, "failed profile writes roll the event back");
    }
}
