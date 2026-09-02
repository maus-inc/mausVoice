use sqlx::{Row, SqlitePool};

use crate::domain::{Meeting, MeetingSegment, MeetingSpeaker};

pub async fn insert_meeting(
    pool: SqlitePool,
    meeting: &Meeting,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO meetings (id, title, created_at, duration_ms, status, summary, transcript, source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(&meeting.id)
    .bind(&meeting.title)
    .bind(meeting.created_at)
    .bind(meeting.duration_ms)
    .bind(&meeting.status)
    .bind(&meeting.summary)
    .bind(&meeting.transcript)
    .bind(&meeting.source)
    .execute(&pool)
    .await?;
    Ok(())
}

pub async fn fetch_meeting(
    pool: SqlitePool,
    id: &str,
) -> Result<Option<Meeting>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, title, created_at, duration_ms, status, summary, transcript, source
         FROM meetings WHERE id = ?1 LIMIT 1",
    )
    .bind(id)
    .fetch_optional(&pool)
    .await?;

    Ok(row.map(|r| Meeting {
        id: r.get::<String, _>("id"),
        title: r.get::<String, _>("title"),
        created_at: r.get::<i64, _>("created_at"),
        duration_ms: r.get::<i64, _>("duration_ms"),
        status: r.get::<String, _>("status"),
        summary: r.try_get::<Option<String>, _>("summary").unwrap_or(None),
        transcript: r.get::<String, _>("transcript"),
        source: r.get::<String, _>("source"),
    }))
}

pub async fn fetch_meetings(
    pool: SqlitePool,
    limit: i64,
) -> Result<Vec<Meeting>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, title, created_at, duration_ms, status, summary, transcript, source
         FROM meetings ORDER BY created_at DESC LIMIT ?1",
    )
    .bind(limit)
    .fetch_all(&pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| Meeting {
            id: r.get::<String, _>("id"),
            title: r.get::<String, _>("title"),
            created_at: r.get::<i64, _>("created_at"),
            duration_ms: r.get::<i64, _>("duration_ms"),
            status: r.get::<String, _>("status"),
            summary: r.try_get::<Option<String>, _>("summary").unwrap_or(None),
            transcript: r.get::<String, _>("transcript"),
            source: r.get::<String, _>("source"),
        })
        .collect())
}

pub async fn update_meeting(
    pool: SqlitePool,
    id: &str,
    title: Option<&str>,
    status: Option<&str>,
    summary: Option<Option<&str>>,
    transcript: Option<&str>,
    duration_ms: Option<i64>,
) -> Result<(), sqlx::Error> {
    let mut assignments: Vec<&str> = Vec::new();
    if title.is_some() {
        assignments.push("title = ?");
    }
    if status.is_some() {
        assignments.push("status = ?");
    }
    if summary.is_some() {
        assignments.push("summary = ?");
    }
    if transcript.is_some() {
        assignments.push("transcript = ?");
    }
    if duration_ms.is_some() {
        assignments.push("duration_ms = ?");
    }
    if assignments.is_empty() {
        return Ok(());
    }
    let query = format!(
        "UPDATE meetings SET {} WHERE id = ?",
        assignments.join(", "),
    );

    let mut q = sqlx::query(&query);
    if let Some(v) = title { q = q.bind(v); }
    if let Some(v) = status { q = q.bind(v); }
    if let Some(v) = summary { q = q.bind(v); }
    if let Some(v) = transcript { q = q.bind(v); }
    if let Some(v) = duration_ms { q = q.bind(v); }
    q.bind(id).execute(&pool).await?;
    Ok(())
}

pub async fn delete_meeting(pool: SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM meetings WHERE id = ?1")
        .bind(id)
        .execute(&pool)
        .await?;
    Ok(())
}

pub async fn insert_segments(
    pool: SqlitePool,
    segments: &[MeetingSegment],
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    for segment in segments {
        sqlx::query(
            "INSERT INTO meeting_segments (id, meeting_id, speaker_id, start_time_ms, end_time_ms, text, confidence)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(&segment.id)
        .bind(&segment.meeting_id)
        .bind(&segment.speaker_id)
        .bind(segment.start_time_ms)
        .bind(segment.end_time_ms)
        .bind(&segment.text)
        .bind(segment.confidence)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn fetch_segments(
    pool: SqlitePool,
    meeting_id: &str,
) -> Result<Vec<MeetingSegment>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, meeting_id, speaker_id, start_time_ms, end_time_ms, text, confidence
         FROM meeting_segments WHERE meeting_id = ?1 ORDER BY start_time_ms ASC",
    )
    .bind(meeting_id)
    .fetch_all(&pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| MeetingSegment {
            id: r.get::<String, _>("id"),
            meeting_id: r.get::<String, _>("meeting_id"),
            speaker_id: r.get::<String, _>("speaker_id"),
            start_time_ms: r.get::<i64, _>("start_time_ms"),
            end_time_ms: r.get::<i64, _>("end_time_ms"),
            text: r.get::<String, _>("text"),
            confidence: r.try_get::<Option<f64>, _>("confidence").unwrap_or(None),
        })
        .collect())
}

pub async fn insert_speakers(
    pool: SqlitePool,
    speakers: &[MeetingSpeaker],
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    for speaker in speakers {
        sqlx::query(
            "INSERT INTO meeting_speakers (id, meeting_id, name, label)
             VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(&speaker.id)
        .bind(&speaker.meeting_id)
        .bind(&speaker.name)
        .bind(&speaker.label)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn fetch_speakers(
    pool: SqlitePool,
    meeting_id: &str,
) -> Result<Vec<MeetingSpeaker>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, meeting_id, name, label
         FROM meeting_speakers WHERE meeting_id = ?1",
    )
    .bind(meeting_id)
    .fetch_all(&pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| MeetingSpeaker {
            id: r.get::<String, _>("id"),
            meeting_id: r.get::<String, _>("meeting_id"),
            name: r.get::<String, _>("name"),
            label: r.try_get::<Option<String>, _>("label").unwrap_or(None),
        })
        .collect())
}
