import type { ChatMessage, Conversation } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, produceAppState, setAppState } from "../store";

const mocks = vi.hoisted(() => ({
  listMessages: vi.fn(),
  listConversations: vi.fn(),
  createConversation: vi.fn(),
  createMessage: vi.fn(),
  updateMessage: vi.fn(),
  deleteMessages: vi.fn(),
  deleteConversation: vi.fn(),
  updateConversation: vi.fn(),
  runAgent: vi.fn(),
  abortAgent: vi.fn(),
}));
vi.mock("../agents", () => ({
  runAgent: mocks.runAgent,
  abortAgentLoop: mocks.abortAgent,
  retireAgentLoop: mocks.abortAgent,
  CHAT_AGENT_CONFIG: {},
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ error: vi.fn(), warning: vi.fn() }),
}));
vi.mock("../repos", () => ({
  getConversationRepo: () => ({
    listConversations: mocks.listConversations,
    createConversation: mocks.createConversation,
    deleteConversation: mocks.deleteConversation,
    updateConversation: mocks.updateConversation,
  }),
  getChatMessageRepo: () => ({
    listChatMessages: mocks.listMessages,
    createChatMessage: mocks.createMessage,
    updateChatMessage: mocks.updateMessage,
    deleteChatMessages: mocks.deleteMessages,
  }),
}));
vi.mock("../repos/chat-message.repo", () => ({
  getChatMessageRepo: () => ({
    createChatMessage: mocks.createMessage,
    updateChatMessage: mocks.updateMessage,
    deleteChatMessages: mocks.deleteMessages,
  }),
}));

import {
  createChatMessage,
  deleteChatMessages,
  updateChatMessage,
} from "./chat-message.actions";
import {
  createConversation,
  deleteConversation,
  loadChatMessages,
  loadConversations,
  sendChatMessage,
} from "./chat.actions";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const conversation: Conversation = {
  id: "conversation",
  title: "Chat",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const message = (id: string, content = id): ChatMessage => ({
  id,
  conversationId: conversation.id,
  role: "user",
  content,
  createdAt: "2026-01-01T00:00:01.000Z",
  metadata: null,
});

beforeEach(() => {
  vi.resetAllMocks();
  const state = structuredClone(INITIAL_APP_STATE);
  state.conversationById[conversation.id] = conversation;
  state.chat.conversationIds = [conversation.id];
  setAppState(state, true);
  mocks.createMessage.mockImplementation(async (value: ChatMessage) => value);
  mocks.updateConversation.mockImplementation(
    async (value: Conversation) => value,
  );
  mocks.deleteConversation.mockResolvedValue(undefined);
  mocks.deleteMessages.mockResolvedValue(undefined);
  mocks.runAgent.mockResolvedValue(undefined);
});

describe("chat history concurrency", () => {
  it("merges new and updated messages into an older read", async () => {
    const old = message("old", "before");
    produceAppState((draft) => {
      draft.chatMessageById[old.id] = old;
      draft.chatMessageIdsByConversationId[conversation.id] = [old.id];
    });
    const read = deferred<ChatMessage[]>();
    mocks.listMessages.mockReturnValueOnce(read.promise);
    const loading = loadChatMessages(conversation.id);
    await createChatMessage(message("new"));
    produceAppState((draft) => {
      draft.chatMessageById.old.content = "after";
    });
    read.resolve([old]);
    await loading;
    expect(
      getAppState().chatMessageIdsByConversationId[conversation.id],
    ).toEqual(["old", "new"]);
    expect(getAppState().chatMessageById.old.content).toBe("after");
  });

  it("does not resurrect messages removed while a read was pending", async () => {
    const old = message("old");
    produceAppState((draft) => {
      draft.chatMessageById.old = old;
      draft.chatMessageIdsByConversationId[conversation.id] = ["old"];
    });
    const read = deferred<ChatMessage[]>();
    mocks.listMessages.mockReturnValueOnce(read.promise);
    const loading = loadChatMessages(conversation.id);
    produceAppState((draft) => {
      draft.chatMessageById.transient = message("transient");
      draft.chatMessageIdsByConversationId[conversation.id].push("transient");
    });
    produceAppState((draft) => {
      delete draft.chatMessageById.old;
      delete draft.chatMessageById.transient;
      draft.chatMessageIdsByConversationId[conversation.id] = [];
    });
    read.resolve([old, message("transient")]);
    await loading;
    expect(
      getAppState().chatMessageIdsByConversationId[conversation.id],
    ).toEqual([]);
    expect(getAppState().chatMessageById.old).toBeUndefined();
    expect(getAppState().chatMessageById.transient).toBeUndefined();
  });

  it("does not let an older load replace a later load", async () => {
    const first = deferred<ChatMessage[]>();
    const second = deferred<ChatMessage[]>();
    mocks.listMessages
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const older = loadChatMessages(conversation.id);
    const newer = loadChatMessages(conversation.id);
    second.resolve([message("newer")]);
    await newer;
    first.resolve([message("older")]);
    await older;
    expect(
      getAppState().chatMessageIdsByConversationId[conversation.id],
    ).toEqual(["newer"]);
  });

  it("does not restore messages when a conversation is deleted during a read", async () => {
    const read = deferred<ChatMessage[]>();
    mocks.listMessages.mockReturnValueOnce(read.promise);
    const loading = loadChatMessages(conversation.id);
    await deleteConversation(conversation.id);
    read.resolve([message("deleted")]);
    await loading;
    expect(getAppState().conversationById[conversation.id]).toBeUndefined();
    expect(getAppState().chatMessageById.deleted).toBeUndefined();
    expect(
      getAppState().chatMessageIdsByConversationId[conversation.id],
    ).toBeUndefined();
  });

  it("clears streaming state and permissions for the deleted conversation only", async () => {
    produceAppState((draft) => {
      draft.chatMessageById.old = message("old");
      draft.chatMessageIdsByConversationId[conversation.id] = ["old"];
      draft.streamingMessageById.old = {
        toolCalls: [],
        reasoning: "",
        isStreaming: false,
      };
      draft.toolPermissionById.old = {
        id: "old",
        toolId: "paste",
        params: {},
        status: "pending",
        conversationId: conversation.id,
        createdAt: 0,
      };
      draft.toolPermissionById.other = {
        id: "other",
        toolId: "paste",
        params: {},
        status: "pending",
        conversationId: "another",
        createdAt: 0,
      };
    });
    await deleteConversation(conversation.id);
    expect(getAppState().streamingMessageById.old).toBeUndefined();
    expect(getAppState().toolPermissionById.old).toBeUndefined();
    expect(getAppState().toolPermissionById.other).toBeDefined();
  });

  it("coalesces concurrent deletes and blocks sends until deletion completes", async () => {
    const deletion = deferred<void>();
    mocks.deleteConversation.mockReturnValueOnce(deletion.promise);
    const first = deleteConversation(conversation.id);
    const second = deleteConversation(conversation.id);
    expect(second).toBe(first);
    await sendChatMessage(conversation.id, "must not be sent");
    expect(mocks.createMessage).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(mocks.deleteConversation).toHaveBeenCalledOnce(),
    );
    deletion.resolve();
    await Promise.all([first, second]);
    expect(getAppState().conversationById[conversation.id]).toBeUndefined();
  });

  it("does not restore deleted conversation state from late message writes", async () => {
    const creation = deferred<ChatMessage>();
    const update = deferred<ChatMessage>();
    const previous = message("existing");
    produceAppState((draft) => {
      draft.chatMessageById[previous.id] = previous;
      draft.chatMessageIdsByConversationId[conversation.id] = [previous.id];
    });
    mocks.createMessage.mockReturnValueOnce(creation.promise);
    mocks.updateMessage.mockReturnValueOnce(update.promise);
    const pendingCreate = createChatMessage(message("new"));
    const pendingUpdate = updateChatMessage({
      ...previous,
      content: "changed",
    });
    await deleteConversation(conversation.id);
    creation.resolve(message("new"));
    update.resolve({ ...previous, content: "changed" });
    await Promise.all([pendingCreate, pendingUpdate]);
    await deleteChatMessages(conversation.id, ["new"]);
    expect(getAppState().chatMessageById.new).toBeUndefined();
    expect(getAppState().chatMessageById.existing).toBeUndefined();
    expect(
      getAppState().chatMessageIdsByConversationId[conversation.id],
    ).toBeUndefined();
  });

  it("does not duplicate a message loaded before its create reply", async () => {
    const saving = deferred<ChatMessage>();
    mocks.createMessage.mockReturnValueOnce(saving.promise);
    const created = message("new");
    const pending = createChatMessage(created);
    mocks.listMessages.mockResolvedValueOnce([created]);
    await loadChatMessages(conversation.id);
    saving.resolve(created);
    await pending;
    expect(
      getAppState().chatMessageIdsByConversationId[conversation.id],
    ).toEqual([created.id]);
  });
});

describe("conversation list concurrency", () => {
  it("preserves conversation updates and creations made during a list read", async () => {
    const read = deferred<Conversation[]>();
    mocks.listConversations.mockReturnValueOnce(read.promise);
    const loading = loadConversations();
    const created = { ...conversation, id: "new", title: "New chat" };
    produceAppState((draft) => {
      draft.conversationById[conversation.id].title = "Updated";
      draft.conversationById[created.id] = created;
      draft.chat.conversationIds.unshift(created.id);
    });
    read.resolve([conversation]);
    await loading;
    expect(getAppState().chat.conversationIds).toEqual([
      "new",
      conversation.id,
    ]);
    expect(getAppState().conversationById[conversation.id].title).toBe(
      "Updated",
    );
    expect(getAppState().conversationById.new.title).toBe("New chat");
    expect(getAppState().chat.status).toBe("success");
  });

  it("does not duplicate a conversation loaded before its create reply", async () => {
    const pending = deferred<Conversation>();
    mocks.createConversation.mockReturnValueOnce(pending.promise);
    const created = { ...conversation, id: "new" };
    const creating = createConversation(created);
    mocks.listConversations.mockResolvedValueOnce([created, conversation]);
    await loadConversations();
    pending.resolve(created);
    await creating;
    expect(getAppState().chat.conversationIds).toEqual([
      "new",
      conversation.id,
    ]);
  });

  it("does not resurrect a deleted conversation absent from the initial state", async () => {
    const read = deferred<Conversation[]>();
    mocks.listConversations.mockReturnValueOnce(read.promise);
    const loading = loadConversations();
    await deleteConversation("not-loaded");
    read.resolve([conversation, { ...conversation, id: "not-loaded" }]);
    await loading;
    expect(getAppState().chat.conversationIds).toEqual([conversation.id]);
    expect(getAppState().conversationById["not-loaded"]).toBeUndefined();
  });

  it("ignores stale list results and errors after a newer load", async () => {
    const first = deferred<Conversation[]>();
    const second = deferred<Conversation[]>();
    mocks.listConversations
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const older = loadConversations();
    const olderRejected = expect(older).rejects.toThrow("old read failed");
    const newer = loadConversations();
    second.resolve([{ ...conversation, title: "Current" }]);
    await newer;
    first.reject(new Error("old read failed"));
    await olderRejected;
    expect(getAppState().chat.status).toBe("success");
    expect(getAppState().conversationById[conversation.id].title).toBe(
      "Current",
    );
  });
});
