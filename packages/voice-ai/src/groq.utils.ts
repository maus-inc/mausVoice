import type {
  JsonResponse,
  LlmChatInput,
  LlmStreamEvent,
} from "@maus-inc/types";
import { countWords, retry } from "@maus-inc/utilities";
import {
  contentToString,
  buildChatMessages,
  transcribeWithOpenAICompatClient,
} from "./shared.utils";
import Groq from "groq-sdk/index";
import {
  ChatCompletionMessageParam,
} from "groq-sdk/resources/chat/completions";
import OpenAI from "openai";
import { openaiCompatibleStreamChat } from "./openai.utils";

export const GENERATE_TEXT_MODELS = [
  "moonshotai/kimi-k2-instruct-0905",
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "qwen/qwen3.6-27b",
] as const;
export type GenerateTextModel = (typeof GENERATE_TEXT_MODELS)[number];

// Models that support `response_format: { type: "json_schema" }`.
// See https://console.groq.com/docs/structured-outputs
const JSON_SCHEMA_SUPPORTED_MODELS = new Set<string>([
  "moonshotai/kimi-k2-instruct-0905",
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
]);

const buildResponseFormat = (
  jsonResponse: JsonResponse | null,
  model: string,
): {
  type: "json_schema";
  json_schema: {
    name: string;
    description?: string;
    schema: Record<string, unknown>;
  };
} | { type: "json_object" } | undefined => {
  if (!jsonResponse) {
    return undefined;
  }
  if (JSON_SCHEMA_SUPPORTED_MODELS.has(model)) {
    return {
      type: "json_schema",
      json_schema: {
        name: jsonResponse.name,
        description: jsonResponse.description,
        schema: jsonResponse.schema,
      },
    };
  }
  return { type: "json_object" };
};

export const TRANSCRIPTION_MODELS = [
  "whisper-large-v3-turbo",
  "whisper-large-v3",
] as const;
export type TranscriptionModel = (typeof TRANSCRIPTION_MODELS)[number];


const createClient = (apiKey: string) => {
  // `dangerouslyAllowBrowser` is needed because this runs on a desktop tauri app.
  // The Tauri app doesn't run in a web browser and encyrpts API keys locally, so this
  // is safe.
  return new Groq({ apiKey: apiKey.trim(), dangerouslyAllowBrowser: true });
};

export type GroqTranscriptionArgs = {
  apiKey: string;
  model?: TranscriptionModel;
  blob: ArrayBuffer | Buffer;
  ext: string;
  prompt?: string;
  language?: string;
};

export type GroqTranscribeAudioOutput = {
  text: string;
  wordsUsed: number;
};

export const groqTranscribeAudio = async ({
  apiKey,
  model = "whisper-large-v3-turbo",
  blob,
  ext,
  prompt,
  language,
}: GroqTranscriptionArgs): Promise<GroqTranscribeAudioOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const client = createClient(apiKey);

      const text = await transcribeWithOpenAICompatClient(client, {
        blob,
        ext,
        model,
        prompt,
        language,
      });
      return { text, wordsUsed: countWords(text) };
    },
  });
};

export type GroqGenerateTextArgs = {
  apiKey: string;
  model?: GenerateTextModel;
  system?: string;
  prompt: string;
  imageUrls?: string[];
  jsonResponse?: JsonResponse;
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
}: GroqGenerateTextArgs): Promise<GroqGenerateResponseOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const client = createClient(apiKey);

      const messages = buildChatMessages({
        system,
        prompt,
        imageUrls,
      }) as unknown as ChatCompletionMessageParam[];

      const response = await client.chat.completions.create({
        messages,
        model,
        max_completion_tokens: 5000,
        response_format: buildResponseFormat(jsonResponse ?? null, model),
      });

      console.log("groq llm usage:", response.usage);
      if (!response.choices || response.choices.length === 0) {
        throw new Error("No response from Groq");
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
  });
};

export type GroqTestIntegrationArgs = {
  apiKey: string;
};

export const groqTestIntegration = async ({
  apiKey,
}: GroqTestIntegrationArgs): Promise<boolean> => {
  const client = createClient(apiKey);

  const response = await client.chat.completions.create({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Reply with the single word "Hello."`,
          },
        ],
      },
    ],
    model: "openai/gpt-oss-120b",
    temperature: 0,
    reasoning_effort: "low",
    max_completion_tokens: 1024,
    top_p: 1,
  });

  if (!response.choices || response.choices.length === 0) {
    throw new Error("No response from Groq");
  }

  const first = response.choices[0];
  const content = contentToString(first?.message?.content);
  if (!content) {
    throw new Error("Response content is empty");
  }

  return content.toLowerCase().includes("hello");
};

// ============================================================================
// Streaming Chat
// ============================================================================

export type GroqStreamChatArgs = {
  apiKey: string;
  model: string;
  input: LlmChatInput;
};

export async function* groqStreamChat({
  apiKey,
  model,
  input,
}: GroqStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const client = new OpenAI({
    apiKey: apiKey.trim(),
    baseURL: "https://api.groq.com/openai/v1",
    dangerouslyAllowBrowser: true,
  });
  yield* openaiCompatibleStreamChat(client, model, input);
}
