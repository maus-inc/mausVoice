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

/// Decode one `tones` row.
///
/// Every column is read with `try_get` and the error is returned rather than
/// folded into `None`. SQLite is dynamically typed, so a `category` holding a
/// blob or an integer decodes as an error; reporting that as "this tone has
/// no category" made a corrupt row indistinguishable from a tone that
/// legitimately has none, and the tone list silently lost the field. A
/// caller now gets the error and can say the row is unreadable.
fn tone_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<Tone, sqlx::Error> {
    Ok(Tone {
        id: row.try_get::<String, _>("id")?,
        name: row.try_get::<String, _>("name")?,
        prompt_template: row.try_get::<String, _>("prompt_template")?,
        created_at: row.try_get::<i64, _>("created_at")?,
        sort_order: row.try_get::<i32, _>("sort_order")?,
        category: row.try_get::<Option<String>, _>("category")?,
        output_length: row.try_get::<Option<String>, _>("output_length")?,
        example_input_output: row.try_get::<Option<String>, _>("example_input_output")?,
    })
}

pub async fn fetch_tone_by_id(pool: SqlitePool, id: &str) -> Result<Option<Tone>, sqlx::Error> {
    let query = format!("SELECT {TONE_COLUMNS} FROM tones WHERE id = ?1 LIMIT 1");
    let row = sqlx::query(&query)
        .bind(id)
        .fetch_optional(&pool)
        .await?;

    row.as_ref().map(tone_from_row).transpose()
}

pub async fn fetch_all_tones(pool: SqlitePool) -> Result<Vec<Tone>, sqlx::Error> {
    let query = format!(
        "SELECT {TONE_COLUMNS} FROM tones ORDER BY sort_order ASC, created_at ASC"
    );
    let rows = sqlx::query(&query).fetch_all(&pool).await?;
    rows.iter().map(tone_from_row).collect()
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

    /// A `NULL` optional column is a real value and must still decode to
    /// `None`. This is the case the old `unwrap_or(None)` was there for, and
    /// it has to keep working.
    #[tokio::test]
    async fn a_null_optional_column_decodes_to_none() {
        let pool = migrated_pool().await;
        sqlx::query(
            "INSERT INTO tones (id, name, prompt_template, created_at, sort_order)
             VALUES ('t1', 'Casual', 'prompt', 1, 0)",
        )
        .execute(&pool)
        .await
        .expect("seed a tone with no optional columns");

        let tone = fetch_tone_by_id(pool, "t1")
            .await
            .expect("read the tone")
            .expect("the tone exists");

        assert_eq!(tone.category, None);
        assert_eq!(tone.output_length, None);
        assert_eq!(tone.example_input_output, None);
    }

    /// A column holding something that is not text is a decode error, not a
    /// missing value. A blob survives the column's TEXT affinity, so this is
    /// a row SQLite is perfectly willing to store and hand back.
    #[tokio::test]
    async fn a_column_holding_the_wrong_type_is_reported_not_swallowed() {
        let pool = migrated_pool().await;
        sqlx::query(
            "INSERT INTO tones (id, name, prompt_template, created_at, sort_order, category)
             VALUES ('t1', 'Casual', 'prompt', 1, 0, x'00ff')",
        )
        .execute(&pool)
        .await
        .expect("seed a tone whose category is a blob");

        assert!(
            fetch_tone_by_id(pool.clone(), "t1")
                .await
                .is_err(),
            "reading one unreadable tone must not look like a tone with no category"
        );
        assert!(
            fetch_all_tones(pool).await.is_err(),
            "the same has to hold for the whole list"
        );
    }

    /// `created_at` and `sort_order` are NOT NULL integers and were read
    /// with `get`, which panics on a type mismatch. They are covered here so
    /// the list reports the bad row instead of unwinding through it.
    #[tokio::test]
    async fn a_non_integer_sort_order_is_reported_rather_than_panicking() {
        let pool = migrated_pool().await;
        sqlx::query(
            "INSERT INTO tones (id, name, prompt_template, created_at, sort_order)
             VALUES ('t1', 'Casual', 'prompt', 1, 'not-a-number')",
        )
        .execute(&pool)
        .await
        .expect("seed a tone whose sort order is text");

        assert!(fetch_all_tones(pool).await.is_err());
    }

    #[tokio::test]
    async fn a_readable_tone_round_trips() {
        let pool = migrated_pool().await;
        let tone: Tone = serde_json::from_value(serde_json::json!({
            "id": "t1",
            "name": "Casual",
            "promptTemplate": "be brief",
            "createdAt": 7,
            "sortOrder": 3,
            "category": "conversational",
            "outputLength": "short",
            "exampleInputOutput": "hi/hey",
        }))
        .expect("deserialize a tone");

        let saved = insert_tone(pool.clone(), &tone).await.expect("insert the tone");
        assert_eq!(saved.category.as_deref(), Some("conversational"));

        let loaded = fetch_tone_by_id(pool.clone(), "t1")
            .await
            .expect("read the tone")
            .expect("the tone exists");
        assert_eq!(loaded.name, "Casual");
        assert_eq!(loaded.sort_order, 3);
        assert_eq!(loaded.output_length.as_deref(), Some("short"));

        assert_eq!(fetch_all_tones(pool).await.expect("list tones").len(), 1);
    }
}
