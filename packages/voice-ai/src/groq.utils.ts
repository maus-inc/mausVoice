import type {
  JsonResponse,
  LlmChatInput,
  LlmStreamEvent,
} from "@maus-inc/types";
import { retry } from "@maus-inc/utilities";
import Groq from "groq-sdk/index";
import type {
  ChatCompletionMessageParam,
} from "groq-sdk/resources/chat/completions";
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

const createClient = (apiKey: string, customFetch?: CustomFetch) => {
  return new Groq({
    apiKey: apiKey.trim(),
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
    retries: signal ? 1 : 3,
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
    dangerouslyAllowBrowser: true,
    fetch: customFetch,
  });
  yield* openaiCompatibleStreamChat(client, model, input);
}
