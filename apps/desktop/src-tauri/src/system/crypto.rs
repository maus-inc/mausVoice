use base64::{engine::general_purpose, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const SECRET_ENV: &str = "MAUSVOICE_API_KEY_SECRET";
const XNONCE_LEN: usize = 24;

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
            if let Ok(home) =
                std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"))
            {
                hasher.update(home.as_bytes());
            }
            if let Ok(user) = std::env::var("USER").or_else(|_| std::env::var("USERNAME"))
            {
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
                        if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
                            hasher.update(home.as_bytes());
                        }
                        if let Ok(user) = std::env::var("USER").or_else(|_| std::env::var("USERNAME")) {
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
        && std::env::var(SECRET_ENV).map(|v| v.is_empty()).unwrap_or(true)
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

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("invalid base64 data: {0}")]
    Base64(String),
    #[error("stored API key is not valid UTF-8: {0}")]
    InvalidUtf8(String),
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
            .encrypt(XNonce::from_slice(&nonce), b"gsk_legacy_row_value")
            .expect("legacy encrypt");
        let salt_b64 = general_purpose::STANDARD.encode(nonce);
        let ciphertext_b64 = general_purpose::STANDARD.encode(ciphertext);

        let revealed =
            reveal_api_key(&salt_b64, &ciphertext_b64).expect("legacy row decrypts");
        assert_eq!(revealed, "gsk_legacy_row_value");
    }
}
