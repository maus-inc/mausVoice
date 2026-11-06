import type { ChatMessage, LlmMessage, LlmToolCall } from "@maus-inc/types";

export const isValidPersistedToolCall = (
  value: unknown,
): value is LlmToolCall => {
  if (value === null || typeof value !== "object") return false;
  const call = value as Record<string, unknown>;
  return (
    typeof call.id === "string" &&
    call.id.length > 0 &&
    typeof call.name === "string" &&
    call.name.length > 0 &&
    typeof call.arguments === "string"
  );
};

/** Rehydrate persisted tool results and assistant calls into the provider protocol. */
export const toReplayMessage = (message: ChatMessage): LlmMessage | null => {
  const metadata = message.metadata;
  if (
    metadata?.type === "tool-result" &&
    typeof metadata.toolCallId === "string"
  ) {
    return {
      role: "tool",
      toolCallId: metadata.toolCallId,
      content: message.content,
    };
  }
  if (message.role === "assistant") {
    const calls = metadata?.toolCalls;
    const toolCalls =
      Array.isArray(calls) && calls.every(isValidPersistedToolCall)
        ? calls
        : undefined;
    return {
      role: "assistant",
      content: message.content || undefined,
      ...(toolCalls && { toolCalls }),
    };
  }
  if (message.role === "user")
    return { role: "user", content: message.content };
  return null;
};
