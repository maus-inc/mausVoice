import type {
  ApiKey,
  ApiKeyCredentialIssue,
  ApiKeyCredentialStatus,
  ApiKeyProvider,
} from "@maus-inc/types";

export const KEYLESS_API_KEY_PROVIDERS = new Set<ApiKeyProvider>([
  "ollama",
  "openai-compatible",
  "speaches",
]);

/**
 * Resolves the truthful usability status of a stored API key.
 *
 * When the backend has inspected the record (`credentialStatus` present), its
 * verdict is authoritative — including flagging legacy Voquill 16-byte XOR
 * credentials as `"needs_reentry"` even on providers whose API key is optional.
 *
 * When `credentialStatus` is absent (for example in lightweight UI test
 * fixtures that omit secret metadata), falls back conservatively based on any
 * explicitly supplied `keyFull` value.
 */
export const getApiKeyCredentialStatus = (
  apiKey:
    | Pick<
        ApiKey,
        "provider" | "keyFull" | "credentialStatus" | "baseUrl" | "azureRegion"
      >
    | null
    | undefined,
): ApiKeyCredentialStatus => {
  if (!apiKey) {
    return "invalid_format";
  }

  if (apiKey.credentialStatus === "needs_reentry") {
    return "needs_reentry";
  }

  if (apiKey.credentialStatus === "invalid_format") {
    return "invalid_format";
  }

  if (apiKey.credentialStatus === "usable") {
    return "usable";
  }

  // Fallback when `credentialStatus` was omitted by a caller/test fixture.
  if (apiKey.provider === "openai-compatible" && apiKey.baseUrl !== undefined) {
    if (!apiKey.baseUrl || apiKey.baseUrl.trim().length === 0) {
      return "invalid_format";
    }
  }
  if (apiKey.provider === "azure" && apiKey.azureRegion !== undefined) {
    if (!apiKey.azureRegion || apiKey.azureRegion.trim().length === 0) {
      return "invalid_format";
    }
  }
  if (apiKey.keyFull !== undefined) {
    const requiresKey = !KEYLESS_API_KEY_PROVIDERS.has(apiKey.provider);
    if (apiKey.keyFull === null) {
      return requiresKey ? "needs_reentry" : "usable";
    }
    if (requiresKey && apiKey.keyFull.trim().length === 0) {
      return "invalid_format";
    }
  }

  return "usable";
};

export const getApiKeyCredentialIssue = (
  apiKey:
    | Pick<
        ApiKey,
        | "provider"
        | "keyFull"
        | "credentialStatus"
        | "credentialIssue"
        | "baseUrl"
        | "azureRegion"
      >
    | null
    | undefined,
): ApiKeyCredentialIssue | null => {
  if (!apiKey) {
    return null;
  }
  if (apiKey.credentialIssue !== undefined && apiKey.credentialIssue !== null) {
    return apiKey.credentialIssue;
  }
  const status = getApiKeyCredentialStatus(apiKey);
  if (status === "usable") {
    return null;
  }
  if (
    apiKey.provider === "openai-compatible" &&
    apiKey.baseUrl !== undefined &&
    (!apiKey.baseUrl || apiKey.baseUrl.trim().length === 0)
  ) {
    return "missing_endpoint";
  }
  if (
    apiKey.provider === "azure" &&
    apiKey.azureRegion !== undefined &&
    (!apiKey.azureRegion || apiKey.azureRegion.trim().length === 0)
  ) {
    return "missing_region";
  }
  if (status === "needs_reentry") {
    return "decryption_failed";
  }
  return "invalid_key_format";
};

export const isApiKeyUsable = (
  apiKey:
    | Pick<
        ApiKey,
        "provider" | "keyFull" | "credentialStatus" | "baseUrl" | "azureRegion"
      >
    | null
    | undefined,
): boolean => Boolean(apiKey) && getApiKeyCredentialStatus(apiKey) === "usable";

export const apiKeyNeedsAttention = (
  apiKey:
    | Pick<
        ApiKey,
        "provider" | "keyFull" | "credentialStatus" | "baseUrl" | "azureRegion"
      >
    | null
    | undefined,
): boolean => Boolean(apiKey) && getApiKeyCredentialStatus(apiKey) !== "usable";

export const apiKeyNeedsReentry = (
  apiKey:
    | Pick<
        ApiKey,
        "provider" | "keyFull" | "credentialStatus" | "baseUrl" | "azureRegion"
      >
    | null
    | undefined,
): boolean =>
  Boolean(apiKey) && getApiKeyCredentialStatus(apiKey) === "needs_reentry";

export const countApiKeysNeedingAttention = (
  apiKeys: readonly ApiKey[],
): number => apiKeys.filter((apiKey) => apiKeyNeedsAttention(apiKey)).length;
