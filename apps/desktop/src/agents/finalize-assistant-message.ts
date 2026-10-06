import type { ChatMessage } from "@maus-inc/types";
import type { ChatToolStatus, LlmToolCall } from "@maus-inc/types";
import { getChatMessageRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import type { PersistedRunOutcome } from "../utils/chat-parts.utils";
import { humanizeScrub } from "../utils/humanize.utils";

/**
 * Persist the finished assistant message with scrubbed content and
 * retire its streaming entry, regardless of persistence outcome.
 *
 * Shared by the tool-calling run and the computer-use run. Both write the same
 * shape of message, and two copies of this function drifted the moment one of
 * them learned a new terminal flag.
 *
 * A19: Apply the humanize scrubber to remove AI-slop markers from the
 * final assistant output before persisting and displaying it.
 *
 * `isActive` guards every await. A superseded run finishing after a newer run
 * started must not overwrite the newer message, must not resurrect a deleted
 * conversation, and must not leave its own streaming entry behind. The caller
 * passes its identity check; a late write is dropped rather than repaired.
 */
export async function finalizeAssistantMessage(
  messageId: string,
  text: string,
  toolCalls: LlmToolCall[],
  toolStatuses: Record<string, ChatToolStatus>,
  runOutcome?: PersistedRunOutcome,
  isActive?: () => boolean,
): Promise<void> {
  if (isActive && !isActive()) return;
  const message: ChatMessage | undefined =
    getAppState().chatMessageById[messageId];
  if (!message) return;
  if (isActive && !isActive()) return;

  const cleaned = text ? humanizeScrub(text) : "";
  const metadata =
    toolCalls.length > 0
      ? { type: "reasoning", toolCalls, toolStatuses }
      : null;
  const final = {
    ...message,
    content: cleaned,
    // Terminal flags survive run-state cleanup/reload without saving raw
    // provider diagnostics or freezing a translated label into history.
    metadata: runOutcome ? { ...metadata, runOutcome } : metadata,
  };

  // Retire the streaming entry regardless of the persistence outcome.
  // safeSideEffect swallows rejections from the caller so the agent
  // loop survives (the whole point of the wrapper); without this finally,
  // a failed createChatMessage would leave the message stuck in
  // streamingMessageById forever as an indefinitely-streaming bubble.
  // On failure the in-memory copy still gets the scrubbed final text so
  // the conversation view stays coherent for the session; only the
  // durable history row is missing, and that is what the log records.
  try {
    if (!isActive || isActive()) {
      await getChatMessageRepo().createChatMessage(final);
      if (isActive && !isActive()) {
        await getChatMessageRepo()
          .deleteChatMessages([final.id])
          .catch(() => undefined);
      }
    }
  } finally {
    produceAppState((draft) => {
      // A deleted conversation/message must not be resurrected by a late write.
      if (!isActive || isActive()) {
        if (draft.chatMessageById[messageId])
          draft.chatMessageById[messageId] = final;
      }
      delete draft.streamingMessageById[messageId];
    });
  }
}
