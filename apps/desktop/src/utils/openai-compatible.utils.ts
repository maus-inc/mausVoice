export const OPENAI_COMPATIBLE_DEFAULT_URL = "http://127.0.0.1:8080";

export const OPENAI_COMPATIBLE_DEFAULT_TRANSCRIPTION_PATH =
  "/audio/transcriptions";

export const normalizeOpenAICompatibleBaseUrl = (
  baseUrl?: string | null,
): string => {
  const candidate = baseUrl?.trim() || OPENAI_COMPATIBLE_DEFAULT_URL;
  return candidate.replace(/\/+$/, "");
};

export const buildOpenAICompatibleUrl = (
  baseUrl?: string | null,
  includeV1Path?: boolean | null,
): string => {
  const normalized = normalizeOpenAICompatibleBaseUrl(baseUrl);
  const shouldIncludeV1 = includeV1Path ?? true;

  if (normalized.endsWith("/v1")) {
    return normalized;
  }

  return shouldIncludeV1 ? `${normalized}/v1` : normalized;
};

<<<<<<< HEAD
export const buildOpenAICompatibleTranscriptionUrl = (
  baseUrl?: string | null,
  includeV1Path?: boolean | null,
  transcriptionPath?: string | null,
): string => {
  const trimmed = transcriptionPath?.trim();
  let path: string;
  if (!trimmed || trimmed.length === 0) {
    path = OPENAI_COMPATIBLE_DEFAULT_TRANSCRIPTION_PATH;
  } else {
    path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  }
  return `${buildOpenAICompatibleUrl(baseUrl, includeV1Path)}${path}`;
};
=======
export const appendOpenAICompatiblePath = (
  apiBaseUrl: string,
  path: string,
): string =>
  `${normalizeOpenAICompatibleBaseUrl(apiBaseUrl)}/${path.replace(/^\/+/, "")}`;
>>>>>>> origin/fix/superfix-review-findings
