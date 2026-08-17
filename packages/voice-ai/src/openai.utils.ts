import type {
  JsonResponse,
  LlmChatInput,
  LlmFinishReason,
  LlmMessage,
  LlmStreamEvent,
  LlmTool,
  LlmToolChoice,
} from "@maus-inc/types";
import { countWords, retry } from "@maus-inc/utilities";
import OpenAI, { toFile } from "openai";
import type { CustomFetch } from "./types";
import type {
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

export const OPENAI_GENERATE_TEXT_MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-3.5-turbo",
  "gpt-5.2",
  "gpt-5.3",
  "gpt-5.4",
] as const;
export type OpenAIGenerateTextModel =
  (typeof OPENAI_GENERATE_TEXT_MODELS)[number];

export const OPENAI_TRANSCRIPTION_MODELS = [
  "whisper-1",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
] as const;
export type OpenAITranscriptionModel =
  (typeof OPENAI_TRANSCRIPTION_MODELS)[number];

const contentToString = (
  content: string | ChatCompletionContentPart[] | null | undefined,
): string => {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text ?? "";
      }
      return "";
    })
    .join("")
    .trim();
};

const createClient = (
  apiKey: string,
  baseUrl?: string,
  customFetch?: CustomFetch,
) => {
  // `dangerouslyAllowBrowser` is needed because this runs on a desktop tauri app.
  // The Tauri app doesn't run in a web browser and encrypts API keys locally, so this
  // is safe.
  return new OpenAI({
    apiKey: apiKey.trim(),
    baseURL: baseUrl,
    dangerouslyAllowBrowser: true,
    fetch: customFetch,
  });
};

export type OpenAITranscriptionArgs = {
  apiKey: string;
  model?: OpenAITranscriptionModel;
  blob: ArrayBuffer | Buffer;
  ext: string;
  prompt?: string;
  language?: string;
};

export type OpenAITranscriptionSegment = {
  text: string;
  noSpeechProb?: number;
};

export type OpenAITranscribeAudioOutput = {
  text: string;
  wordsUsed: number;
  segments?: OpenAITranscriptionSegment[];
};

export const openaiTranscribeAudio = async ({
  apiKey,
  model = "whisper-1",
  blob,
  ext,
  prompt,
  language,
}: OpenAITranscriptionArgs): Promise<OpenAITranscribeAudioOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const client = createClient(apiKey);

      const file = await toFile(blob, `audio.${ext}`);
      const response = await client.audio.transcriptions.create({
        file,
        model,
        prompt,
        language: language && language !== "auto" ? language : undefined,
        // Request verbose output so `segments[].no_speech_prob` is returned,
        // enabling issue #54's probability-gated silence handling. Providers
        // that don't support this simply ignore it and return plain `text`, so
        // the defensive parse below keeps the existing behavior.
        response_format: "verbose_json",
      });

      // The SDK types `create` as a union; request verbose_json and read the
      // fields defensively so non-verbose responses still work.
      const verbose = response as unknown as {
        text?: string;
        segments?: Array<{ text?: string; no_speech_prob?: number }>;
      };

      if (!verbose.text) {
        throw new Error("Transcription failed");
      }

      const segments = verbose.segments
        ? verbose.segments.map((segment) => ({
            text: segment.text ?? "",
            noSpeechProb: segment.no_speech_prob,
          }))
        : undefined;

      return {
        text: verbose.text,
        wordsUsed: countWords(verbose.text),
        segments,
      };
    },
  });
};

export type OpenAIGenerateTextArgs = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  system?: string;
  prompt: string;
  imageUrls?: string[];
  jsonResponse?: JsonResponse;
  customFetch?: CustomFetch;
};

export type OpenAIGenerateResponseOutput = {
  text: string;
  tokensUsed: number;
};

export const openaiGenerateTextResponse = async ({
  apiKey,
  baseUrl,
  model = "gpt-4o-mini",
  system,
  prompt,
  imageUrls = [],
  jsonResponse,
  customFetch,
}: OpenAIGenerateTextArgs): Promise<OpenAIGenerateResponseOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const client = createClient(apiKey, baseUrl, customFetch);

      const messages: ChatCompletionMessageParam[] = [];
      if (system) {
        messages.push({ role: "system", content: system });
      }

      const userParts: ChatCompletionContentPart[] = [];
      for (const url of imageUrls) {
        userParts.push({
          type: "image_url",
          image_url: { url },
        });
      }

      userParts.push({ type: "text", text: prompt });
      messages.push({ role: "user", content: userParts });

      const response = await client.chat.completions.create({
        messages,
        model,
        temperature: 1,
        max_completion_tokens: 1024,
        top_p: 1,
        response_format: jsonResponse
          ? {
              type: "json_schema",
              json_schema: {
                name: jsonResponse.name,
                description: jsonResponse.description,
                schema: jsonResponse.schema,
                strict: true,
              },
            }
          : undefined,
      });

      console.log("openai llm usage:", response.usage);
      if (!response.choices || response.choices.length === 0) {
        throw new Error("No response from OpenAI");
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

export type OpenAITestIntegrationArgs = {
  apiKey: string;
};

export type OpenAICompatibleTestIntegrationArgs = {
  baseUrl: string;
  apiKey?: string;
};

export const openaiCompatibleTestIntegration = async ({
  baseUrl,
  apiKey,
}: OpenAICompatibleTestIntegrationArgs): Promise<boolean> => {
  const client = createClient(apiKey || "dummy", baseUrl);

  // Test connectivity by listing models
  await client.models.list();

  // If we get here, the connection is successful
  return true;
};

export const openaiTestIntegration = async ({
  apiKey,
}: OpenAITestIntegrationArgs): Promise<boolean> => {
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
    model: "gpt-4o-mini",
    temperature: 0,
    max_completion_tokens: 32,
    top_p: 1,
  });

  if (!response.choices || response.choices.length === 0) {
    throw new Error("No response from OpenAI");
  }

  const first = response.choices[0];
  const content = contentToString(first?.message?.content);
  if (!content) {
    throw new Error("Response content is empty");
  }

  return content.toLowerCase().includes("hello");
};

// ============================================================================
// Streaming Chat (shared utility for all OpenAI-compatible providers)
// ============================================================================

export function llmMessagesToOpenAI(
  messages: LlmMessage[],
): ChatCompletionMessageParam[] {
  return messages.map((msg): ChatCompletionMessageParam => {
    switch (msg.role) {
      case "system":
        return { role: "system", content: msg.content };
      case "user":
        return { role: "user", content: msg.content };
      case "assistant":
        return {
          role: "assistant",
          content: msg.content ?? null,
          tool_calls: msg.toolCalls?.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      case "tool":
        return {
          role: "tool",
          tool_call_id: msg.toolCallId,
          content: msg.content,
        };
    }
  });
}

function llmToolsToOpenAI(
  tools: LlmTool[] | undefined,
): ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown> | undefined,
    },
  }));
}

function llmToolChoiceToOpenAI(
  choice: LlmToolChoice | undefined,
):
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } }
  | undefined {
  if (!choice) return undefined;
  if (typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

function toFinishReason(raw: string | null | undefined): LlmFinishReason {
  switch (raw) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content-filter";
    case "tool_calls":
      return "tool-calls";
    default:
      return "other";
  }
}

type OpenAIStreamState = {
  toolCalls: Map<number, { id: string; name: string; arguments: string }>;
  finishReason: LlmFinishReason;
  promptTokens?: number;
  completionTokens?: number;
  modelId?: string;
};

const applyOpenAIToolCalls = (
  choice: ChatCompletionChunk.Choice,
  toolCalls: OpenAIStreamState["toolCalls"],
): void => {
  for (const tc of choice.delta?.tool_calls ?? []) {
    const index = tc.index ?? toolCalls.size;
    const current = toolCalls.get(index) ?? {
      id: "",
      name: "",
      arguments: "",
    };
    if (tc.id) current.id = tc.id;
    if (tc.function?.name) current.name = tc.function.name;
    if (tc.function?.arguments) current.arguments += tc.function.arguments;
    toolCalls.set(index, current);
  }
};

const handleOpenAIChunk = (
  chunk: ChatCompletionChunk,
  state: OpenAIStreamState,
): LlmStreamEvent[] => {
  if (chunk.model) {
    state.modelId = chunk.model;
  }

  if (chunk.usage) {
    state.promptTokens = chunk.usage.prompt_tokens ?? undefined;
    state.completionTokens = chunk.usage.completion_tokens ?? undefined;
  }

  const choice = chunk.choices[0];
  if (!choice) {
    return [];
  }

  const events: LlmStreamEvent[] = [];
  if (choice.delta?.content) {
    events.push({ type: "text-delta", text: choice.delta.content });
  }

  applyOpenAIToolCalls(choice, state.toolCalls);

  if (choice.finish_reason) {
    state.finishReason = toFinishReason(choice.finish_reason);
  }

  return events;
};

export async function* openaiCompatibleStreamChat(
  client: OpenAI,
  model: string,
  input: LlmChatInput,
  extraBody?: Record<string, unknown>,
): AsyncGenerator<LlmStreamEvent> {
  const stream = await client.chat.completions.create({
    model,
    messages: llmMessagesToOpenAI(input.messages),
    stream: true,
    stream_options: { include_usage: true },
    tools: llmToolsToOpenAI(input.tools),
    tool_choice: llmToolChoiceToOpenAI(input.toolChoice),
    max_tokens: input.maxTokens,
    temperature: input.temperature,
    stop: input.stopSequences,
    top_p: input.topP,
    frequency_penalty: input.frequencyPenalty,
    presence_penalty: input.presencePenalty,
    seed: input.seed,
    ...extraBody,
  });

  const state: OpenAIStreamState = {
    toolCalls: new Map(),
    finishReason: "other",
  };

  for await (const chunk of stream) {
    yield* handleOpenAIChunk(chunk, state);
  }

  for (const [, tc] of [...state.toolCalls.entries()].sort(
    ([a], [b]) => a - b,
  )) {
    yield {
      type: "tool-call",
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    };
  }

  yield {
    type: "finish",
    finishReason: state.finishReason,
    usage:
      state.promptTokens != null || state.completionTokens != null
        ? {
            promptTokens: state.promptTokens,
            completionTokens: state.completionTokens,
          }
        : undefined,
    modelId: state.modelId,
  };
}

export type OpenAIStreamChatArgs = {
  apiKey: string;
  baseUrl?: string;
  model: string;
  input: LlmChatInput;
  customFetch?: CustomFetch;
};

export async function* openaiStreamChat({
  apiKey,
  baseUrl,
  model,
  input,
  customFetch,
}: OpenAIStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const client = createClient(apiKey, baseUrl, customFetch);
  yield* openaiCompatibleStreamChat(client, model, input);
}
