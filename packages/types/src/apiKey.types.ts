import type { Nullable } from "./common.types";
import type { OpenRouterConfig } from "./openrouter.types";

export const API_KEY_PROVIDERS = [
  "groq",
  "openai",
  "aldea",
  "assemblyai",
  "elevenlabs",
  "deepgram",
  "gladia",
  "openrouter",
  "ollama",
  "openai-compatible",
  "azure",
  "deepseek",
  "gemini",
  "claude",
  "cerebras",
  "speaches",
  "xai",
] as const;
export type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number];

export type ApiKeyCredentialStatus =
  "usable" | "needs_reentry" | "invalid_format";

export type ApiKeyCredentialIssue =
  | "legacy_encryption"
  | "decryption_failed"
  | "missing_key"
  | "invalid_key_format"
  | "missing_endpoint"
  | "missing_region";

export type ApiKey = {
  id: string;
  name: string;
  provider: ApiKeyProvider;
  createdAt: string;
  keySuffix?: string | null;
  keyFull?: string | null;
  credentialStatus?: ApiKeyCredentialStatus;
  credentialIssue?: ApiKeyCredentialIssue | null;
  transcriptionModel?: string | null;
  postProcessingModel?: string | null;
  openRouterConfig?: Nullable<OpenRouterConfig>;
  baseUrl?: string | null;
  azureRegion?: string | null;
  includeV1Path?: boolean | null;
  transcriptionPath?: string | null;
};
