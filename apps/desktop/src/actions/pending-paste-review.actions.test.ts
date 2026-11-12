import type { ChatMessage } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createChatMessageMock = vi.hoisted(() => vi.fn());
const updateChatMessageMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());
const listChatMessagesMock = vi.hoisted(() => vi.fn());

vi.mock("./chat.actions", () => ({
  createChatMessage: createChatMessageMock,
  updateChatMessage: updateChatMessageMock,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../repos", () => ({
  getChatMessageRepo: () => ({ listChatMessages: listChatMessagesMock }),
}));

const { intlFormatMessage } = vi.hoisted(() => ({
  /** Every descriptor the code under test asked the intl layer to format. */
  intlFormatMessage: vi.fn(),
}));

// `PendingPasteReviewBubble` hands a thrown Error straight to
// `showErrorSnackbar`, which stringifies it, so every message these actions
// throw is user-facing copy. The formatter records the descriptors it was given:
// a hardcoded sentence and a formatted one produce the same string, so only the
// record can tell them apart.
vi.mock("../i18n/intl", () => ({
  getIntl: () => ({
    formatMessage: (descriptor: { defaultMessage: string }) => {
      intlFormatMessage(descriptor);
      return descriptor.defaultMessage;
    },
  }),
}));

import {
  cancelPendingPasteReview,
  copyPendingPasteReview,
  createPendingPasteReview,
  getPendingPasteReview,
  updatePendingPasteReviewDraft,
  updatePendingPasteReviewDraftById,
} from "./pending-paste-review.actions";

/** The Error a call rejected with, so an assertion can read `error.message`. */
const rejectionOf = async (run: Promise<unknown>): Promise<Error> => {
  try {
    await run;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to reject");
};

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
    draftRevision: 0,
  },
});

describe("pending Paste reviews", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createChatMessageMock.mockImplementation((message) =>
      Promise.resolve(message),
    );
    updateChatMessageMock.mockImplementation((message) =>
      Promise.resolve(message),
    );
    invokeMock.mockResolvedValue(undefined);
    listChatMessagesMock.mockResolvedValue([]);
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
          draftRevision: 0,
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

  it("uses a caller-provided id so Open retries target the same card", async () => {
    await createPendingPasteReview(
      "conversation-1",
      "saved draft",
      "stable-review-id",
    );

    expect(createChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "stable-review-id",
        conversationId: "conversation-1",
      }),
    );
  });

  it("updates an existing pending card when Open is retried with new text", async () => {
    const message = pendingMessage();
    const saved = await updatePendingPasteReviewDraft(message, "latest draft");

    expect(updateChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: message.id,
        conversationId: message.conversationId,
        metadata: expect.objectContaining({
          text: "latest draft",
          status: "pending",
        }),
      }),
    );
    expect(saved.id).toBe(message.id);
  });

  it("updates a card by its stable id after a create response is lost", async () => {
    listChatMessagesMock.mockResolvedValue([
      {
        ...pendingMessage(),
        id: "pending-review-1",
        conversationId: "conversation-1",
      },
    ]);
    await updatePendingPasteReviewDraftById(
      "conversation-1",
      "pending-review-1",
      "latest draft",
      1,
    );

    expect(updateChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "pending-review-1",
        conversationId: "conversation-1",
        metadata: expect.objectContaining({
          text: "latest draft",
          status: "pending",
          draftRevision: 1,
        }),
      }),
    );
  });

  it.each([
    ["missing", []],
    [
      "owned by another conversation",
      [{ ...pendingMessage(), conversationId: "other" }],
    ],
  ])(
    "rejects by-id recovery when the card is %s",
    async (_reason, messages) => {
      listChatMessagesMock.mockResolvedValue(messages);

      await expect(
        updatePendingPasteReviewDraftById(
          "conversation-1",
          "review-1",
          "latest draft",
          1,
        ),
      ).rejects.toThrow("This Paste review is no longer pending");
      expect(updateChatMessageMock).not.toHaveBeenCalled();
    },
  );

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

  it("does not copy text when a newer draft won the persistence race", async () => {
    updateChatMessageMock.mockImplementationOnce((message) =>
      Promise.resolve({
        ...message,
        metadata: {
          ...message.metadata,
          text: "newer draft",
          draftRevision: 2,
        },
      }),
    );

    await expect(
      copyPendingPasteReview(pendingMessage(), "stale draft"),
    ).rejects.toThrow("This Paste review is no longer pending");
    expect(invokeMock).not.toHaveBeenCalled();
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

  it("retries cancel against a newer stored draft without replacing its text", async () => {
    updateChatMessageMock
      .mockImplementationOnce((message) =>
        Promise.resolve({
          ...message,
          metadata: {
            ...message.metadata,
            text: "newer draft",
            status: "pending",
            draftRevision: 2,
          },
        }),
      )
      .mockImplementationOnce((message) => Promise.resolve(message));

    await cancelPendingPasteReview(pendingMessage(), "");

    expect(updateChatMessageMock).toHaveBeenCalledTimes(2);
    expect(updateChatMessageMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        metadata: expect.objectContaining({
          text: "newer draft",
          status: "canceled",
          draftRevision: 3,
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

  it.each([
    [
      "an empty save",
      () => createPendingPasteReview("conversation-1", "   "),
      "Cannot save an empty Paste review",
    ],
    [
      "an empty copy",
      () => copyPendingPasteReview(pendingMessage(), "  "),
      "Cannot copy an empty Paste review",
    ],
    [
      "a review that is no longer pending",
      () =>
        copyPendingPasteReview(
          {
            ...pendingMessage(),
            metadata: { ...pendingMessage().metadata, status: "canceled" },
          },
          "edited again",
        ),
      "This Paste review is no longer pending",
    ],
    [
      "cancelling a review that is no longer pending",
      () =>
        cancelPendingPasteReview(
          {
            ...pendingMessage(),
            metadata: { ...pendingMessage().metadata, status: "copied" },
          },
          "edited again",
        ),
      "This Paste review is no longer pending",
    ],
  ])(
    "builds the %s error from the intl layer",
    async (_label, run, message) => {
      const error = await rejectionOf(run());

      expect(error.message).toBe(message);
      expect(intlFormatMessage).toHaveBeenCalledWith(
        expect.objectContaining({ defaultMessage: message }),
      );
    },
  );
});
