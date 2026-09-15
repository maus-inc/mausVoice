use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub trigger: String,
    pub body: String,
    pub variables: String,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}
