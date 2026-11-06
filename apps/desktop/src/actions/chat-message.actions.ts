import type { ChatMessage } from "@maus-inc/types";
import { getChatMessageRepo } from "../repos/chat-message.repo";
import { getAppState, produceAppState } from "../store";

export const createChatMessage = async (
  message: ChatMessage,
  isCurrent: () => boolean = () => true,
): Promise<ChatMessage> => {
  const conversation = getAppState().conversationById?.[message.conversationId];
  const saved = await getChatMessageRepo().createChatMessage(message);

  if (!isCurrent()) return saved;
  produceAppState((draft) => {
    if (
      !isCurrent() ||
      (conversation &&
        draft.conversationById[saved.conversationId]?.createdAt !==
          conversation.createdAt)
    )
      return;
    draft.chatMessageById[saved.id] = saved;
    const ids =
      draft.chatMessageIdsByConversationId[saved.conversationId] ?? [];
    if (!ids.includes(saved.id)) ids.push(saved.id);
    draft.chatMessageIdsByConversationId[saved.conversationId] = ids;
  });

  return saved;
};

export const updateChatMessage = async (
  message: ChatMessage,
): Promise<ChatMessage> => {
  const state = getAppState();
  const conversation = state.conversationById?.[message.conversationId];
  const existed = Boolean(state.chatMessageById[message.id]);
  const saved = await getChatMessageRepo().updateChatMessage(message);

  produceAppState((draft) => {
    if (
      (conversation &&
        draft.conversationById[saved.conversationId]?.createdAt !==
          conversation.createdAt) ||
      (existed && !draft.chatMessageById[saved.id])
    )
      return;
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
    const existing = draft.chatMessageIdsByConversationId[conversationId];
    if (existing) {
      const idSet = new Set(ids);
      draft.chatMessageIdsByConversationId[conversationId] = existing.filter(
        (mid) => !idSet.has(mid),
      );
    }
  });
};
