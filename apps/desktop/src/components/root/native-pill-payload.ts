import type { ChatMessage, ToolPermission } from "@maus-inc/types";
import type { IntlShape } from "react-intl";
import type { AppState } from "../../state/app.state";
import { markdownToPillText } from "../../utils/assistant-pill-text.utils";

export type NativePillPayload = {
  type: "assistant_state";
  active: boolean;
  input_mode: string;
  compact: boolean;
  conversation_id: string | null;
  user_prompt: string | null;
  messages: {
    id: string;
    content: string | null;
    is_error: boolean;
    is_tool_result: boolean;
    tool_name: string | null;
    tool_description: string | null;
    reason: string | null;
  }[];
  streaming: {
    message_id: string;
    tool_calls: { id: string; name: string; done: boolean }[];
    reasoning: string;
    is_streaming: boolean;
  } | null;
  permissions: {
    id: string;
    tool_name: string;
    description: string | null;
    reason: string | null;
  }[];
  /** Transcript awaiting a review decision on the pill, if any. */
  review: {
    id: string;
    text: string;
    /** Localized captions for every control the pill draws for this review. */
    edit_label: string;
    insert_label: string;
    copy_label: string;
    cancel_label: string;
    hint: string;
  } | null;
};

const formatPromptPreview = (text: string): string | null => {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  const words = normalized.split(" ");
  if (words.length <= 9) return normalized;
  return `${words.slice(0, 4).join(" ")} ... ${words.slice(-5).join(" ")}`;
};

/** Resolve the tool-related fields shared with native assistant messages. */
const pillToolMetadata = (
  metadata: ChatMessage["metadata"],
  toolInfoById: Record<string, { description: string }>,
) => {
  const toolName = (metadata?.toolName as string) ?? null;
  return {
    is_tool_result: metadata?.type === "tool-result",
    tool_name: toolName,
    tool_description: toolName
      ? (toolInfoById[toolName]?.description ?? null)
      : null,
    reason: (metadata?.reason as string) ?? null,
  };
};

const buildNativePillMessages = (
  messages: ChatMessage[],
  streamingById: AppState["streamingMessageById"],
  toolInfoById: Record<string, { description: string }>,
): NativePillPayload["messages"] => {
  return messages
    .filter((m) => {
      if (m.role === "user") return false;
      if (m.role === "assistant" && !m.content?.trim()) {
        return !!streamingById[m.id];
      }
      return true;
    })
    .map((m) => {
      // A04: Strip markdown from assistant messages so the native pill
      // (which has no markdown renderer) shows clean plain text.
      const rawContent = m.content || null;
      const cleanedContent =
        m.role === "assistant" && rawContent
          ? markdownToPillText(rawContent, { maxLength: 600 })
          : rawContent;
      return {
        id: m.id,
        content: cleanedContent,
        is_error: m.role === "system",
        ...pillToolMetadata(m.metadata, toolInfoById),
      };
    });
};

const buildNativePillStreaming = (
  messages: ChatMessage[],
  streamingById: AppState["streamingMessageById"],
): NativePillPayload["streaming"] => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const streaming = streamingById[msg.id];
    if (streaming) {
      return {
        message_id: msg.id,
        tool_calls: streaming.toolCalls.map((tc) => ({
          id: tc.toolCallId,
          name: tc.toolName,
          done: tc.done,
        })),
        reasoning: streaming.reasoning,
        is_streaming: streaming.isStreaming,
      };
    }
  }
  return null;
};

const buildNativePillPermissions = (
  permissions: Record<string, ToolPermission>,
  conversationId: string | null,
  toolInfoById: Record<string, { description: string }>,
): NativePillPayload["permissions"] => {
  if (!conversationId) return [];
  return Object.values(permissions)
    .filter(
      (p) => p.conversationId === conversationId && p.status === "pending",
    )
    .map((p) => ({
      id: p.id,
      tool_name: p.toolId,
      description: toolInfoById[p.toolId]?.description ?? null,
      reason: null,
    }));
};

export type NativePillSyncState = {
  activeRecordingMode: AppState["activeRecordingMode"];
  pendingPillReview: AppState["pendingPillReview"];
  assistantInputMode: AppState["assistantInputMode"];
  pillConversationId: AppState["pillConversationId"];
  chatMessageById: AppState["chatMessageById"];
  chatMessageIdsByConversationId: AppState["chatMessageIdsByConversationId"];
  toolPermissionById: AppState["toolPermissionById"];
  toolInfoById: AppState["toolInfoById"];
  streamingMessageById: AppState["streamingMessageById"];
};

export const selectNativePillState = (s: AppState): NativePillSyncState => ({
  activeRecordingMode: s.activeRecordingMode,
  pendingPillReview: s.pendingPillReview,
  assistantInputMode: s.assistantInputMode,
  pillConversationId: s.pillConversationId,
  chatMessageById: s.chatMessageById,
  chatMessageIdsByConversationId: s.chatMessageIdsByConversationId,
  toolPermissionById: s.toolPermissionById,
  toolInfoById: s.toolInfoById,
  streamingMessageById: s.streamingMessageById,
});

/** Build the complete native snapshot before crossing the IPC boundary. */
export const buildNativePillPayload = (
  state: NativePillSyncState,
  intl: IntlShape,
): NativePillPayload => {
  const review = state.pendingPillReview;
  const active = state.activeRecordingMode === "agent";

  const conversationId = state.pillConversationId ?? null;
  const messageIds = conversationId
    ? (state.chatMessageIdsByConversationId[conversationId] ?? [])
    : [];
  const messages: ChatMessage[] = messageIds
    .map((id) => state.chatMessageById[id])
    .filter((m): m is ChatMessage => !!m);

  const pillMessages = buildNativePillMessages(
    messages,
    state.streamingMessageById,
    state.toolInfoById,
  );
  const streaming = buildNativePillStreaming(
    messages,
    state.streamingMessageById,
  );
  const permissions = buildNativePillPermissions(
    state.toolPermissionById,
    conversationId,
    state.toolInfoById,
  );

  const latestUserMessage = messages
    .slice()
    .reverse()
    .find((m) => m.role === "user");
  const userPrompt = latestUserMessage?.content
    ? formatPromptPreview(latestUserMessage.content)
    : null;

  const compact =
    state.assistantInputMode !== "type" &&
    messages.length === 0 &&
    permissions.length === 0 &&
    review === null;

  return {
    type: "assistant_state",
    active,
    input_mode: state.assistantInputMode ?? "voice",
    compact,
    conversation_id: conversationId,
    user_prompt: userPrompt,
    messages: pillMessages,
    streaming,
    permissions,
    review: review
      ? {
          ...review,
          // The pill draws these captions itself, so every one of them has to
          // cross the bridge. Shipping them as literals left a German user
          // reading "Insert" and "Cancel" on the one surface that asks them
          // to accept or reject their own dictation.
          edit_label: intl.formatMessage({
            id: "edit",
            defaultMessage: "Edit",
          }),
          insert_label: intl.formatMessage({ defaultMessage: "Insert" }),
          copy_label: intl.formatMessage({ defaultMessage: "Copy" }),
          cancel_label: intl.formatMessage({ defaultMessage: "Cancel" }),
          hint: intl.formatMessage({
            defaultMessage: "Edit below, then press Enter to insert",
          }),
        }
      : null,
  };
};
