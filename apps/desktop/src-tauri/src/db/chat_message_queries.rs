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

fn pending_paste_revision(message: &ChatMessage) -> Option<i64> {
    let metadata: serde_json::Value = serde_json::from_str(message.metadata.as_deref()?).ok()?;
    if metadata.get("type")?.as_str()? != "pending-paste-review" {
        return None;
    }
    Some(
        metadata
            .get("draftRevision")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0),
    )
}

async fn fetch_chat_message_for_conversation(
    pool: &SqlitePool,
    id: &str,
    conversation_id: &str,
) -> Result<ChatMessage, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, conversation_id, role, content, created_at, metadata
         FROM chat_messages WHERE id = ?1 AND conversation_id = ?2",
    )
    .bind(id)
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?
    .ok_or(sqlx::Error::RowNotFound)?;

    Ok(ChatMessage {
        id: row.get::<String, _>("id"),
        conversation_id: row.get::<String, _>("conversation_id"),
        role: row.get::<String, _>("role"),
        content: row.get::<String, _>("content"),
        created_at: row.get::<i64, _>("created_at"),
        metadata: row.get::<Option<String>, _>("metadata"),
    })
}

pub async fn update_chat_message(
    pool: SqlitePool,
    message: &ChatMessage,
) -> Result<ChatMessage, sqlx::Error> {
    if let Some(revision) = pending_paste_revision(message) {
        let result = sqlx::query(
            "UPDATE chat_messages SET content = ?2, metadata = ?3
             WHERE id = ?1 AND conversation_id = ?4
               AND json_extract(metadata, '$.type') = 'pending-paste-review'
               AND json_extract(metadata, '$.status') = 'pending'
               AND CAST(COALESCE(json_extract(metadata, '$.draftRevision'), 0) AS INTEGER) < ?5",
        )
        .bind(&message.id)
        .bind(&message.content)
        .bind(&message.metadata)
        .bind(&message.conversation_id)
        .bind(revision)
        .execute(&pool)
        .await?;

        if result.rows_affected() > 0 {
            return Ok(message.clone());
        }

        // A newer revision may already have won the write race. Return the
        // stored row; the caller checks its status and revision before success.
        return fetch_chat_message_for_conversation(&pool, &message.id, &message.conversation_id)
            .await;
    }

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
    use super::{delete_chat_messages, insert_chat_message, update_chat_message};
    use crate::domain::ChatMessage;
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

    fn pending_review_message(
        id: &str,
        conversation_id: &str,
        revision: u64,
        text: &str,
    ) -> ChatMessage {
        ChatMessage {
            id: id.to_owned(),
            conversation_id: conversation_id.to_owned(),
            role: "system".to_owned(),
            content: String::new(),
            created_at: 1,
            metadata: Some(format!(
                "{{\"type\":\"pending-paste-review\",\"status\":\"pending\",\"draftRevision\":{revision},\"text\":\"{text}\"}}"
            )),
        }
    }

    async fn revision_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE chat_messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                metadata TEXT
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn stale_pending_paste_revision_cannot_overwrite_a_newer_retry() {
        let pool = revision_pool().await;
        insert_chat_message(
            pool.clone(),
            &pending_review_message("review", "conversation", 1, "original"),
        )
        .await
        .unwrap();

        let latest = update_chat_message(
            pool.clone(),
            &pending_review_message("review", "conversation", 3, "latest draft"),
        )
        .await
        .unwrap();
        assert!(latest.metadata.unwrap().contains("latest draft"));

        let stale = update_chat_message(
            pool.clone(),
            &pending_review_message("review", "conversation", 2, "stale draft"),
        )
        .await
        .unwrap();
        let metadata = stale.metadata.unwrap();
        assert!(metadata.contains("latest draft"));
        assert!(!metadata.contains("stale draft"));
        assert!(metadata.contains(r#""draftRevision":3"#));
    }

    #[tokio::test]
    async fn pending_paste_revision_update_fails_if_card_was_deleted() {
        let pool = revision_pool().await;
        let missing = pending_review_message("missing", "conversation", 1, "draft");
        assert!(update_chat_message(pool, &missing).await.is_err());
    }

    #[tokio::test]
    async fn pending_paste_revision_update_rejects_a_different_conversation() {
        let pool = revision_pool().await;
        insert_chat_message(
            pool.clone(),
            &pending_review_message("review", "owner-conversation", 1, "original"),
        )
        .await
        .unwrap();

        let wrong_owner = pending_review_message("review", "other-conversation", 2, "draft");
        assert!(update_chat_message(pool, &wrong_owner).await.is_err());
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
