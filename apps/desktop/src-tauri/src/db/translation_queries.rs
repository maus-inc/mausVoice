use sqlx::{Row, SqlitePool};

use crate::domain::TranslationEntry;

pub async fn insert_translation(
    pool: SqlitePool,
    entry: &TranslationEntry,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO translations (id, source_text, translated_text, source_language, target_language, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(&entry.id)
    .bind(&entry.source_text)
    .bind(&entry.translated_text)
    .bind(&entry.source_language)
    .bind(&entry.target_language)
    .bind(entry.created_at)
    .execute(&pool)
    .await?;
    Ok(())
}

fn translation_from_row(r: &sqlx::sqlite::SqliteRow) -> TranslationEntry {
    TranslationEntry {
        id: r.get::<String, _>("id"),
        source_text: r.get::<String, _>("source_text"),
        translated_text: r.get::<String, _>("translated_text"),
        source_language: r.get::<String, _>("source_language"),
        target_language: r.get::<String, _>("target_language"),
        created_at: r.get::<i64, _>("created_at"),
    }
}

pub async fn fetch_translations(
    pool: SqlitePool,
    limit: i64,
) -> Result<Vec<TranslationEntry>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, source_text, translated_text, source_language, target_language, created_at
         FROM translations ORDER BY created_at DESC LIMIT ?1",
    )
    .bind(limit.clamp(1, 100))
    .fetch_all(&pool)
    .await?;
    Ok(rows.iter().map(translation_from_row).collect())
}

pub async fn search_translations(
    pool: SqlitePool,
    query: &str,
    limit: i64,
) -> Result<Vec<TranslationEntry>, sqlx::Error> {
    let pattern = format!("%{}%", query);
    let rows = sqlx::query(
        "SELECT id, source_text, translated_text, source_language, target_language, created_at
         FROM translations
         WHERE source_text LIKE ?1 OR translated_text LIKE ?1
         ORDER BY created_at DESC LIMIT ?2",
    )
    .bind(pattern)
    .bind(limit.clamp(1, 100))
    .fetch_all(&pool)
    .await?;
    Ok(rows.iter().map(translation_from_row).collect())
}
