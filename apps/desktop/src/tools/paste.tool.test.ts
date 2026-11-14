import type { ToolInfo } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reviewTranscriptBeforeInsertMock = vi.hoisted(() => vi.fn());
const cancelPendingPasteReviewMock = vi.hoisted(() => vi.fn());
const createPendingPasteReviewMock = vi.hoisted(() => vi.fn());
const updatePendingPasteReviewDraftMock = vi.hoisted(() => vi.fn());
const updatePendingPasteReviewDraftByIdMock = vi.hoisted(() => vi.fn());
const invokeMock = vi.hoisted(() => vi.fn());
const emitMock = vi.hoisted(() => vi.fn());
const loggerErrorMock = vi.hoisted(() => vi.fn());
const showToastMock = vi.hoisted(() => vi.fn());
const runToastMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  userPrefs: { reviewBeforeInsert: true } as { reviewBeforeInsert?: boolean },
}));

vi.mock("../actions/pill-review.actions", () => ({
  reviewTranscriptBeforeInsert: reviewTranscriptBeforeInsertMock,
}));
vi.mock("../actions/pending-paste-review.actions", () => ({
  cancelPendingPasteReview: cancelPendingPasteReviewMock,
  createPendingPasteReview: createPendingPasteReviewMock,
  updatePendingPasteReviewDraft: updatePendingPasteReviewDraftMock,
  updatePendingPasteReviewDraftById: updatePendingPasteReviewDraftByIdMock,
}));
vi.mock("../store", () => ({ getAppState: () => state }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ emit: emitMock }));
vi.mock("../utils/tool-permission.utils", () => ({
  getToolAlwaysAllow: vi.fn(),
  setToolAlwaysAllow: vi.fn(),
}));
vi.mock("../i18n/intl", () => ({
  getIntl: () => ({
    formatMessage: (descriptor: { defaultMessage?: string }) =>
      descriptor.defaultMessage ?? "",
  }),
}));
vi.mock("../actions/toast.actions", () => ({
  showToast: showToastMock,
  runToast: runToastMock,
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    error: loggerErrorMock,
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));

import { PasteTool } from "./paste.tool";

const toolInfo: ToolInfo = {
  id: "paste",
  description: "Paste text",
  instructions: "Paste text",
  schema: { type: "object" },
};

describe("PasteTool review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.userPrefs = { reviewBeforeInsert: true };
    createPendingPasteReviewMock.mockResolvedValue({ id: "pending-review" });
    cancelPendingPasteReviewMock.mockResolvedValue(undefined);
    updatePendingPasteReviewDraftMock.mockImplementation((message: unknown) =>
      Promise.resolve(message),
    );
    updatePendingPasteReviewDraftByIdMock.mockResolvedValue({
      id: "pending-review",
    });
    // What the Rust `paste` command returns when the text reached the target.
    invokeMock.mockResolvedValue("pasted");
  });

  it("saves the review when the focused target could not take the text", async () => {
    reviewTranscriptBeforeInsertMock.mockResolvedValue("edited text");
    invokeMock.mockResolvedValue("copied_to_clipboard");

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).resolves.toEqual({ copiedToClipboard: true });

    expect(createPendingPasteReviewMock).toHaveBeenCalledWith(
      "conv-1",
      "edited text",
    );
    // The insert is attempted first: the saved review exists for the pastes
    // that did not land, so it cannot be written before the outcome is known.
    expect(invokeMock.mock.invocationCallOrder[0]).toBeLessThan(
      createPendingPasteReviewMock.mock.invocationCallOrder[0],
    );
  });

  it("saves no review when the text already landed in the target", async () => {
    reviewTranscriptBeforeInsertMock.mockResolvedValue("edited text");

    await new PasteTool(toolInfo).execute(
      { text: "agent version" },
      { conversationId: "conv-1" },
    );

    // The card says a paste is waiting on the user, which is false once the
    // text is in the target app.
    expect(createPendingPasteReviewMock).not.toHaveBeenCalled();
  });

  it("saves the review and reports the failure when the insert errors", async () => {
    reviewTranscriptBeforeInsertMock.mockResolvedValue("edited text");
    invokeMock.mockRejectedValue(new Error("Paste is already in progress"));

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).rejects.toThrow("Paste is already in progress");

    // Nothing reached the target, so the text is only recoverable by hand.
    expect(createPendingPasteReviewMock).toHaveBeenCalledWith(
      "conv-1",
      "edited text",
    );
  });

  it("keeps the paste successful when the review cannot be saved", async () => {
    reviewTranscriptBeforeInsertMock.mockResolvedValue("edited text");
    invokeMock.mockResolvedValue("copied_to_clipboard");
    createPendingPasteReviewMock.mockRejectedValue(new Error("disk full"));

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).resolves.toEqual({ copiedToClipboard: true });

    // The clipboard fallback already delivered the text; a failed bookkeeping
    // write must not be reported as a failed paste.
    expect(invokeMock).toHaveBeenCalledWith("paste", {
      text: "edited text",
      keybind: null,
    });
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it("reports the insert failure when the review cannot be saved either", async () => {
    reviewTranscriptBeforeInsertMock.mockResolvedValue("edited text");
    invokeMock.mockRejectedValue(new Error("Paste is already in progress"));
    createPendingPasteReviewMock.mockRejectedValue(new Error("disk full"));

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).rejects.toThrow("Paste is already in progress");
  });

  it("saves the review with an empty conversation id when the call carries no context", async () => {
    state.userPrefs = { reviewBeforeInsert: false };
    invokeMock.mockResolvedValue("copied_to_clipboard");

    await new PasteTool(toolInfo).execute({ text: "agent version" });

    expect(createPendingPasteReviewMock).toHaveBeenCalledWith(
      "",
      "agent version",
    );
  });

  it("reports an expired review distinctly from an explicit cancel", async () => {
    reviewTranscriptBeforeInsertMock.mockImplementationOnce(
      (_text: string, _source: string, options?: { onExpire?: () => void }) => {
        options?.onExpire?.();
        return Promise.resolve(null);
      },
    );

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).rejects.toThrow(
      "Paste transcript review expired before a decision was made.",
    );

    expect(invokeMock).not.toHaveBeenCalled();
    expect(createPendingPasteReviewMock).not.toHaveBeenCalled();
  });

  it("reports a failed review as an unsuccessful tool outcome", async () => {
    reviewTranscriptBeforeInsertMock.mockImplementationOnce(
      (
        _text: string,
        _source: string,
        options?: { onFailure?: () => void },
      ) => {
        options?.onFailure?.();
        return Promise.resolve(null);
      },
    );

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).rejects.toThrow("Paste transcript review could not be completed.");

    expect(invokeMock).not.toHaveBeenCalled();
    expect(createPendingPasteReviewMock).not.toHaveBeenCalled();
  });

  it("saves nothing when the review is cancelled", async () => {
    reviewTranscriptBeforeInsertMock.mockResolvedValue(null);

    await expect(
      new PasteTool(toolInfo).execute({ text: "agent version" }),
    ).resolves.toEqual({ canceled: true });

    expect(createPendingPasteReviewMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reviews as an assistant-tool source and pastes the settled text", async () => {
    reviewTranscriptBeforeInsertMock.mockResolvedValue("edited text");

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).resolves.toEqual({});

    expect(reviewTranscriptBeforeInsertMock).toHaveBeenCalledWith(
      "agent version",
      "assistant-tool",
      expect.objectContaining({
        onCopy: expect.any(Function),
        onOpen: expect.any(Function),
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith("paste", {
      text: "edited text",
      keybind: null,
    });
  });

  it("saves and opens an Open review in Chats instead of pasting into the old target", async () => {
    reviewTranscriptBeforeInsertMock.mockImplementation(
      async (
        _text: string,
        _source: string,
        options?: {
          onCopy?: () => void;
          onOpen?: (text: string) => Promise<void>;
        },
      ) => {
        await options?.onOpen?.("edited in pill");
        return null;
      },
    );

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).resolves.toEqual({ awaitingManualPaste: true });

    expect(createPendingPasteReviewMock).toHaveBeenCalledWith(
      "conv-1",
      "edited in pill",
      expect.any(String),
    );
    expect(emitMock).toHaveBeenCalledWith("open-pill-conversation", {
      conversationId: "conv-1",
      pendingPasteReview: true,
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("saves a later Insert edit without pasting after an Open hand-off", async () => {
    const savedCard = { id: "pending-review" };
    createPendingPasteReviewMock.mockResolvedValue(savedCard);
    reviewTranscriptBeforeInsertMock.mockImplementationOnce(
      async (
        _text: string,
        _source: string,
        options?: { onOpen?: (text: string) => Promise<void> },
      ) => {
        await options?.onOpen?.("saved before open");
        return "edited after Open timed out";
      },
    );

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).resolves.toEqual({ awaitingManualPaste: true });

    expect(updatePendingPasteReviewDraftMock).toHaveBeenCalledWith(
      savedCard,
      "edited after Open timed out",
      2,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("cancels a late Open save when the user chose Insert after timeout", async () => {
    const savedCard = { id: "pending-review" };
    let finishSave: ((message: typeof savedCard) => void) | undefined;
    let lateOpenSave: Promise<void> | undefined;
    createPendingPasteReviewMock.mockImplementationOnce(
      () =>
        new Promise<typeof savedCard>((resolve) => {
          finishSave = resolve;
        }),
    );
    reviewTranscriptBeforeInsertMock.mockImplementationOnce(
      async (
        _text: string,
        _source: string,
        options?: {
          onOpen?: (text: string, signal?: AbortSignal) => Promise<void>;
        },
      ) => {
        const controller = new AbortController();
        lateOpenSave = options?.onOpen?.("review draft", controller.signal);
        controller.abort();
        return "insert after timeout";
      },
    );

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).resolves.toEqual({});
    expect(invokeMock).toHaveBeenCalledWith("paste", {
      text: "insert after timeout",
      keybind: null,
    });

    finishSave?.(savedCard);
    await lateOpenSave;
    expect(cancelPendingPasteReviewMock).toHaveBeenCalledWith(savedCard, "");
  });

  it("does not wait for unused-card cleanup before completing Copy", async () => {
    const savedCard = { id: "pending-review" };
    let finishCleanup: (() => void) | undefined;
    cancelPendingPasteReviewMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    reviewTranscriptBeforeInsertMock.mockImplementationOnce(
      async (
        _text: string,
        _source: string,
        options?: {
          onCopy?: () => void;
          onOpen?: (text: string, signal?: AbortSignal) => Promise<void>;
        },
      ) => {
        const controller = new AbortController();
        const opening = options?.onOpen?.("review draft", controller.signal);
        controller.abort();
        await opening;
        options?.onCopy?.();
        return null;
      },
    );
    createPendingPasteReviewMock.mockResolvedValueOnce(savedCard);

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).resolves.toEqual({ copiedToClipboard: true });
    expect(cancelPendingPasteReviewMock).toHaveBeenCalledWith(savedCard, "");
    finishCleanup?.();
  });

  it("warns when an unused pending review cannot be closed", async () => {
    const savedCard = { id: "pending-review" };
    let finishSave: ((message: typeof savedCard) => void) | undefined;
    let lateOpenSave: Promise<void> | undefined;
    createPendingPasteReviewMock.mockImplementationOnce(
      () =>
        new Promise<typeof savedCard>((resolve) => {
          finishSave = resolve;
        }),
    );
    cancelPendingPasteReviewMock.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    reviewTranscriptBeforeInsertMock.mockImplementationOnce(
      (
        _text: string,
        _source: string,
        options?: {
          onOpen?: (text: string, signal?: AbortSignal) => Promise<void>;
        },
      ) => {
        const controller = new AbortController();
        lateOpenSave = options?.onOpen?.("review draft", controller.signal);
        controller.abort();
        return "insert after timeout";
      },
    );

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).resolves.toEqual({});

    finishSave?.(savedCard);
    await lateOpenSave;
    expect(cancelPendingPasteReviewMock).toHaveBeenCalledWith(savedCard, "");
    await vi.waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith({
        message:
          "An unused Paste review could not be closed. Check Chats and dismiss the leftover card.",
        toastType: "error",
        duration: 8000,
      }),
    );
  });

  it("shows Chats recovery guidance when navigation fails after saving", async () => {
    emitMock.mockRejectedValueOnce(new Error("window unavailable"));
    reviewTranscriptBeforeInsertMock.mockImplementationOnce(
      async (
        _text: string,
        _source: string,
        options?: { onOpen?: (text: string) => Promise<void> },
      ) => {
        await options?.onOpen?.("edited in pill");
        return null;
      },
    );

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).resolves.toEqual({ awaitingManualPaste: true });

    await vi.waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("Open Chats"),
          toastType: "info",
        }),
      ),
    );
  });

  it("settles Open after saving even when Chats navigation stalls", async () => {
    vi.useFakeTimers();
    try {
      // Simulate a navigation event that never resolves.
      emitMock.mockImplementationOnce(() => new Promise<void>(() => {}));
      reviewTranscriptBeforeInsertMock.mockImplementationOnce(
        async (
          _text: string,
          _source: string,
          options?: { onOpen?: (text: string) => Promise<void> },
        ) => {
          await options?.onOpen?.("saved before navigation");
          return null;
        },
      );

      await expect(
        new PasteTool(toolInfo).execute(
          { text: "agent version" },
          { conversationId: "conv-1" },
        ),
      ).resolves.toEqual({ awaitingManualPaste: true });
      expect(createPendingPasteReviewMock).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("Open Chats"),
          toastType: "info",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not navigate if the Open save finishes after its timeout", async () => {
    let finishSave: (() => void) | undefined;
    createPendingPasteReviewMock.mockImplementationOnce(
      () =>
        new Promise<{ id: string }>((resolve) => {
          finishSave = () => resolve({ id: "pending-review" });
        }),
    );
    reviewTranscriptBeforeInsertMock.mockImplementationOnce(
      async (
        _text: string,
        _source: string,
        options?: {
          onOpen?: (text: string, signal?: AbortSignal) => Promise<void>;
        },
      ) => {
        const controller = new AbortController();
        const saving = options?.onOpen?.("edited in pill", controller.signal);
        for (
          let attempt = 0;
          attempt < 10 && createPendingPasteReviewMock.mock.calls.length === 0;
          attempt += 1
        ) {
          await Promise.resolve();
        }
        controller.abort();
        finishSave?.();
        await saving;
        return null;
      },
    );

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).resolves.toEqual({ canceled: true });

    expect(createPendingPasteReviewMock).toHaveBeenCalledOnce();
    expect(emitMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reuses a late successful save when retrying an aborted Open hand-off", async () => {
    let finishSave: (() => void) | undefined;
    createPendingPasteReviewMock.mockImplementationOnce(
      () =>
        new Promise<{ id: string }>((resolve) => {
          finishSave = () => resolve({ id: "pending-review" });
        }),
    );
    reviewTranscriptBeforeInsertMock.mockImplementationOnce(
      async (
        _text: string,
        _source: string,
        options?: {
          onOpen?: (text: string, signal?: AbortSignal) => Promise<void>;
        },
      ) => {
        const firstController = new AbortController();
        const firstAttempt = options?.onOpen?.(
          "edited in pill",
          firstController.signal,
        );
        for (
          let attempt = 0;
          attempt < 10 && createPendingPasteReviewMock.mock.calls.length === 0;
          attempt += 1
        ) {
          await Promise.resolve();
        }
        firstController.abort();
        finishSave?.();
        await firstAttempt;
        await options?.onOpen?.("edited in pill", new AbortController().signal);
        return null;
      },
    );

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).resolves.toEqual({ awaitingManualPaste: true });

    expect(createPendingPasteReviewMock).toHaveBeenCalledOnce();
    expect(emitMock).toHaveBeenCalledOnce();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("lets Open retry proceed when an earlier save promise is stalled", async () => {
    let finishStalledCreate: ((message: { id: string }) => void) | undefined;
    createPendingPasteReviewMock
      .mockImplementationOnce(
        () =>
          new Promise<{ id: string }>((resolve) => {
            finishStalledCreate = resolve;
          }),
      )
      .mockRejectedValueOnce(
        new Error("UNIQUE constraint failed: chat_messages.id"),
      );
    reviewTranscriptBeforeInsertMock.mockImplementationOnce(
      async (
        _text: string,
        _source: string,
        options?: {
          onOpen?: (text: string, signal?: AbortSignal) => Promise<void>;
        },
      ) => {
        const stalledAttempt = new AbortController();
        const firstSave = options?.onOpen?.(
          "first draft",
          stalledAttempt.signal,
        );
        for (
          let attempt = 0;
          attempt < 10 && createPendingPasteReviewMock.mock.calls.length === 0;
          attempt += 1
        ) {
          await Promise.resolve();
        }
        stalledAttempt.abort();

        await options?.onOpen?.("latest draft", new AbortController().signal);
        // The first save never settles, but the retry still saves the latest
        // draft under the same id and opens Chats.
        expect(firstSave).toBeInstanceOf(Promise);
        return null;
      },
    );

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).resolves.toEqual({ awaitingManualPaste: true });

    expect(createPendingPasteReviewMock).toHaveBeenCalledTimes(2);
    expect(createPendingPasteReviewMock.mock.calls[0][2]).toBe(
      createPendingPasteReviewMock.mock.calls[1][2],
    );
    expect(updatePendingPasteReviewDraftByIdMock).toHaveBeenCalledWith(
      "conv-1",
      createPendingPasteReviewMock.mock.calls[0][2],
      "latest draft",
      2,
    );
    expect(emitMock).toHaveBeenCalledOnce();
    finishStalledCreate?.({ id: "pending-review" });
    await Promise.resolve();
  });

  it("reapplies the latest draft when a stalled update completes after a retry", async () => {
    let finishStaleUpdate: ((message: { id: string }) => void) | undefined;
    updatePendingPasteReviewDraftMock.mockImplementationOnce(
      () =>
        new Promise<{ id: string }>((resolve) => {
          finishStaleUpdate = resolve;
        }),
    );
    reviewTranscriptBeforeInsertMock.mockImplementationOnce(
      async (
        _text: string,
        _source: string,
        options?: {
          onOpen?: (text: string, signal?: AbortSignal) => Promise<void>;
        },
      ) => {
        await options?.onOpen?.("initial draft", new AbortController().signal);
        const staleAttempt = new AbortController();
        const staleSave = options?.onOpen?.("stale draft", staleAttempt.signal);
        for (
          let attempt = 0;
          attempt < 10 &&
          updatePendingPasteReviewDraftMock.mock.calls.length === 0;
          attempt += 1
        ) {
          await Promise.resolve();
        }
        staleAttempt.abort();

        await options?.onOpen?.("latest draft", new AbortController().signal);
        finishStaleUpdate?.({ id: "pending-review" });
        await staleSave;
        return null;
      },
    );

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).resolves.toEqual({ awaitingManualPaste: true });

    expect(updatePendingPasteReviewDraftMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ id: "pending-review" }),
      "latest draft",
      3,
    );
  });

  it("persists edited text on an Open retry without duplicating the card", async () => {
    const savedCard = { id: "pending-review" };
    let finishSave: (() => void) | undefined;
    createPendingPasteReviewMock.mockImplementationOnce(
      () =>
        new Promise<{ id: string }>((resolve) => {
          finishSave = () => resolve(savedCard);
        }),
    );
    reviewTranscriptBeforeInsertMock.mockImplementationOnce(
      async (
        _text: string,
        _source: string,
        options?: {
          onOpen?: (text: string, signal?: AbortSignal) => Promise<void>;
        },
      ) => {
        const timedOutAttempt = new AbortController();
        const firstAttempt = options?.onOpen?.(
          "first draft",
          timedOutAttempt.signal,
        );
        for (
          let attempt = 0;
          attempt < 10 && createPendingPasteReviewMock.mock.calls.length === 0;
          attempt += 1
        ) {
          await Promise.resolve();
        }
        timedOutAttempt.abort();
        finishSave?.();
        await firstAttempt;
        await options?.onOpen?.("latest draft", new AbortController().signal);
        return null;
      },
    );

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).resolves.toEqual({ awaitingManualPaste: true });

    expect(createPendingPasteReviewMock).toHaveBeenCalledOnce();
    expect(updatePendingPasteReviewDraftMock).toHaveBeenCalledWith(
      savedCard,
      "latest draft",
      2,
    );
    expect(emitMock).toHaveBeenCalledOnce();
  });

  it("returns a successful clipboard result when the user chooses Copy", async () => {
    reviewTranscriptBeforeInsertMock.mockImplementation(
      (_text: string, _source: string, options?: { onCopy?: () => void }) => {
        options?.onCopy?.();
        return Promise.resolve(null);
      },
    );

    await expect(
      new PasteTool(toolInfo).execute(
        { text: "agent version" },
        { conversationId: "conv-1" },
      ),
    ).resolves.toEqual({ copiedToClipboard: true });

    expect(invokeMock).not.toHaveBeenCalled();
    expect(createPendingPasteReviewMock).not.toHaveBeenCalled();
  });

  it("cancels the paste when the review returns no text", async () => {
    reviewTranscriptBeforeInsertMock.mockResolvedValue(null);

    await expect(
      new PasteTool(toolInfo).execute({ text: "agent version" }),
    ).resolves.toEqual({ canceled: true });

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("pastes directly when review-before-insert is disabled", async () => {
    state.userPrefs = { reviewBeforeInsert: false };

    await expect(
      new PasteTool(toolInfo).execute({ text: "agent version" }),
    ).resolves.toEqual({});

    expect(reviewTranscriptBeforeInsertMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("paste", {
      text: "agent version",
      keybind: null,
    });
  });
});
