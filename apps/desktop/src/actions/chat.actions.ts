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
import {
  type LocalDataWriteLease,
  withLocalDataWrite,
} from "../utils/local-data-write-gate";

const sendQueuesByConversationId = new Map<string, Promise<void>>();
// Retry and edit share a reservation because both replace conversation history.
// Agent status alone cannot guard the asynchronous persistence/preparation gap.
const resendingConversationIds = new Set<string>();

// Conversations whose delete is in progress. persistSend and
// runAgentForConversation both check this set so a send initiated
// between deleteConversation starting and the in-memory store being
// cleared is rejected before it can persist a message or make an LLM
// call against a conversation that is about to disappear.
const deletingConversationIds = new Set<string>();

const enqueueConversationWrite = <T>(
  conversationId: string,
  write: () => Promise<T>,
): Promise<T> => {
  const previous =
    sendQueuesByConversationId.get(conversationId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(write);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  sendQueuesByConversationId.set(conversationId, settled);
  void settled.then(() => {
    if (sendQueuesByConversationId.get(conversationId) === settled) {
      sendQueuesByConversationId.delete(conversationId);
    }
  });
  return result;
};

export const abortAgent = (conversationId: string): void => {
  abortAgentLoop(conversationId);
};

const isAgentRunning = (conversationId: string): boolean => {
  const status =
    getAppState().agentStateByConversationId[conversationId]?.status;
  return (
    status === "idle" ||
    status === "calling-llm" ||
    status === "processing-tools"
  );
};

const resendConversation = async (
  conversationId: string,
  persist: (lease: LocalDataWriteLease) => Promise<boolean>,
): Promise<void> => {
  if (
    resendingConversationIds.has(conversationId) ||
    isAgentRunning(conversationId)
  )
    return;
  resendingConversationIds.add(conversationId);
  try {
    const persisted = await enqueueConversationWrite(conversationId, () =>
      withLocalDataWrite(async (lease) => {
        if (
          !getAppState().conversationById[conversationId] ||
          deletingConversationIds.has(conversationId) ||
          isAgentRunning(conversationId)
        ) {
          return false;
        }
        return persist(lease);
      }),
    );
    if (persisted) await runAgentForConversation(conversationId);
  } finally {
    resendingConversationIds.delete(conversationId);
  }
};

/** Replace the trailing assistant attempt with a fresh run for the last user. */
export const retryAssistant = (conversationId: string): Promise<void> =>
  resendConversation(conversationId, async (lease) => {
    const state = getAppState();
    const ids = state.chatMessageIdsByConversationId[conversationId] ?? [];
    let lastUser = -1;
    for (let i = 0; i < ids.length; i += 1) {
      if (state.chatMessageById[ids[i]]?.role === "user") lastUser = i;
    }
    if (lastUser === -1) return false;
    const drop = ids.slice(lastUser + 1);
    if (drop.length > 0) await deleteChatMessages(conversationId, drop, lease);
    return true;
  });

/** True when messages after `messageId` hold tool activity the edit would drop. */
export const laterMessagesHaveToolActivity = (
  conversationId: string,
  messageId: string,
): boolean => {
  const state = getAppState();
  const ids = state.chatMessageIdsByConversationId[conversationId] ?? [];
  return ids.slice(ids.indexOf(messageId) + 1).some((id) => {
    const message = state.chatMessageById[id];
    if (message?.role !== "assistant") return false;
    const metadata = message.metadata as Record<string, unknown> | null;
    return (
      metadata?.type === "reasoning" &&
      Array.isArray(metadata.toolCalls) &&
      metadata.toolCalls.length > 0
    );
  });
};

/**
 * Replace a user message and everything after it with a fresh send. The
 * caller confirms first when laterMessagesHaveToolActivity is true.
 */
const persistEditedMessage = async (
  conversationId: string,
  messageId: string,
  text: string,
  lease: LocalDataWriteLease,
): Promise<boolean> => {
  const state = getAppState();
  const ids = state.chatMessageIdsByConversationId[conversationId] ?? [];
  const index = ids.indexOf(messageId);
  if (index === -1 || state.chatMessageById[messageId]?.role !== "user")
    return false;

  // Save the replacement before removing any history. A crash between these
  // writes can leave an extra draft, but cannot discard the original thread.
  const replacement = await createChatMessage(
    {
      id: crypto.randomUUID(),
      conversationId,
      role: "user",
      content: text,
      createdAt: nowIso(),
      metadata: null,
    },
    lease,
  );
  try {
    await deleteChatMessages(conversationId, ids.slice(index), lease);
  } catch (error) {
    try {
      await deleteChatMessages(conversationId, [replacement.id], lease);
    } catch (cleanupError) {
      // Keep the staged draft visible if its cleanup also fails.
      getLogger().error("Failed to remove staged chat edit", cleanupError);
    }
    throw error;
  }
  if (
    await applySendToConversation(
      conversationId,
      text,
      index === 0,
      replacement.createdAt,
      lease,
    )
  ) {
    bumpConversationToTop(conversationId, lease);
  }
  return true;
};

export const editAndResend = async (
  conversationId: string,
  messageId: string,
  newText: string,
): Promise<void> => {
  const text = newText.trim();
  if (!text) return;
  await resendConversation(conversationId, (lease) =>
    persistEditedMessage(conversationId, messageId, text, lease),
  );
};

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

export const createConversation = (
  conversation: Conversation,
  existingLease?: LocalDataWriteLease,
): Promise<Conversation> =>
  withLocalDataWrite(async (lease) => {
    const saved = await getConversationRepo().createConversation(
      conversation,
      lease,
    );

    produceAppState((draft) => {
      registerConversations(draft, [saved]);
      draft.chat.conversationIds.unshift(saved.id);
    }, lease);

    return saved;
  }, existingLease);

export const updateConversation = (
  conversation: Conversation,
  existingLease?: LocalDataWriteLease,
): Promise<Conversation> =>
  withLocalDataWrite(async (lease) => {
    const saved = await getConversationRepo().updateConversation(
      conversation,
      lease,
    );

    produceAppState((draft) => {
      registerConversations(draft, [saved]);
    }, lease);

    return saved;
  }, existingLease);

export const deleteConversation = async (id: string): Promise<void> => {
  deletingConversationIds.add(id);
  abortAgent(id);

  try {
    // Wait without holding a write lease. A queued send may still need one to
    // settle, so acquiring the lease before this wait would deadlock the queue.
    const previous = sendQueuesByConversationId.get(id) ?? Promise.resolve();
    await previous.catch(() => undefined);
    sendQueuesByConversationId.delete(id);

    await withLocalDataWrite(async (lease) => {
      await getConversationRepo().deleteConversation(id, lease);
      produceAppState((draft) => {
        // Immer draft deletion is intentional. DeepSource JS-0320 flags the
        // dynamic key, but this is type-safe and matches the repo pattern.
        delete draft.conversationById[id]; // skipcq: JS-0320
        draft.chat.conversationIds = draft.chat.conversationIds.filter(
          (conversationId) => conversationId !== id,
        );

        const messageIds = draft.chatMessageIdsByConversationId[id] ?? [];
        for (const messageId of messageIds) {
          delete draft.chatMessageById[messageId]; // skipcq: JS-0320
        }
        delete draft.chatMessageIdsByConversationId[id]; // skipcq: JS-0320
      }, lease);
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

export const createChatMessage = (
  message: ChatMessage,
  existingLease?: LocalDataWriteLease,
): Promise<ChatMessage> =>
  withLocalDataWrite(async (lease) => {
    const saved = await getChatMessageRepo().createChatMessage(message, lease);

    produceAppState((draft) => {
      draft.chatMessageById[saved.id] = saved;
      const ids =
        draft.chatMessageIdsByConversationId[saved.conversationId] ?? [];
      ids.push(saved.id);
      draft.chatMessageIdsByConversationId[saved.conversationId] = ids;
    }, lease);

    return saved;
  }, existingLease);

export const updateChatMessage = (
  message: ChatMessage,
  existingLease?: LocalDataWriteLease,
): Promise<ChatMessage> =>
  withLocalDataWrite(async (lease) => {
    const saved = await getChatMessageRepo().updateChatMessage(message, lease);

    produceAppState((draft) => {
      draft.chatMessageById[saved.id] = saved;
    }, lease);

    return saved;
  }, existingLease);

export const deleteChatMessages = (
  conversationId: string,
  ids: string[],
  existingLease?: LocalDataWriteLease,
): Promise<void> =>
  withLocalDataWrite(async (lease) => {
    await getChatMessageRepo().deleteChatMessages(ids, lease);

    produceAppState((draft) => {
      for (const id of ids) {
        delete draft.chatMessageById[id];
      }
      const existing =
        draft.chatMessageIdsByConversationId[conversationId] ?? [];
      const idSet = new Set(ids);
      draft.chatMessageIdsByConversationId[conversationId] = existing.filter(
        (messageId) => !idSet.has(messageId),
      );
    }, lease);
  }, existingLease);

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
  // runAgent owns the agent-state cleanup with an identity guard (it only
  // removes state only while it owns the loop registration). A superseded run finishing after
  // a newer run started must not delete the newer run's state, so no
  // cleanup is done here.
  await runAgent(conversationId, CHAT_AGENT_CONFIG);
};

const applySendToConversation = async (
  conversationId: string,
  text: string,
  isFirstMessage: boolean,
  createdAt: string,
  lease: LocalDataWriteLease,
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
    await updateConversation(
      { ...conversation, title, updatedAt: createdAt },
      lease,
    );
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
const bumpConversationToTop = (
  conversationId: string,
  lease: LocalDataWriteLease,
): void => {
  produceAppState((draft) => {
    draft.chat.conversationIds = [
      conversationId,
      ...draft.chat.conversationIds.filter((cid) => cid !== conversationId),
    ];
  }, lease);
};

const persistSend = async (
  conversationId: string,
  text: string,
  lease: LocalDataWriteLease,
): Promise<boolean> => {
  // The conversation may have been deleted between the time the user
  // pressed send and the time this entry reached the front of the queue.
  // Bail out before createChatMessage so we do not persist a message or
  // run the agent against a conversation that is about to disappear.
  if (
    !getAppState().conversationById[conversationId] ||
    deletingConversationIds.has(conversationId)
  ) {
    return false;
  }
  // The in-memory message list can be empty even for a conversation
  // that already has messages persisted when a send races with
  // loadChatMessages. The probe only runs in that window and
  // defaults to not-first on failure.
  const isFirstMessage = await computeIsFirstMessage(conversationId, text);

  // The timestamp comes from inside the serialized section, so queued sends
  // stay monotonic.
  const createdAt = nowIso();
  await createChatMessage(
    {
      id: crypto.randomUUID(),
      conversationId,
      role: "user",
      content: text,
      createdAt,
      metadata: null,
    },
    lease,
  );

  const updated = await applySendToConversation(
    conversationId,
    text,
    isFirstMessage,
    createdAt,
    lease,
  );

  // Only move the conversation to the top of the local sidebar order
  // when the repo update succeeded. A failed update keeps the old
  // order so a reload restores a consistent view, and the next send
  // retries the bump.
  if (updated) bumpConversationToTop(conversationId, lease);
  return true;
};

export const sendChatMessage = async (
  conversationId: string,
  text: string,
  /** Called after the draft is durable, before the potentially long agent run. */
  onPersisted?: () => void,
): Promise<void> => {
  const persisted = await enqueueConversationWrite(conversationId, () =>
    withLocalDataWrite(async (lease) => {
      try {
        return await persistSend(conversationId, text, lease);
      } catch (error) {
        const dev = getIsDevMode();
        getLogger().error(
          `Failed to persist chat message for conversation ${conversationId}`,
          ...(dev ? [{ contentPreview: text.slice(0, 50) }] : []),
          error,
        );
        throw error;
      }
    }),
  );
  if (!persisted) return;
  try {
    onPersisted?.();
  } catch (error) {
    // A UI notification failure must not make a durable send look unsaved.
    getLogger().error("Failed to notify chat-message persistence", error);
  }
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
