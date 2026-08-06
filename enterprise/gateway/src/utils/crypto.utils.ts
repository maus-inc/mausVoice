import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

const CURRENT_SALT = "mausvoice-stt-providers";
const LEGACY_SALT = "voquill-stt-providers";

function deriveKey(secret: string, salt: string): Buffer {
  return crypto.scryptSync(secret, salt, KEY_LENGTH);
}

export function encryptApiKey(plaintext: string, secret: string): string {
  const key = deriveKey(secret, CURRENT_SALT);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${encrypted.toString("base64")}:${tag.toString("base64")}`;
}

export function decryptApiKey(ciphertext: string, secret: string): string {
  const [ivB64, encB64, tagB64] = ciphertext.split(":");
  const iv = Buffer.from(ivB64, "base64");
  const encrypted = Buffer.from(encB64, "base64");
  const tag = Buffer.from(tagB64, "base64");

  // The rebrand changed the KDF salt from "voquill-stt-providers" to CURRENT_SALT.
  // Credentials persisted before the rebrand were encrypted under the legacy
  // salt. Try the current salt first, then fall back to the legacy salt so
  // existing LLM/STT/OIDC credentials remain readable on upgrade. New writes
  // always use CURRENT_SALT, so the fallback only affects legacy ciphertext.
  const attempts = [CURRENT_SALT, LEGACY_SALT];
  for (const salt of attempts) {
    const key = deriveKey(secret, salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    try {
      const plaintext = decipher.update(encrypted) + decipher.final("utf8");
      return plaintext;
    } catch {
      // Wrong salt / tampered data; try the next one.
    }
  }
  throw new Error("invalid ciphertext: decryption failed with both current and legacy salts");
}
