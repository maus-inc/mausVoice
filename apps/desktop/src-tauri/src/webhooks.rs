use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::db::webhook_queries;
use crate::domain::Webhook;

/// HMAC-SHA256 over `message`, hex-encoded. Implemented against `sha2`
/// directly so webhook signing needs no extra macro crate; the RFC 4231
/// vector below locks the construction.
pub fn hmac_sha256_hex(key: &[u8], message: &[u8]) -> String {
    const BLOCK: usize = 64;
    let mut key_block = vec![0u8; BLOCK];
    if key.len() > BLOCK {
        let digest = Sha256::digest(key);
        key_block[..digest.len()].copy_from_slice(&digest);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(key_block.iter().map(|b| b ^ 0x36).collect::<Vec<u8>>());
    inner.update(message);
    let inner_digest = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(key_block.iter().map(|b| b ^ 0x5c).collect::<Vec<u8>>());
    outer.update(inner_digest);
    format!("{:x}", outer.finalize())
}

fn signature_header(secret: &str, body: &str) -> (String, String) {
    (
        "X-Mausvoice-Signature".to_string(),
        format!("sha256={}", hmac_sha256_hex(secret.as_bytes(), body.as_bytes())),
    )
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn reveal_secret(webhook: &Webhook) -> Result<Option<String>, String> {
    match (&webhook.secret_salt, &webhook.secret_ciphertext) {
        (Some(salt), Some(ciphertext)) => {
            crate::system::crypto::reveal_api_key(salt, ciphertext)
                .map(Some)
                .map_err(|err| format!("stored webhook secret cannot be revealed: {err:?}"))
        }
        _ => Ok(None),
    }
}

async fn attempt_once(
    client: &reqwest::Client,
    url: &str,
    body: &str,
    secret: Option<&str>,
) -> Result<(), String> {
    let mut request = client
        .post(url)
        .header("Content-Type", "application/json")
        .body(body.to_string());
    if let Some(secret) = secret {
        let (name, value) = signature_header(secret, body);
        request = request.header(name, value);
    }
    let response = request
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("delivery request failed: {err}"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("delivery rejected: {}", response.status()))
    }
}

/// Fan out `event` to every subscribed webhook: one delivery row each,
/// then at most three attempts per row with a short backoff. Runs in a
/// spawned task; callers never wait for the network.
pub async fn emit_event(pool: SqlitePool, event: &str, payload: serde_json::Value) {
    let webhooks = match webhook_queries::fetch_webhooks(pool.clone()).await {
        Ok(rows) => rows,
        Err(err) => {
            log::warn!("webhook emit {event} failed to list webhooks: {err}");
            return;
        }
    };
    let body = serde_json::json!({
        "event": event,
        "payload": payload,
        "timestamp": now_ms(),
    })
    .to_string();

    for webhook in webhooks
        .into_iter()
        .filter(|hook| webhook_queries::webhook_subscribes(hook, event))
    {
        let delivery = crate::domain::WebhookDelivery {
            id: format!("wdl_{}", uuid_simple()),
            webhook_id: webhook.id.clone(),
            event: event.to_string(),
            payload: body.clone(),
            status: "pending".to_string(),
            attempts: 0,
            last_attempt_at: None,
            created_at: now_ms(),
        };
        if let Err(err) = webhook_queries::insert_delivery(pool.clone(), &delivery).await {
            log::warn!("webhook emit {event} failed to record delivery: {err}");
            continue;
        }
        let task_pool = pool.clone();
        let delivery_id = delivery.id.clone();
        tauri::async_runtime::spawn(async move {
            deliver_with_retry(task_pool, delivery_id, webhook, body).await;
        });
    }
}

async fn deliver_with_retry(
    pool: SqlitePool,
    delivery_id: String,
    webhook: Webhook,
    body: String,
) {
    let secret = match reveal_secret(&webhook) {
        Ok(secret) => secret,
        Err(err) => {
            log::warn!("webhook delivery {delivery_id} failed: {err}");
            let _ = webhook_queries::update_delivery(
                pool,
                &delivery_id,
                "failed",
                1,
                now_ms(),
            )
            .await;
            return;
        }
    };
    let client = reqwest::Client::new();
    let mut attempts: i64 = 0;
    for backoff_secs in [0u64, 2, 8] {
        if backoff_secs > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
        }
        attempts += 1;
        match attempt_once(&client, &webhook.url, &body, secret.as_deref()).await {
            Ok(()) => {
                let _ = webhook_queries::update_delivery(
                    pool,
                    &delivery_id,
                    "delivered",
                    attempts,
                    now_ms(),
                )
                .await;
                return;
            }
            Err(err) => {
                log::warn!("webhook delivery {delivery_id} attempt {attempts} failed: {err}");
            }
        }
    }
    let _ = webhook_queries::update_delivery(pool, &delivery_id, "failed", attempts, now_ms())
        .await;
}

fn uuid_simple() -> String {
    use rand::{rngs::OsRng, RngCore};

    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_rfc_4231_vector() {
        let key = vec![0x0bu8; 20];
        assert_eq!(
            hmac_sha256_hex(&key, b"Hi There"),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    #[test]
    fn hmac_hashes_long_keys_first() {
        let long_key = vec![0xabu8; 100];
        let short = hmac_sha256_hex(&long_key, b"msg");
        assert_eq!(short.len(), 64);
        assert_ne!(short, hmac_sha256_hex(b"other", b"msg"));
    }

    #[test]
    fn signature_header_names_algorithm() {
        let (name, value) = signature_header("secret", "{}");
        assert_eq!(name, "X-Mausvoice-Signature");
        assert!(value.starts_with("sha256="));
        assert_eq!(value.len(), "sha256=".len() + 64);
    }
}
