import type { ApiKey } from "@maus-inc/types";
import { describe, expect, it } from "vitest";
import {
  apiKeyNeedsAttention,
  apiKeyNeedsReentry,
  countApiKeysNeedingAttention,
  getApiKeyCredentialIssue,
  getApiKeyCredentialStatus,
  isApiKeyUsable,
} from "./api-key.utils";

const baseKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: "key-1",
  name: "Groq",
  provider: "groq",
  keyFull: "placeholder-groq-token",
  keySuffix: "1234",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("api-key.utils", () => {
  it("treats explicit usable status as usable", () => {
    const key = baseKey({ credentialStatus: "usable", credentialIssue: null });
    expect(getApiKeyCredentialStatus(key)).toBe("usable");
    expect(getApiKeyCredentialIssue(key)).toBeNull();
    expect(isApiKeyUsable(key)).toBe(true);
    expect(apiKeyNeedsAttention(key)).toBe(false);
    expect(apiKeyNeedsReentry(key)).toBe(false);
  });

  it("classifies legacy migrated keys needing re-entry as unusable and needing attention", () => {
    const key = baseKey({
      keyFull: null,
      credentialStatus: "needs_reentry",
      credentialIssue: "legacy_encryption",
    });
    expect(getApiKeyCredentialStatus(key)).toBe("needs_reentry");
    expect(getApiKeyCredentialIssue(key)).toBe("legacy_encryption");
    expect(isApiKeyUsable(key)).toBe(false);
    expect(apiKeyNeedsAttention(key)).toBe(true);
    expect(apiKeyNeedsReentry(key)).toBe(true);
  });

  it("infers needs_reentry when keyFull is null for a secret-requiring provider", () => {
    const key = baseKey({ keyFull: null });
    expect(getApiKeyCredentialStatus(key)).toBe("needs_reentry");
    expect(getApiKeyCredentialIssue(key)).toBe("decryption_failed");
    expect(isApiKeyUsable(key)).toBe(false);
    expect(apiKeyNeedsReentry(key)).toBe(true);
  });

  it("allows keyless ollama and validates openai-compatible baseUrl and azure region", () => {
    const ollama = baseKey({
      provider: "ollama",
      keyFull: null,
      baseUrl: "http://localhost:11434",
    });
    expect(isApiKeyUsable(ollama)).toBe(true);

    const brokenCompat = baseKey({
      provider: "openai-compatible",
      keyFull: null,
      baseUrl: "",
    });
    expect(getApiKeyCredentialStatus(brokenCompat)).toBe("invalid_format");
    expect(getApiKeyCredentialIssue(brokenCompat)).toBe("missing_endpoint");
    expect(isApiKeyUsable(brokenCompat)).toBe(false);
    expect(apiKeyNeedsAttention(brokenCompat)).toBe(true);
    expect(apiKeyNeedsReentry(brokenCompat)).toBe(false);

    const brokenAzure = baseKey({
      provider: "azure",
      keyFull: "azure-key",
      azureRegion: "",
    });
    expect(getApiKeyCredentialStatus(brokenAzure)).toBe("invalid_format");
    expect(getApiKeyCredentialIssue(brokenAzure)).toBe("missing_region");
    expect(isApiKeyUsable(brokenAzure)).toBe(false);
  });

  it("counts keys needing attention accurately", () => {
    const keys: ApiKey[] = [
      baseKey({ id: "ok", credentialStatus: "usable" }),
      baseKey({
        id: "legacy",
        keyFull: null,
        credentialStatus: "needs_reentry",
        credentialIssue: "legacy_encryption",
      }),
      baseKey({
        id: "missing-endpoint",
        provider: "openai-compatible",
        keyFull: null,
        baseUrl: null,
        credentialStatus: "invalid_format",
        credentialIssue: "missing_endpoint",
      }),
    ];
    expect(countApiKeysNeedingAttention(keys)).toBe(2);
  });
});
