import type {
  ChatMessage,
  ChatPart,
  ChatToolStatus,
  LlmToolCall,
  ToolPermission,
} from "@maus-inc/types";
import type { AgentToolCallState } from "../state/agent.state";
import type { StreamingMessageState } from "../state/app.state";

export type MessagePartsInput = {
  message: ChatMessage;
  /** Live overlay for the currently streaming message. Wins over persisted. */
  streaming?: StreamingMessageState | null;
  /** Current-iteration steps. Only meaningful alongside `streaming`. */
  liveToolCalls?: AgentToolCallState[] | null;
  permissions?: ToolPermission[] | null;
  runNote?: { kind: "error" | "status"; text: string } | null;
};

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Stable, locale-neutral terminal state; never stores provider diagnostics. */
export type PersistedRunOutcome = "error" | "aborted";

export const persistedRunOutcomeOf = (
  message: ChatMessage,
): PersistedRunOutcome | null => {
  const metadata = recordOf(message.metadata);
  const outcome =
    metadata && Object.hasOwn(metadata, "runOutcome")
      ? metadata.runOutcome
      : null;
  return outcome === "error" || outcome === "aborted" ? outcome : null;
};

const persistedToolCallsOf = (message: ChatMessage): LlmToolCall[] => {
  const metadata = recordOf(message.metadata);
  if (metadata?.type !== "reasoning") return [];
  const calls = metadata.toolCalls;
  if (!Array.isArray(calls)) return [];
  return calls.filter(
    (call): call is LlmToolCall =>
      !!recordOf(call) &&
      typeof (call as LlmToolCall).id === "string" &&
      typeof (call as LlmToolCall).name === "string",
  );
};

const reasonFrom = (
  permissions: ToolPermission[] | null | undefined,
  toolCallId: string,
): string | undefined => {
  const linked = permissions?.find((p) => p.toolCallId === toolCallId);
  const reason = linked ? recordOf(linked.params)?.reason : undefined;
  return typeof reason === "string" && reason.trim() ? reason : undefined;
};

const permissionFor = (
  permissions: ToolPermission[] | null | undefined,
  toolCallId: string,
): ToolPermission | undefined =>
  permissions?.find((p) => p.toolCallId === toolCallId);

const persistedStatusOf = (
  message: ChatMessage,
  permissions: ToolPermission[] | null | undefined,
  toolCallId: string,
): ChatToolStatus => {
  const statuses = recordOf(recordOf(message.metadata)?.toolStatuses);
  const status =
    statuses && Object.hasOwn(statuses, toolCallId)
      ? statuses[toolCallId]
      : undefined;
  switch (status) {
    case "complete":
    case "failed":
    case "denied":
    case "pending":
    case "unknown":
      return status;
  }
  const linked = permissionFor(permissions, toolCallId);
  if (linked?.status === "pending") return "approval";
  // Legacy approval only proves consent, not successful execution.
  return linked?.status === "denied" ? "denied" : "unknown";
};

const liveStatusOf = (status: AgentToolCallState["status"]): ChatToolStatus => {
  switch (status) {
    case "awaiting-permission":
      return "approval";
    case "executing":
      return "running";
    case "done":
      return "complete";
    case "denied":
    case "failed":
      return status;
    default:
      return "pending";
  }
};

const toolResultPartFrom = (
  metadata: Record<string, unknown>,
  messageId: string,
): Extract<ChatPart, { kind: "tool-result" }> => ({
  kind: "tool-result",
  toolCallId:
    typeof metadata.toolCallId === "string" && metadata.toolCallId
      ? metadata.toolCallId
      : messageId,
  toolName:
    typeof metadata.toolName === "string" && metadata.toolName
      ? metadata.toolName
      : "tool",
  ...(typeof metadata.reason === "string" ? { reason: metadata.reason } : {}),
});

const appendToolPart = (
  parts: ChatPart[],
  toolCallId: string,
  toolName: string,
  status: ChatToolStatus,
  permissions: MessagePartsInput["permissions"],
  linked: ToolPermission | undefined,
) => {
  const reason = reasonFrom(permissions, toolCallId);
  parts.push({
    kind: "tool",
    toolCallId,
    toolName,
    status,
    ...(reason ? { reason } : {}),
  });
  if (status === "approval" && linked?.status === "pending") {
    parts.push({ kind: "permission", permissionId: linked.id });
  }
};

const livePartsOf = (
  live: StreamingMessageState,
  toolCalls: MessagePartsInput["liveToolCalls"],
  permissions: MessagePartsInput["permissions"],
): ChatPart[] => {
  const parts: ChatPart[] = [];
  if (live.reasoning.trim()) {
    parts.push({
      kind: "reasoning",
      text: live.reasoning,
      open: live.isStreaming,
    });
  }
  for (const call of toolCalls ?? []) {
    const linked = call.permissionId
      ? permissions?.find((p) => p.id === call.permissionId)
      : permissionFor(permissions, call.toolCallId);
    appendToolPart(
      parts,
      call.toolCallId,
      call.toolName,
      liveStatusOf(call.status),
      permissions,
      linked,
    );
  }
  return parts;
};

const persistedPartsOf = (
  message: ChatMessage,
  permissions: MessagePartsInput["permissions"],
): ChatPart[] => {
  const parts: ChatPart[] = [];
  for (const call of persistedToolCallsOf(message)) {
    appendToolPart(
      parts,
      call.id,
      call.name,
      persistedStatusOf(message, permissions, call.id),
      permissions,
      permissionFor(permissions, call.id),
    );
  }
  return parts;
};

/**
 * Split a stored message into renderable parts. Stored content and metadata
 * stay the source of truth, so anything written before parts existed still
 * reads; live streaming and agent state only overlay the message that is
 * currently being written.
 */
export const partsForMessage = (input: MessagePartsInput): ChatPart[] => {
  const { message, streaming, liveToolCalls, permissions, runNote } = input;
  const metadata = recordOf(message.metadata);
  if (metadata?.type === "tool-result") {
    return [toolResultPartFrom(metadata, message.id)];
  }

  const parts = streaming
    ? livePartsOf(streaming, liveToolCalls, permissions)
    : persistedPartsOf(message, permissions);
  if (message.content.trim()) {
    parts.push({ kind: "text", text: message.content });
  }
  if (runNote) {
    parts.push({ kind: runNote.kind, text: runNote.text });
  }
  return parts;
};
