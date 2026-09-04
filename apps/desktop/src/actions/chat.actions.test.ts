import type { ChatMessage, Conversation } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

const runAgentMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const repoMocks = vi.hoisted(() => ({
  rejectNextUpdate: false,
  rejectNextCreate: false,
  rejectNextDelete: false,
  rejectNextList: false,
}));

vi.mock("../agents", () => ({
  runAgent: runAgentMock,
  abortAgentLoop: vi.fn(),
  CHAT_AGENT_CONFIG: { agentType: "chat" },
}));

// formatMessage descriptors only carry defaultMessage until the formatjs
// babel plugin injects ids at build time, so raw react-intl throws here.
// Mirror the placeholder lookup the production build performs.
vi.mock("../i18n/intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../i18n/intl")>();
  return {
    ...actual,
    getIntl: () => ({
      formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
        defaultMessage,
    }),
  };
});

const conversationStorage = new Map<string, Conversation>();
const messageStorage = new Map<string, ChatMessage>();

// Only the two repo methods sendChatMessage touches are faked, plus the
// deleteConversation method deleteConversation touches. Everything else
// stays out so an unexpected repo call fails loudly. Setting
// rejectNextUpdate makes the next updateConversation reject once, for the
// failure-path test.
vi.mock("../repos", () => ({
  getConversationRepo: () => ({
    updateConversation: (conversation: Conversation) => {
      if (repoMocks.rejectNextUpdate) {
        repoMocks.rejectNextUpdate = false;
        return Promise.reject(new Error("update rejected"));
      }
      conversationStorage.set(conversation.id, conversation);
      return Promise.resolve(conversation);
    },
    deleteConversation: (id: string) => {
      if (repoMocks.rejectNextDelete) {
        repoMocks.rejectNextDelete = false;
        return Promise.reject(new Error("delete rejected"));
      }
      conversationStorage.delete(id);
      return Promise.resolve();
    },
  }),
  getChatMessageRepo: () => ({
    createChatMessage: (message: ChatMessage) => {
      if (repoMocks.rejectNextCreate) {
        repoMocks.rejectNextCreate = false;
        return Promise.reject(new Error("persist rejected"));
      }
      messageStorage.set(message.id, message);
      return Promise.resolve(message);
    },
    listChatMessages: (conversationId: string) => {
      if (repoMocks.rejectNextList) {
        repoMocks.rejectNextList = false;
        return Promise.reject(new Error("list rejected"));
      }
      return Promise.resolve(
        [...messageStorage.values()].filter(
          (message) => message.conversationId === conversationId,
        ),
      );
    },
  }),
}));

import { deleteConversation, sendChatMessage } from "./chat.actions";

const baseConversation: Conversation = {
  id: "conv-1",
  title: "New conversation",
  createdAt: "2026-08-20T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:00.000Z",
};

const existingMessage: ChatMessage = {
  id: "msg-existing",
  conversationId: "conv-1",
  role: "user",
  content: "An older message",
  createdAt: "2026-08-20T10:01:00.000Z",
  metadata: null,
};

const seed = (options?: { title?: string; withExistingMessage?: boolean }) => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.conversationById[baseConversation.id] = {
    ...baseConversation,
    ...(options?.title !== undefined ? { title: options.title } : {}),
  };
  state.chat.conversationIds = ["conv-other", baseConversation.id, "conv-old"];
  state.chatMessageIdsByConversationId[baseConversation.id] = [];
  if (options?.withExistingMessage) {
    state.chatMessageById[existingMessage.id] = { ...existingMessage };
    state.chatMessageIdsByConversationId[baseConversation.id] = [
      existingMessage.id,
    ];
    messageStorage.set(existingMessage.id, { ...existingMessage });
  }
  setAppState(state, true);
};

describe("sendChatMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoMocks.rejectNextUpdate = false;
    repoMocks.rejectNextCreate = false;
    repoMocks.rejectNextDelete = false;
    repoMocks.rejectNextList = false;
    conversationStorage.clear();
    messageStorage.clear();
    seed();
  });

  it("names the conversation from the first message and bumps updatedAt", async () => {
    await sendChatMessage(
      "conv-1",
      "Can you help me write an email to my landlord?",
    );

    const saved = getAppState().conversationById["conv-1"];
    expect(saved?.title).toBe("Can you help me…");
    expect(new Date(saved?.updatedAt ?? 0).getTime()).toBeGreaterThan(
      new Date(baseConversation.updatedAt).getTime(),
    );

    const persisted = conversationStorage.get("conv-1");
    expect(persisted?.title).toBe("Can you help me…");

    const messages = [...messageStorage.values()];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe(
      "Can you help me write an email to my landlord?",
    );

    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the derived title on follow-up messages", async () => {
    await sendChatMessage("conv-1", "Can you help me write an email?");
    await sendChatMessage("conv-1", "Actually, make it about the heating.");

    expect(getAppState().conversationById["conv-1"]?.title).toBe(
      "Can you help me…",
    );
  });

  it("retitles legacy placeholder conversations that already have messages", async () => {
    seed({ withExistingMessage: true });

    await sendChatMessage("conv-1", "Fix the heating issue please");

    expect(getAppState().conversationById["conv-1"]?.title).toBe(
      "Fix the heating issue…",
    );
    expect(messageStorage.get(existingMessage.id)).toBeTruthy();
  });

  it("does not touch a conversation that already has a real title", async () => {
    seed({ title: "Quarterly report", withExistingMessage: true });

    await sendChatMessage("conv-1", "Something else entirely");

    expect(getAppState().conversationById["conv-1"]?.title).toBe(
      "Quarterly report",
    );
  });

  it("moves the conversation to the top of the sidebar order", async () => {
    await sendChatMessage("conv-1", "Hello");

    expect(getAppState().chat.conversationIds).toEqual([
      "conv-1",
      "conv-other",
      "conv-old",
    ]);
  });

  it("serializes concurrent sends so the newest timestamp wins", async () => {
    await Promise.all([
      sendChatMessage("conv-1", "Please help me fix the heating"),
      sendChatMessage("conv-1", "It stopped working yesterday evening"),
    ]);

    const messages = [...messageStorage.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    expect(messages).toHaveLength(2);
    // The first send names the chat. The second send runs after it and keeps
    // the name, so the persisted row carries the newer timestamp.
    const persisted = conversationStorage.get("conv-1");
    expect(persisted?.title).toBe("Please help me fix…");
    expect(persisted?.updatedAt).toBe(messages[1]?.createdAt);
  });

  it("still delivers the message and runs the agent when the update fails", async () => {
    repoMocks.rejectNextUpdate = true;
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      await sendChatMessage("conv-1", "Can you help me write an email?");
      // The next send retries the title and timestamp bump.
      await sendChatMessage("conv-1", "It is about the broken heater");

      // mockRestore clears the call history, so assert before the finally
      // block runs.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(messageStorage.size).toBe(2);
      expect(runAgentMock).toHaveBeenCalledTimes(2);
      // The failed bump never reached the store, and the retry retitled the
      // row from the second message.
      expect(getAppState().conversationById["conv-1"]?.title).toBe(
        "It is about the…",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("a send that lands after deleteConversation never persists a message", async () => {
    // The conversation is alive at send time. The delete completes first,
    // then the send is enqueued, then the send reaches the front of the
    // queue. persistSend re-reads the store and aborts because the
    // conversation is gone.
    seed();
    await sendChatMessage("conv-1", "Before delete");
    await deleteConversation("conv-1");
    expect(getAppState().conversationById["conv-1"]).toBeUndefined();

    await sendChatMessage("conv-1", "After delete");

    // The second send must not have created a message, re-added the
    // conversation to the sidebar, or triggered the agent.
    expect(messageStorage.size).toBe(1);
    expect(getAppState().chat.conversationIds.includes("conv-1")).toBe(false);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it("a delete that starts during a send skips the agent for that send", async () => {
    // Queue a send, then race a delete against it. The send's persist
    // either lands before the repo delete (and the conversation is
    // gone by the time we re-check) or after (and persistSend bails).
    // In both cases the agent must not run.
    seed();
    const sendPromise = sendChatMessage("conv-1", "Racing send");
    const deletePromise = deleteConversation("conv-1");
    await Promise.all([sendPromise, deletePromise]);

    expect(runAgentMock).not.toHaveBeenCalled();
    expect(getAppState().conversationById["conv-1"]).toBeUndefined();
    expect(getAppState().chat.conversationIds.includes("conv-1")).toBe(false);
  });

  it("a persist failure skips the agent and does not run it", async () => {
    // Make createChatMessage reject. The send must not trigger the
    // agent because no message reached storage.
    repoMocks.rejectNextCreate = true;

    await sendChatMessage("conv-1", "This will fail");

    expect(runAgentMock).not.toHaveBeenCalled();
    expect(messageStorage.size).toBe(0);
  });

  it("treats a persisted message as not-first when the in-memory list is stale", async () => {
    // Seed a persisted message but leave the in-memory list empty,
    // as if a send raced a pending loadChatMessages. The persisted
    // count means the new message is not the first, but the old
    // title is still the placeholder so the new message re-derives
    // the title from its content.
    seed({ withExistingMessage: true });
    const state = getAppState();
    state.chatMessageIdsByConversationId["conv-1"] = [];
    setAppState(state, true);

    await sendChatMessage(
      "conv-1",
      "Please help me write a very long email about something",
    );

    expect(getAppState().conversationById["conv-1"]?.title).toBe(
      "Please help me write…",
    );
    expect(messageStorage.size).toBe(2);
  });

  it("keeps the sidebar order when the conversation update fails", async () => {
    // A failed updateConversation must not move the conversation to
    // the top of the local order; otherwise a reload would show a
    // different order than the persisted one until a later send
    // retries.
    seed();
    repoMocks.rejectNextUpdate = true;
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      await sendChatMessage("conv-1", "Hello");
      expect(getAppState().chat.conversationIds).toEqual([
        "conv-other",
        "conv-1",
        "conv-old",
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("falls back to not-first when the persisted list query fails", async () => {
    // A transient repo failure on listChatMessages must not abort
    // the send. The send still persists and runs the agent, and the
    // isFirstMessage decision defaults to not-first so a stale
    // transient error does not risk overwriting a real title.
    // Seed a conversation with an existing real title.
    seed({ title: "Quarterly report", withExistingMessage: true });
    // Clear the in-memory list to simulate a stale empty read.
    const state = getAppState();
    state.chatMessageIdsByConversationId["conv-1"] = [];
    setAppState(state, true);

    repoMocks.rejectNextList = true;
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      await sendChatMessage("conv-1", "Hello");

      expect(messageStorage.size).toBe(2);
      expect(runAgentMock).toHaveBeenCalledTimes(1);
      // The title must not be overwritten because the failed
      // persisted read defaults to not-first.
      expect(getAppState().conversationById["conv-1"]?.title).toBe(
        "Quarterly report",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("deleteConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoMocks.rejectNextUpdate = false;
    repoMocks.rejectNextCreate = false;
    repoMocks.rejectNextDelete = false;
    conversationStorage.clear();
    messageStorage.clear();
    seed();
  });

  it("keeps the in-memory store intact when the repo delete rejects", async () => {
    // The conversation must remain visible so the user can retry the
    // delete. The deletingConversationIds flag must also be cleared
    // so a subsequent send can reach the store.
    repoMocks.rejectNextDelete = true;

    await expect(deleteConversation("conv-1")).rejects.toThrow(
      "delete rejected",
    );

    expect(getAppState().conversationById["conv-1"]).toBeDefined();
    expect(getAppState().chat.conversationIds.includes("conv-1")).toBe(true);

    // A send after the failed delete must still persist and run the
    // agent, proving the deleting flag was cleared.
    await sendChatMessage("conv-1", "After failed delete");
    expect(messageStorage.size).toBe(1);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });
});
