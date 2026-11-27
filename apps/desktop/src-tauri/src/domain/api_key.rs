use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ApiKeyCredentialStatus {
    Usable,
    NeedsReentry,
    InvalidFormat,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ApiKeyCredentialIssue {
    LegacyEncryption,
    DecryptionFailed,
    MissingKey,
    InvalidKeyFormat,
    MissingEndpoint,
    MissingRegion,
}

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ApiKey {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub created_at: i64,
    pub salt: String,
    pub key_hash: String,
    pub key_ciphertext: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_suffix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_processing_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "openRouterConfig")]
    pub openrouter_config: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub azure_region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_v1_path: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyCreateRequest {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub azure_region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_v1_path: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyUpdateRequest {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_processing_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "openRouterConfig")]
    pub openrouter_config: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub azure_region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_v1_path: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clear_transcription_path: Option<bool>,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyView {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_suffix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_full: Option<String>,
    pub credential_status: ApiKeyCredentialStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_issue: Option<ApiKeyCredentialIssue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_processing_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "openRouterConfig")]
    pub openrouter_config: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub azure_region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_v1_path: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription_path: Option<String>,
}

impl From<ApiKey> for ApiKeyView {
    fn from(api_key: ApiKey) -> Self {
        Self {
            id: api_key.id,
            name: api_key.name,
            provider: api_key.provider,
            created_at: api_key.created_at,
            key_suffix: api_key.key_suffix,
            key_full: None,
            credential_status: ApiKeyCredentialStatus::NeedsReentry,
            credential_issue: Some(ApiKeyCredentialIssue::MissingKey),
            transcription_model: api_key.transcription_model,
            post_processing_model: api_key.post_processing_model,
            openrouter_config: api_key.openrouter_config,
            base_url: api_key.base_url,
            azure_region: api_key.azure_region,
            include_v1_path: api_key.include_v1_path,
            transcription_path: api_key.transcription_path,
        }
    }
}

impl ApiKeyView {
    pub fn with_credential_state(
        mut self,
        key: Option<String>,
        status: ApiKeyCredentialStatus,
        issue: Option<ApiKeyCredentialIssue>,
    ) -> Self {
        self.key_full = key;
        self.credential_status = status;
        self.credential_issue = issue;
        self
    }
}
