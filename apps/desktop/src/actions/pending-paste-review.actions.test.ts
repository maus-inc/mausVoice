import type { ChatMessage } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createChatMessageMock = vi.hoisted(() => vi.fn());
const updateChatMessageMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("./chat.actions", () => ({
  createChatMessage: createChatMessageMock,
  updateChatMessage: updateChatMessageMock,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  cancelPendingPasteReview,
  copyPendingPasteReview,
  createPendingPasteReview,
  getPendingPasteReview,
} from "./pending-paste-review.actions";

const pendingMessage = (): ChatMessage => ({
  id: "review-1",
  conversationId: "conversation-1",
  role: "system",
  content: "",
  createdAt: "2026-09-09T12:00:00.000Z",
  metadata: {
    type: "pending-paste-review",
    toolName: "paste",
    toolCallState: "awaiting-manual-paste",
    text: "edited in the pill",
    status: "pending",
  },
});

describe("pending Paste reviews", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createChatMessageMock.mockImplementation(async (message) => message);
    updateChatMessageMock.mockImplementation(async (message) => message);
    invokeMock.mockResolvedValue(undefined);
  });

  it("stores the edited text and tool state before the native review closes", async () => {
    const saved = await createPendingPasteReview(
      "conversation-1",
      "edited in the pill",
    );

    expect(createChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-1",
        role: "system",
        content: "",
        metadata: {
          type: "pending-paste-review",
          toolName: "paste",
          toolCallState: "awaiting-manual-paste",
          text: "edited in the pill",
          status: "pending",
        },
      }),
    );
    expect(getPendingPasteReview(saved.metadata)).toEqual(
      expect.objectContaining({
        text: "edited in the pill",
        status: "pending",
      }),
    );
  });

  it("persists the latest edit before copying it for manual paste", async () => {
    const message = pendingMessage();
    await copyPendingPasteReview(message, "edited again");

    expect(updateChatMessageMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        metadata: expect.objectContaining({
          text: "edited again",
          status: "pending",
        }),
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith("copy_to_clipboard", {
      text: "edited again",
    });
    expect(updateChatMessageMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        metadata: expect.objectContaining({
          text: "edited again",
          status: "copied",
        }),
      }),
    );
  });

  it("leaves a durable retryable review when copying fails", async () => {
    const message = pendingMessage();
    invokeMock.mockRejectedValueOnce(new Error("clipboard unavailable"));

    await expect(
      copyPendingPasteReview(message, "edited again"),
    ).rejects.toThrow("clipboard unavailable");

    expect(updateChatMessageMock).toHaveBeenCalledTimes(1);
    expect(updateChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          text: "edited again",
          status: "pending",
        }),
      }),
    );
  });

  it("records a cancel without removing the user's edited text", async () => {
    await cancelPendingPasteReview(pendingMessage(), "edited again");

    expect(updateChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          text: "edited again",
          status: "canceled",
        }),
      }),
    );
  });

  it("preserves the saved text when an empty editor is cancelled", async () => {
    await cancelPendingPasteReview(pendingMessage(), "   ");

    expect(updateChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          text: "edited in the pill",
          status: "canceled",
        }),
      }),
    );
  });
});
