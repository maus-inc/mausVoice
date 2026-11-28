import type {
  ApiKey,
  ApiKeyCredentialIssue,
  ApiKeyCredentialStatus,
  ApiKeyProvider,
} from "@maus-inc/types";

const KEYLESS_API_KEY_PROVIDERS = new Set<ApiKeyProvider>([
  "ollama",
  "openai-compatible",
  "speaches",
]);

type CredentialInspectableKey = Pick<
  ApiKey,
  "provider" | "keyFull" | "credentialStatus" | "baseUrl" | "azureRegion"
>;

const EXPLICIT_CREDENTIAL_STATUSES = new Set<ApiKeyCredentialStatus>([
  "usable",
  "needs_reentry",
  "invalid_format",
]);

const isBlankOptionalString = (value: string | null | undefined): boolean =>
  value !== undefined && (!value || value.trim().length === 0);

const hasMissingProviderConfig = (apiKey: CredentialInspectableKey): boolean =>
  (apiKey.provider === "openai-compatible" &&
    isBlankOptionalString(apiKey.baseUrl)) ||
  (apiKey.provider === "azure" && isBlankOptionalString(apiKey.azureRegion));

const inferKeyValueStatus = (
  apiKey: CredentialInspectableKey,
): ApiKeyCredentialStatus => {
  if (apiKey.keyFull === undefined) {
    return "usable";
  }
  const requiresKey = !KEYLESS_API_KEY_PROVIDERS.has(apiKey.provider);
  if (!requiresKey) {
    return "usable";
  }
  if (apiKey.keyFull === null) {
    return "needs_reentry";
  }
  return apiKey.keyFull.trim().length === 0 ? "invalid_format" : "usable";
};

/**
 * Resolves the truthful usability status of a stored API key.
 *
 * When the backend has inspected the record (`credentialStatus` present), its
 * verdict is authoritative, including flagging legacy Voquill 16-byte XOR
 * credentials as `"needs_reentry"` even on providers whose API key is optional.
 *
 * When `credentialStatus` is absent (for example in lightweight UI test
 * fixtures that omit secret metadata), falls back conservatively based on any
 * explicitly supplied `keyFull` value.
 */
export const getApiKeyCredentialStatus = (
  apiKey: CredentialInspectableKey | null | undefined,
): ApiKeyCredentialStatus => {
  if (!apiKey) {
    return "invalid_format";
  }
  if (
    apiKey.credentialStatus &&
    EXPLICIT_CREDENTIAL_STATUSES.has(apiKey.credentialStatus)
  ) {
    return apiKey.credentialStatus;
  }
  if (hasMissingProviderConfig(apiKey)) {
    return "invalid_format";
  }
  return inferKeyValueStatus(apiKey);
};

export const getApiKeyCredentialIssue = (
  apiKey:
    | (CredentialInspectableKey & Pick<ApiKey, "credentialIssue">)
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
    isBlankOptionalString(apiKey.baseUrl)
  ) {
    return "missing_endpoint";
  }
  if (
    apiKey.provider === "azure" &&
    isBlankOptionalString(apiKey.azureRegion)
  ) {
    return "missing_region";
  }
  return status === "needs_reentry"
    ? "decryption_failed"
    : "invalid_key_format";
};

export const isApiKeyUsable = (
  apiKey: CredentialInspectableKey | null | undefined,
): boolean => Boolean(apiKey) && getApiKeyCredentialStatus(apiKey) === "usable";

export const apiKeyNeedsAttention = (
  apiKey: CredentialInspectableKey | null | undefined,
): boolean => Boolean(apiKey) && getApiKeyCredentialStatus(apiKey) !== "usable";

export const apiKeyNeedsReentry = (
  apiKey: CredentialInspectableKey | null | undefined,
): boolean =>
  Boolean(apiKey) && getApiKeyCredentialStatus(apiKey) === "needs_reentry";

export const countApiKeysNeedingAttention = (
  apiKeys: readonly Pick<
    ApiKey,
    "provider" | "keyFull" | "credentialStatus" | "baseUrl" | "azureRegion"
  >[],
): number => apiKeys.filter((apiKey) => apiKeyNeedsAttention(apiKey)).length;
