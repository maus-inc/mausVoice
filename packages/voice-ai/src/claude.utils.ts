import Anthropic from "@anthropic-ai/sdk";
import { parseToolArguments } from "./shared.utils";
import type {
  MessageStreamEvent,
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
} from "@maus-inc/types";

export const CLAUDE_MODELS = [
  "claude-opus-4-5-20251101",
  "claude-opus-4-5",
  "claude-3-7-sonnet-latest",
  "claude-3-7-sonnet-20250219",
  "claude-3-5-haiku-latest",
  "claude-3-5-haiku-20241022",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-20250514",
  "claude-sonnet-4-0",
  "claude-4-sonnet-20250514",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-0",
  "claude-opus-4-20250514",
  "claude-4-opus-20250514",
  "claude-opus-4-1-20250805",
  "claude-3-opus-latest",
  "claude-3-opus-20240229",
  "claude-3-haiku-20240307",
] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

const createClient = (apiKey: string) => {
  return new Anthropic({
    apiKey: apiKey.trim(),
    dangerouslyAllowBrowser: true,
  });
};

export type ClaudeGenerateTextArgs = {
  apiKey: string;
  model?: ClaudeModel;
  system?: string;
  prompt: string;
  jsonResponse?: JsonResponse;
};

export type ClaudeGenerateResponseOutput = {
  text: string;
  tokensUsed: number;
};

export const claudeGenerateTextResponse = async ({
  apiKey,
  model = "claude-sonnet-4-20250514",
  system,
  prompt,
  jsonResponse,
}: ClaudeGenerateTextArgs): Promise<ClaudeGenerateResponseOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const client = createClient(apiKey);

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
      if (textBlock?.type !== "text") {
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
};

export const claudeTestIntegration = async ({
  apiKey,
}: ClaudeTestIntegrationArgs): Promise<boolean> => {
  const client = createClient(apiKey);

  const response = await client.messages.create({
    model: "claude-3-haiku-20240307",
    max_tokens: 32,
    messages: [
      {
        role: "user",
        content: 'Reply with the single word "Hello."',
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (textBlock?.type !== "text") {
    throw new Error("No text response from Claude");
  }

  return textBlock.text.toLowerCase().includes("hello");
};

// ============================================================================
// Streaming Chat
// ============================================================================

const buildAssistantContent = (
  msg: Extract<LlmMessage, { role: "assistant" }>,
): ContentBlockParam[] => {
  const content: ContentBlockParam[] = [];
  if (msg.content) {
    content.push({ type: "text", text: msg.content });
  }
  for (const tc of msg.toolCalls ?? []) {
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input: parseToolArguments(tc.arguments),
    });
  }
  return content;
};

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
      const content = buildAssistantContent(msg);
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

const resolveToolChoice = (
  toolChoice: LlmChatInput["toolChoice"],
  tools: Tool[] | undefined,
): ToolChoiceAuto | ToolChoiceAny | ToolChoiceTool | undefined => {
  if (!toolChoice || !tools) {
    return undefined;
  }
  if (typeof toolChoice === "string") {
    if (toolChoice === "auto") {
      return { type: "auto" };
    }
    if (toolChoice === "required") {
      return { type: "any" };
    }
    return undefined;
  }
  return { type: "tool", name: toolChoice.name };
};

const buildClaudeTools = (
  tools: LlmChatInput["tools"],
): Tool[] | undefined => {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: (t.parameters ?? {
      type: "object",
      properties: {},
    }) as Tool["input_schema"],
  }));
};

const handleClaudeStreamEvent = (
  event: MessageStreamEvent,
  pendingToolCalls: Array<{ id: string; name: string; arguments: string }>,
): LlmStreamEvent[] => {
  if (event.type !== "content_block_delta") {
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
    return [];
  }

  if (event.delta.type === "text_delta") {
    return [{ type: "text-delta", text: event.delta.text }];
  }

  if (event.delta.type === "input_json_delta") {
    const last = pendingToolCalls.at(-1);
    if (last) {
      last.arguments += event.delta.partial_json;
    }
  }

  return [];
};

export type ClaudeStreamChatArgs = {
  apiKey: string;
  model: string;
  input: LlmChatInput;
};

export async function* claudeStreamChat({
  apiKey,
  model,
  input,
}: ClaudeStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const client = createClient(apiKey);
  const { system, messages } = llmMessagesToClaude(input.messages);

  const tools = buildClaudeTools(input.tools);

  const toolChoice = resolveToolChoice(input.toolChoice, tools);

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

  const pendingToolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }> = [];

  for await (const event of stream) {
    const events = handleClaudeStreamEvent(event, pendingToolCalls);
    for (const streamEvent of events) {
      yield streamEvent;
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
