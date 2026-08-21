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
import type { CustomFetch, DiscoveredModelId } from "./types";
import {
  contentToString,
  runSdkTranscription,
  TranscriptionSegment,
  TranscribeAudioOutput,
} from "./transcription.utils";
import type {
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

export const OPENAI_GENERATE_TEXT_MODELS = [
  "gpt-4o-mini",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-5-mini",
] as const;
export type OpenAIGenerateTextModel =
  (typeof OPENAI_GENERATE_TEXT_MODELS)[number] | DiscoveredModelId;

export const OPENAI_TRANSCRIPTION_MODELS = [
  "whisper-1",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
] as const;
export type OpenAITranscriptionModel =
  (typeof OPENAI_TRANSCRIPTION_MODELS)[number] | DiscoveredModelId;

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
  customFetch?: CustomFetch;
};

/**
 * OpenAI transcription models that support `verbose_json` and return the
 * detailed per-segment `no_speech_prob` used by downstream hallucination
 * gating (issue #54). Models here keep `verbose_json`.
 */
const VERBOSE_JSON_TRANSCRIPTION_MODELS = ["whisper-1"] as const;

/**
 * Pick the `response_format` for an OpenAI transcription request.
 *
 * `whisper-1` keeps `verbose_json` so `segments[].no_speech_prob` is returned
 * for probability-gated silence handling. The newer `gpt-4o-transcribe` and
 * `gpt-4o-mini-transcribe` models do NOT support `verbose_json` — they reject
 * it with a deterministic HTTP 400 — and only accept `json` / `text`. Sending
 * `verbose_json` to them previously caused a 400 that the generic retry wrapper
 * repeated three times.
 */
const getTranscriptionResponseFormat = (
  model: OpenAITranscriptionModel,
): "verbose_json" | "json" =>
  (VERBOSE_JSON_TRANSCRIPTION_MODELS as readonly string[]).includes(model)
    ? "verbose_json"
    : "json";

export type OpenAITranscriptionSegment = TranscriptionSegment;
export type OpenAITranscribeAudioOutput = TranscribeAudioOutput;

export const openaiTranscribeAudio = async ({
  apiKey,
  model = "whisper-1",
  blob,
  ext,
  prompt,
  language,
  customFetch,
}: OpenAITranscriptionArgs): Promise<OpenAITranscribeAudioOutput> => {
  const client = createClient(apiKey, undefined, customFetch);
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
      // `whisper-1` keeps `verbose_json` so `segments[].no_speech_prob` is
      // returned; `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` reject
      // `verbose_json` (HTTP 400) and use `json` instead.
      response_format: getTranscriptionResponseFormat(model),
    },
  );
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
  customFetch?: CustomFetch;
};

export type OpenAICompatibleTestIntegrationArgs = {
  baseUrl: string;
  apiKey?: string;
  customFetch?: CustomFetch;
};

export const openaiCompatibleTestIntegration = async ({
  baseUrl,
  apiKey,
  customFetch,
}: OpenAICompatibleTestIntegrationArgs): Promise<boolean> => {
  const client = createClient(apiKey || "dummy", baseUrl, customFetch);

  // Test connectivity by listing models
  await client.models.list();

  // If we get here, the connection is successful
  return true;
};

export const openaiTestIntegration = async ({
  apiKey,
  customFetch,
}: OpenAITestIntegrationArgs): Promise<boolean> => {
  const client = createClient(apiKey, undefined, customFetch);
  await client.models.list();
  return true;
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
