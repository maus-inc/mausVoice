import type { ChatMessage } from "@maus-inc/types";
import { getChatMessageRepo } from "../repos/chat-message.repo";
import { produceAppState } from "../store";
import {
  type LocalDataWriteLease,
  withLocalDataWrite,
} from "./local-data-write-gate";

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
