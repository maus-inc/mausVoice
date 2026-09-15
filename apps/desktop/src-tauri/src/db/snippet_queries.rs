use sqlx::{Row, SqlitePool};

use crate::domain::Snippet;

pub async fn insert_snippet(pool: SqlitePool, snippet: &Snippet) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO snippets (id, trigger, body, variables, enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(&snippet.id)
    .bind(&snippet.trigger)
    .bind(&snippet.body)
    .bind(&snippet.variables)
    .bind(snippet.enabled)
    .bind(snippet.created_at)
    .bind(snippet.updated_at)
    .execute(&pool)
    .await?;
    Ok(())
}

pub async fn update_snippet(pool: SqlitePool, snippet: &Snippet) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE snippets SET trigger = ?1, body = ?2, variables = ?3, enabled = ?4, updated_at = ?5 WHERE id = ?6",
    )
    .bind(&snippet.trigger)
    .bind(&snippet.body)
    .bind(&snippet.variables)
    .bind(snippet.enabled)
    .bind(snippet.updated_at)
    .bind(&snippet.id)
    .execute(&pool)
    .await?;
    Ok(())
}

fn snippet_from_row(r: &sqlx::sqlite::SqliteRow) -> Snippet {
    Snippet {
        id: r.get::<String, _>("id"),
        trigger: r.get::<String, _>("trigger"),
        body: r.get::<String, _>("body"),
        variables: r.get::<String, _>("variables"),
        enabled: r.get::<bool, _>("enabled"),
        created_at: r.get::<i64, _>("created_at"),
        updated_at: r.get::<i64, _>("updated_at"),
    }
}

pub async fn fetch_snippets(pool: SqlitePool) -> Result<Vec<Snippet>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, trigger, body, variables, enabled, created_at, updated_at FROM snippets ORDER BY trigger ASC",
    )
    .fetch_all(&pool)
    .await?;
    Ok(rows.iter().map(snippet_from_row).collect())
}

pub async fn fetch_snippet_by_trigger(
    pool: SqlitePool,
    trigger: &str,
) -> Result<Option<Snippet>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, trigger, body, variables, enabled, created_at, updated_at FROM snippets WHERE trigger = ?1 LIMIT 1",
    )
    .bind(trigger)
    .fetch_optional(&pool)
    .await?;
    Ok(row.as_ref().map(snippet_from_row))
}

pub async fn delete_snippet(pool: SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM snippets WHERE id = ?1")
        .bind(id)
        .execute(&pool)
        .await?;
    Ok(())
}
