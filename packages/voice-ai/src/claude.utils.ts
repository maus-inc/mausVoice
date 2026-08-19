import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
  ToolChoiceAuto,
  ToolChoiceAny,
  ToolChoiceTool,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import { retry, countWords } from "@maus-inc/utilities";
import type {
  JsonResponse,
  LlmChatInput,
  LlmFinishReason,
  LlmMessage,
  LlmStreamEvent,
  LlmTool,
} from "@maus-inc/types";
import type { CustomFetch } from "./types";

// The SDK does not re-export MessageStream from its root, so derive the type
// from the client's stream() method instead of a deep subpath import.
type MessageStream = ReturnType<Anthropic["messages"]["stream"]>;

export const CLAUDE_MODELS = [
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "claude-opus-5",
  "claude-fable-5",
] as const;
export type ClaudeModel = string;

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
  customFetch?: CustomFetch;
};

export type ClaudeGenerateResponseOutput = {
  text: string;
  tokensUsed: number;
};

export const claudeGenerateTextResponse = async ({
  apiKey,
  model = "claude-sonnet-5",
  system,
  prompt,
  jsonResponse,
  customFetch,
}: ClaudeGenerateTextArgs): Promise<ClaudeGenerateResponseOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const client = createClient(apiKey, customFetch);

      let finalPrompt = prompt;
      if (jsonResponse) {
        finalPrompt = `${prompt}\n\nRespond with valid JSON matching this schema: ${JSON.stringify(jsonResponse.schema)}`;
      }

      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        system: system ?? undefined,
        messages: [{ role: "user", content: finalPrompt }],
      });

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
      const content: ContentBlockParam[] = [];
      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.toolCalls ?? []) {
        let parsedInput: Record<string, unknown>;
        try {
          parsedInput = JSON.parse(tc.arguments) as Record<string, unknown>;
        } catch {
          parsedInput = {};
        }
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: parsedInput,
        });
      }
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

const buildClaudeTools = (input: LlmChatInput): Tool[] | undefined => {
  if (!input.tools || input.tools.length === 0) {
    return undefined;
  }
  return input.tools.map(toClaudeTool);
};

const buildClaudeToolChoice = (
  input: LlmChatInput,
  tools?: Tool[],
): ToolChoiceAuto | ToolChoiceAny | ToolChoiceTool | undefined => {
  if (!input.toolChoice || !tools) {
    return undefined;
  }
  if (typeof input.toolChoice !== "string") {
    return { type: "tool", name: input.toolChoice.name };
  }
  switch (input.toolChoice) {
    case "auto":
      return { type: "auto" };
    case "required":
      return { type: "any" };
    case "none":
      return undefined;
  }
};

async function* claudeStreamEvents(
  stream: MessageStream,
  pendingToolCalls: PendingClaudeToolCall[],
): AsyncGenerator<LlmStreamEvent> {
  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield { type: "text-delta", text: event.delta.text };
    }

    if (
      event.type === "content_block_delta" &&
      event.delta.type === "input_json_delta"
    ) {
      const last = pendingToolCalls[pendingToolCalls.length - 1];
      if (last) {
        last.arguments += event.delta.partial_json;
      }
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
  }
}

export async function* claudeStreamChat({
  apiKey,
  model,
  input,
  customFetch,
}: ClaudeStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const client = createClient(apiKey, customFetch);
  const { system, messages } = llmMessagesToClaude(input.messages);
  const tools = buildClaudeTools(input);
  const toolChoice = buildClaudeToolChoice(input, tools);

  const stream = client.messages.stream({
    model,
    max_tokens: input.maxTokens ?? 4096,
    system,
    messages,
    tools,
    tool_choice: toolChoice,
    temperature: input.temperature,
    top_p: input.topP,
    stop_sequences: input.stopSequences,
  });

  const pendingToolCalls: PendingClaudeToolCall[] = [];
  yield* claudeStreamEvents(stream, pendingToolCalls);

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
