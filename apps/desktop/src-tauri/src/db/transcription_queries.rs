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
/// The INSERT and the UPDATE bind the identical 26 values, so they share this
/// one chain: a field added to one writer and not the other used to be a
/// silent, per-path data loss.
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
    let row = bind_transcription_fields(
        sqlx::query(&format!(
            "UPDATE transcriptions
         SET {}
         WHERE id = ?1
         RETURNING {}",
            transcription_update_assignments(),
            transcription_column_list(),
        )),
        transcription,
    )
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

    /// The real `transcriptions` table is built by migration 002 plus a dozen
    /// `ALTER TABLE ADD COLUMN` steps, and `update_transcription` names every
    /// column in both its `SET` and `RETURNING` lists. The fixture therefore
    /// declares all 26 in `TRANSCRIPTION_COLUMNS` order rather than a hand-picked
    /// subset, so a column added to that list fails here instead of silently
    /// making the update a partial one.
    const FIXTURE_SCHEMA: &str = "CREATE TABLE transcriptions (
        id TEXT PRIMARY KEY,
        transcript TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        audio_path TEXT,
        audio_duration_ms INTEGER,
        model_size TEXT,
        inference_device TEXT,
        raw_transcript TEXT,
        sanitized_transcript TEXT,
        transcription_prompt TEXT,
        post_process_prompt TEXT,
        transcription_api_key_id TEXT,
        post_process_api_key_id TEXT,
        transcription_mode TEXT,
        post_process_mode TEXT,
        post_process_device TEXT,
        post_process_model TEXT,
        post_process_provider TEXT,
        post_process_failed INTEGER,
        post_process_error TEXT,
        transcription_duration_ms INTEGER,
        postprocess_duration_ms INTEGER,
        warnings_json TEXT,
        remote_status TEXT,
        remote_device_id TEXT,
        post_process_fallback INTEGER
    )";

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
    /// connection count.
    ///
    /// A bare `sqlite::memory:` DSN gives every pooled connection its own
    /// private database, so with `max_connections(5)` the `CREATE TABLE` would
    /// land on one connection and every later query would hit a different,
    /// empty one. `cache=shared` is what makes the five connections one
    /// database, which is the whole point: `max_connections(1)` would serialise
    /// the `UPDATE`-then-`SELECT` pair onto one connection and hide exactly the
    /// interleaving the race test below exists to catch.
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
        sqlx::query(FIXTURE_SCHEMA)
            .execute(&pool)
            .await
            .expect("fixture table must be creatable");
        pool
    }

    /// The returned row must be the row *this* call wrote.
    ///
    /// `UPDATE` followed by a bare `SELECT` on a `max_connections(5)` pool has a
    /// window between the two statements. A second writer's whole-row `UPDATE`
    /// landing in that window makes the first writer return the other writer's
    /// values as its own success. This test drives many concurrent rounds and
    /// asserts the update never reports text it did not write.
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

        // Yield before each update so the two tasks contend for the pool and the
        // interleaving window is actually entered rather than run start-to-finish.
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

            let (result_a, _result_b) = tokio::join!(writer_a_task, writer_b_task);

            let returned_a = result_a
                .expect("writer A task must not panic")
                .expect("writer A's update must succeed");
            assert_eq!(
                returned_a.transcript, "written-by-a",
                "update_transcription returned another writer's transcript as its own success"
            );
        }
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

        let returned = update_transcription(pool.clone(), &stored)
            .await
            .expect("a matching row must update");

        assert_eq!(returned.transcript, "second");
        assert_eq!(returned.raw_transcript.as_deref(), Some("raw second"));
        let read_back = fetch_transcriptions(pool, 10, 0)
            .await
            .expect("rows must be readable");
        assert_eq!(read_back.len(), 1);
        assert_eq!(read_back[0].transcript, "second");
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

    #[tokio::test]
    async fn the_fixture_schema_covers_every_bound_column() {
        // Guards the fixture against drift: if `TRANSCRIPTION_COLUMNS` grows, this
        // fails and the fixture is extended rather than the update quietly
        // narrowing to the columns the fixture happens to have.
        let columns = super::TRANSCRIPTION_COLUMNS.len();
        let declared: i64 = {
            let pool = transcription_pool("case").await;
            sqlx::query("SELECT COUNT(*) AS count FROM pragma_table_info('transcriptions')")
                .fetch_one(&pool)
                .await
                .expect("pragma must be readable")
                .get("count")
        };
        assert_eq!(declared, columns as i64);
    }
}
