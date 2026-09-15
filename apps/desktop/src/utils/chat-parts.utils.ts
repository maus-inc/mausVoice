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
  permissions: ToolPermission[] | null | undefined,
  toolCallId: string,
): ChatToolStatus => {
  const linked = permissionFor(permissions, toolCallId);
  if (!linked) return "complete";
  if (linked.status === "pending") return "approval";
  return linked.status === "denied" ? "denied" : "complete";
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
      return "denied";
    default:
      return "pending";
  }
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
    const toolCallId =
      typeof metadata.toolCallId === "string" && metadata.toolCallId
        ? metadata.toolCallId
        : message.id;
    const toolName =
      typeof metadata.toolName === "string" && metadata.toolName
        ? metadata.toolName
        : "tool";
    const reason =
      typeof metadata.reason === "string" ? metadata.reason : undefined;
    return [{ kind: "tool-result", toolCallId, toolName, reason }];
  }

  const parts: ChatPart[] = [];
  const live = streaming ?? null;

  if (live) {
    if (live.reasoning.trim()) {
      parts.push({
        kind: "reasoning",
        text: live.reasoning,
        open: live.isStreaming,
      });
    }
    for (const tc of liveToolCalls ?? []) {
      const reason = reasonFrom(permissions, tc.toolCallId);
      parts.push({
        kind: "tool",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        status: liveStatusOf(tc.status),
        ...(reason ? { reason } : {}),
      });
      const linked = tc.permissionId
        ? permissions?.find((p) => p.id === tc.permissionId)
        : permissionFor(permissions, tc.toolCallId);
      if (linked && linked.status === "pending") {
        parts.push({ kind: "permission", permissionId: linked.id });
      }
    }
  } else {
    for (const call of persistedToolCallsOf(message)) {
      const reason = reasonFrom(permissions, call.id);
      parts.push({
        kind: "tool",
        toolCallId: call.id,
        toolName: call.name,
        status: persistedStatusOf(permissions, call.id),
        ...(reason ? { reason } : {}),
      });
      // Only an undecided request renders its prompt. A denied request is
      // already reflected in the step status; an allowed one is consumed.
      const linked = permissionFor(permissions, call.id);
      if (linked && linked.status === "pending") {
        parts.push({ kind: "permission", permissionId: linked.id });
      }
    }
  }

  if (message.content.trim()) {
    parts.push({ kind: "text", text: message.content });
  }
  if (runNote) {
    parts.push({ kind: runNote.kind, text: runNote.text });
  }
  return parts;
};
