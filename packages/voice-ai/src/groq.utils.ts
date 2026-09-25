import type {
  JsonResponse,
  LlmChatInput,
  LlmStreamEvent,
} from "@maus-inc/types";
import { retry } from "@maus-inc/utilities";
import Groq from "groq-sdk/index";
import type { ChatCompletionMessageParam } from "groq-sdk/resources/chat/completions";
import OpenAI, { toFile } from "openai";
import { openaiCompatibleStreamChat } from "./openai.utils";
import { parseOpenAICompatibleGenerateTextResponse } from "./openai-compatible-generate.utils";
import type { CustomFetch, DiscoveredModelId } from "./types";
import {
  runSdkTranscription,
  TranscriptionSegment,
  TranscribeAudioOutput,
} from "./transcription.utils";

export const GENERATE_TEXT_MODELS = [
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
] as const;
export type GenerateTextModel =
  (typeof GENERATE_TEXT_MODELS)[number] | DiscoveredModelId;

/**
 * Model the Groq repo selects when the user has not chosen one. It must stay
 * inside `GENERATE_TEXT_MODELS` so a default-model failure can still fall back
 * to a different live model instead of rethrowing with no second attempt.
 */
export const GROQ_DEFAULT_GENERATE_TEXT_MODEL: GenerateTextModel =
  "openai/gpt-oss-20b";

// Models that support `response_format: { type: "json_schema" }`.
// See https://console.groq.com/docs/structured-outputs
const JSON_SCHEMA_SUPPORTED_MODELS = new Set<string>([
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
]);

/**
 * HTTP statuses that describe the account or the request, not the model.
 * Switching models cannot fix any of them, so neither another retry of the
 * same model nor a second model is worth the extra request chain.
 *
 * 404 is deliberately absent. A 404 from Groq is `model_not_found`, which is
 * exactly the case a different model can fix. 429 is absent because Groq
 * enforces per-model rate limits, so another model can still succeed.
 */
const ACCOUNT_SCOPED_GENERATE_TEXT_STATUSES = new Set([400, 401, 402, 403]);

const readErrorStatus = (error: unknown): number | null => {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
};

/**
 * True when the failure is scoped to the account or the request rather than
 * the model, so retrying the same model or falling back to a different one
 * cannot succeed.
 */
export const isGroqAccountScopedError = (error: unknown): boolean => {
  const status = readErrorStatus(error);
  return status !== null && ACCOUNT_SCOPED_GENERATE_TEXT_STATUSES.has(status);
};

export const TRANSCRIPTION_MODELS = [
  "whisper-large-v3-turbo",
  "whisper-large-v3",
] as const;
export type TranscriptionModel = (typeof TRANSCRIPTION_MODELS)[number];

const createClient = (apiKey: string, customFetch?: CustomFetch) => {
  return new Groq({
    apiKey: apiKey.trim(),
    // Runs inside a Tauri WebView where the SDK's browser check would
    // otherwise reject; the key is never persisted and the request goes
    // through the desktop's secure-fetch bridge when customFetch is set.
    dangerouslyAllowBrowser: true,
    fetch: customFetch,
  });
};

export type GroqTranscriptionArgs = {
  apiKey: string;
  model?: TranscriptionModel;
  blob: ArrayBuffer | Buffer;
  ext: string;
  prompt?: string;
  language?: string;
  customFetch?: CustomFetch;
};

export type GroqTranscriptionSegment = TranscriptionSegment;
export type GroqTranscribeAudioOutput = TranscribeAudioOutput;

export const groqTranscribeAudio = async ({
  apiKey,
  model = "whisper-large-v3-turbo",
  blob,
  ext,
  prompt,
  language,
  customFetch,
}: GroqTranscriptionArgs): Promise<GroqTranscribeAudioOutput> => {
  const client = createClient(apiKey, customFetch);
  const file = await toFile(blob, `audio.${ext}`);
  return runSdkTranscription(
    (body) =>
      client.audio.transcriptions.create(
        body as unknown as Parameters<
          typeof client.audio.transcriptions.create
        >[0],
      ),
    {
      file,
      model,
      prompt,
      language,
      response_format: "verbose_json",
    },
  );
};

export type GroqGenerateTextArgs = {
  apiKey: string;
  model?: GenerateTextModel;
  system?: string;
  prompt: string;
  imageUrls?: string[];
  jsonResponse?: JsonResponse;
  maxTokens?: number;
  signal?: AbortSignal;
  customFetch?: CustomFetch;
};

export type GroqGenerateResponseOutput = {
  text: string;
  tokensUsed: number;
};

export const groqGenerateTextResponse = async ({
  apiKey,
  model = "openai/gpt-oss-20b",
  system,
  prompt,
  imageUrls = [],
  jsonResponse,
  maxTokens,
  signal,
  customFetch,
}: GroqGenerateTextArgs): Promise<GroqGenerateResponseOutput> => {
  return retry({
    // A present-but-not-aborted signal is not an abort and must not disable
    // retries for transient failures. Only an actually aborted signal is
    // terminal. An account-scoped rejection is terminal too: another attempt
    // on the same key cannot succeed.
    retries: 3,
    isRetryable: (error) =>
      !signal?.aborted && !isGroqAccountScopedError(error),
    fn: async () => {
      const client = createClient(apiKey, customFetch);

      const messages: ChatCompletionMessageParam[] = [
        ...(system ? [{ role: "system" as const, content: system }] : []),
        {
          role: "user" as const,
          content: [
            ...imageUrls.map((url) => ({
              type: "image_url" as const,
              image_url: { url },
            })),
            { type: "text" as const, text: prompt },
          ],
        },
      ];

      const response = await client.chat.completions.create(
        {
          messages,
          model,
          max_completion_tokens: maxTokens ?? 5000,
          response_format: jsonResponse
            ? JSON_SCHEMA_SUPPORTED_MODELS.has(model)
              ? {
                  type: "json_schema",
                  json_schema: {
                    name: jsonResponse.name,
                    description: jsonResponse.description,
                    schema: jsonResponse.schema,
                  },
                }
              : { type: "json_object" }
            : undefined,
        },
        { signal },
      );

      console.log("groq llm usage:", response.usage);
      return parseOpenAICompatibleGenerateTextResponse({
        response,
        providerLabel: "Groq",
      });
    },
  });
};

export type GroqTestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export const groqTestIntegration = async ({
  apiKey,
  customFetch,
}: GroqTestIntegrationArgs): Promise<boolean> => {
  const client = createClient(apiKey, customFetch);
  await client.models.list();
  return true;
};

// ============================================================================
// Streaming Chat
// ============================================================================

export type GroqStreamChatArgs = {
  apiKey: string;
  model: string;
  input: LlmChatInput;
  customFetch?: CustomFetch;
};

export async function* groqStreamChat({
  apiKey,
  model,
  input,
  customFetch,
}: GroqStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const client = new OpenAI({
    apiKey: apiKey.trim(),
    baseURL: "https://api.groq.com/openai/v1",
    // Same WebView constraint as createClient above; requests are routed
    // through the desktop secure-fetch bridge when customFetch is set.
    dangerouslyAllowBrowser: true,
    fetch: customFetch,
  });
  yield* openaiCompatibleStreamChat(client, model, input);
}
