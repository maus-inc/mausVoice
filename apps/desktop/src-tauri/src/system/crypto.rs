use base64::{engine::general_purpose, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use url::Url;

use crate::domain::{ApiKeyCredentialIssue, ApiKeyCredentialStatus};

const SECRET_ENV: &str = "MAUSVOICE_API_KEY_SECRET";
const XNONCE_LEN: usize = 24;
// Upstream Voquill generated 16-byte salts for its SHA-256 XOR keystream
// cipher, whereas mausVoice uses 24-byte XChaCha20-Poly1305 nonces. Detecting
// that exact length lets callers tell users *why* a migrated key must be
// re-entered instead of showing a generic failure or pretending it works.
const LEGACY_VOQUILL_SALT_LEN: usize = 16;

static RUNTIME_SECRET: OnceLock<Vec<u8>> = OnceLock::new();
static LEGACY_FALLBACK_SECRET: OnceLock<Vec<u8>> = OnceLock::new();
static LOGGED_FALLBACK: OnceLock<()> = OnceLock::new();

// The pre-machine-id fallback derivation, for decrypting credentials that were
// persisted before commit 79434736 added the machine identifier to the fallback
// secret. `runtime_secret()` hashes the label + machine id + home + user; this
// mirrors the older label + home + user derivation (no machine id) so rows
// written under that fallback remain decryptable after upgrade.
fn legacy_fallback_secret() -> &'static [u8] {
    LEGACY_FALLBACK_SECRET
        .get_or_init(|| {
            let mut hasher = Sha256::new();
            hasher.update(b"mausvoice-local-dev-fallback-v1");
            if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
                hasher.update(home.as_bytes());
            }
            if let Ok(user) = std::env::var("USER").or_else(|_| std::env::var("USERNAME")) {
                hasher.update(user.as_bytes());
            }
            hasher.finalize().to_vec()
        })
        .as_slice()
}

pub struct ProtectedApiKey {
    // Holds the per-record XChaCha20-Poly1305 nonce (kept under the existing
    // `salt` column name to avoid a schema migration).
    pub salt_b64: String,
    pub hash_b64: String,
    pub ciphertext_b64: String,
    pub key_suffix: Option<String>,
}

// Prefers a value baked in at build time (option_env!), then a runtime env var.
// Falls back to a built-in secret so running from source never hard-fails;
// setting MAUSVOICE_API_KEY_SECRET at build time is recommended for shipped builds.
pub fn runtime_secret() -> &'static [u8] {
    RUNTIME_SECRET
        .get_or_init(|| {
            if let Some(value) = option_env!("MAUSVOICE_API_KEY_SECRET") {
                if !value.is_empty() {
                    return value.as_bytes().to_vec();
                }
            }
            match std::env::var(SECRET_ENV) {
                Ok(value) if !value.is_empty() => value.into_bytes(),
                _ => {
                    LOGGED_FALLBACK.get_or_init(|| {
                        log::warn!(
                            "{SECRET_ENV} not set; using a per-machine fallback secret. Set this \
                             at build time to protect stored API keys at rest."
                        );
                    });
                    {
                        // Fallback secret. Instead of a static published default, derive it from
                        // the host's stable device id (Windows MachineGuid / macOS IOPlatformUUID /
                        // Linux machine-id) plus the user profile, so the secret is unique per
                        // machine and does not travel with the database. A copied DB cannot be
                        // decrypted on another host without its machine id.
                        let mut hasher = Sha256::new();
                        hasher.update(b"mausvoice-device-fallback-v1");
                        if let Some(machine) = crate::system::machine_id::machine_id() {
                            hasher.update(machine.as_bytes());
                        }
                        if let Ok(home) =
                            std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"))
                        {
                            hasher.update(home.as_bytes());
                        }
                        if let Ok(user) =
                            std::env::var("USER").or_else(|_| std::env::var("USERNAME"))
                        {
                            hasher.update(user.as_bytes());
                        }
                        hasher.finalize().to_vec()
                    }
                }
            }
        })
        .as_slice()
}

pub fn protect_api_key(key: &str) -> ProtectedApiKey {
    let secret = runtime_secret();
    let nonce = generate_nonce();
    let cipher = cipher_for(secret, &nonce);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), key.as_bytes())
        .expect("XChaCha20-Poly1305 encryption failed");

    ProtectedApiKey {
        salt_b64: general_purpose::STANDARD.encode(nonce),
        hash_b64: general_purpose::STANDARD.encode(hash_key(secret, &nonce, key.as_bytes())),
        ciphertext_b64: general_purpose::STANDARD.encode(ciphertext),
        key_suffix: compute_key_suffix(key),
    }
}

pub fn reveal_api_key(salt_b64: &str, ciphertext_b64: &str) -> Result<String, CryptoError> {
    let nonce = general_purpose::STANDARD
        .decode(salt_b64)
        .map_err(|err| CryptoError::Base64(err.to_string()))?;
    if nonce.len() == LEGACY_VOQUILL_SALT_LEN {
        return Err(CryptoError::LegacyFormat);
    }
    if nonce.len() != XNONCE_LEN {
        return Err(CryptoError::Decryption(
            "stored nonce has unexpected length".to_string(),
        ));
    }
    let ciphertext = general_purpose::STANDARD
        .decode(ciphertext_b64)
        .map_err(|err| CryptoError::Base64(err.to_string()))?;

    let mut last_error = None;
    let mut candidates: Vec<&'static [u8]> = vec![runtime_secret()];
    // Only offer the legacy derivation when the runtime secret itself is the
    // built-in fallback; if an explicit secret is set there is no legacy variant
    // to migrate from (all writes already used the explicit secret).
    if option_env!("MAUSVOICE_API_KEY_SECRET").is_none()
        && std::env::var(SECRET_ENV)
            .map(|v| v.is_empty())
            .unwrap_or(true)
    {
        candidates.push(legacy_fallback_secret());
    }

    for secret in candidates {
        let cipher = cipher_for(secret, &nonce);
        match cipher.decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref()) {
            Ok(plaintext) => {
                return String::from_utf8(plaintext)
                    .map_err(|err| CryptoError::InvalidUtf8(err.to_string()));
            }
            Err(err) => {
                last_error = Some(err);
            }
        }
    }

    Err(CryptoError::Decryption(
        last_error
            .map(|err| err.to_string())
            .unwrap_or_else(|| "all decryption attempts failed".to_string()),
    ))
}

#[derive(Debug, PartialEq, Eq)]
pub struct CredentialInspection {
    pub key_full: Option<String>,
    pub status: ApiKeyCredentialStatus,
    pub issue: Option<ApiKeyCredentialIssue>,
}

/// Providers that can legitimately operate against a local or self-hosted
/// server without an API key when their ciphertext decrypts cleanly to empty.
pub fn provider_allows_empty_key(provider: &str) -> bool {
    matches!(provider, "ollama" | "speaches" | "openai-compatible")
}

fn is_valid_http_endpoint(raw: Option<&str>) -> bool {
    let Some(value) = raw.map(str::trim).filter(|v| !v.is_empty()) else {
        return false;
    };
    let Ok(parsed) = Url::parse(value) else {
        return false;
    };
    matches!(parsed.scheme(), "http" | "https")
        && parsed.host_str().is_some()
        && parsed.username().is_empty()
        && parsed.password().is_none()
}

/// Inspects a stored provider record and determines whether its credential is
/// genuinely readable and structurally usable under the current mausVoice
/// identity. Never infers usability from row presence or opaque ciphertext.
pub fn inspect_api_key_credential(
    provider: &str,
    salt_b64: &str,
    ciphertext_b64: &str,
    base_url: Option<&str>,
    azure_region: Option<&str>,
) -> CredentialInspection {
    if salt_b64.trim().is_empty() && ciphertext_b64.trim().is_empty() {
        return if provider_allows_empty_key(provider) {
            validate_provider_structure(provider, String::new(), base_url, azure_region)
        } else {
            CredentialInspection {
                key_full: None,
                status: ApiKeyCredentialStatus::NeedsReentry,
                issue: Some(ApiKeyCredentialIssue::MissingKey),
            }
        };
    }

    let plaintext = match reveal_api_key(salt_b64, ciphertext_b64) {
        Ok(value) => value,
        Err(CryptoError::LegacyFormat) => {
            return CredentialInspection {
                key_full: None,
                status: ApiKeyCredentialStatus::NeedsReentry,
                issue: Some(ApiKeyCredentialIssue::LegacyEncryption),
            };
        }
        Err(_) => {
            return CredentialInspection {
                key_full: None,
                status: ApiKeyCredentialStatus::NeedsReentry,
                issue: Some(ApiKeyCredentialIssue::DecryptionFailed),
            };
        }
    };

    if plaintext.trim().is_empty() {
        if !provider_allows_empty_key(provider) {
            return CredentialInspection {
                key_full: None,
                status: ApiKeyCredentialStatus::NeedsReentry,
                issue: Some(ApiKeyCredentialIssue::MissingKey),
            };
        }
        return validate_provider_structure(provider, String::new(), base_url, azure_region);
    }

    if plaintext.chars().any(char::is_control) || plaintext.trim() != plaintext {
        return CredentialInspection {
            key_full: None,
            status: ApiKeyCredentialStatus::InvalidFormat,
            issue: Some(ApiKeyCredentialIssue::InvalidKeyFormat),
        };
    }

    validate_provider_structure(provider, plaintext, base_url, azure_region)
}

fn validate_provider_structure(
    provider: &str,
    key: String,
    base_url: Option<&str>,
    azure_region: Option<&str>,
) -> CredentialInspection {
    let trimmed_base_url = base_url.map(str::trim).filter(|url| !url.is_empty());

    if provider == "openai-compatible"
        && trimmed_base_url.is_some()
        && !is_valid_http_endpoint(trimmed_base_url)
    {
        return CredentialInspection {
            key_full: None,
            status: ApiKeyCredentialStatus::InvalidFormat,
            issue: Some(ApiKeyCredentialIssue::MissingEndpoint),
        };
    }

    if provider == "azure" {
        if let Some(url) = trimmed_base_url {
            if !is_valid_http_endpoint(Some(url)) {
                return CredentialInspection {
                    key_full: None,
                    status: ApiKeyCredentialStatus::InvalidFormat,
                    issue: Some(ApiKeyCredentialIssue::MissingEndpoint),
                };
            }
        } else if azure_region
            .map(str::trim)
            .filter(|region| !region.is_empty())
            .is_none()
        {
            return CredentialInspection {
                key_full: None,
                status: ApiKeyCredentialStatus::InvalidFormat,
                issue: Some(ApiKeyCredentialIssue::MissingRegion),
            };
        }
    }

    CredentialInspection {
        key_full: Some(key),
        status: ApiKeyCredentialStatus::Usable,
        issue: None,
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("invalid base64 data: {0}")]
    Base64(String),
    #[error("stored API key is not valid UTF-8: {0}")]
    InvalidUtf8(String),
    #[error("stored API key uses legacy Voquill encryption and must be re-entered")]
    LegacyFormat,
    #[error("failed to decrypt stored API key: {0}")]
    Decryption(String),
}

fn cipher_for(secret: &[u8], nonce: &[u8]) -> XChaCha20Poly1305 {
    let key = derive_key(secret, nonce);
    XChaCha20Poly1305::new_from_slice(&key).expect("XChaCha20-Poly1305 key must be 32 bytes")
}

fn derive_key(secret: &[u8], nonce: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(secret);
    hasher.update(nonce);
    hasher.finalize().into()
}

fn generate_nonce() -> [u8; XNONCE_LEN] {
    let mut nonce = [0u8; XNONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    nonce
}

fn hash_key(secret: &[u8], nonce: &[u8], key: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(secret);
    hasher.update(nonce);
    hasher.update(key);
    hasher.finalize().into()
}

fn compute_key_suffix(key: &str) -> Option<String> {
    let mut chars = key.chars();
    let mut buffer = Vec::new();

    while let Some(ch) = chars.next_back() {
        buffer.push(ch);
        if buffer.len() == 4 {
            break;
        }
    }

    if buffer.is_empty() {
        None
    } else {
        buffer.reverse();
        Some(buffer.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_key() {
        let protected = protect_api_key("gsk_super_secret_value");
        let revealed =
            reveal_api_key(&protected.salt_b64, &protected.ciphertext_b64).expect("reveal");
        assert_eq!(revealed, "gsk_super_secret_value");
    }

    #[test]
    fn uses_a_fresh_nonce_per_call() {
        let a = protect_api_key("same-key");
        let b = protect_api_key("same-key");
        assert_ne!(a.salt_b64, b.salt_b64);
        assert_ne!(a.ciphertext_b64, b.ciphertext_b64);
    }

    #[test]
    fn rejects_tampered_ciphertext() {
        let protected = protect_api_key("gsk_tamper_target");
        let mut raw = general_purpose::STANDARD
            .decode(&protected.ciphertext_b64)
            .expect("decode");
        raw[0] ^= 0xFF;
        let tampered = general_purpose::STANDARD.encode(raw);
        assert!(reveal_api_key(&protected.salt_b64, &tampered).is_err());
    }

    #[test]
    fn exposes_last_four_as_suffix() {
        let protected = protect_api_key("abcdef1234");
        assert_eq!(protected.key_suffix.as_deref(), Some("1234"));
    }

    #[test]
    fn reveals_credentials_encrypted_with_legacy_fallback() {
        // Simulate a row written before the machine-id fallback existed: encrypt
        // with the legacy label + home + user derivation, then confirm reveal
        // still decrypts it (current secret fails, legacy succeeds).
        let legacy = legacy_fallback_secret();
        let nonce = generate_nonce();
        let cipher = cipher_for(legacy, &nonce);
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                b"gsk_legacy_row_value".as_slice(),
            )
            .expect("legacy encrypt");
        let salt_b64 = general_purpose::STANDARD.encode(nonce);
        let ciphertext_b64 = general_purpose::STANDARD.encode(ciphertext);

        let revealed = reveal_api_key(&salt_b64, &ciphertext_b64).expect("legacy row decrypts");
        assert_eq!(revealed, "gsk_legacy_row_value");
    }

    #[test]
    fn classifies_voquill_16_byte_salt_as_legacy_encryption() {
        let voquill_salt = general_purpose::STANDARD.encode([0x42u8; LEGACY_VOQUILL_SALT_LEN]);
        let voquill_ciphertext = general_purpose::STANDARD.encode(b"opaque-xor-bytes");

        let inspection =
            inspect_api_key_credential("groq", &voquill_salt, &voquill_ciphertext, None, None);

        assert_eq!(inspection.key_full, None);
        assert_eq!(inspection.status, ApiKeyCredentialStatus::NeedsReentry);
        assert_eq!(
            inspection.issue,
            Some(ApiKeyCredentialIssue::LegacyEncryption)
        );
    }

    #[test]
    fn classifies_tampered_or_wrong_machine_key_as_decryption_failed() {
        let foreign_nonce = generate_nonce();
        let foreign_cipher = cipher_for(b"some-other-machine-secret", &foreign_nonce);
        let ciphertext = foreign_cipher
            .encrypt(
                XNonce::from_slice(&foreign_nonce),
                b"gsk_unreadable".as_slice(),
            )
            .expect("encrypt");
        let salt_b64 = general_purpose::STANDARD.encode(foreign_nonce);
        let ciphertext_b64 = general_purpose::STANDARD.encode(ciphertext);

        let inspection =
            inspect_api_key_credential("deepgram", &salt_b64, &ciphertext_b64, None, None);

        assert_eq!(inspection.key_full, None);
        assert_eq!(inspection.status, ApiKeyCredentialStatus::NeedsReentry);
        assert_eq!(
            inspection.issue,
            Some(ApiKeyCredentialIssue::DecryptionFailed)
        );
    }

    #[test]
    fn classifies_empty_key_according_to_provider_requirements() {
        let empty = protect_api_key("");

        let groq =
            inspect_api_key_credential("groq", &empty.salt_b64, &empty.ciphertext_b64, None, None);
        assert_eq!(groq.key_full, None);
        assert_eq!(groq.status, ApiKeyCredentialStatus::NeedsReentry);
        assert_eq!(groq.issue, Some(ApiKeyCredentialIssue::MissingKey));

        let ollama = inspect_api_key_credential(
            "ollama",
            &empty.salt_b64,
            &empty.ciphertext_b64,
            Some("http://localhost:11434"),
            None,
        );
        assert_eq!(ollama.key_full.as_deref(), Some(""));
        assert_eq!(ollama.status, ApiKeyCredentialStatus::Usable);
        assert_eq!(ollama.issue, None);

        let openai_compat_default_url = inspect_api_key_credential(
            "openai-compatible",
            &empty.salt_b64,
            &empty.ciphertext_b64,
            None,
            None,
        );
        assert_eq!(
            openai_compat_default_url.status,
            ApiKeyCredentialStatus::Usable
        );
        assert_eq!(openai_compat_default_url.issue, None);

        let openai_compat_blank_url = inspect_api_key_credential(
            "openai-compatible",
            &empty.salt_b64,
            &empty.ciphertext_b64,
            Some("   "),
            None,
        );
        assert_eq!(
            openai_compat_blank_url.status,
            ApiKeyCredentialStatus::Usable
        );
        assert_eq!(openai_compat_blank_url.issue, None);

        let openai_compat_invalid_url = inspect_api_key_credential(
            "openai-compatible",
            &empty.salt_b64,
            &empty.ciphertext_b64,
            Some("not-a-valid-endpoint"),
            None,
        );
        assert_eq!(
            openai_compat_invalid_url.status,
            ApiKeyCredentialStatus::InvalidFormat
        );
        assert_eq!(
            openai_compat_invalid_url.issue,
            Some(ApiKeyCredentialIssue::MissingEndpoint)
        );

        let openai_compat_valid_url = inspect_api_key_credential(
            "openai-compatible",
            &empty.salt_b64,
            &empty.ciphertext_b64,
            Some("http://localhost:8000/v1"),
            None,
        );
        assert_eq!(
            openai_compat_valid_url.status,
            ApiKeyCredentialStatus::Usable
        );
        assert_eq!(openai_compat_valid_url.issue, None);
    }

    #[test]
    fn rejects_control_characters_and_missing_azure_region() {
        let bad_key = protect_api_key("gsk_line1\nline2");
        let bad = inspect_api_key_credential(
            "groq",
            &bad_key.salt_b64,
            &bad_key.ciphertext_b64,
            None,
            None,
        );
        assert_eq!(bad.key_full, None);
        assert_eq!(bad.status, ApiKeyCredentialStatus::InvalidFormat);
        assert_eq!(bad.issue, Some(ApiKeyCredentialIssue::InvalidKeyFormat));

        let good_azure = protect_api_key("azure_valid_key_1234");
        let missing_region = inspect_api_key_credential(
            "azure",
            &good_azure.salt_b64,
            &good_azure.ciphertext_b64,
            None,
            None,
        );
        assert_eq!(missing_region.status, ApiKeyCredentialStatus::InvalidFormat);
        assert_eq!(
            missing_region.issue,
            Some(ApiKeyCredentialIssue::MissingRegion)
        );

        let valid_azure_speech = inspect_api_key_credential(
            "azure",
            &good_azure.salt_b64,
            &good_azure.ciphertext_b64,
            None,
            Some("eastus"),
        );
        assert_eq!(valid_azure_speech.status, ApiKeyCredentialStatus::Usable);
        assert_eq!(
            valid_azure_speech.key_full.as_deref(),
            Some("azure_valid_key_1234")
        );

        // Azure OpenAI keys provide an HTTPS resource endpoint without a Speech region.
        let valid_azure_openai = inspect_api_key_credential(
            "azure",
            &good_azure.salt_b64,
            &good_azure.ciphertext_b64,
            Some("https://my-resource.openai.azure.com"),
            None,
        );
        assert_eq!(valid_azure_openai.status, ApiKeyCredentialStatus::Usable);
        assert_eq!(
            valid_azure_openai.key_full.as_deref(),
            Some("azure_valid_key_1234")
        );

        let invalid_azure_openai = inspect_api_key_credential(
            "azure",
            &good_azure.salt_b64,
            &good_azure.ciphertext_b64,
            Some("ftp://invalid-endpoint"),
            None,
        );
        assert_eq!(
            invalid_azure_openai.status,
            ApiKeyCredentialStatus::InvalidFormat
        );
        assert_eq!(
            invalid_azure_openai.issue,
            Some(ApiKeyCredentialIssue::MissingEndpoint)
        );
    }

    #[test]
    fn legacy_encrypted_openai_compatible_row_is_still_flagged_for_reentry() {
        // Even though openai-compatible allows an intentionally empty key,
        // an unreadable Voquill-encrypted row means the user had a credential
        // (or legacy ciphertext) that cannot be verified or decrypted.
        let voquill_salt = general_purpose::STANDARD.encode([0x11u8; LEGACY_VOQUILL_SALT_LEN]);
        let voquill_ciphertext = general_purpose::STANDARD.encode(b"encrypted-key");

        let inspection = inspect_api_key_credential(
            "openai-compatible",
            &voquill_salt,
            &voquill_ciphertext,
            Some("https://api.example.com/v1"),
            None,
        );

        assert_eq!(inspection.key_full, None);
        assert_eq!(inspection.status, ApiKeyCredentialStatus::NeedsReentry);
        assert_eq!(
            inspection.issue,
            Some(ApiKeyCredentialIssue::LegacyEncryption)
        );
    }

    #[test]
    fn rejects_endpoint_urls_with_embedded_credentials() {
        let empty = protect_api_key("");
        for endpoint in [
            "http://user:pass@localhost:8000/v1",
            "http://user@localhost:8000/v1",
            "https://:secret@api.example.com/v1",
        ] {
            let inspection = inspect_api_key_credential(
                "openai-compatible",
                &empty.salt_b64,
                &empty.ciphertext_b64,
                Some(endpoint),
                None,
            );
            assert_eq!(inspection.key_full, None);
            assert_eq!(inspection.status, ApiKeyCredentialStatus::InvalidFormat);
            assert_eq!(
                inspection.issue,
                Some(ApiKeyCredentialIssue::MissingEndpoint)
            );
        }

        let good_azure = protect_api_key("azure_valid_key_1234");
        let azure_with_userinfo = inspect_api_key_credential(
            "azure",
            &good_azure.salt_b64,
            &good_azure.ciphertext_b64,
            Some("https://user:pass@my-resource.openai.azure.com"),
            None,
        );
        assert_eq!(azure_with_userinfo.key_full, None);
        assert_eq!(
            azure_with_userinfo.status,
            ApiKeyCredentialStatus::InvalidFormat
        );
        assert_eq!(
            azure_with_userinfo.issue,
            Some(ApiKeyCredentialIssue::MissingEndpoint)
        );
    }
}
