import OpenAI from "openai";
import {
  isTerminalHttpStatus,
  readHttpStatus,
  retry,
} from "@maus-inc/utilities";
import type {
  JsonResponse,
  LlmChatInput,
  LlmStreamEvent,
} from "@maus-inc/types";
import { openaiCompatibleStreamChat } from "./openai.utils";
import {
  buildJsonObjectPrompt,
  buildOpenAICompatibleMessages,
  parseOpenAICompatibleGenerateTextResponse,
} from "./openai-compatible-generate.utils";
import type { CustomFetch, DiscoveredModelId } from "./types";

export const CEREBRAS_MODELS = ["gpt-oss-120b", "gemma-4-31b"] as const;
export type CerebrasModel =
  (typeof CEREBRAS_MODELS)[number] | DiscoveredModelId;

const CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";

/**
 * Terminal, non-retryable failure from a Cerebras request. Carries the HTTP
 * status when the SDK surfaced one so callers can map 402 to a billing/quota
 * message instead of a generic fallback. The API key, authorization header,
 * and raw transcript are never attached.
 */
export class CerebrasProviderError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "CerebrasProviderError";
    this.status = status;
  }
}

/**
 * True when a status must not be retried (billing, auth, bad request). Reads
 * the shared terminal-status set so this provider and the shared `retry`
 * helper can never disagree about which statuses are permanent.
 */
export const isCerebrasTerminalStatus = (status: number): boolean =>
  isTerminalHttpStatus(status);

/**
 * Replace the literal API key and common authorization material anywhere in
 * a provider message. The OpenAI SDK's own error strings can embed the key
 * ("Incorrect API key provided: csk_..."), and some proxies echo the
 * Authorization header. Never reveals the key value itself (no length/first
 * characters), so a message like "key csk_ab" redacts the whole token.
 */
const CEREBRAS_SECRET_PATTERNS: RegExp[] = [
  /\bcsk_[a-z0-9_-]+/gi,
  /\bsk-[a-z0-9_-]+/gi,
  /\bsk_[a-z0-9_-]+/gi,
  /bearer\s+[a-z0-9._~+/=-]+/gi,
  /authorization:\s*[^\s;,]+/gi,
  /api[_-]?key[:=]\s*[a-z0-9._~+/=-]+/gi,
];

export const redactCerebrasMessage = (message: string): string =>
  CEREBRAS_SECRET_PATTERNS.reduce(
    (cleaned, pattern) => cleaned.replace(pattern, "[redacted]"),
    message,
  );

/** True when a thrown value carries a non-retryable Cerebras HTTP status. */
export const isCerebrasTerminalError = (error: unknown): boolean => {
  if (error instanceof CerebrasProviderError && error.status !== undefined) {
    return isCerebrasTerminalStatus(error.status);
  }
  const status = readHttpStatus(error);
  return status !== undefined && isCerebrasTerminalStatus(status);
};

/**
 * Normalize any value thrown by a Cerebras call into a throwable error.
 *
 * The OpenAI SDK (which Cerebras is wire-compatible with) rejects on a
 * non-2xx response with an `APIError` carrying `status`. For a 402 with an
 * empty body that surfaces as `402 status code (no body)`; we map it to a
 * provider-specific message. Other errors pass through with their original
 * message so transient failures still retry.
 */
export const normalizeCerebrasError = (error: unknown): Error => {
  if (error instanceof CerebrasProviderError) {
    return error;
  }

  const numericStatus = readHttpStatus(error);

  if (numericStatus === 402) {
    return new CerebrasProviderError(
      "Cerebras could not process this request. Your Cerebras account may be out of credit, over its quota, blocked by billing state, or missing access to the selected model.",
      402,
    );
  }

  if (numericStatus !== undefined && isCerebrasTerminalStatus(numericStatus)) {
    const rawMessage =
      error instanceof Error && error.message
        ? error.message
        : `Cerebras request failed with status ${numericStatus}`;
    // Sanitize before wrapping: SDK APIError messages can contain the API
    // key (e.g. "Incorrect API key provided: csk_..."). The key must never
    // reach logs, snackbars, or persisted postProcessError metadata.
    return new CerebrasProviderError(
      `Cerebras: ${redactCerebrasMessage(rawMessage)}`,
      numericStatus,
    );
  }

  // Network/timeout/5xx: return a plain Error so the retry helper treats it
  // as transient and tries again. A proxy or server can still echo key
  // material in these messages, so scrub it before it reaches logs or saved
  // metadata; the original error is returned unchanged when clean.
  if (error instanceof Error) {
    const redacted = redactCerebrasMessage(error.message);
    return redacted === error.message ? error : new Error(redacted);
  }
  return new Error(redactCerebrasMessage(String(error)));
};

const createClient = (apiKey: string, customFetch?: CustomFetch) => {
  return new OpenAI({
    apiKey: apiKey.trim(),
    baseURL: CEREBRAS_BASE_URL,
    dangerouslyAllowBrowser: true,
    fetch: customFetch,
  });
};

export type CerebrasGenerateTextArgs = {
  apiKey: string;
  model?: CerebrasModel;
  system?: string;
  prompt: string;
  jsonResponse?: JsonResponse;
  maxTokens?: number;
  customFetch?: CustomFetch;
  signal?: AbortSignal;
};

export type CerebrasGenerateResponseOutput = {
  text: string;
  tokensUsed: number;
};

export const cerebrasGenerateTextResponse = async ({
  apiKey,
  model = CEREBRAS_MODELS[0],
  system,
  prompt,
  jsonResponse,
  maxTokens,
  customFetch,
  signal,
}: CerebrasGenerateTextArgs): Promise<CerebrasGenerateResponseOutput> => {
  return retry({
    // An aborted request must not be retried; the abort is the caller's
    // deadline decision, not a transient failure worth another attempt.
    // A present-but-not-aborted signal is not an abort and must not disable
    // retries for transient failures.
    retries: 3,
    // A billing/auth/validation failure cannot be fixed by retrying. A 402
    // in particular must surface immediately with an actionable message.
    // The status may arrive either as a raw SDK error (before normalization)
    // or already wrapped, so inspect both shapes.
    isRetryable: (error) => !signal?.aborted && !isCerebrasTerminalError(error),
    // An abort during the wait is honoured: `retry` hands the signal to its
    // own wait, so a cancelled caller stops there instead of sitting it out.
    // That wait is the helper's own 20ms. The helper stretches a wait for a
    // `Retry-After` hint only, and it reads that hint off an `HttpError`.
    // What reaches `retry` is the raw OpenAI SDK `APIError`: the `.catch`
    // below normalizes only after `retry` has given up, and it hands back a
    // `CerebrasProviderError` or a plain `Error`, never an `HttpError`. So a
    // 429 is retried 20ms later. Converting inside `fn` (the pattern in
    // `transcription.utils.ts`) is what would let a hint apply here, capped at
    // the helper's 2s default.
    signal,
    fn: async () => {
      const client = createClient(apiKey, customFetch);

      const finalPrompt = buildJsonObjectPrompt({ prompt, jsonResponse });
      const messages = buildOpenAICompatibleMessages({
        system,
        prompt: finalPrompt,
      });

      const params: Record<string, unknown> = {
        messages,
        model,
        temperature: 1,
        max_tokens: maxTokens ?? 1024,
        top_p: 1,
        response_format: jsonResponse ? { type: "json_object" } : undefined,
      };
      const response = await client.chat.completions.create(
        params as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
        { signal },
      );

      console.log("cerebras llm usage:", response.usage);
      return parseOpenAICompatibleGenerateTextResponse({
        response,
        providerLabel: "Cerebras",
      });
    },
  }).catch((error: unknown) => {
    throw normalizeCerebrasError(error);
  });
};

export type CerebrasTestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export const cerebrasTestIntegration = async ({
  apiKey,
  customFetch,
}: CerebrasTestIntegrationArgs): Promise<boolean> => {
  const client = createClient(apiKey, customFetch);
  await client.models.list();
  return true;
};

// ============================================================================
// Streaming Chat
// ============================================================================

export type CerebrasStreamChatArgs = {
  apiKey: string;
  model: string;
  input: LlmChatInput;
  customFetch?: CustomFetch;
};

export async function* cerebrasStreamChat({
  apiKey,
  model,
  input,
  customFetch,
}: CerebrasStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const client = createClient(apiKey, customFetch);
  try {
    yield* openaiCompatibleStreamChat(client, model, input);
  } catch (error) {
    // Surface a 402 (or other terminal status) with an actionable message in
    // agent/assistant streaming too, not just the non-streaming path.
    throw normalizeCerebrasError(error);
  }
}
