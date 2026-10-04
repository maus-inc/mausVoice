import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
  MessageStreamEvent,
  ToolChoiceAuto,
  ToolChoiceAny,
  ToolChoiceTool,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import { retry, countWords, parseJsonObject } from "@maus-inc/utilities";
import type {
  JsonResponse,
  LlmChatInput,
  LlmFinishReason,
  LlmMessage,
  LlmStreamEvent,
  LlmToolChoice,
  LlmTool,
} from "@maus-inc/types";
import type { CustomFetch, DiscoveredModelId } from "./types";

export const CLAUDE_MODELS = [
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "claude-opus-5",
  "claude-fable-5",
] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number] | DiscoveredModelId;

const createClient = (apiKey: string, customFetch?: CustomFetch) => {
  return new Anthropic({
    apiKey: apiKey.trim(),
    dangerouslyAllowBrowser: true,
    fetch: customFetch,
  });
};

export type ClaudeGenerateTextArgs = {
  apiKey: string;
  model?: ClaudeModel;
  system?: string;
  prompt: string;
  jsonResponse?: JsonResponse;
  maxTokens?: number;
  customFetch?: CustomFetch;
  signal?: AbortSignal;
};

export type ClaudeGenerateResponseOutput = {
  text: string;
  tokensUsed: number;
};

export const claudeGenerateTextResponse = ({
  apiKey,
  model = CLAUDE_MODELS[0],
  system,
  prompt,
  jsonResponse,
  maxTokens,
  customFetch,
  signal,
}: ClaudeGenerateTextArgs): Promise<ClaudeGenerateResponseOutput> => {
  return retry({
    // An aborted request must not be retried; the abort is the caller's
    // deadline decision, not a transient failure worth another attempt.
    // A present-but-not-aborted signal is not an abort and must not disable
    // retries for transient failures.
    retries: 3,
    isRetryable: () => !signal?.aborted,
    // An abort during the wait is honoured: `retry` hands the signal to its
    // own wait, so a cancelled caller stops there instead of sitting it out.
    // That wait is the helper's own 20ms, because the helper only stretches
    // a wait for a `Retry-After` hint and reads that hint off an `HttpError`.
    // The Anthropic SDK throws its own `APIError` here, which nothing
    // converts, so a 429 is retried 20ms later. Converting the failure with
    // `toHttpError` inside `fn` (the pattern in `transcription.utils.ts`) is
    // what would let a hint apply here, capped at the helper's 2s default.
    signal,
    fn: async () => {
      const client = createClient(apiKey, customFetch);

      let finalPrompt = prompt;
      if (jsonResponse) {
        finalPrompt = `${prompt}\n\nRespond with valid JSON matching this schema: ${JSON.stringify(jsonResponse.schema)}`;
      }

      const response = await client.messages.create(
        {
          model,
          max_tokens: maxTokens ?? 1024,
          system: system ?? undefined,
          messages: [{ role: "user", content: finalPrompt }],
        },
        { signal },
      );

      console.log("claude llm usage:", response.usage);

      const textBlock = response.content.find((block) => block.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error("No text response from Claude");
      }

      const content = textBlock.text;
      const tokensUsed =
        (response.usage?.input_tokens ?? 0) +
        (response.usage?.output_tokens ?? 0);

      return {
        text: content,
        tokensUsed: tokensUsed || countWords(content),
      };
    },
  });
};

export type ClaudeTestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export const claudeTestIntegration = async ({
  apiKey,
  customFetch,
}: ClaudeTestIntegrationArgs): Promise<boolean> => {
  const client = createClient(apiKey, customFetch);
  await client.models.list();
  return true;
};

// ============================================================================
// Streaming Chat
// ============================================================================

function claudeAssistantContent(
  msg: Extract<LlmMessage, { role: "assistant" }>,
): ContentBlockParam[] {
  const content: ContentBlockParam[] = [];
  if (msg.content) {
    content.push({ type: "text", text: msg.content });
  }
  for (const tc of msg.toolCalls ?? []) {
    const parsedInput = parseJsonObject(tc.arguments) ?? {};
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input: parsedInput,
    });
  }
  return content;
}

function llmMessagesToClaude(messages: LlmMessage[]): {
  system: string | undefined;
  messages: MessageParam[];
} {
  let system: string | undefined;
  const out: MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = msg.content;
      continue;
    }

    if (msg.role === "user") {
      out.push({ role: "user", content: msg.content });
      continue;
    }

    if (msg.role === "assistant") {
      const content = claudeAssistantContent(msg);
      if (content.length > 0) {
        out.push({ role: "assistant", content });
      }
      continue;
    }

    if (msg.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolCallId,
            content: msg.content,
          },
        ],
      });
    }
  }

  return { system, messages: out };
}

function claudeFinishReason(raw: string | null | undefined): LlmFinishReason {
  switch (raw) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool-calls";
    default:
      return "other";
  }
}

export type ClaudeStreamChatArgs = {
  apiKey: string;
  model: string;
  input: LlmChatInput;
  customFetch?: CustomFetch;
};

const mapClaudeToolChoice = (
  choice: LlmToolChoice | undefined,
  hasTools: boolean,
): ToolChoiceAuto | ToolChoiceAny | ToolChoiceTool | undefined => {
  // Nothing to choose between. Leaving `tool_choice` off is not neutral either:
  // it is the only shape of this request Anthropic accepts when no tool is
  // defined, so it has to be absent rather than name a tool that is not there.
  if (!choice || !hasTools) return undefined;
  if (typeof choice === "string") {
    switch (choice) {
      case "auto":
        return { type: "auto" };
      case "required":
        return { type: "any" };
      case "none":
        return undefined;
      // This arm is unreachable as far as the compiler is concerned, and that is
      // exactly why it has to be here. `LlmToolChoice` is a closed union, so
      // TypeScript narrows `choice` to those three strings above and reads the
      // switch as exhaustive. `toolChoice` is read straight off the caller's
      // `LlmChatInput` and crosses a persistence/IPC boundary where that union
      // is not enforced, so an unrecognised string does arrive at runtime.
      //
      // Without this arm it falls out of the switch and reaches
      // `{ type: "tool", name: choice.name }` with `choice` still a string, so
      // `name` is `undefined` and the request is sent as a malformed
      // `tool_choice` — a 400 from a paid endpoint, rather than the documented
      // behaviour of omitting the field when there is nothing valid to choose.
      default:
        return undefined;
    }
  }
  return { type: "tool", name: choice.name };
};

type ClaudeToolCall = { id: string; name: string; arguments: string };

const processClaudeStreamEvent = (
  event: MessageStreamEvent,
  pendingToolCalls: ClaudeToolCall[],
): string | undefined => {
  if (
    event.type === "content_block_delta" &&
    event.delta.type === "text_delta"
  ) {
    return event.delta.text;
  }

  if (
    event.type === "content_block_delta" &&
    event.delta.type === "input_json_delta"
  ) {
    const last = pendingToolCalls[pendingToolCalls.length - 1];
    if (last) {
      last.arguments += event.delta.partial_json;
    }
    return undefined;
  }

  if (
    event.type === "content_block_start" &&
    event.content_block.type === "tool_use"
  ) {
    pendingToolCalls.push({
      id: event.content_block.id,
      name: event.content_block.name,
      arguments: "",
    });
  }

  return undefined;
};

type PendingClaudeToolCall = {
  id: string;
  name: string;
  arguments: string;
};

const toClaudeTool = (tool: LlmTool): Tool => ({
  name: tool.name,
  description: tool.description ?? "",
  input_schema: (tool.parameters ?? {
    type: "object",
    properties: {},
  }) as Tool["input_schema"],
});

export async function* claudeStreamChat({
  apiKey,
  model,
  input,
  customFetch,
}: ClaudeStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const client = createClient(apiKey, customFetch);
  const { system, messages } = llmMessagesToClaude(input.messages);
  // An empty list is a request with no tool definitions, and `[]` is truthy, so
  // the length is what decides it here: sending `tools: []` would claim a tool
  // list that does not exist and leave `tool_choice` naming one of nothing.
  // The other providers already drop an empty list the same way.
  const tools = input.tools?.length ? input.tools.map(toClaudeTool) : undefined;
  const toolChoice = mapClaudeToolChoice(input.toolChoice, Boolean(tools));

  const stream = client.messages.stream(
    {
      model,
      max_tokens: input.maxTokens ?? 4096,
      system,
      messages,
      tools,
      tool_choice: toolChoice,
      temperature: input.temperature,
      top_p: input.topP,
      stop_sequences: input.stopSequences,
    },
    { signal: input.signal },
  );

  const pendingToolCalls: PendingClaudeToolCall[] = [];
  for await (const event of stream) {
    const textDelta = processClaudeStreamEvent(event, pendingToolCalls);
    if (textDelta) {
      yield { type: "text-delta", text: textDelta };
    }
  }

  for (const tc of pendingToolCalls) {
    yield {
      type: "tool-call",
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    };
  }

  const finalMessage = await stream.finalMessage();
  yield {
    type: "finish",
    finishReason: claudeFinishReason(finalMessage.stop_reason),
    usage: {
      promptTokens: finalMessage.usage?.input_tokens,
      completionTokens: finalMessage.usage?.output_tokens,
    },
    modelId: finalMessage.model,
  };
}
