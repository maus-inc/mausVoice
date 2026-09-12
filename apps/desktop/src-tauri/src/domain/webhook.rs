use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Webhook {
    pub id: String,
    pub url: String,
    pub events: String,
    pub secret_salt: Option<String>,
    pub secret_ciphertext: Option<String>,
    pub enabled: bool,
    pub created_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WebhookDelivery {
    pub id: String,
    pub webhook_id: String,
    pub event: String,
    pub payload: String,
    pub status: String,
    pub attempts: i64,
    pub last_attempt_at: Option<i64>,
    pub created_at: i64,
}
