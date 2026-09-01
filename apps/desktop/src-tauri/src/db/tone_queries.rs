use sqlx::{Row, SqlitePool};

use crate::domain::Tone;

pub async fn insert_tone(pool: SqlitePool, tone: &Tone) -> Result<Tone, sqlx::Error> {
    sqlx::query(
        "INSERT INTO tones (
             id, name, prompt_template, created_at, sort_order,
             category, output_length, example_input_output
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(&tone.id)
    .bind(&tone.name)
    .bind(&tone.prompt_template)
    .bind(tone.created_at)
    .bind(tone.sort_order)
    .bind(&tone.category)
    .bind(&tone.output_length)
    .bind(&tone.example_input_output)
    .execute(&pool)
    .await?;

    Ok(tone.clone())
}

pub async fn update_tone(pool: SqlitePool, tone: &Tone) -> Result<Tone, sqlx::Error> {
    sqlx::query(
        "UPDATE tones SET
            name = ?2,
            prompt_template = ?3,
            sort_order = ?4,
            category = ?5,
            output_length = ?6,
            example_input_output = ?7
         WHERE id = ?1",
    )
    .bind(&tone.id)
    .bind(&tone.name)
    .bind(&tone.prompt_template)
    .bind(tone.sort_order)
    .bind(&tone.category)
    .bind(&tone.output_length)
    .bind(&tone.example_input_output)
    .execute(&pool)
    .await?;

    Ok(tone.clone())
}

pub async fn delete_tone(pool: SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM tones WHERE id = ?1")
        .bind(id)
        .execute(&pool)
        .await?;

    Ok(())
}

const TONE_COLUMNS: &str =
    "id, name, prompt_template, created_at, sort_order, category, output_length, example_input_output";

fn tone_from_row(row: &sqlx::sqlite::SqliteRow) -> Tone {
    Tone {
        id: row.get::<String, _>("id"),
        name: row.get::<String, _>("name"),
        prompt_template: row.get::<String, _>("prompt_template"),
        created_at: row.get::<i64, _>("created_at"),
        sort_order: row.get::<i32, _>("sort_order"),
        category: row.try_get::<Option<String>, _>("category").unwrap_or(None),
        output_length: row
            .try_get::<Option<String>, _>("output_length")
            .unwrap_or(None),
        example_input_output: row
            .try_get::<Option<String>, _>("example_input_output")
            .unwrap_or(None),
    }
}

pub async fn fetch_tone_by_id(pool: SqlitePool, id: &str) -> Result<Option<Tone>, sqlx::Error> {
    let query = format!("SELECT {TONE_COLUMNS} FROM tones WHERE id = ?1 LIMIT 1");
    let row = sqlx::query(&query)
        .bind(id)
        .fetch_optional(&pool)
        .await?;

    Ok(row.as_ref().map(tone_from_row))
}

pub async fn fetch_all_tones(pool: SqlitePool) -> Result<Vec<Tone>, sqlx::Error> {
    let query = format!(
        "SELECT {TONE_COLUMNS} FROM tones ORDER BY sort_order ASC, created_at ASC"
    );
    let rows = sqlx::query(&query).fetch_all(&pool).await?;
    Ok(rows.iter().map(tone_from_row).collect())
}

pub async fn count_tones(pool: SqlitePool) -> Result<i64, sqlx::Error> {
    let row = sqlx::query("SELECT COUNT(*) as count FROM tones")
        .fetch_one(&pool)
        .await?;

    Ok(row.get::<i64, _>("count"))
}

pub async fn delete_all_tones(pool: SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM tones").execute(&pool).await?;

    Ok(())
}
