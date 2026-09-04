import type { ChatMessage, Conversation } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

const runAgentMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const repoMocks = vi.hoisted(() => ({ rejectNextUpdate: false }));

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
      conversationStorage.delete(id);
      return Promise.resolve();
    },
  }),
  getChatMessageRepo: () => ({
    createChatMessage: (message: ChatMessage) => {
      messageStorage.set(message.id, message);
      return Promise.resolve(message);
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

    // The second send must not have created a message or re-added the
    // conversation to the sidebar.
    expect(messageStorage.size).toBe(1);
    expect(getAppState().chat.conversationIds.includes("conv-1")).toBe(false);
  });
});
