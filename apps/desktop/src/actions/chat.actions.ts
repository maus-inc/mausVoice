import type { ChatMessage, Conversation } from "@maus-inc/types";
import { abortAgentLoop, CHAT_AGENT_CONFIG, runAgent } from "../agents";
import { getChatMessageRepo, getConversationRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import {
  registerChatMessages,
  registerConversations,
} from "../utils/app.utils";
import { nextConversationTitle } from "../utils/chat.utils";
import { nowIso } from "../utils/date.utils";

const sendQueuesByConversationId = new Map<string, Promise<void>>();

// Conversations whose delete is in progress. persistSend and
// runAgentForConversation both check this set so a send initiated
// between deleteConversation starting and the in-memory store being
// cleared is rejected before it can persist a message or make an LLM
// call against a conversation that is about to disappear.
const deletingConversationIds = new Set<string>();

export const loadConversations = async (): Promise<void> => {
  produceAppState((draft) => {
    draft.chat.status = "loading";
  });

  try {
    const conversations = await getConversationRepo().listConversations();
    produceAppState((draft) => {
      registerConversations(draft, conversations);
      draft.chat.conversationIds = conversations.map((c) => c.id);
      draft.chat.status = "success";
    });
  } catch (error) {
    console.error("Failed to load conversations", error);
    produceAppState((draft) => {
      draft.chat.status = "error";
    });
    throw error;
  }
};

export const createConversation = async (
  conversation: Conversation,
): Promise<Conversation> => {
  const saved = await getConversationRepo().createConversation(conversation);

  produceAppState((draft) => {
    registerConversations(draft, [saved]);
    draft.chat.conversationIds.unshift(saved.id);
  });

  return saved;
};

export const updateConversation = async (
  conversation: Conversation,
): Promise<Conversation> => {
  const saved = await getConversationRepo().updateConversation(conversation);

  produceAppState((draft) => {
    registerConversations(draft, [saved]);
  });

  return saved;
};

export const deleteConversation = async (id: string): Promise<void> => {
  // Mark the conversation as deleting before the await so a send
  // initiated during the delete window is rejected by persistSend.
  // The flag stays set until the in-memory store is cleared, so a
  // send that races with produceAppState below still bails.
  deletingConversationIds.add(id);
  try {
    // Wait for the in-flight send so its updateConversation cannot
    // fire after the repo delete. The queue's own rejection is
    // swallowed so an unrelated send failure does not block the
    // user-initiated delete. The queue entry is cleared after the
    // await so a new send that arrives between this point and the
    // repo delete still sees deletingConversationIds and bails in
    // persistSend.
    const previous = sendQueuesByConversationId.get(id) ?? Promise.resolve();
    await previous.catch(() => undefined);
    sendQueuesByConversationId.delete(id);

    await getConversationRepo().deleteConversation(id);
  } catch (error) {
    // The repo delete failed. Leave the in-memory store intact so the
    // conversation remains visible and the user can retry. Re-throw
    // after clearing the flag below.
    deletingConversationIds.delete(id);
    throw error;
  }

  // Clear the in-memory store and the flag together. A send that
  // races with produceAppState would otherwise find the
  // conversation removed from the store while deletingConversationIds
  // is already cleared, and would re-add it to the sidebar.
  try {
    produceAppState((draft) => {
      // delete is the idiomatic Immer draft operation and matches
      // the rest of the codebase. DeepSource JS-0323 flags the
      // dynamic key, but the pattern is intentional here.
      delete draft.conversationById[id]; // deepsource ignore JS-0323
      draft.chat.conversationIds = draft.chat.conversationIds.filter(
        (cid) => cid !== id,
      );

      const messageIds = draft.chatMessageIdsByConversationId[id] ?? [];
      for (const messageId of messageIds) {
        delete draft.chatMessageById[messageId]; // deepsource ignore JS-0323
      }
      delete draft.chatMessageIdsByConversationId[id]; // deepsource ignore JS-0323
    });
  } finally {
    deletingConversationIds.delete(id);
  }
};

export const loadChatMessages = async (
  conversationId: string,
): Promise<void> => {
  const messages = await getChatMessageRepo().listChatMessages(conversationId);

  produceAppState((draft) => {
    registerChatMessages(draft, conversationId, messages);
  });
};

export const createChatMessage = async (
  message: ChatMessage,
): Promise<ChatMessage> => {
  const saved = await getChatMessageRepo().createChatMessage(message);

  produceAppState((draft) => {
    draft.chatMessageById[saved.id] = saved;
    const ids =
      draft.chatMessageIdsByConversationId[saved.conversationId] ?? [];
    ids.push(saved.id);
    draft.chatMessageIdsByConversationId[saved.conversationId] = ids;
  });

  return saved;
};

export const updateChatMessage = async (
  message: ChatMessage,
): Promise<ChatMessage> => {
  const saved = await getChatMessageRepo().updateChatMessage(message);

  produceAppState((draft) => {
    draft.chatMessageById[saved.id] = saved;
  });

  return saved;
};

export const deleteChatMessages = async (
  conversationId: string,
  ids: string[],
): Promise<void> => {
  await getChatMessageRepo().deleteChatMessages(ids);

  produceAppState((draft) => {
    for (const id of ids) {
      delete draft.chatMessageById[id];
    }
    const existing = draft.chatMessageIdsByConversationId[conversationId] ?? [];
    const idSet = new Set(ids);
    draft.chatMessageIdsByConversationId[conversationId] = existing.filter(
      (mid) => !idSet.has(mid),
    );
  });
};

export const runAgentForConversation = async (
  conversationId: string,
): Promise<void> => {
  // Defense in depth: persistSend and sendChatMessage both guard
  // against running the agent for a conversation that was deleted
  // while the send was in flight. This guard catches the remaining
  // race where the send completed before the delete started but the
  // delete finishes before runAgent is awaited.
  if (
    !getAppState().conversationById[conversationId] ||
    deletingConversationIds.has(conversationId)
  ) {
    return;
  }
  try {
    await runAgent(conversationId, CHAT_AGENT_CONFIG);
  } finally {
    produceAppState((draft) => {
      delete draft.agentStateByConversationId[conversationId];
    });
  }
};

const applySendToConversation = async (
  conversationId: string,
  text: string,
  isFirstMessage: boolean,
  createdAt: string,
): Promise<boolean> => {
  // Re-read right before the update, so the spread below cannot apply a
  // stale snapshot when the conversation changed while the message was
  // being persisted.
  const conversation = getAppState().conversationById[conversationId];
  if (!conversation) return false;

  const title = nextConversationTitle(text, conversation.title, isFirstMessage);
  // The message is already persisted, so a failed title or timestamp bump
  // must not abort the send or skip the agent. The next send retries both.
  // Returns whether the conversation update succeeded so the caller can
  // decide whether to bump the local recency order.
  try {
    await updateConversation({ ...conversation, title, updatedAt: createdAt });
    return true;
  } catch (error) {
    const dev =
      typeof process !== "undefined" && process.env.NODE_ENV !== "production";
    console.error(
      `Failed to update conversation ${conversationId} after a send`,
      dev ? { title, updatedAt: createdAt } : { updatedAt: createdAt },
      error,
    );
    return false;
  }
};

const persistSend = async (
  conversationId: string,
  text: string,
): Promise<void> => {
  // The conversation may have been deleted between the time the user
  // pressed send and the time this entry reached the front of the queue.
  // Bail out before createChatMessage so we do not persist a message or
  // run the agent against a conversation that is about to disappear.
  if (
    !getAppState().conversationById[conversationId] ||
    deletingConversationIds.has(conversationId)
  ) {
    return;
  }
  // The in-memory message list can be empty even for a conversation that
  // already has messages persisted when a send races with loadChatMessages.
  // Ask the repo for the persisted count so a stale empty in-memory list
  // cannot cause a non-first message to be treated as the first one and
  // overwrite a real title.
  const persistedCount = (
    await getChatMessageRepo().listChatMessages(conversationId)
  ).length;
  const isFirstMessage =
    (getAppState().chatMessageIdsByConversationId[conversationId] ?? [])
      .length === 0 && persistedCount === 0;

  // The timestamp comes from inside the serialized section, so queued sends
  // stay monotonic.
  const createdAt = nowIso();
  await createChatMessage({
    id: crypto.randomUUID(),
    conversationId,
    role: "user",
    content: text,
    createdAt,
    metadata: null,
  });

  const updated = await applySendToConversation(
    conversationId,
    text,
    isFirstMessage,
    createdAt,
  );

  // Only move the conversation to the top of the local sidebar order when
  // the repo update succeeded. A failed update keeps the old order so a
  // reload restores a consistent view, and the next send retries the bump.
  if (updated) {
    produceAppState((draft) => {
      draft.chat.conversationIds = [
        conversationId,
        ...draft.chat.conversationIds.filter((cid) => cid !== conversationId),
      ];
    });
  }
};

export const sendChatMessage = async (
  conversationId: string,
  text: string,
): Promise<void> => {
  // Concurrent sends into one conversation persist back to back, so an
  // older send cannot overwrite a newer send's timestamp or title. The
  // queue holds only in-flight sends, because each entry removes itself
  // once its persist settles. The agent run stays outside the queue, so a
  // running agent never blocks the next message. A failed message persist
  // skips the agent, because the message never reached storage. A failed
  // conversation update is caught and logged inside applySendToConversation
  // instead.
  const previous =
    sendQueuesByConversationId.get(conversationId) ?? Promise.resolve();
  // Track whether persistSend rejected so the agent is not invoked
  // when no message was actually persisted. The previous chain is
  // swallowed so an unrelated send failure does not abort this send.
  // The error is logged so storage failures stay visible, mirroring
  // the dev/prod gating in applySendToConversation so production logs
  // stay compact.
  let persistFailed = false;
  const persist = previous
    .catch(() => undefined)
    .then(() =>
      persistSend(conversationId, text).catch((error) => {
        persistFailed = true;
        const dev =
          typeof process !== "undefined" &&
          process.env.NODE_ENV !== "production";
        console.error(
          `Failed to persist chat message for conversation ${conversationId}`,
          dev ? { content: text } : undefined,
          error,
        );
      }),
    );
  sendQueuesByConversationId.set(conversationId, persist);
  persist
    .catch(() => undefined)
    .then(() => {
      if (sendQueuesByConversationId.get(conversationId) === persist) {
        sendQueuesByConversationId.delete(conversationId);
      }
    });

  await persist.catch(() => undefined);
  if (persistFailed) return;
  // Re-check the conversation state after persist settles. A delete
  // that started during the persist window may have cleared the
  // conversation, and the agent must not run against a deleted row.
  if (
    !getAppState().conversationById[conversationId] ||
    deletingConversationIds.has(conversationId)
  ) {
    return;
  }
  await runAgentForConversation(conversationId);
};

export const abortAgent = (conversationId: string): void => {
  abortAgentLoop(conversationId);
};
