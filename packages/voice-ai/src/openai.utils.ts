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
import {
  buildJsonSchemaResponseFormat,
  OPENAI_LEGACY_CHAT_MODELS,
} from "./response-format.utils";
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
  ChatCompletionCreateParamsNonStreaming,
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
const JSON_OBJECT_ONLY_MODELS = new Set<string>(OPENAI_LEGACY_CHAT_MODELS);

/** True when the model accepts `response_format: { type: "json_schema" }`. */
export function supportsOpenAIJsonSchema(model: string): boolean {
  return !JSON_OBJECT_ONLY_MODELS.has(model);
}

/** True for legacy models that need the `json_object` shape instead. */
export const isOpenAIJsonObjectOnlyModel = (model: string): boolean =>
  JSON_OBJECT_ONLY_MODELS.has(model);

/**
 * The field that caps the completion length for `model`.
 *
 * `max_completion_tokens` arrived with the o-series and is the only spelling
 * those models and everything after gpt-4o-2024-08-06 accept. The pre-turbo
 * GPT-4 and GPT-3.5 line rejects it as an unrecognised request argument, so it
 * answers a request that carries it with a 400 instead of a transcript. Those
 * ids are the same `OPENAI_LEGACY_CHAT_MODELS` set the `json_object` branch
 * above serves, and they are reachable as discovered model ids, so the same
 * request shape that works on gpt-4o-mini has to keep working on them.
 */
const buildMaxTokensParams = (
  model: string,
  maxTokens = 1024,
): Record<string, number> =>
  isOpenAIJsonObjectOnlyModel(model)
    ? { max_tokens: maxTokens }
    : { max_completion_tokens: maxTokens };

// Matches the o-series id shape, with or without a vendor prefix: `o3-mini` on
// OpenAI, `openai/o3-mini` where an aggregator routes one through, and
// `openai:o3-mini` where the prefix is qualified with a colon instead of a
// slash. The prefix boundary is any character that is neither alphanumeric nor
// `-`, because `-` is the intra-id separator every published id already uses
// (`gpt-4o-mini`, `gpt-oss-20b`) and is not a prefix delimiter: reading it as one
// would classify `llama-o1-finetune`, a user-chosen Azure deployment alias, as a
// reasoning model and silently drop its sampling parameters. The trailing digit
// requirement is what keeps the test off everything else, and
// `omni-moderation-latest` is what keeps it from being a bare "starts with o".
const OPENAI_O_SERIES_MODEL_ID = /(?:^|[^A-Za-z0-9-])o\d/;

/**
 * Whether a model id names an OpenAI o-series (or gpt-5-style reasoning) model,
 * which reject the sampling parameters rather than ignoring them.
 *
 * `temperature` and `top_p` are not "unsupported values" on these models the way
 * they are on gpt-5 (which accepts only the default `1` and is therefore happy
 * with the request this file sends). OpenAI documents `temperature`, `top_p`,
 * `frequency_penalty` and `presence_penalty` as not supported by o1 and the
 * reasoning models that followed it, and answers a request that carries them
 * with a 400 before generating anything. This endpoint takes any id the model
 * list returned, so an o-series id is reachable here and the request has to be
 * built for it rather than sent and corrected.
 *
 * Exported because two other providers serve these model ids and hit the same
 * 400: Azure by deployment name, OpenRouter by routing prefix (`openai/o3-mini`).
 * A duplicate of this test in each file is a fourth thing to forget when the
 * family grows.
 */
export const isOpenAIOReasoningModel = (model: string): boolean =>
  OPENAI_O_SERIES_MODEL_ID.test(model);

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
    // The SDK's own retry layer is OFF. `retry()` below is this package's single retry
    // layer, and it carries the parts the SDK's does not: `isRetryable`, a wait the caller's
    // abort signal can cut short, and `Retry-After` as far as the header parser allows. With
    // both layers live the attempts multiply -- measured, one failed call issued 9 requests
    // for a 500 -- and each of those is a chargeable request.
    maxRetries: 0,
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

export const openaiGenerateTextResponse = ({
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
    // The OpenAI SDK throws its own `APIError` here, which nothing converts,
    // so a 429 is retried 20ms later. Converting the failure with
    // `toHttpError` inside `fn` (the pattern in `transcription.utils.ts`) is
    // what would let a hint apply here, capped at the helper's 2s default.
    signal,
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

      // The o-series rejects the sampling pair outright, so it is omitted
      // rather than sent and left to fail. Both keys are deleted rather than
      // conditionally spread so `temperature: undefined` cannot reach the
      // request as a key the API still sees.
      const params: ChatCompletionCreateParamsNonStreaming = {
        messages,
        model,
        ...buildMaxTokensParams(model, maxTokens),
        ...(response_format ? { response_format } : {}),
      };
      if (!isOpenAIOReasoningModel(model)) {
        params.temperature = 1;
        params.top_p = 1;
      }

      const response = await client.chat.completions.create(params, {
        signal,
      });

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
  const stream = await client.chat.completions.create(
    {
      model,
      messages: llmMessagesToOpenAI(input.messages),
      stream: true,
      stream_options: { include_usage: true },
      tools: llmToolsToOpenAI(input.tools),
      tool_choice: llmToolChoiceToOpenAI(input.toolChoice),
      max_tokens: input.maxTokens,
      // The streaming half of the guard the non-streaming call above already
      // has: this entry point serves the same reasoning ids (Azure by
      // deployment name, OpenRouter by routing prefix), and OpenAI documents
      // these four as unsupported on o-series models, answering a request that
      // carries them with a 400 before generating anything. `stop` and `seed`
      // are not in that set, so a reasoning stream keeps them.
      ...(isOpenAIOReasoningModel(model)
        ? {}
        : {
            temperature: input.temperature,
            top_p: input.topP,
            frequency_penalty: input.frequencyPenalty,
            presence_penalty: input.presencePenalty,
          }),
      stop: input.stopSequences,
      seed: input.seed,
      ...extraBody,
    },
    { signal: input.signal },
  );

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
