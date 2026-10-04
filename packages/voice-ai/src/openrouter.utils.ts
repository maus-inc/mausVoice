import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { retry } from "@maus-inc/utilities";
import { openaiCompatibleTranscribeAudio } from "./openai-compatible-transcribe.utils";
import {
  buildJsonSchemaResponseFormat,
  OPENAI_LEGACY_CHAT_MODELS,
} from "./response-format.utils";
import {
  buildJsonObjectPrompt,
  buildOpenAICompatibleMessages,
  parseOpenAICompatibleGenerateTextResponse,
} from "./openai-compatible-generate.utils";
import type {
  JsonResponse,
  LlmChatInput,
  LlmStreamEvent,
  OpenRouterModel,
  OpenRouterProvider,
  OpenRouterProviderRouting,
} from "@maus-inc/types";
import {
  isOpenAIOReasoningModel,
  openaiCompatibleStreamChat,
} from "./openai.utils";
import type { CustomFetch } from "./types";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_APP_NAME = "mausVoice";
export const OPENROUTER_APP_URL = "https://maus-inc.github.io/mausVoice/";

/**
 * Pre-set favorite models for quick access.
 * These are shown at the top of the model picker.
 */
export const OPENROUTER_FAVORITE_MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
] as const;

/** Default generation model when no selection is saved. */
export const OPENROUTER_DEFAULT_MODEL = "openai/gpt-oss-20b";

// Legacy chat models (OpenAI id space, "openai/"-prefixed) that predate
// Structured Outputs and reject `json_schema`. Every other model — including
// ones discovered from the OpenRouter catalog — defaults to `json_schema`,
// which the o-series and all gpt-4o-2024-08-06+ models require/accept and
// which `json_object` callers would otherwise get 400s for (the o-series
// rejects json_object outright).
const JSON_OBJECT_ONLY_MODELS = new Set<string>(
  OPENAI_LEGACY_CHAT_MODELS.map((model) => `openai/${model}`),
);

export const isOpenRouterJsonObjectOnlyModel = (model: string): boolean =>
  JSON_OBJECT_ONLY_MODELS.has(model);

const buildResponseFormat = (model: string, jsonResponse?: JsonResponse) =>
  buildJsonSchemaResponseFormat(
    model,
    isOpenRouterJsonObjectOnlyModel,
    jsonResponse,
  );

/**
 * Create OpenAI client configured for OpenRouter
 */
const createClient = (apiKey: string, customFetch?: CustomFetch) => {
  return new OpenAI({
    apiKey: apiKey.trim(),
    baseURL: OPENROUTER_BASE_URL,
    dangerouslyAllowBrowser: true,
    fetch: customFetch,
    // The SDK's own retry layer is OFF. `retry()` below is this package's single retry
    // layer, and it carries the parts the SDK's does not: `isRetryable`, a wait the caller's
    // abort signal can cut short, and `Retry-After` as far as the header parser allows. With
    // both layers live the attempts multiply -- measured, one failed call issued 9 requests
    // for a 500 -- and each of those is a chargeable request.
    maxRetries: 0,
    defaultHeaders: {
      "HTTP-Referer": OPENROUTER_APP_URL,
      "X-Title": OPENROUTER_APP_NAME,
    },
  });
};

// ============================================================================
// Fetch Models
// ============================================================================

export type OpenRouterFetchModelsArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export type OpenRouterFetchModelsOutput = {
  models: OpenRouterModel[];
};

/**
 * Fetch all available models from OpenRouter.
 */
export const openrouterFetchModels = async ({
  apiKey,
  customFetch,
}: OpenRouterFetchModelsArgs): Promise<OpenRouterFetchModelsOutput> => {
  const fetchFn = customFetch ?? globalThis.fetch;

  const response = await fetchFn(`${OPENROUTER_BASE_URL}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "HTTP-Referer": OPENROUTER_APP_URL,
      "X-Title": OPENROUTER_APP_NAME,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenRouter models: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as { data: OpenRouterModel[] };
  return { models: data.data ?? [] };
};

// ============================================================================
// Fetch Providers
// ============================================================================

export type OpenRouterFetchProvidersArgs = {
  customFetch?: CustomFetch;
};

export type OpenRouterFetchProvidersOutput = {
  providers: OpenRouterProvider[];
};

/**
 * Fetch all available providers from OpenRouter.
 * No API key required for this endpoint.
 */
export const openrouterFetchProviders = async ({
  customFetch,
}: OpenRouterFetchProvidersArgs = {}): Promise<OpenRouterFetchProvidersOutput> => {
  const fetchFn = customFetch ?? globalThis.fetch;

  const response = await fetchFn(`${OPENROUTER_BASE_URL}/providers`, {
    headers: {
      "HTTP-Referer": OPENROUTER_APP_URL,
      "X-Title": OPENROUTER_APP_NAME,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenRouter providers: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as { data: OpenRouterProvider[] };
  return { providers: data.data ?? [] };
};

// ============================================================================
// Generate Text
// ============================================================================

export type OpenRouterGenerateTextArgs = {
  apiKey: string;
  model?: string;
  system?: string;
  prompt: string;
  jsonResponse?: JsonResponse;
  providerRouting?: OpenRouterProviderRouting;
  customFetch?: CustomFetch;
  maxTokens?: number;
  signal?: AbortSignal;
};

export type OpenRouterGenerateTextOutput = {
  text: string;
  tokensUsed: number;
};

/**
 * Generate text using OpenRouter's chat completions API.
 * Uses the OpenAI SDK with custom baseURL since OpenRouter is OpenAI-compatible.
 */
export const openrouterGenerateTextResponse = ({
  apiKey,
  model = OPENROUTER_DEFAULT_MODEL,
  system,
  prompt,
  jsonResponse,
  providerRouting,
  customFetch,
  maxTokens,
  signal,
}: OpenRouterGenerateTextArgs): Promise<OpenRouterGenerateTextOutput> => {
  return retry({
    // An aborted request must not be retried; the abort is the caller's
    // deadline decision, not a transient failure worth another attempt.
    // A present-but-not-aborted signal is not an abort and must not disable
    // retries for transient failures.
    retries: 3,
    isRetryable: () => !signal?.aborted,
    // An abort during the wait is honoured: `retry` hands the signal to its
    // own wait, so a cancelled caller stops there instead of sitting it out.
    // The SDK's own retry layer is off -- `maxRetries: 0` at the client -- so its
    // `APIError` reaches `retry` on the FIRST attempt. That is what makes the wait below the
    // only wait. Before that setting the SDK retried three times underneath, honouring
    // `Retry-After` on the way, so the caller sat through three of its own waits before this
    // one began and a single call issued nine requests.
    // That wait is the helper's own 20ms, because the helper only stretches
    // a wait for a `Retry-After` hint and reads that hint off an `HttpError`.
    // OpenRouter is called through the OpenAI SDK, whose own `APIError`
    // nothing here converts, so a 429 is retried 20ms later. Converting the
    // failure with `toHttpError` inside `fn` (the pattern in
    // `transcription.utils.ts`) is what would let a hint apply here, capped at
    // the helper's 2s default.
    signal,
    fn: async () => {
      const client = createClient(apiKey, customFetch);

      // The `json_object` shape (legacy models only) requires the word "JSON"
      // somewhere in the context or the upstream API rejects the request;
      // append the schema instruction only on that branch so json_schema
      // calls are unchanged.
      const finalPrompt =
        jsonResponse && isOpenRouterJsonObjectOnlyModel(model)
          ? buildJsonObjectPrompt({ prompt, jsonResponse })
          : prompt;

      const messages = buildOpenAICompatibleMessages({
        system,
        prompt: finalPrompt,
      });

      const response_format = buildResponseFormat(model, jsonResponse);

      // OpenRouter routes `openai/o1` and `openai/o3-mini` to the same models
      // that reject `temperature` and `top_p`, so the id is checked through its
      // routing prefix rather than being assumed to be a third-party model.
      const reasoning = isOpenAIOReasoningModel(model);
      const requestParams: ChatCompletionCreateParamsNonStreaming & {
        provider?: OpenRouterProviderRouting;
      } = {
        messages,
        model,
        max_tokens: maxTokens ?? 1024,
        ...(reasoning ? {} : { temperature: 1, top_p: 1 }),
        ...(response_format ? { response_format } : {}),
      };

      if (providerRouting) {
        requestParams.provider = providerRouting;
      }

      const response = await client.chat.completions.create(requestParams, {
        signal,
      });

      console.log("openrouter llm usage:", response.usage);
      return parseOpenAICompatibleGenerateTextResponse({
        response,
        providerLabel: "OpenRouter",
      });
    },
  });
};

// ============================================================================
// Test Integration
// ============================================================================

export type OpenRouterTestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

/** Test authentication without depending on a fixed inference model. */
export const openrouterTestIntegration = async ({
  apiKey,
  customFetch,
}: OpenRouterTestIntegrationArgs): Promise<boolean> => {
  const client = createClient(apiKey, customFetch);
  await client.models.list();
  return true;
};

// ============================================================================
// Transcribe Audio
// ============================================================================

export type OpenRouterTranscriptionArgs = {
  apiKey: string;
  model: string;
  blob: ArrayBuffer | Buffer;
  ext: string;
  prompt?: string;
  language?: string;
  signal?: AbortSignal;
  /**
   * The transport to run the request over. Every other entry point in this file
   * takes one, and every other transcription provider in the desktop app is
   * wired with the app's own native or secure fetch. Without it this call was
   * the one transcription path that could not use the configured request path
   * and always fell back to the SDK's default transport.
   */
  customFetch?: CustomFetch;
};

export type OpenRouterTranscribeAudioOutput = {
  text: string;
  wordsUsed: number;
};

export const openrouterTranscribeAudio = ({
  apiKey,
  model,
  blob,
  ext,
  prompt,
  language,
  signal,
  customFetch,
}: OpenRouterTranscriptionArgs): Promise<OpenRouterTranscribeAudioOutput> => {
  return openaiCompatibleTranscribeAudio({
    client: createClient(apiKey, customFetch),
    blob,
    model,
    ext,
    prompt,
    language,
    signal,
  });
};

// ============================================================================
// Streaming Chat
// ============================================================================

export type OpenRouterStreamChatArgs = {
  apiKey: string;
  model: string;
  input: LlmChatInput;
  customFetch?: CustomFetch;
};

export async function* openrouterStreamChat({
  apiKey,
  model,
  input,
  customFetch,
}: OpenRouterStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const client = createClient(apiKey, customFetch);
  yield* openaiCompatibleStreamChat(client, model, input);
}
