use sqlx::{Row, SqlitePool};

use crate::domain::Conversation;

pub async fn insert_conversation(
    pool: SqlitePool,
    conversation: &Conversation,
) -> Result<Conversation, sqlx::Error> {
    sqlx::query(
        "INSERT INTO conversations (id, title, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(&conversation.id)
    .bind(&conversation.title)
    .bind(conversation.created_at)
    .bind(conversation.updated_at)
    .execute(&pool)
    .await?;

    Ok(conversation.clone())
}

pub async fn fetch_conversations(pool: SqlitePool) -> Result<Vec<Conversation>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, title, created_at, updated_at
         FROM conversations
         ORDER BY updated_at DESC",
    )
    .fetch_all(&pool)
    .await?;

    let conversations = rows
        .into_iter()
        .map(|row| Conversation {
            id: row.get::<String, _>("id"),
            title: row.get::<String, _>("title"),
            created_at: row.get::<i64, _>("created_at"),
            updated_at: row.get::<i64, _>("updated_at"),
        })
        .collect();

    Ok(conversations)
}

pub async fn update_conversation(
    pool: SqlitePool,
    conversation: &Conversation,
) -> Result<Conversation, sqlx::Error> {
    sqlx::query("UPDATE conversations SET title = ?2, updated_at = ?3 WHERE id = ?1")
        .bind(&conversation.id)
        .bind(&conversation.title)
        .bind(conversation.updated_at)
        .execute(&pool)
        .await?;

    Ok(conversation.clone())
}

pub async fn delete_conversation(pool: SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    // ONE statement, and the messages go with it.
    //
    // This used to delete the messages first and the conversation second, as two statements
    // against the pool. If the second failed -- SQLITE_BUSY, a disk error, a trigger -- the
    // conversation survived with its messages already gone, and there was nothing to put them
    // back: a later delete of that conversation removed an empty shell. Measured on this
    // schema with a trigger refusing the parent delete:
    //
    //     two statements    conversations 1, messages 0     <- partial deletion
    //     one statement     conversations 1, messages 3     <- all or nothing
    //
    // `chat_messages.conversation_id` is `ON DELETE CASCADE` (migration 063) and every pool
    // the app opens has foreign keys enforced (`sqlite_connect_options` in open.rs), so the
    // child statement was doing work the database already does. Dropping it is what makes the
    // remaining one atomic.
    //
    // `delete_chat_messages` in the sibling module carries the same shape for the same
    // reason, and the transaction there is this pull request's own work -- so this function
    // was the one place left below the bar the PR set.
    sqlx::query("DELETE FROM conversations WHERE id = ?1")
        .bind(id)
        .execute(&pool)
        .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::delete_conversation;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::SqlitePool;

    /// One connection, because `sqlite::memory:` is per-connection and the pragma is too --
    /// a second connection would be a second, empty database with foreign keys OFF.
    async fn conversation_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            // `in_memory(true)`, NOT `.filename("sqlite::memory:")`. The latter looks
            // right and is not: `SqlitePoolOptions::connect("sqlite::memory:")` special-cases
            // that string, while `filename` takes it as a literal path -- and SQLite then tries
            // to create a file with that name. Measured: code 14, "unable to open database file",
            // from all three tests at once.
            .connect_with(
                SqliteConnectOptions::new()
                    .in_memory(true)
                    .foreign_keys(true),
            )
            .await
            .expect("connect");
        sqlx::query(
            "CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, updated_at TEXT)",
        )
        .execute(&pool)
        .await
        .expect("create conversations");
        sqlx::query(
            "CREATE TABLE chat_messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                body TEXT,
                created_at TEXT,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            )",
        )
        .execute(&pool)
        .await
        .expect("create chat_messages");
        sqlx::query("INSERT INTO conversations (id, title, updated_at) VALUES ('c1', 't', 'now')")
            .execute(&pool)
            .await
            .expect("insert conversation");
        for id in ["m1", "m2", "m3"] {
            sqlx::query(
                "INSERT INTO chat_messages (id, conversation_id, body, created_at)
                 VALUES (?1, 'c1', 'body', 'now')",
            )
            .bind(id)
            .execute(&pool)
            .await
            .expect("insert message");
        }
        pool
    }

    /// The regression. Two statements and a refused parent delete left the conversation
    /// standing with its messages gone; the cascade means the messages are only ever removed
    /// as part of removing the conversation, so there is no window to be caught in.
    #[tokio::test]
    async fn a_refused_conversation_delete_leaves_its_messages() {
        let pool = conversation_pool().await;
        sqlx::query(
            "CREATE TRIGGER refuse_conversation_delete BEFORE DELETE ON conversations
             BEGIN SELECT RAISE(ABORT, 'refused'); END",
        )
        .execute(&pool)
        .await
        .expect("create trigger");

        assert!(delete_conversation(pool.clone(), "c1").await.is_err());

        let conversations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM conversations")
            .fetch_one(&pool)
            .await
            .unwrap();
        let messages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_messages")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(conversations, 1, "the conversation must survive");
        assert_eq!(
            messages, 3,
            "a refused delete must not have removed any messages"
        );
    }

    /// The positive control, and the reason the first test means anything: with the trigger
    /// absent the same call removes both, so the messages really are the cascade's doing.
    #[tokio::test]
    async fn a_successful_conversation_delete_removes_its_messages() {
        let pool = conversation_pool().await;

        delete_conversation(pool.clone(), "c1")
            .await
            .expect("delete");

        let conversations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM conversations")
            .fetch_one(&pool)
            .await
            .unwrap();
        let messages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_messages")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(conversations, 0);
        assert_eq!(messages, 0, "the cascade must remove the messages");
    }

    /// ...and an id that is not there is not an error, which is what the cascade shape buys
    /// over the two-statement version: there was no second statement to fail on a row that
    /// had already gone.
    #[tokio::test]
    async fn deleting_an_absent_conversation_is_not_an_error() {
        let pool = conversation_pool().await;

        delete_conversation(pool.clone(), "no-such-conversation")
            .await
            .expect("deleting something absent must succeed");

        let messages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_messages")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(messages, 3, "another conversation's messages are untouched");
    }
}
