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
  isProviderTerminalError,
  isProviderTerminalStatus,
  PROVIDER_MODEL_NOT_FOUND_CODE,
  ProviderError,
  readProviderCode,
  readProviderStatus,
  redactProviderMessage,
} from "./provider-error.utils";
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

// Models that support `response_format: { type: "json_schema" }`.
// See https://console.groq.com/docs/structured-outputs
const JSON_SCHEMA_SUPPORTED_MODELS = new Set<string>([
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
]);

export const TRANSCRIPTION_MODELS = [
  "whisper-large-v3-turbo",
  "whisper-large-v3",
] as const;
export type TranscriptionModel = (typeof TRANSCRIPTION_MODELS)[number];

/**
 * Terminal, non-retryable failure from a Groq request. Carries the HTTP status
 * and the provider's error code so callers can branch without reading the
 * message. The API key, the authorization header, and the raw request body are
 * never attached.
 */
export class GroqProviderError extends ProviderError {
  constructor(message: string, status?: number, code?: string) {
    super(message, { status, code });
    this.name = "GroqProviderError";
  }
}

/**
 * Groq retires models without notice, so a request that names one it no longer
 * serves comes back as a bare 404 with a JSON body. Name the model and say
 * where to change it, because that is the only part of the failure a user can
 * act on. Groq reports the same code when the key itself lacks access, so both
 * causes are named.
 */
const describeRetiredModel = (model: string) =>
  `Groq does not serve the model ${model}, or your Groq key has no access to it. Pick a different post-processing model in Settings.`;

/**
 * Normalize any value thrown by a Groq call into a throwable error. A retired
 * model becomes an actionable message instead of a raw 404, and other terminal
 * statuses keep the status so a caller can map them. Network, timeout, and 5xx
 * failures pass through as plain errors so `retry` treats them as transient,
 * with any key material a proxy echoed scrubbed first.
 */
export const normalizeGroqError = (args: {
  error: unknown;
  model: string;
}): Error => {
  const { error, model } = args;
  if (error instanceof ProviderError) {
    return error;
  }

  const status = readProviderStatus(error);
  const code = readProviderCode(error);

  if (status === 404 && code === PROVIDER_MODEL_NOT_FOUND_CODE) {
    return new GroqProviderError(describeRetiredModel(model), status, code);
  }

  if (status !== undefined && isProviderTerminalStatus(status)) {
    const detail =
      error instanceof Error && error.message
        ? redactProviderMessage(error.message)
        : "";
    return new GroqProviderError(
      detail
        ? `Groq rejected the request (HTTP ${status}): ${detail}`
        : `Groq rejected the request (HTTP ${status})`,
      status,
      code,
    );
  }

  if (error instanceof Error) {
    const redacted = redactProviderMessage(error.message);
    return redacted === error.message ? error : new Error(redacted);
  }
  return new Error(redactProviderMessage(String(error)));
};

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
    // terminal.
    retries: 3,
    // A retired model, a wrong key, and a bad request all fail the same way on
    // every attempt. Retrying them only spends the caller's deadline, so let
    // the normalized terminal error surface on the first response.
    isRetryable: (error) => !signal?.aborted && !isProviderTerminalError(error),
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

      try {
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
      } catch (error) {
        throw normalizeGroqError({ error, model });
      }
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
  try {
    yield* openaiCompatibleStreamChat(client, model, input);
  } catch (error) {
    // A model retired between catalog reads and this request must read the same
    // way here as on the generate path, not as a raw 404.
    throw normalizeGroqError({ error, model });
  }
}
