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

pub async fn update_transcription(
    pool: SqlitePool,
    transcription: &Transcription,
) -> Result<Transcription, sqlx::Error> {
    bind_transcription_fields(
        sqlx::query(&format!(
            "UPDATE transcriptions
         SET {}
         WHERE id = ?1",
            transcription_update_assignments(),
        )),
        transcription,
    )
    .execute(&pool)
    .await?;

    let row = sqlx::query(&format!(
        "SELECT {}
         FROM transcriptions
         WHERE id = ?1",
        transcription_column_list(),
    ))
    .bind(&transcription.id)
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
