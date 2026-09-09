import type {
  JsonResponse,
  LlmChatInput,
  LlmFinishReason,
  LlmMessage,
  LlmStreamEvent,
  LlmTool,
  LlmToolChoice,
} from "@maus-inc/types";
import { retry } from "@maus-inc/utilities";
import OpenAI, { toFile } from "openai";
import { buildJsonSchemaResponseFormat } from "./response-format.utils";
import {
  buildJsonObjectPrompt,
  buildOpenAICompatibleMessages,
  parseOpenAICompatibleGenerateTextResponse,
} from "./openai-compatible-generate.utils";
import type { CustomFetch, DiscoveredModelId } from "./types";
import {
  runSdkTranscription,
  TranscriptionSegment,
  TranscribeAudioOutput,
} from "./transcription.utils";
import type {
  ChatCompletionChunk,
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

// Legacy chat models that predate Structured Outputs and therefore REJECT
// `response_format: { type: "json_schema" }` (400 from the API). Only these
// may receive the legacy `json_object` shape; every other model — including
// discovered ones (o-series, gpt-4.1, gpt-5.x, gpt-oss) — defaults to
// `json_schema`, which is the only structured format the o-series accepts.
const JSON_OBJECT_ONLY_MODELS = new Set<string>([
  "gpt-3.5-turbo",
  "gpt-3.5-turbo-0125",
  "gpt-3.5-turbo-1106",
  "gpt-4",
  "gpt-4-0301",
  "gpt-4-0613",
  "gpt-4-32k",
  "gpt-4-turbo",
  "gpt-4-turbo-2024-04-09",
  "gpt-4-1106-preview",
  "gpt-4-0125-preview",
]);

/** True when the model accepts `response_format: { type: "json_schema" }`. */
export function supportsOpenAIJsonSchema(model: string): boolean {
  return !JSON_OBJECT_ONLY_MODELS.has(model);
}

/** True for legacy models that need the `json_object` shape instead. */
export const isOpenAIJsonObjectOnlyModel = (model: string): boolean =>
  JSON_OBJECT_ONLY_MODELS.has(model);

const buildResponseFormat = (model: string, jsonResponse?: JsonResponse) =>
  buildJsonSchemaResponseFormat(
    model,
    isOpenAIJsonObjectOnlyModel,
    jsonResponse,
  );

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
  maxTokens?: number;
  signal?: AbortSignal;
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
  maxTokens,
  signal,
}: OpenAIGenerateTextArgs): Promise<OpenAIGenerateResponseOutput> => {
  return retry({
    // An aborted request must not be retried; the abort is the caller's
    // deadline decision, not a transient failure worth another attempt.
    // A present-but-not-aborted signal is not an abort and must not disable
    // retries for transient failures.
    retries: 3,
    isRetryable: (error) => !signal?.aborted,
    fn: async () => {
      const client = createClient(apiKey, baseUrl, customFetch);

      // The `json_object` shape (legacy models only) requires the word "JSON"
      // somewhere in the context or the API rejects the request; append the
      // schema instruction only on that branch so json_schema calls are
      // unchanged.
      const finalPrompt =
        jsonResponse && isOpenAIJsonObjectOnlyModel(model)
          ? buildJsonObjectPrompt({ prompt, jsonResponse })
          : prompt;

      const messages = buildOpenAICompatibleMessages({
        system,
        prompt: finalPrompt,
        imageUrls,
      });

      const response_format = buildResponseFormat(model, jsonResponse);

      const response = await client.chat.completions.create(
        {
          messages,
          model,
          temperature: 1,
          max_completion_tokens: maxTokens ?? 1024,
          top_p: 1,
          ...(response_format ? { response_format } : {}),
        },
        { signal },
      );

      console.log("openai llm usage:", response.usage);
      return parseOpenAICompatibleGenerateTextResponse({
        response,
        providerLabel: "OpenAI",
      });
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

type OpenAIChunkState = {
  toolCalls: Map<number, { id: string; name: string; arguments: string }>;
  finishReason: LlmFinishReason;
  promptTokens: number | undefined;
  completionTokens: number | undefined;
  modelId: string | undefined;
};

const applyOpenAIToolCalls = (
  choice: ChatCompletionChunk.Choice,
  toolCalls: OpenAIChunkState["toolCalls"],
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

const processOpenAIChunk = (
  chunk: OpenAI.Chat.Completions.ChatCompletionChunk,
  state: OpenAIChunkState,
): LlmStreamEvent[] => {
  const events: LlmStreamEvent[] = [];
  if (chunk.model) {
    state.modelId = chunk.model;
  }

  if (chunk.usage) {
    state.promptTokens = chunk.usage.prompt_tokens ?? undefined;
    state.completionTokens = chunk.usage.completion_tokens ?? undefined;
  }

  const choice = chunk.choices[0];
  if (!choice) {
    return events;
  }

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

  const state: OpenAIChunkState = {
    toolCalls: new Map<
      number,
      { id: string; name: string; arguments: string }
    >(),
    finishReason: "other",
    promptTokens: undefined,
    completionTokens: undefined,
    modelId: undefined,
  };

  for await (const chunk of stream) {
    for (const event of processOpenAIChunk(chunk, state)) {
      yield event;
    }
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
