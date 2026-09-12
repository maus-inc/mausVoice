use sqlx::{Row, SqlitePool};

use crate::domain::{Webhook, WebhookDelivery};

pub async fn insert_webhook(
    pool: SqlitePool,
    webhook: &Webhook,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO webhooks (id, url, events, secret_salt, secret_ciphertext, enabled, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(&webhook.id)
    .bind(&webhook.url)
    .bind(&webhook.events)
    .bind(&webhook.secret_salt)
    .bind(&webhook.secret_ciphertext)
    .bind(webhook.enabled)
    .bind(webhook.created_at)
    .execute(&pool)
    .await?;
    Ok(())
}

fn webhook_from_row(r: &sqlx::sqlite::SqliteRow) -> Webhook {
    Webhook {
        id: r.get::<String, _>("id"),
        url: r.get::<String, _>("url"),
        events: r.get::<String, _>("events"),
        secret_salt: r.try_get::<Option<String>, _>("secret_salt").unwrap_or(None),
        secret_ciphertext: r
            .try_get::<Option<String>, _>("secret_ciphertext")
            .unwrap_or(None),
        enabled: r.get::<bool, _>("enabled"),
        created_at: r.get::<i64, _>("created_at"),
    }
}

pub async fn fetch_webhooks(pool: SqlitePool) -> Result<Vec<Webhook>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, url, events, secret_salt, secret_ciphertext, enabled, created_at
         FROM webhooks ORDER BY created_at DESC",
    )
    .fetch_all(&pool)
    .await?;

    Ok(rows.iter().map(webhook_from_row).collect())
}

pub async fn delete_webhook(pool: SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM webhooks WHERE id = ?1")
        .bind(id)
        .execute(&pool)
        .await?;
    Ok(())
}

/// True when the webhook is enabled and its event list names `event`.
/// The list is stored as a JSON array; parsing beats LIKE matching, which
/// a crafted event name could fool.
pub fn webhook_subscribes(webhook: &Webhook, event: &str) -> bool {
    if !webhook.enabled {
        return false;
    }
    serde_json::from_str::<Vec<String>>(&webhook.events)
        .map(|events| events.iter().any(|name| name == event))
        .unwrap_or(false)
}

pub async fn insert_delivery(
    pool: SqlitePool,
    delivery: &WebhookDelivery,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status, attempts, last_attempt_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(&delivery.id)
    .bind(&delivery.webhook_id)
    .bind(&delivery.event)
    .bind(&delivery.payload)
    .bind(&delivery.status)
    .bind(delivery.attempts)
    .bind(delivery.last_attempt_at)
    .bind(delivery.created_at)
    .execute(&pool)
    .await?;
    Ok(())
}

pub async fn update_delivery(
    pool: SqlitePool,
    id: &str,
    status: &str,
    attempts: i64,
    last_attempt_at: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE webhook_deliveries SET status = ?1, attempts = ?2, last_attempt_at = ?3 WHERE id = ?4",
    )
    .bind(status)
    .bind(attempts)
    .bind(last_attempt_at)
    .bind(id)
    .execute(&pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hook(events: &str, enabled: bool) -> Webhook {
        Webhook {
            id: "w".to_string(),
            url: "https://example.com/hook".to_string(),
            events: events.to_string(),
            secret_salt: None,
            secret_ciphertext: None,
            enabled,
            created_at: 0,
        }
    }

    #[test]
    fn subscribes_matches_exact_event_names() {
        let subscribed = hook(r#"["transcription.completed","meeting.completed"]"#, true);
        assert!(webhook_subscribes(&subscribed, "meeting.completed"));
        assert!(!webhook_subscribes(&subscribed, "meeting"));
        assert!(!webhook_subscribes(&subscribed, "meeting.completed.evil"));
    }

    #[test]
    fn subscribes_rejects_disabled_and_broken_lists() {
        assert!(!webhook_subscribes(
            &hook(r#"["meeting.completed"]"#, false),
            "meeting.completed"
        ));
        assert!(!webhook_subscribes(&hook("not-json", true), "meeting.completed"));
    }
}
