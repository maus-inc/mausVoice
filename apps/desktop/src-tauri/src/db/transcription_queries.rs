use sqlx::{sqlite::SqliteRow, Row, Sqlite, SqlitePool};

use crate::domain::{Transcription, TranscriptionAudioSnapshot};

/// Every `transcriptions` column, in the order the INSERT binds its `?N`
/// placeholders and the SELECT reads them.
///
/// All three statements in this file are generated from this list, so a column
/// can never be added to the writer and forgotten by the reader (or vice
/// versa).
const TRANSCRIPTION_COLUMNS: &[&str] = &[
    "id",
    "transcript",
    "timestamp",
    "audio_path",
    "audio_duration_ms",
    "model_size",
    "inference_device",
    "raw_transcript",
    "sanitized_transcript",
    "transcription_prompt",
    "post_process_prompt",
    "transcription_api_key_id",
    "post_process_api_key_id",
    "transcription_mode",
    "post_process_mode",
    "post_process_device",
    "post_process_model",
    "post_process_provider",
    "post_process_failed",
    "post_process_error",
    "transcription_duration_ms",
    "postprocess_duration_ms",
    "warnings_json",
    "remote_status",
    "remote_device_id",
    "post_process_fallback",
    "post_process_edit_failed",
    "post_process_edit_failure_count",
    "post_process_edit_auto_retry_used",
    "post_process_edit_retry_tone_id",
    "post_process_edit_retry_language_code",
];

fn transcription_column_list() -> String {
    TRANSCRIPTION_COLUMNS.join(",\n                 ")
}

/// `?1, ?2, ... ?n` for a positional bind of `count` values.
fn positional_placeholders(count: usize) -> String {
    (1..=count)
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The UPDATE's `SET` list: every column but the `id` the WHERE clause keys on,
/// each bound to the placeholder it holds in [`TRANSCRIPTION_COLUMNS`]. The
/// offset is one because `id` itself is `?1`.
fn transcription_update_assignments() -> String {
    TRANSCRIPTION_COLUMNS
        .iter()
        .enumerate()
        .skip(1)
        .map(|(index, column)| format!("{column} = ?{}", index + 1))
        .collect::<Vec<_>>()
        .join(",\n             ")
}

/// Binds every transcription field onto `query`, in [`TRANSCRIPTION_COLUMNS`]
/// order.
///
/// The INSERT and the UPDATE bind the identical transcription values, so they
/// share this one chain. A field added to one writer and not the other used to
/// be a silent, per-path data loss.
fn bind_transcription_fields<'q>(
    query: sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    transcription: &'q Transcription,
) -> sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    query
        .bind(&transcription.id)
        .bind(&transcription.transcript)
        .bind(transcription.timestamp)
        .bind(
            transcription
                .audio
                .as_ref()
                .map(|audio| audio.file_path.as_str()),
        )
        .bind(transcription.audio.as_ref().map(|audio| audio.duration_ms))
        .bind(transcription.model_size.as_deref())
        .bind(transcription.inference_device.as_deref())
        .bind(transcription.raw_transcript.as_deref())
        .bind(transcription.sanitized_transcript.as_deref())
        .bind(transcription.transcription_prompt.as_deref())
        .bind(transcription.post_process_prompt.as_deref())
        .bind(transcription.transcription_api_key_id.as_deref())
        .bind(transcription.post_process_api_key_id.as_deref())
        .bind(transcription.transcription_mode.as_deref())
        .bind(transcription.post_process_mode.as_deref())
        .bind(transcription.post_process_device.as_deref())
        .bind(transcription.post_process_model.as_deref())
        .bind(transcription.post_process_provider.as_deref())
        .bind(transcription.post_process_failed)
        .bind(transcription.post_process_error.as_deref())
        .bind(transcription.transcription_duration_ms)
        .bind(transcription.postprocess_duration_ms)
        .bind(serialize_warnings(&transcription.warnings))
        .bind(transcription.remote_status.as_deref())
        .bind(transcription.remote_device_id.as_deref())
        .bind(transcription.post_process_fallback)
        .bind(transcription.post_process_edit_failed)
        .bind(transcription.post_process_edit_failure_count)
        .bind(transcription.post_process_edit_auto_retry_used)
        .bind(transcription.post_process_edit_retry_tone_id.as_deref())
        .bind(transcription.post_process_edit_retry_language_code.as_deref())
}

fn serialize_warnings(warnings: &Option<Vec<String>>) -> Option<String> {
    warnings
        .as_ref()
        .and_then(|list| serde_json::to_string(list).ok())
}

fn row_to_transcription(row: SqliteRow) -> Result<Transcription, sqlx::Error> {
    let audio_path: Option<String> = row.try_get("audio_path")?;
    let audio_duration: Option<i64> = row.try_get("audio_duration_ms")?;
    let warnings_json: Option<String> = row.try_get("warnings_json")?;

    let audio = audio_path.map(|file_path| TranscriptionAudioSnapshot {
        file_path,
        duration_ms: audio_duration.unwrap_or_default(),
    });
    let warnings = warnings_json.and_then(|json| serde_json::from_str::<Vec<String>>(&json).ok());
    let remote_status: Option<String> = row.try_get("remote_status")?;
    let remote_device_id: Option<String> = row.try_get("remote_device_id")?;

    Ok(Transcription {
        id: row.get::<String, _>("id"),
        transcript: row.get::<String, _>("transcript"),
        timestamp: row.get::<i64, _>("timestamp"),
        audio,
        model_size: row.try_get::<Option<String>, _>("model_size")?,
        inference_device: row.try_get::<Option<String>, _>("inference_device")?,
        raw_transcript: row.try_get::<Option<String>, _>("raw_transcript")?,
        sanitized_transcript: row.try_get::<Option<String>, _>("sanitized_transcript")?,
        transcription_prompt: row.try_get::<Option<String>, _>("transcription_prompt")?,
        post_process_prompt: row.try_get::<Option<String>, _>("post_process_prompt")?,
        transcription_api_key_id: row.try_get::<Option<String>, _>("transcription_api_key_id")?,
        post_process_api_key_id: row.try_get::<Option<String>, _>("post_process_api_key_id")?,
        transcription_mode: row.try_get::<Option<String>, _>("transcription_mode")?,
        post_process_mode: row.try_get::<Option<String>, _>("post_process_mode")?,
        post_process_device: row.try_get::<Option<String>, _>("post_process_device")?,
        post_process_model: row.try_get::<Option<String>, _>("post_process_model")?,
        post_process_provider: row.try_get::<Option<String>, _>("post_process_provider")?,
        post_process_failed: row.try_get::<Option<bool>, _>("post_process_failed")?,
        post_process_edit_failed: row.try_get::<Option<bool>, _>("post_process_edit_failed")?,
        post_process_edit_failure_count: row
            .try_get::<Option<i64>, _>("post_process_edit_failure_count")?,
        post_process_edit_auto_retry_used: row
            .try_get::<Option<bool>, _>("post_process_edit_auto_retry_used")?,
        post_process_edit_retry_tone_id: row
            .try_get::<Option<String>, _>("post_process_edit_retry_tone_id")?,
        post_process_edit_retry_language_code: row
            .try_get::<Option<String>, _>("post_process_edit_retry_language_code")?,
        post_process_fallback: row.try_get::<Option<bool>, _>("post_process_fallback")?,
        post_process_error: row.try_get::<Option<String>, _>("post_process_error")?,
        transcription_duration_ms: row.try_get::<Option<i64>, _>("transcription_duration_ms")?,
        postprocess_duration_ms: row.try_get::<Option<i64>, _>("postprocess_duration_ms")?,
        warnings,
        remote_status,
        remote_device_id,
    })
}

pub async fn insert_transcription(
    pool: SqlitePool,
    transcription: &Transcription,
) -> Result<Transcription, sqlx::Error> {
    bind_transcription_fields(
        sqlx::query(&format!(
            "INSERT INTO transcriptions ({})
         VALUES ({})",
            transcription_column_list(),
            positional_placeholders(TRANSCRIPTION_COLUMNS.len()),
        )),
        transcription,
    )
    .execute(&pool)
    .await?;

    Ok(transcription.clone())
}

pub async fn fetch_transcriptions(
    pool: SqlitePool,
    limit: u32,
    offset: u32,
) -> Result<Vec<Transcription>, sqlx::Error> {
    let rows = sqlx::query(&format!(
        "SELECT {}
         FROM transcriptions
         ORDER BY timestamp DESC
         LIMIT ?1 OFFSET ?2",
        transcription_column_list(),
    ))
    .bind(limit as i64)
    .bind(offset as i64)
    .fetch_all(&pool)
    .await?;

    let mut transcriptions = Vec::with_capacity(rows.len());

    for row in rows {
        transcriptions.push(row_to_transcription(row)?);
    }

    Ok(transcriptions)
}

/// The `UPDATE` statement [`update_transcription`] runs.
///
/// Shared with the test that pins the single-statement shape, so the test reads
/// the string the caller actually executes. A test that formats its own copy
/// asserts only that its own copy is well formed, and therefore keeps passing
/// when the caller is reverted to the `UPDATE`-then-`SELECT` pair the test is
/// named against -- a regression guard that cannot fail.
fn transcription_update_sql() -> String {
    format!(
        "UPDATE transcriptions
         SET {}
         WHERE id = ?1
         RETURNING {}",
        transcription_update_assignments(),
        transcription_column_list(),
    )
}

/// Update one row and return it as stored.
///
/// The read is `RETURNING`, not a follow-up `SELECT`. On the shared pool
/// (`max_connections(5)`) the previous `UPDATE`-then-`SELECT` pair left a window
/// between the two statements in which another writer's whole-row `UPDATE` could
/// commit, and this call would then hand back that writer's values as its own
/// success. `RETURNING` makes the write and the read one atomic statement, so
/// the row returned is the row this call wrote and no interleaving is possible.
pub async fn update_transcription(
    pool: SqlitePool,
    transcription: &Transcription,
) -> Result<Transcription, sqlx::Error> {
    let sql = transcription_update_sql();
    let row = bind_transcription_fields(sqlx::query(&sql), transcription)
        .fetch_optional(&pool)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;

    row_to_transcription(row)
}

pub async fn delete_transcription(pool: SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM transcriptions
         WHERE id = ?1",
    )
    .bind(id)
    .execute(&pool)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{delete_transcription, fetch_transcriptions, update_transcription};
    use crate::domain::Transcription;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::{Row, SqlitePool};

    fn transcription(id: &str, transcript: &str) -> Transcription {
        Transcription {
            id: id.to_string(),
            transcript: transcript.to_string(),
            timestamp: 1_700_000_000_000,
            audio: None,
            model_size: None,
            inference_device: None,
            raw_transcript: None,
            sanitized_transcript: None,
            transcription_prompt: None,
            post_process_prompt: None,
            transcription_api_key_id: None,
            post_process_api_key_id: None,
            transcription_mode: None,
            post_process_mode: None,
            post_process_device: None,
            post_process_model: None,
            post_process_provider: None,
            post_process_failed: None,
            post_process_edit_failed: None,
            post_process_edit_failure_count: None,
            post_process_edit_auto_retry_used: None,
            post_process_edit_retry_tone_id: None,
            post_process_edit_retry_language_code: None,
            post_process_fallback: None,
            post_process_error: None,
            transcription_duration_ms: None,
            postprocess_duration_ms: None,
            warnings: None,
            remote_status: None,
            remote_device_id: None,
        }
    }

    /// A pool over a *shared-cache* in-memory database, at the production
    /// connection count, carrying the real migrated schema.
    ///
    /// The schema is built by [`crate::db::migrations`] rather than a
    /// hand-written `CREATE TABLE`. A fixture that re-declares the table drifts
    /// silently: it had `sanitized_transcript` ninth where migration 069 puts it
    /// nineteenth, and `post_process_model` seventeenth where 069 puts it
    /// twenty-fifth, because it was copied from `TRANSCRIPTION_COLUMNS` — the
    /// *binding* order, which is not the physical one. Any future column renamed
    /// or reordered in a migration would keep passing against the hand-written
    /// table. Applying the migrations is the same thing `preferences_queries.rs`
    /// does, and it makes the table under test the table production gets.
    ///
    /// A bare `sqlite::memory:` DSN gives every pooled connection its own
    /// private database, so with `max_connections(5)` the schema would land on
    /// one connection and every later query would hit a different, empty one.
    /// `cache=shared` is what makes the five connections one database, which is
    /// the whole point: `max_connections(1)` would serialise the statements onto
    /// one connection and hide exactly the interleaving the race test below
    /// exists to catch.
    ///
    /// The database name is unique per call because a shared-cache in-memory
    /// database is process-global by name; a fixed name would let these tests
    /// run in parallel and see each other's tables.
    async fn transcription_pool(label: &str) -> SqlitePool {
        static NEXT_DATABASE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let serial = NEXT_DATABASE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let name = format!(
            "file:mau-transcriptions-{label}-{}-{serial}?mode=memory&cache=shared",
            std::process::id()
        );
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect(&name)
            .await
            .expect("shared in-memory pool must open");
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

    /// The returned row must be the row *this* call wrote.
    ///
    /// What protects that is not the concurrency here — it is that
    /// `update_transcription` writes and reads back in ONE statement, via
    /// `UPDATE ... RETURNING`. There is no window between a write and a
    /// subsequent `SELECT` for another writer to land in, because there is no
    /// subsequent `SELECT`. `the_write_and_the_read_back_are_one_statement` is
    /// what pins that, and it is the part that is actually decidable.
    ///
    /// The 400 concurrent rounds below are a soak, not the proof, and this
    /// comment used to claim they were the proof. They are not, and that was
    /// measured rather than assumed:
    ///
    ///   - replacing `tokio::join!` with two sequential awaits SURVIVES
    ///   - deleting writer B's `yield_now()` before its update SURVIVES
    ///
    /// Both leave the test green, which means no round actually interleaves the
    /// two writers at the point the hazard needs. Running the writers strictly
    /// one after another satisfies every assertion here just as well as running
    /// them concurrently, so these rounds would pass against an implementation
    /// that had no concurrency safety at all. They cannot be made to fail by
    /// removing the `yield_now()`, so the interleaving they appear to force is
    /// not one they force.
    ///
    /// What they are good for is real, just narrower: two writers on a
    /// five-connection shared-cache pool repeatedly contend for one row without
    /// deadlocking, erroring, or losing a write, 400 times over. Kept for that.
    ///
    /// The assertions are strict on purpose. Making them tolerate a
    /// `SQLITE_LOCKED` error was tried and reverted — see the note at the
    /// assertions — because it softens the one assertion here with teeth and the
    /// nondeterminism it was meant to absorb does not reproduce.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn update_returns_the_row_it_wrote_not_a_concurrent_writers_values() {
        let pool = transcription_pool("race").await;
        sqlx::query(
            "INSERT INTO transcriptions (id, transcript, timestamp) VALUES ('shared', 'seed', 1)",
        )
        .execute(&pool)
        .await
        .expect("seed row must be insertable");

        let writer_a = transcription("shared", "written-by-a");
        // The winning value has to be recognisable: `writer_b` is what the
        // assertion must never see come back out of writer A's own call.
        let writer_b_marker = "written-by-b";

        // Yield before each update so the two tasks are released together rather
        // than run start-to-finish. The property below is what makes that
        // meaningful: both results are inspected, so a round in which one writer
        // genuinely observed the other writer's row cannot pass unnoticed.
        for _ in 0..400 {
            let other = transcription("shared", writer_b_marker);
            let writer_a_copy = writer_a.clone();
            let writer_a_task = tokio::spawn({
                let pool = pool.clone();
                async move {
                    tokio::task::yield_now().await;
                    update_transcription(pool, &writer_a_copy).await
                }
            });
            let writer_b_task = tokio::spawn({
                let pool = pool.clone();
                async move {
                    tokio::task::yield_now().await;
                    update_transcription(pool, &other).await
                }
            });

            let (result_a, result_b) = tokio::join!(writer_a_task, writer_b_task);

            // Both writers are asserted. Inspecting only A left the test blind to
            // exactly the half of the round where B's call came back carrying
            // another writer's values — the binding was `_result_b`, which reads
            // as deliberate and is dropped without ever being looked at.
            //
            // The assertions are strict. Tolerating a lock error here was tried
            // and reverted: it weakens the one assertion that has teeth, and the
            // nondeterminism it was meant to absorb does not reproduce -- the
            // strict form passed 8 consecutive runs of all 400 rounds.
            let returned_a = result_a
                .expect("writer A task must not panic")
                .expect("writer A's update must succeed");
            assert_eq!(
                returned_a.transcript, "written-by-a",
                "update_transcription returned another writer's transcript as its own success"
            );

            let returned_b = result_b
                .expect("writer B task must not panic")
                .expect("writer B's update must succeed");
            assert_eq!(
                returned_b.transcript, writer_b_marker,
                "update_transcription returned another writer's transcript as its own success"
            );
        }
    }

    /// The mechanism that actually prevents one writer's values from being reported
    /// as another's: the write and the read-back are ONE statement.
    ///
    /// `UPDATE ... RETURNING` gives SQLite the row as part of the write, under the
    /// same lock. There is therefore no interval between "the row is written" and
    /// "the row is read" in which a second writer could land — the hazard the soak
    /// above is aimed at cannot occur, not because the race is unlikely but
    /// because the window does not exist.
    ///
    /// So this pins the window's absence structurally. It is decidable on every
    /// run and in every environment, which the concurrency approaches are not.
    #[test]
    fn the_write_and_the_read_back_are_one_statement() {
        // Read through the caller's helper on purpose. Formatting the statement
        // here would give this test its own copy to bless, and the assertions
        // below would still hold after a revert to UPDATE-then-SELECT.
        let sql = super::transcription_update_sql();

        let statements = sql
            .split(';')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .count();
        assert_eq!(
            statements, 1,
            "the update must be a single statement, or a concurrent writer has a window to land in: {sql}"
        );

        // A read-back would have to be a separate SELECT. There must not be one.
        let without_strings = sql.replace('\'', "");
        assert!(
            !without_strings.to_ascii_uppercase().contains("SELECT"),
            "the update must not read the row back in a second statement: {sql}"
        );
        assert!(
            without_strings.to_ascii_uppercase().contains("RETURNING"),
            "the row must come from the write itself, via RETURNING: {sql}"
        );
    }

    /// `UPDATE` must not report success for a row it did not touch.
    #[tokio::test]
    async fn update_reports_row_not_found_for_an_absent_row() {
        let pool = transcription_pool("case").await;

        let result = update_transcription(pool, &transcription("absent", "never stored")).await;

        assert!(
            matches!(result, Err(sqlx::Error::RowNotFound)),
            "an update that matched no row must not report a stored transcription"
        );
    }

    /// A plain update still round-trips every field it wrote.
    #[tokio::test]
    async fn update_round_trips_the_written_values() {
        let pool = transcription_pool("case").await;
        let mut stored = transcription("round-trip", "first");
        sqlx::query("INSERT INTO transcriptions (id, transcript, timestamp) VALUES (?1, ?2, ?3)")
            .bind(&stored.id)
            .bind(&stored.transcript)
            .bind(stored.timestamp)
            .execute(&pool)
            .await
            .expect("seed row must be insertable");

        stored.transcript = "second".to_string();
        stored.raw_transcript = Some("raw second".to_string());
        stored.post_process_edit_failed = Some(true);
        stored.post_process_edit_failure_count = Some(3);
        stored.post_process_edit_auto_retry_used = Some(true);
        stored.post_process_edit_retry_tone_id = Some("custom-tone".to_string());
        stored.post_process_edit_retry_language_code = Some("fr".to_string());

        let returned = update_transcription(pool.clone(), &stored)
            .await
            .expect("a matching row must update");

        assert_eq!(returned.transcript, "second");
        assert_eq!(returned.raw_transcript.as_deref(), Some("raw second"));
        assert_eq!(returned.post_process_edit_failed, Some(true));
        assert_eq!(returned.post_process_edit_failure_count, Some(3));
        assert_eq!(returned.post_process_edit_auto_retry_used, Some(true));
        assert_eq!(returned.post_process_edit_retry_tone_id.as_deref(), Some("custom-tone"));
        assert_eq!(returned.post_process_edit_retry_language_code.as_deref(), Some("fr"));
        let read_back = fetch_transcriptions(pool, 10, 0)
            .await
            .expect("rows must be readable");
        assert_eq!(read_back.len(), 1);
        assert_eq!(read_back[0].transcript, "second");
        assert_eq!(read_back[0].post_process_edit_failed, Some(true));
        assert_eq!(read_back[0].post_process_edit_failure_count, Some(3));
        assert_eq!(read_back[0].post_process_edit_auto_retry_used, Some(true));
        assert_eq!(read_back[0].post_process_edit_retry_tone_id.as_deref(), Some("custom-tone"));
        assert_eq!(read_back[0].post_process_edit_retry_language_code.as_deref(), Some("fr"));
    }

    #[tokio::test]
    async fn delete_removes_only_the_named_row() {
        let pool = transcription_pool("case").await;
        for id in ["first", "second"] {
            sqlx::query(
                "INSERT INTO transcriptions (id, transcript, timestamp) VALUES (?1, ?2, 1)",
            )
            .bind(id)
            .bind(id)
            .execute(&pool)
            .await
            .expect("seed row must be insertable");
        }

        delete_transcription(pool.clone(), "first")
            .await
            .expect("delete must succeed");

        let remaining = fetch_transcriptions(pool, 10, 0)
            .await
            .expect("rows must be readable");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, "second");
    }

    /// The migrated table must carry exactly the columns the writer binds, by
    /// name.
    ///
    /// This compares names rather than a count. A `COUNT(*)` against
    /// `TRANSCRIPTION_COLUMNS.len()` passes for a table that no longer has the
    /// column the writer binds, because a rename leaves the count untouched —
    /// the guard only notices columns being added, never ones being renamed or
    /// dropped. Comparing the name sets fails on either.
    ///
    /// Order is deliberately not asserted: `TRANSCRIPTION_COLUMNS` is the
    /// placeholder-binding order, and migration 069 builds the table in a
    /// different physical order (`sanitized_transcript` ninth here, nineteenth
    /// there). Every statement in this file names its columns explicitly, so
    /// physical order is not something the writer depends on.
    #[tokio::test]
    async fn the_fixture_schema_covers_every_bound_column() {
        let declared: Vec<String> = {
            let pool = transcription_pool("case").await;
            sqlx::query("SELECT name FROM pragma_table_info('transcriptions')")
                .fetch_all(&pool)
                .await
                .expect("pragma must be readable")
                .iter()
                .map(|row| row.get::<String, _>("name"))
                .collect()
        };

        let mut declared_names = declared;
        declared_names.sort();
        let mut expected_names = super::TRANSCRIPTION_COLUMNS.to_vec();
        expected_names.sort();

        assert_eq!(
            declared_names, expected_names,
            "the migrated `transcriptions` table and TRANSCRIPTION_COLUMNS name \
             different columns, so a write binds a column the schema lacks or \
             drops one it has"
        );
    }
}
