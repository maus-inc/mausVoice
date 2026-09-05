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
import { getIsDevMode } from "../utils/env.utils";
import { getLogger } from "../utils/log.utils";

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
    getLogger().error("Failed to load conversations", error);
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
      // the rest of the codebase. DeepSource JS-0320 flags the dynamic
      // key, but the deletion is intentional and type-safe here.
      delete draft.conversationById[id]; // skipcq: JS-0320
      draft.chat.conversationIds = draft.chat.conversationIds.filter(
        (cid) => cid !== id,
      );

      const messageIds = draft.chatMessageIdsByConversationId[id] ?? [];
      for (const messageId of messageIds) {
        delete draft.chatMessageById[messageId]; // skipcq: JS-0320
      }
      delete draft.chatMessageIdsByConversationId[id]; // skipcq: JS-0320
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
    const dev = getIsDevMode();
    // The title holds the user's own text, so it is only attached in dev
    // mode; the timestamp is harmless and always useful for correlation.
    getLogger().error(
      `Failed to update conversation ${conversationId} after a send`,
      { updatedAt: createdAt, ...(dev ? { title } : {}) },
      error,
    );
    return false;
  }
};

// True when the conversation has no messages in memory and the
// persisted count is confirmed to be zero. A failed persisted read
// returns false (not-first) so a transient error does not risk
// overwriting a real title.
const computeIsFirstMessage = async (
  conversationId: string,
  text: string,
): Promise<boolean> => {
  const inMemoryCount = (
    getAppState().chatMessageIdsByConversationId[conversationId] ?? []
  ).length;
  if (inMemoryCount > 0) return false;
  // The probe only runs when the in-memory list is empty, because
  // a non-empty list already proves the message is not the first.
  // A failed read defaults to false (not-first) so a transient
  // error never overwrites a real title.
  try {
    return (
      (await getChatMessageRepo().listChatMessages(conversationId)).length === 0
    );
  } catch (error) {
    const dev = getIsDevMode();
    getLogger().error(
      `Failed to read persisted message count for conversation ${conversationId}`,
      ...(dev ? [{ contentPreview: text.slice(0, 50) }] : []),
      error,
    );
    return false;
  }
};

// Moves the conversation to the top of the local sidebar order.
const bumpConversationToTop = (conversationId: string) => {
  produceAppState((draft) => {
    draft.chat.conversationIds = [
      conversationId,
      ...draft.chat.conversationIds.filter((cid) => cid !== conversationId),
    ];
  });
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
  // The in-memory message list can be empty even for a conversation
  // that already has messages persisted when a send races with
  // loadChatMessages. The probe only runs in that window and
  // defaults to not-first on failure.
  const isFirstMessage = await computeIsFirstMessage(conversationId, text);

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

  // Only move the conversation to the top of the local sidebar order
  // when the repo update succeeded. A failed update keeps the old
  // order so a reload restores a consistent view, and the next send
  // retries the bump.
  if (!updated) return;
  bumpConversationToTop(conversationId);
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
  // rejects the send and skips the agent, because the message never
  // reached storage. A failed conversation update is caught and logged
  // inside applySendToConversation instead.
  const previous =
    sendQueuesByConversationId.get(conversationId) ?? Promise.resolve();
  // The error is captured so it can be re-thrown to the caller after
  // the queue cleanup runs. The previous chain is swallowed so an
  // unrelated send failure does not abort this send.
  let persistError: unknown;
  let persistFailed = false;
  const persist = previous
    .catch(() => undefined)
    .then(() =>
      persistSend(conversationId, text).catch((error) => {
        persistFailed = true;
        persistError = error;
        const dev = getIsDevMode();
        getLogger().error(
          `Failed to persist chat message for conversation ${conversationId}`,
          ...(dev ? [{ contentPreview: text.slice(0, 50) }] : []),
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
  if (persistFailed) throw persistError;
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
