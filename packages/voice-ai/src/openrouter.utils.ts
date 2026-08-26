import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { retry, countWords } from "@maus-inc/utilities";
import { openaiCompatibleTranscribeAudio } from "./openai-compatible-transcribe.utils";
import { buildJsonSchemaResponseFormat } from "./response-format.utils";
import type {
  JsonResponse,
  LlmChatInput,
  LlmStreamEvent,
  OpenRouterModel,
  OpenRouterProvider,
  OpenRouterProviderRouting,
} from "@maus-inc/types";
import { openaiCompatibleStreamChat } from "./openai.utils";
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

/**
 * Default model for testing and fallback
 */
export const OPENROUTER_DEFAULT_MODEL = "openai/gpt-4o-mini";

// OpenRouter routes requests to many providers; most reject `json_schema`
// and only accept the legacy `json_object` shape. Use `json_schema` only for
// models that explicitly support structured outputs upstream.
const JSON_SCHEMA_SUPPORTED_MODELS = new Set<string>([
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "openai/gpt-4-turbo",
  "openai/gpt-3.5-turbo",
  "openai/gpt-5.2",
  "openai/gpt-5.3",
  "openai/gpt-5.4",
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "moonshotai/kimi-k2-instruct-0905",
]);

const buildResponseFormat = (model: string, jsonResponse?: JsonResponse) =>
  buildJsonSchemaResponseFormat(
    model,
    JSON_SCHEMA_SUPPORTED_MODELS,
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
};

export type OpenRouterGenerateTextOutput = {
  text: string;
  tokensUsed: number;
};

/**
 * Generate text using OpenRouter's chat completions API.
 * Uses the OpenAI SDK with custom baseURL since OpenRouter is OpenAI-compatible.
 */
export const openrouterGenerateTextResponse = async ({
  apiKey,
  model = OPENROUTER_DEFAULT_MODEL,
  system,
  prompt,
  jsonResponse,
  providerRouting,
  customFetch,
  maxTokens,
}: OpenRouterGenerateTextArgs): Promise<OpenRouterGenerateTextOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const client = createClient(apiKey, customFetch);

      const messages: ChatCompletionMessageParam[] = [];
      if (system) {
        messages.push({ role: "system", content: system });
      }
      messages.push({ role: "user", content: prompt });

      // Build the request with optional provider routing
      const response_format = buildResponseFormat(model, jsonResponse);

      const requestParams: ChatCompletionCreateParamsNonStreaming & {
        provider?: OpenRouterProviderRouting;
      } = {
        messages,
        model,
        temperature: 1,
        max_tokens: maxTokens ?? 1024,
        top_p: 1,
        ...(response_format ? { response_format } : {}),
      };

      // Add provider routing if specified
      if (providerRouting) {
        requestParams.provider = providerRouting;
      }

      const response = await client.chat.completions.create(requestParams);

      console.log("openrouter llm usage:", response.usage);
      if (!response.choices || response.choices.length === 0) {
        throw new Error("No response from OpenRouter");
      }

      const result = response.choices[0].message.content;
      if (!result) {
        throw new Error("Content is empty");
      }

      return {
        text: result,
        tokensUsed: response.usage?.total_tokens ?? countWords(result),
      };
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

/**
 * Test if an OpenRouter API key is valid by making a simple chat completion.
 */
export const openrouterTestIntegration = async ({
  apiKey,
  customFetch,
}: OpenRouterTestIntegrationArgs): Promise<boolean> => {
  const client = createClient(apiKey, customFetch);

  const response = await client.chat.completions.create({
    messages: [
      {
        role: "user",
        content: 'Reply with the single word "Hello."',
      },
    ],
    model: OPENROUTER_DEFAULT_MODEL,
    temperature: 0,
    max_tokens: 32,
  });

  if (!response.choices || response.choices.length === 0) {
    throw new Error("No response from OpenRouter");
  }

  const content = response.choices[0]?.message?.content ?? "";
  return content.toLowerCase().includes("hello");
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
};

export type OpenRouterTranscribeAudioOutput = {
  text: string;
  wordsUsed: number;
};

export const openrouterTranscribeAudio = async ({
  apiKey,
  model,
  blob,
  ext,
  prompt,
  language,
}: OpenRouterTranscriptionArgs): Promise<OpenRouterTranscribeAudioOutput> => {
  return openaiCompatibleTranscribeAudio({
    client: createClient(apiKey),
    blob,
    model,
    ext,
    prompt,
    language,
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
