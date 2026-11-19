use sqlx::{Row, SqlitePool};

use crate::domain::Term;

pub async fn insert_term(pool: SqlitePool, term: &Term) -> Result<Term, sqlx::Error> {
    sqlx::query(
        "INSERT INTO terms (id, created_at, created_by_user_id, source_value, destination_value, is_replacement, is_deleted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(&term.id)
    .bind(term.created_at)
    .bind(&term.created_by_user_id)
    .bind(&term.source_value)
    .bind(&term.destination_value)
    .bind(term.is_replacement as i64)
    .bind(term.is_deleted as i64)
    .execute(&pool)
    .await?;

    Ok(term.clone())
}

pub async fn fetch_terms(pool: SqlitePool) -> Result<Vec<Term>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, created_at, created_by_user_id, source_value, destination_value, is_replacement, is_deleted
         FROM terms
         WHERE is_deleted = 0
         ORDER BY created_at DESC",
    )
    .fetch_all(&pool)
    .await?;

    let terms = rows
        .into_iter()
        .map(|row| Term {
            id: row.get::<String, _>("id"),
            created_at: row.get::<i64, _>("created_at"),
            created_by_user_id: row.get::<String, _>("created_by_user_id"),
            source_value: row.get::<String, _>("source_value"),
            destination_value: row.get::<String, _>("destination_value"),
            is_replacement: row.get::<i64, _>("is_replacement") != 0,
            is_deleted: row.get::<i64, _>("is_deleted") != 0,
        })
        .collect();

    Ok(terms)
}

pub async fn update_term(pool: SqlitePool, term: &Term) -> Result<Term, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE terms
         SET source_value = ?2,
             destination_value = ?3,
             is_replacement = ?4
         WHERE id = ?1 AND is_deleted = 0",
    )
    .bind(&term.id)
    .bind(&term.source_value)
    .bind(&term.destination_value)
    .bind(term.is_replacement as i64)
    .execute(&pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(sqlx::Error::RowNotFound);
    }
    let mut updated = term.clone();
    updated.is_deleted = false;
    Ok(updated)
}

pub async fn delete_term(pool: SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE terms
         SET is_deleted = 1
         WHERE id = ?1",
    )
    .bind(id)
    .execute(&pool)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect to in-memory database");
        sqlx::query(
            "CREATE TABLE terms (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
             created_by_user_id TEXT NOT NULL, source_value TEXT NOT NULL,
             destination_value TEXT NOT NULL, is_replacement INTEGER NOT NULL,
             is_deleted INTEGER NOT NULL)",
        )
        .execute(&pool)
        .await
        .expect("create terms table");
        pool
    }

    fn term(id: &str) -> Term {
        Term {
            id: id.to_string(),
            created_at: 1,
            created_by_user_id: String::new(),
            source_value: "original".to_string(),
            destination_value: String::new(),
            is_replacement: false,
            is_deleted: false,
        }
    }

    #[tokio::test]
    async fn stale_edits_cannot_restore_deleted_or_missing_rows() {
        let pool = pool().await;
        let original = term("one");
        insert_term(pool.clone(), &original).await.unwrap();
        let mut edited = original.clone();
        edited.source_value = "edited".to_string();
        update_term(pool.clone(), &edited).await.unwrap();
        delete_term(pool.clone(), &original.id).await.unwrap();
        assert!(matches!(
            update_term(pool.clone(), &original).await,
            Err(sqlx::Error::RowNotFound)
        ));
        assert!(fetch_terms(pool.clone()).await.unwrap().is_empty());
        assert!(matches!(
            update_term(pool, &term("missing")).await,
            Err(sqlx::Error::RowNotFound)
        ));
    }

    #[tokio::test]
    async fn update_cannot_set_the_delete_flag() {
        let pool = pool().await;
        let original = term("one");
        insert_term(pool.clone(), &original).await.unwrap();
        let mut edited = original;
        edited.is_deleted = true;
        edited.source_value = "updated".to_string();
        let saved = update_term(pool.clone(), &edited).await.unwrap();
        assert!(!saved.is_deleted);
        let rows = fetch_terms(pool).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source_value, "updated");
    }
}
