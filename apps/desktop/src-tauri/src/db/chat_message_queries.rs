use sqlx::{Row, SqlitePool};

use crate::domain::ChatMessage;

pub async fn insert_chat_message(
    pool: SqlitePool,
    message: &ChatMessage,
) -> Result<ChatMessage, sqlx::Error> {
    sqlx::query(
        "INSERT INTO chat_messages (id, conversation_id, role, content, created_at, metadata)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(&message.id)
    .bind(&message.conversation_id)
    .bind(&message.role)
    .bind(&message.content)
    .bind(message.created_at)
    .bind(&message.metadata)
    .execute(&pool)
    .await?;

    Ok(message.clone())
}

pub async fn fetch_chat_messages_by_conversation(
    pool: SqlitePool,
    conversation_id: &str,
) -> Result<Vec<ChatMessage>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, conversation_id, role, content, created_at, metadata
         FROM chat_messages
         WHERE conversation_id = ?1
         ORDER BY created_at ASC",
    )
    .bind(conversation_id)
    .fetch_all(&pool)
    .await?;

    let messages = rows
        .into_iter()
        .map(|row| ChatMessage {
            id: row.get::<String, _>("id"),
            conversation_id: row.get::<String, _>("conversation_id"),
            role: row.get::<String, _>("role"),
            content: row.get::<String, _>("content"),
            created_at: row.get::<i64, _>("created_at"),
            metadata: row.get::<Option<String>, _>("metadata"),
        })
        .collect();

    Ok(messages)
}

pub async fn update_chat_message(
    pool: SqlitePool,
    message: &ChatMessage,
) -> Result<ChatMessage, sqlx::Error> {
    sqlx::query("UPDATE chat_messages SET content = ?2, metadata = ?3 WHERE id = ?1")
        .bind(&message.id)
        .bind(&message.content)
        .bind(&message.metadata)
        .execute(&pool)
        .await?;

    Ok(message.clone())
}

pub async fn delete_chat_messages(pool: SqlitePool, ids: &[String]) -> Result<(), sqlx::Error> {
    let mut transaction = pool.begin().await?;
    for id in ids {
        sqlx::query("DELETE FROM chat_messages WHERE id = ?1")
            .bind(id)
            .execute(&mut *transaction)
            .await?;
    }

    transaction.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::delete_chat_messages;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    async fn message_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE chat_messages (id TEXT PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO chat_messages VALUES ('first'), ('blocked'), ('last')")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn failed_tail_delete_rolls_back_every_message() {
        let pool = message_pool().await;
        sqlx::query(
            "CREATE TRIGGER reject_delete BEFORE DELETE ON chat_messages
             WHEN OLD.id = 'blocked' BEGIN SELECT RAISE(ABORT, 'blocked'); END",
        )
        .execute(&pool)
        .await
        .unwrap();
        let ids = vec!["first".into(), "blocked".into(), "last".into()];

        assert!(delete_chat_messages(pool.clone(), &ids).await.is_err());
        let remaining: Vec<String> = sqlx::query_scalar("SELECT id FROM chat_messages ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(remaining, vec!["blocked", "first", "last"]);
    }

    #[tokio::test]
    async fn successful_tail_delete_commits_only_selected_messages() {
        let pool = message_pool().await;
        delete_chat_messages(pool.clone(), &["first".into(), "last".into()])
            .await
            .unwrap();
        let remaining: Vec<String> = sqlx::query_scalar("SELECT id FROM chat_messages")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(remaining, vec!["blocked"]);
    }
}
