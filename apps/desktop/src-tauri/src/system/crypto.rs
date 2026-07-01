use base64::{engine::general_purpose, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const SECRET_ENV: &str = "VOQUILL_API_KEY_SECRET";
const FALLBACK_SECRET: &str = "voquill-default-secret";
const XNONCE_LEN: usize = 24;

static RUNTIME_SECRET: OnceLock<Vec<u8>> = OnceLock::new();
static LOGGED_FALLBACK: OnceLock<()> = OnceLock::new();

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
// setting VOQUILL_API_KEY_SECRET at build time is recommended for shipped builds.
pub fn runtime_secret() -> &'static [u8] {
    RUNTIME_SECRET
        .get_or_init(|| {
            if let Some(value) = option_env!("VOQUILL_API_KEY_SECRET") {
                if !value.is_empty() {
                    return value.as_bytes().to_vec();
                }
            }
            match std::env::var(SECRET_ENV) {
                Ok(value) if !value.is_empty() => value.into_bytes(),
                _ => {
                    LOGGED_FALLBACK.get_or_init(|| {
                        log::warn!(
                            "{SECRET_ENV} not set; using a built-in fallback secret. Set this \
                             at build time to protect stored API keys at rest."
                        );
                    });
                    FALLBACK_SECRET.as_bytes().to_vec()
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

    let secret = runtime_secret();
    let cipher = cipher_for(secret, &nonce);
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|err| CryptoError::Decryption(err.to_string()))?;

    String::from_utf8(plaintext).map_err(|err| CryptoError::InvalidUtf8(err.to_string()))
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
}
