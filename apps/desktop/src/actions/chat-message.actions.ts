import type { ChatMessage } from "@maus-inc/types";
import { produceAppState } from "../store";
import type { BaseChatMessageRepo } from "../repos/chat-message.repo";
import {
  type LocalDataWriteLease,
  withLocalDataWrite,
} from "../utils/local-data-write-gate";

export const createChatMessageWithRepo = (
  repo: BaseChatMessageRepo,
  message: ChatMessage,
  existingLease?: LocalDataWriteLease,
): Promise<ChatMessage> =>
  withLocalDataWrite(async (lease) => {
    const saved = await repo.createChatMessage(message, lease);

    produceAppState((draft) => {
      draft.chatMessageById[saved.id] = saved;
      const ids =
        draft.chatMessageIdsByConversationId[saved.conversationId] ?? [];
      ids.push(saved.id);
      draft.chatMessageIdsByConversationId[saved.conversationId] = ids;
    }, lease);

    return saved;
  }, existingLease);

export const updateChatMessageWithRepo = (
  repo: BaseChatMessageRepo,
  message: ChatMessage,
  existingLease?: LocalDataWriteLease,
): Promise<ChatMessage> =>
  withLocalDataWrite(async (lease) => {
    const saved = await repo.updateChatMessage(message, lease);

    produceAppState((draft) => {
      draft.chatMessageById[saved.id] = saved;
    }, lease);

    return saved;
  }, existingLease);
