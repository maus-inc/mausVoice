import type { Conversation } from "@maus-inc/types";
import {
  abortAgentLoop,
  CHAT_AGENT_CONFIG,
  retireAgentLoop,
  runAgent,
} from "../agents";
import { getChatMessageRepo, getConversationRepo } from "../repos";
import { getAppState, produceAppState, useAppStore } from "../store";
import {
  registerChatMessages,
  registerConversations,
} from "../utils/app.utils";
import { nextConversationTitle } from "../utils/chat.utils";
import { nowIso } from "../utils/date.utils";
import { getIsDevMode } from "../utils/env.utils";
import { getLogger } from "../utils/log.utils";
import { captureUserSession } from "../utils/user-session.utils";
import { createChatMessage, deleteChatMessages } from "./chat-message.actions";

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
const messageLoads = new Map<string, { unsubscribe: () => void }>();
const conversationDeletePromises = new Map<string, Promise<void>>();
let activeConversationRead: {
  touched: Set<string>;
  unsubscribe: () => void;
} | null = null;

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
  persist: () => Promise<boolean>,
): Promise<void> => {
  if (
    resendingConversationIds.has(conversationId) ||
    isAgentRunning(conversationId)
  )
    return;
  resendingConversationIds.add(conversationId);
  try {
    const persisted = await enqueueConversationWrite(conversationId, () => {
      if (
        !getAppState().conversationById[conversationId] ||
        deletingConversationIds.has(conversationId) ||
        isAgentRunning(conversationId)
      ) {
        return Promise.resolve(false);
      }
      return persist();
    });
    if (persisted) await runAgentForConversation(conversationId);
  } finally {
    resendingConversationIds.delete(conversationId);
  }
};

/** Replace the trailing assistant attempt with a fresh run for the last user. */
export const retryAssistant = (conversationId: string): Promise<void> =>
  resendConversation(conversationId, async () => {
    const state = getAppState();
    const ids = state.chatMessageIdsByConversationId[conversationId] ?? [];
    let lastUser = -1;
    for (let i = 0; i < ids.length; i += 1) {
      if (state.chatMessageById[ids[i]]?.role === "user") lastUser = i;
    }
    if (lastUser === -1) return false;
    const drop = ids.slice(lastUser + 1);
    if (drop.length > 0) await deleteChatMessages(conversationId, drop);
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
): Promise<boolean> => {
  const state = getAppState();
  const ids = state.chatMessageIdsByConversationId[conversationId] ?? [];
  const index = ids.indexOf(messageId);
  if (index === -1 || state.chatMessageById[messageId]?.role !== "user")
    return false;

  // Save the replacement before removing any history. A crash between these
  // writes can leave an extra draft, but cannot discard the original thread.
  const replacement = await createChatMessage({
    id: crypto.randomUUID(),
    conversationId,
    role: "user",
    content: text,
    createdAt: nowIso(),
    metadata: null,
  });
  try {
    await deleteChatMessages(conversationId, ids.slice(index));
  } catch (error) {
    try {
      await deleteChatMessages(conversationId, [replacement.id]);
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
    )
  ) {
    bumpConversationToTop(conversationId);
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
  await resendConversation(conversationId, () =>
    persistEditedMessage(conversationId, messageId, text),
  );
};

export const loadConversations = async (): Promise<void> => {
  activeConversationRead?.unsubscribe();
  const read = { touched: new Set<string>(), unsubscribe: () => {} };
  activeConversationRead = read;
  read.unsubscribe = useAppStore.subscribe((current, previous) => {
    const before = previous.chat.conversationIds;
    const after = current.chat.conversationIds;
    if (
      before === after &&
      previous.conversationById === current.conversationById
    )
      return;
    const oldPositions = new Map(before.map((id, index) => [id, index]));
    const newPositions = new Map(after.map((id, index) => [id, index]));
    for (const id of new Set([...before, ...after])) {
      if (
        oldPositions.get(id) !== newPositions.get(id) ||
        previous.conversationById[id] !== current.conversationById[id]
      )
        read.touched.add(id);
    }
  });
  produceAppState((draft) => {
    draft.chat.status = "loading";
  });

  try {
    const conversations = await getConversationRepo().listConversations();
    if (activeConversationRead !== read) return;
    const state = getAppState();
    const currentIds = new Set(state.chat.conversationIds);
    const merged = new Map(
      conversations.map((conversation) => [conversation.id, conversation]),
    );
    for (const id of read.touched) {
      const current = state.conversationById[id];
      if (currentIds.has(id) && current) merged.set(id, current);
      else merged.delete(id);
    }
    const ids = [
      ...state.chat.conversationIds.filter(
        (id) => read.touched.has(id) && merged.has(id),
      ),
      ...conversations
        .map((conversation) => conversation.id)
        .filter((id) => !read.touched.has(id) && merged.has(id)),
    ];
    produceAppState((draft) => {
      registerConversations(draft, [...merged.values()]);
      draft.chat.conversationIds = ids;
      draft.chat.status = "success";
    });
  } catch (error) {
    if (activeConversationRead === read) {
      getLogger().error("Failed to load conversations", error);
      produceAppState((draft) => {
        draft.chat.status = "error";
      });
    }
    throw error;
  } finally {
    read.unsubscribe();
    if (activeConversationRead === read) activeConversationRead = null;
  }
};

export const createConversation = async (
  conversation: Conversation,
): Promise<Conversation> => {
  const saved = await getConversationRepo().createConversation(conversation);

  produceAppState((draft) => {
    registerConversations(draft, [saved]);
    draft.chat.conversationIds = [
      saved.id,
      ...draft.chat.conversationIds.filter((id) => id !== saved.id),
    ];
  });

  return saved;
};

const updateConversation = async (
  conversation: Conversation,
  isCurrent: () => boolean = () => true,
): Promise<Conversation> => {
  const saved = await getConversationRepo().updateConversation(conversation);

  if (isCurrent())
    produceAppState((draft) => {
      if (isCurrent()) registerConversations(draft, [saved]);
    });

  return saved;
};

export const deleteConversation = (id: string): Promise<void> => {
  const pending = conversationDeletePromises.get(id);
  if (pending) return pending;
  deletingConversationIds.add(id);
  messageLoads.get(id)?.unsubscribe();
  messageLoads.delete(id);
  const operation = Promise.resolve().then(() => deleteConversationOwned(id));
  conversationDeletePromises.set(id, operation);
  const retire = () => {
    if (conversationDeletePromises.get(id) === operation)
      conversationDeletePromises.delete(id);
  };
  void operation.then(retire, retire);
  return operation;
};

const deleteConversationOwned = async (id: string): Promise<void> => {
  try {
    // Agent runs are outside the send queue and must be retired separately.
    retireAgentLoop(id);
    // Wait for the in-flight send so its updateConversation cannot
    // fire after the repo delete. The queue's own rejection is
    // swallowed so an unrelated send failure does not block the
    // user-initiated delete. The queue entry is cleared after the
    // await so a new send that arrives between this point and the
    // repo delete still sees deletingConversationIds and bails in
    // persistSend.
    const previous = sendQueuesByConversationId.get(id) ?? Promise.resolve();
    await previous.catch(() => undefined);
    if (sendQueuesByConversationId.get(id) === previous)
      sendQueuesByConversationId.delete(id);

    await getConversationRepo().deleteConversation(id);
    activeConversationRead?.touched.add(id);
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
        delete draft.streamingMessageById[messageId];
      }
      delete draft.chatMessageIdsByConversationId[id]; // skipcq: JS-0320
      for (const [permissionId, permission] of Object.entries(
        draft.toolPermissionById,
      )) {
        if (permission.conversationId === id)
          delete draft.toolPermissionById[permissionId];
      }
    });
  } finally {
    deletingConversationIds.delete(id);
  }
};

/**
 * Track message ids whose stored value changed while the listing was in flight,
 * so a local edit or an in-flight stream is not replaced by the stale read.
 */
const watchTouchedMessages = (
  conversationId: string,
  touched: Set<string>,
): (() => void) =>
  useAppStore.subscribe((current, previous) => {
    const before =
      previous.chatMessageIdsByConversationId[conversationId] ?? [];
    const after = current.chatMessageIdsByConversationId[conversationId] ?? [];
    if (
      before === after &&
      current.chatMessageById === previous.chatMessageById
    )
      return;
    const beforeIds = new Set(before);
    const afterIds = new Set(after);
    for (const id of new Set([...before, ...after])) {
      if (
        beforeIds.has(id) !== afterIds.has(id) ||
        previous.chatMessageById[id] !== current.chatMessageById[id]
      )
        touched.add(id);
    }
  });

type StoredChatMessage = ReturnType<
  typeof getAppState
>["chatMessageById"][string];

/** Merge a listing with the local state the reader changed while it loaded. */
const mergeChatMessages = (
  messages: StoredChatMessage[],
  touched: Set<string>,
  state: ReturnType<typeof getAppState>,
  conversationId: string,
): Map<string, StoredChatMessage> => {
  const ids = state.chatMessageIdsByConversationId[conversationId] ?? [];
  const currentIds = new Set(ids);
  const merged = new Map(
    messages.map((message) => [message.id, message] as const),
  );
  for (const id of touched) {
    const current = state.chatMessageById[id];
    if (currentIds.has(id) && current) merged.set(id, current);
    else merged.delete(id);
  }
  for (const id of ids) {
    const current = state.chatMessageById[id];
    if (current && state.streamingMessageById[id]?.isStreaming)
      merged.set(id, current);
  }
  return merged;
};

export const loadChatMessages = async (
  conversationId: string,
): Promise<void> => {
  if (deletingConversationIds.has(conversationId)) return;
  messageLoads.get(conversationId)?.unsubscribe();
  const read = { unsubscribe: () => {} };
  messageLoads.set(conversationId, read);
  const hadConversation = Boolean(
    getAppState().conversationById[conversationId],
  );
  const touched = new Set<string>();
  read.unsubscribe = watchTouchedMessages(conversationId, touched);

  try {
    const messages =
      await getChatMessageRepo().listChatMessages(conversationId);
    if (
      messageLoads.get(conversationId) !== read ||
      deletingConversationIds.has(conversationId)
    )
      return;
    const state = getAppState();
    if (hadConversation && !state.conversationById[conversationId]) return;
    const merged = mergeChatMessages(messages, touched, state, conversationId);
    produceAppState((draft) => {
      registerChatMessages(draft, conversationId, [...merged.values()]);
    });
  } finally {
    read.unsubscribe();
    if (messageLoads.get(conversationId) === read)
      messageLoads.delete(conversationId);
  }
};

const runAgentForConversation = async (
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
  isCurrent: () => boolean = () => true,
): Promise<boolean> => {
  if (!isCurrent()) return false;
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
    if (!isCurrent()) return false;
    await updateConversation(
      { ...conversation, title, updatedAt: createdAt },
      isCurrent,
    );
    return isCurrent();
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
  } catch {
    getLogger().error(
      `Failed to read persisted message count for conversation ${conversationId}`,
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

/**
 * The conversation may have been deleted while this send waited in the queue,
 * so both the queue entry and the post-probe check need the same answer.
 */
const sendTargetIsLive = (
  conversationId: string,
  isCurrent: () => boolean,
): boolean =>
  isCurrent() &&
  !deletingConversationIds.has(conversationId) &&
  Boolean(getAppState().conversationById[conversationId]);

const persistSend = async (
  conversationId: string,
  text: string,
  isCurrent: () => boolean,
): Promise<boolean> => {
  // The conversation may have been deleted between the time the user
  // pressed send and the time this entry reached the front of the queue.
  // Bail out before createChatMessage so we do not persist a message or
  // run the agent against a conversation that is about to disappear.
  if (!sendTargetIsLive(conversationId, isCurrent)) return false;
  // The in-memory message list can be empty even for a conversation
  // that already has messages persisted when a send races with
  // loadChatMessages. The probe only runs in that window and
  // defaults to not-first on failure.
  const isFirstMessage = await computeIsFirstMessage(conversationId);
  if (!sendTargetIsLive(conversationId, isCurrent)) return false;

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
    isCurrent,
  );
  if (!isCurrent()) return false;

  const updated = await applySendToConversation(
    conversationId,
    text,
    isFirstMessage,
    createdAt,
    isCurrent,
  );
  if (!isCurrent()) return false;

  // Only move the conversation to the top of the local sidebar order
  // when the repo update succeeded. A failed update keeps the old
  // order so a reload restores a consistent view, and the next send
  // retries the bump.
  if (updated) bumpConversationToTop(conversationId);
  return true;
};

export const sendChatMessage = async (
  conversationId: string,
  text: string,
  /** Called after the draft is durable, before the potentially long agent run. */
  onPersisted?: () => void,
  ownsSend: () => boolean = () => true,
): Promise<void> => {
  const sessionIsCurrent = captureUserSession();
  const isCurrent = () => sessionIsCurrent() && ownsSend();
  if (!isCurrent()) return;
  const persisted = await enqueueConversationWrite(conversationId, async () => {
    try {
      return await persistSend(conversationId, text, isCurrent);
    } catch (error) {
      if (!isCurrent()) return false;
      getLogger().error(
        `Failed to persist chat message for conversation ${conversationId}`,
      );
      throw error;
    }
  });
  if (!persisted || !isCurrent()) return;
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
    !isCurrent() ||
    !getAppState().conversationById[conversationId] ||
    deletingConversationIds.has(conversationId)
  ) {
    return;
  }
  await runAgentForConversation(conversationId);
};
