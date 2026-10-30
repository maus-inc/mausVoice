import { ChatMessage, ChatMessageRole, Nullable } from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import dayjs from "dayjs";
import type { LocalDataWriteLease } from "../utils/local-data-write-gate";
import { BaseRepo, withLocalDataWrite } from "./base.repo";

type LocalChatMessage = {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: number;
  metadata: Nullable<string>;
};

const fromLocalChatMessage = (local: LocalChatMessage): ChatMessage => ({
  id: local.id,
  conversationId: local.conversationId,
  role: local.role as ChatMessageRole,
  content: local.content,
  createdAt: dayjs(local.createdAt).toISOString(),
  metadata: local.metadata ? JSON.parse(local.metadata) : null,
});

const toLocalChatMessage = (message: ChatMessage): LocalChatMessage => ({
  id: message.id,
  conversationId: message.conversationId,
  role: message.role,
  content: message.content,
  createdAt: dayjs(message.createdAt).valueOf(),
  metadata: message.metadata ? JSON.stringify(message.metadata) : null,
});

export abstract class BaseChatMessageRepo extends BaseRepo {
  abstract listChatMessages(conversationId: string): Promise<ChatMessage[]>;
  abstract createChatMessage(
    message: ChatMessage,
    lease?: LocalDataWriteLease,
  ): Promise<ChatMessage>;
  abstract updateChatMessage(
    message: ChatMessage,
    lease?: LocalDataWriteLease,
  ): Promise<ChatMessage>;
  abstract deleteChatMessages(
    ids: string[],
    lease?: LocalDataWriteLease,
  ): Promise<void>;
}

export class LocalChatMessageRepo extends BaseChatMessageRepo {
  async listChatMessages(conversationId: string): Promise<ChatMessage[]> {
    const locals = await invoke<LocalChatMessage[]>("chat_message_list", {
      conversationId,
    });
    return locals.map(fromLocalChatMessage);
  }

  createChatMessage(
    message: ChatMessage,
    lease?: LocalDataWriteLease,
  ): Promise<ChatMessage> {
    return withLocalDataWrite(async () => {
      const created = await invoke<LocalChatMessage>("chat_message_create", {
        message: toLocalChatMessage(message),
      });
      return fromLocalChatMessage(created);
    }, lease);
  }

  updateChatMessage(
    message: ChatMessage,
    lease?: LocalDataWriteLease,
  ): Promise<ChatMessage> {
    return withLocalDataWrite(async () => {
      const updated = await invoke<LocalChatMessage>("chat_message_update", {
        message: toLocalChatMessage(message),
      });
      return fromLocalChatMessage(updated);
    }, lease);
  }

  deleteChatMessages(
    ids: string[],
    lease?: LocalDataWriteLease,
  ): Promise<void> {
    return withLocalDataWrite(
      () => invoke<void>("chat_message_delete_many", { ids }),
      lease,
    );
  }
}
