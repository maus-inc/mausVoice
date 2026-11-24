import type { ChatMessage } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createChatMessageMock = vi.hoisted(() => vi.fn());

vi.mock("../../repos/chat-message.repo", () => ({
  getChatMessageRepo: () => ({ createChatMessage: createChatMessageMock }),
}));

import { createChatMessage } from "../chat-message.utils";
import { getAppState, produceAppState } from "../../store";

const message = (id: string): ChatMessage => ({
  id,
  conversationId: "conversation-1",
  role: "user",
  content: "hello",
  createdAt: "2026-01-01T00:00:00.000Z",
  metadata: null,
});

describe("createChatMessage", () => {
  beforeEach(() => {
    createChatMessageMock.mockReset();
    createChatMessageMock.mockImplementation((input: ChatMessage) =>
      Promise.resolve(input),
    );
    produceAppState((draft) => {
      draft.chatMessageById = {};
      draft.chatMessageIdsByConversationId = {};
    });
  });

  it("registers a new message once", async () => {
    await createChatMessage(message("message-1"));

    expect(getAppState().chatMessageIdsByConversationId["conversation-1"]).toEqual(
      ["message-1"],
    );
  });

  it("does not list a message twice when a retry re-creates the same id", async () => {
    await createChatMessage(message("message-1"));
    await createChatMessage(message("message-1"));

    expect(getAppState().chatMessageIdsByConversationId["conversation-1"]).toEqual(
      ["message-1"],
    );
  });
});
