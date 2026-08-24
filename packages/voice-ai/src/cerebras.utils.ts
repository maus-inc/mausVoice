import OpenAI from "openai";
import {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { retry, countWords } from "@maus-inc/utilities";
import type {
  JsonResponse,
  LlmChatInput,
  LlmStreamEvent,
} from "@maus-inc/types";
import { openaiCompatibleStreamChat } from "./openai.utils";
import { contentToString } from "./transcription.utils";
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

/** True when a status must not be retried (billing, auth, bad request). */
export const isCerebrasTerminalStatus = (status: number): boolean =>
  status === 400 ||
  status === 401 ||
  status === 402 ||
  status === 403 ||
  status === 404 ||
  status === 422;

const readStatus = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
};

/** True when a thrown value carries a non-retryable Cerebras HTTP status. */
export const isCerebrasTerminalError = (error: unknown): boolean => {
  if (error instanceof CerebrasProviderError && error.status !== undefined) {
    return isCerebrasTerminalStatus(error.status);
  }
  const status = readStatus(error);
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

  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  const numericStatus = typeof status === "number" ? status : undefined;

  if (numericStatus === 402) {
    return new CerebrasProviderError(
      "Cerebras could not process this request. Your Cerebras account may be out of credit, over its quota, blocked by billing state, or missing access to the selected model.",
      402,
    );
  }

  if (numericStatus !== undefined && isCerebrasTerminalStatus(numericStatus)) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : `Cerebras request failed with status ${numericStatus}`;
    return new CerebrasProviderError(`Cerebras: ${message}`, numericStatus);
  }

  // Network/timeout/5xx: return a plain Error so the retry helper treats it
  // as transient and tries again.
  return error instanceof Error ? error : new Error(String(error));
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
  customFetch?: CustomFetch;
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
  customFetch,
}: CerebrasGenerateTextArgs): Promise<CerebrasGenerateResponseOutput> => {
  return retry({
    retries: 3,
    // A billing/auth/validation failure cannot be fixed by retrying. A 402
    // in particular must surface immediately with an actionable message.
    // The status may arrive either as a raw SDK error (before normalization)
    // or already wrapped, so inspect both shapes.
    isRetryable: (error) => !isCerebrasTerminalError(error),
    fn: async () => {
      const client = createClient(apiKey, customFetch);

      const messages: ChatCompletionMessageParam[] = [];
      if (system) {
        messages.push({ role: "system", content: system });
      }

      let finalPrompt = prompt;
      if (jsonResponse) {
        finalPrompt = `${prompt}\n\nRespond with valid JSON matching this schema: ${JSON.stringify(jsonResponse.schema)}`;
      }

      const userParts: ChatCompletionContentPart[] = [];
      userParts.push({ type: "text", text: finalPrompt });
      messages.push({ role: "user", content: userParts });

      const params: Record<string, unknown> = {
        messages,
        model,
        temperature: 1,
        max_tokens: 1024,
        top_p: 1,
        response_format: jsonResponse ? { type: "json_object" } : undefined,
      };
      const response = await client.chat.completions.create(
        params as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
      );

      console.log("cerebras llm usage:", response.usage);
      if (!response.choices || response.choices.length === 0) {
        throw new Error("No response from Cerebras");
      }

      const result = response.choices[0].message.content;
      if (!result) {
        throw new Error("Content is empty");
      }

      const content = contentToString(result);
      return {
        text: content,
        tokensUsed: response.usage?.total_tokens ?? countWords(content),
      };
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
  yield* openaiCompatibleStreamChat(client, model, input);
}
