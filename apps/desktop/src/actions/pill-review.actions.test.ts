import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const invoke = vi.fn();
  const listen = vi.fn();
  const reviewTextInComposer = vi.fn();
  const showToast = vi.fn();
  const runToast = vi.fn();
  const isNativePillAvailable = vi.fn();
  const logger = {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  };
  return {
    invoke,
    listen,
    reviewTextInComposer,
    showToast,
    runToast,
    isNativePillAvailable,
    logger,
  };
});

// Keep the real module apart from `invoke`: other modules pulled in by the
// action import `Channel` from it.
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mocks.listen(...args),
}));
vi.mock("../utils/composer.utils", () => ({
  reviewTextInComposer: (...args: unknown[]) =>
    mocks.reviewTextInComposer(...args),
}));
vi.mock("../i18n/intl", () => ({
  getIntl: () => ({
    formatMessage: (descriptor: { defaultMessage?: string }) =>
      descriptor.defaultMessage ?? "",
  }),
}));
vi.mock("./toast.actions", () => ({
  runToast: (...args: unknown[]) => mocks.runToast(...args),
  showToast: (...args: unknown[]) => mocks.showToast(...args),
}));
vi.mock("../utils/native-pill.utils", () => ({
  isNativePillAvailable: (...args: unknown[]) =>
    mocks.isNativePillAvailable(...args),
  resetNativePillAvailability: vi.fn(),
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => mocks.logger,
}));

import {
  cancelAllPillReviews,
  getQueuedSessions,
  getReviewSession,
  reviewTranscriptBeforeInsert,
  reviewTranscriptOnPill,
} from "./pill-review.actions";
import { getAppState } from "../store";

type DecisionListener = (event: { payload: unknown }) => void;

let decide: DecisionListener | null = null;

const flush = async (predicate: () => boolean) => {
  for (let i = 0; i < 20 && !predicate(); i += 1) {
    await Promise.resolve();
  }
};

const currentReviewId = (): string => {
  const review = getAppState().pendingPillReview;
  if (!review) throw new Error("no review is published to the pill");
  return review.id;
};

const startPillReview = (
  ...args: Parameters<typeof reviewTranscriptOnPill>
): Promise<string | null> => reviewTranscriptOnPill(...args);

const beginAssistantToolOpen = async (
  onOpen: (text: string, signal?: AbortSignal) => Promise<void>,
): Promise<{ id: string; pending: Promise<string | null> }> => {
  const pending = reviewTranscriptOnPill("rough take", "assistant-tool", {
    onOpen,
  });
  await flush(() => getAppState().pendingPillReview !== null);
  const id = currentReviewId();
  decide?.({
    payload: { reviewId: id, action: "open", text: "pill draft" },
  });
  return { id, pending };
};

const cancelPillReview = async (
  pending: Promise<string | null>,
): Promise<void> => {
  decide?.({ payload: { reviewId: currentReviewId(), action: "cancel" } });
  await expect(pending).resolves.toBeNull();
};

describe("reviewTranscriptOnPill", () => {
  beforeEach(() => {
    cancelAllPillReviews();
    mocks.logger.error.mockClear();
    mocks.logger.warning.mockClear();
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation(() => Promise.resolve());
    mocks.reviewTextInComposer.mockReset();
    decide = null;
    mocks.listen.mockReset();
    mocks.isNativePillAvailable.mockReset();
    mocks.isNativePillAvailable.mockResolvedValue(true);
    mocks.listen.mockImplementation((_event: string, cb: unknown) => {
      decide = cb as DecisionListener;
      return Promise.resolve(vi.fn());
    });
  });

  it.each([null, 123, { text: 123 }, { text: ["not a string"] }])(
    "ignores malformed decisions without stranding the review: %j",
    async (malformed) => {
      const pending = startPillReview("kept transcript");
      try {
        await flush(() => getAppState().pendingPillReview !== null);
        const id = currentReviewId();
        const payload =
          typeof malformed === "object" && malformed !== null
            ? { reviewId: id, action: "insert", ...malformed }
            : malformed;
        expect(() => decide?.({ payload })).not.toThrow();
        await flush(() => false);
        expect(getAppState().pendingPillReview?.id).toBe(id);
        decide?.({ payload: { reviewId: id, action: "insert" } });
        await flush(() => getAppState().pendingPillReview === null);
        expect(getAppState().pendingPillReview).toBeNull();
        await expect(pending).resolves.toBe("kept transcript");
      } finally {
        cancelAllPillReviews();
      }
    },
  );

  it("does not coerce a failed clipboard request into a log message", async () => {
    const pending = startPillReview("kept transcript");
    try {
      await flush(() => getAppState().pendingPillReview !== null);
      const toString = vi.fn(() => "private reviewed transcript");
      mocks.invoke.mockRejectedValueOnce({ toString });
      decide?.({ payload: { reviewId: currentReviewId(), action: "copy" } });
      await flush(() => mocks.logger.error.mock.calls.length > 0);
      expect(toString).not.toHaveBeenCalled();
      expect(mocks.logger.error).toHaveBeenCalledWith(
        "Failed to copy the reviewed transcript",
      );
      expect(mocks.showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            "Could not copy the reviewed text. The review remains open so you can retry.",
          toastType: "error",
          duration: 8000,
        }),
      );
      expect(mocks.showToast).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "open_transcriptions" }),
      );
      await cancelPillReview(pending);
    } finally {
      cancelAllPillReviews();
    }
  });

  it("cancels a review while listener registration is pending and releases the late listener", async () => {
    let finishRegistration: (unlisten: () => void) => void = () => undefined;
    const registration = new Promise<() => void>((resolve) => {
      finishRegistration = resolve;
    });
    mocks.listen.mockReturnValueOnce(registration);
    const unlisten = vi.fn();
    const pending = startPillReview("pending transcript");
    let settled = false;
    const outcome = pending.then((value) => {
      settled = true;
      return value;
    });
    try {
      cancelAllPillReviews();
      await flush(() => settled);
      expect(settled).toBe(true);
      await expect(outcome).resolves.toBeNull();
      finishRegistration(unlisten);
      await flush(() => unlisten.mock.calls.length > 0);
      expect(unlisten).toHaveBeenCalledOnce();
      expect(getAppState().pendingPillReview).toBeNull();
    } finally {
      finishRegistration(unlisten);
      await flush(() => false);
      cancelAllPillReviews();
      await pending;
    }
  });

  it("does not replace a new listener with an obsolete registration", async () => {
    let finishOld: (unlisten: () => void) => void = () => undefined;
    const oldRegistration = new Promise<() => void>((resolve) => {
      finishOld = resolve;
    });
    mocks.listen.mockReturnValueOnce(oldRegistration);
    const oldReview = startPillReview("old transcript");
    cancelAllPillReviews();
    const currentCleanup = vi.fn();
    mocks.listen.mockImplementationOnce((_event, listener) => {
      decide = listener;
      return Promise.resolve(currentCleanup);
    });
    const currentReview = startPillReview("current transcript");
    const oldCleanup = vi.fn();
    try {
      await flush(() => getAppState().pendingPillReview !== null);
      const currentId = currentReviewId();
      const obsoleteHandler = mocks.listen.mock.calls[0][1] as DecisionListener;
      obsoleteHandler({ payload: { reviewId: currentId, action: "insert" } });
      expect(getAppState().pendingPillReview?.id).toBe(currentId);
      finishOld(oldCleanup);
      await flush(() => oldCleanup.mock.calls.length > 0);
      expect(oldCleanup).toHaveBeenCalledOnce();
      expect(currentCleanup).not.toHaveBeenCalled();
      expect(
        getQueuedSessions().map((session) => session.originalText),
      ).toEqual(["current transcript"]);
      decide?.({ payload: { reviewId: currentId, action: "insert" } });
      await expect(currentReview).resolves.toBe("current transcript");
      await expect(oldReview).resolves.toBeNull();
      expect(currentCleanup).toHaveBeenCalledOnce();
    } finally {
      finishOld(oldCleanup);
      await flush(() => false);
      cancelAllPillReviews();
      await Promise.all([oldReview, currentReview]);
    }
  });

  it("does not clear a new setup promise when an obsolete registration rejects", async () => {
    let rejectOld: (error: Error) => void = () => undefined;
    let finishCurrent: (unlisten: () => void) => void = () => undefined;
    mocks.listen.mockReturnValueOnce(
      new Promise<() => void>((_resolve, reject) => {
        rejectOld = reject;
      }),
    );
    const oldReview = startPillReview("old transcript");
    cancelAllPillReviews();
    mocks.listen.mockReturnValueOnce(
      new Promise<() => void>((resolve) => {
        finishCurrent = resolve;
      }),
    );
    const currentReview = startPillReview("current transcript");
    let queuedReview: Promise<string | null> | undefined;
    try {
      rejectOld(new Error("obsolete setup failed"));
      await flush(() => false);
      queuedReview = startPillReview("queued transcript");
      expect(mocks.listen).toHaveBeenCalledTimes(2);
      finishCurrent(vi.fn());
      await flush(() => getQueuedSessions().length === 2);
      expect(
        getQueuedSessions().map((session) => session.originalText),
      ).toEqual(["current transcript", "queued transcript"]);
      expect(mocks.reviewTextInComposer).not.toHaveBeenCalled();
    } finally {
      finishCurrent(vi.fn());
      await flush(() => false);
      cancelAllPillReviews();
      await Promise.all([oldReview, currentReview, queuedReview]);
    }
  });
  it("publishes the transcript to the pill and inserts it on Insert", async () => {
    const pending = startPillReview("hello world");
    await flush(() => getAppState().pendingPillReview !== null);

    expect(getAppState().pendingPillReview?.text).toBe("hello world");

    decide?.({
      payload: { reviewId: currentReviewId(), action: "insert" },
    });

    await expect(pending).resolves.toBe("hello world");
    expect(getAppState().pendingPillReview).toBeNull();
  });

  it("returns null and keeps the transcript out of the target on Cancel", async () => {
    const pending = startPillReview("draft");
    await flush(() => getAppState().pendingPillReview !== null);

    await cancelPillReview(pending);
  });

  it("copies to the clipboard instead of inserting on Copy", async () => {
    const pending = startPillReview("copy me");
    await flush(() => getAppState().pendingPillReview !== null);

    decide?.({ payload: { reviewId: currentReviewId(), action: "copy" } });

    await expect(pending).resolves.toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("copy_to_clipboard", {
      text: "copy me",
    });
  });

  it("reports a successful assistant-tool Copy decision to its caller", async () => {
    const onCopy = vi.fn();
    const pending = reviewTranscriptOnPill("copy me", "assistant-tool", {
      onCopy,
    });
    await flush(() => getAppState().pendingPillReview !== null);

    decide?.({ payload: { reviewId: currentReviewId(), action: "copy" } });

    await expect(pending).resolves.toBeNull();
    expect(onCopy).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("copy_to_clipboard", {
      text: "copy me",
    });
  });

  it("recovers when a clipboard hand-off stalls and remains retryable", async () => {
    vi.useFakeTimers();
    let first: Promise<string | null> | null = null;
    let releaseStalledCopy: (() => void) | undefined;
    try {
      mocks.invoke
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              releaseStalledCopy = resolve;
            }),
        )
        .mockImplementationOnce(() => Promise.resolve());
      first = startPillReview("copy me");
      await flush(() => getAppState().pendingPillReview !== null);
      const id = currentReviewId();
      const second = startPillReview("queued review");
      await flush(() => getQueuedSessions().length === 2);

      decide?.({ payload: { reviewId: id, action: "copy" } });
      await flush(() => mocks.invoke.mock.calls.length === 1);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(getAppState().pendingPillReview).toEqual({ id, text: "copy me" });
      expect(getReviewSession(id)?.status).toBe("open");
      expect(getQueuedSessions()).toHaveLength(2);

      decide?.({ payload: { reviewId: id, action: "copy" } });
      await expect(first).resolves.toBeNull();
      expect(getReviewSession(id)?.decision).toBe("copy");
      expect(getAppState().pendingPillReview?.text).toBe("queued review");
      await cancelPillReview(second);
    } finally {
      releaseStalledCopy?.();
      cancelAllPillReviews();
      vi.useRealTimers();
    }
  });

  it("keeps a failed copy open with its edited draft and lets the user retry", async () => {
    const first = startPillReview("original");
    await flush(() => getAppState().pendingPillReview !== null);
    const id = currentReviewId();
    const second = startPillReview("queued");
    await flush(() => getQueuedSessions().length === 2);
    const resolved = vi.fn();
    // Deliberately not awaited: the assertion under test is that this
    // rejection is swallowed by the review path, which `resolved` records.
    // `.then` with no rejection handler would surface as an unhandled
    // rejection, so attach one that is itself asserted to be uncalled.
    first.then(resolved, () => undefined);
    mocks.invoke.mockRejectedValueOnce(new Error("clipboard unavailable"));
    decide?.({
      payload: { reviewId: id, action: "copy", text: "edited draft" },
    });
    await flush(() => false);

    expect(resolved).not.toHaveBeenCalled();
    expect(getAppState().pendingPillReview).toEqual({
      id,
      text: "edited draft",
    });
    expect(getReviewSession(id)?.status).toBe("open");
    expect(getQueuedSessions()).toHaveLength(2);

    decide?.({
      payload: { reviewId: id, action: "copy", text: "edited draft" },
    });
    await expect(first).resolves.toBeNull();
    expect(mocks.invoke).toHaveBeenLastCalledWith("copy_to_clipboard", {
      text: "edited draft",
    });
    expect(getReviewSession(id)?.decision).toBe("copy");
    expect(getAppState().pendingPillReview?.text).toBe("queued");
    await cancelPillReview(second);
  });

  it("does not republish a cancelled copy when its clipboard failure arrives late", async () => {
    const first = startPillReview("old review");
    await flush(() => getAppState().pendingPillReview !== null);
    const id = currentReviewId();
    let rejectCopy!: (error: Error) => void;
    mocks.invoke.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectCopy = reject;
      }),
    );
    decide?.({ payload: { reviewId: id, action: "copy" } });
    cancelAllPillReviews();
    await expect(first).resolves.toBeNull();
    const second = startPillReview("new review");
    await flush(() => getAppState().pendingPillReview !== null);
    const secondId = currentReviewId();
    rejectCopy(new Error("clipboard unavailable"));
    await flush(() => false);
    expect(getAppState().pendingPillReview).toEqual({
      id: secondId,
      text: "new review",
    });
    expect(getQueuedSessions()).toHaveLength(1);
    await cancelPillReview(second);
  });

  it("inserts the text edited in the pill panel, not the original", async () => {
    const pending = startPillReview("rough text");
    await flush(() => getAppState().pendingPillReview !== null);

    decide?.({
      payload: {
        reviewId: currentReviewId(),
        action: "insert",
        text: "edited in the pill",
      },
    });

    await expect(pending).resolves.toBe("edited in the pill");
    // Editing happens on the pill, so no window is opened for it.
    expect(mocks.reviewTextInComposer).not.toHaveBeenCalled();
  });

  it("copies the edited text rather than the original on Copy", async () => {
    const pending = startPillReview("rough text");
    await flush(() => getAppState().pendingPillReview !== null);

    decide?.({
      payload: {
        reviewId: currentReviewId(),
        action: "copy",
        text: "edited before copying",
      },
    });

    await expect(pending).resolves.toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("copy_to_clipboard", {
      text: "edited before copying",
    });
  });

  it("falls back to the transcript when the pill sends an empty edit", async () => {
    const pending = startPillReview("original words");
    await flush(() => getAppState().pendingPillReview !== null);

    decide?.({
      payload: { reviewId: currentReviewId(), action: "insert", text: "   " },
    });

    await expect(pending).resolves.toBe("original words");
  });

  it("queues a second transcript behind the one on the pill", async () => {
    const first = startPillReview("first");
    await flush(() => getAppState().pendingPillReview !== null);
    const firstId = currentReviewId();

    const second = reviewTranscriptOnPill("second");
    await flush(() => true);

    // The pill still shows the first transcript: the second one waits.
    expect(getAppState().pendingPillReview?.id).toBe(firstId);
    expect(getAppState().pendingPillReview?.text).toBe("first");

    decide?.({ payload: { reviewId: firstId, action: "insert" } });
    await expect(first).resolves.toBe("first");

    await flush(() => getAppState().pendingPillReview?.text === "second");
    expect(getAppState().pendingPillReview?.text).toBe("second");

    await cancelPillReview(second);
    expect(getAppState().pendingPillReview).toBeNull();
  });

  it("ignores a decision for a review that is no longer on the pill", async () => {
    const pending = startPillReview("current");
    await flush(() => getAppState().pendingPillReview !== null);

    decide?.({ payload: { reviewId: "stale-id", action: "insert" } });
    await flush(() => false);

    // The stale click neither resolved nor replaced the live review.
    expect(getAppState().pendingPillReview?.text).toBe("current");

    await cancelPillReview(pending);
  });

  it("settles the review when the listener-failure composer accepts text", async () => {
    const idSpy = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000001");
    try {
      mocks.listen.mockRejectedValueOnce(new Error("no event bus"));
      mocks.reviewTextInComposer.mockResolvedValue("from the composer");

      await expect(reviewTranscriptOnPill("stranded")).resolves.toBe(
        "from the composer",
      );
      // Nothing was queued, so the next review can still use the pill.
      expect(getAppState().pendingPillReview).toBeNull();
      expect(mocks.reviewTextInComposer).toHaveBeenCalledWith(
        "stranded",
        expect.objectContaining({ source: "dictation" }),
      );
      expect(
        getReviewSession("00000000-0000-4000-8000-000000000001"),
      ).toMatchObject({
        status: "decided",
        decision: "insert",
        draftText: "from the composer",
      });
    } finally {
      idSpy.mockRestore();
    }
  });

  it("marks a listener-fallback composer expiry as expired", async () => {
    const id = "00000000-0000-4000-8000-000000000002";
    const idSpy = vi.spyOn(crypto, "randomUUID").mockReturnValue(id);
    try {
      mocks.listen.mockRejectedValueOnce(new Error("no event bus"));
      mocks.reviewTextInComposer.mockImplementationOnce(
        (_text: string, options?: { onExpire?: () => void }) => {
          options?.onExpire?.();
          return Promise.resolve(null);
        },
      );

      await expect(reviewTranscriptOnPill("stranded")).resolves.toBeNull();
      expect(getReviewSession(id)?.status).toBe("expired");
      expect(getReviewSession(id)?.decision).toBeNull();
    } finally {
      idSpy.mockRestore();
    }
  });

  it("gives up on a review nobody answers instead of blocking the insert", async () => {
    vi.useFakeTimers();
    try {
      const pending = reviewTranscriptOnPill("ignored");
      await flush(() => getAppState().pendingPillReview !== null);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      await expect(pending).resolves.toBeNull();
      expect(getAppState().pendingPillReview).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an unknown action instead of resolving the review", async () => {
    const pending = startPillReview("safe");
    await flush(() => getAppState().pendingPillReview !== null);

    decide?.({ payload: { reviewId: currentReviewId(), action: "explode" } });
    await flush(() => false);

    expect(getAppState().pendingPillReview?.text).toBe("safe");

    await cancelPillReview(pending);
  });

  it("records source, queued status, and timestamps on enqueue", async () => {
    const pending = startPillReview("rough take", "assistant-tool");
    await flush(() => getAppState().pendingPillReview !== null);

    const [queued] = getQueuedSessions();
    const session = getReviewSession(queued.id);
    expect(session?.originalText).toBe("rough take");
    expect(session?.source).toBe("assistant-tool");
    expect(session?.status).toBe("open");
    expect(queued).toEqual(session);
    expect(session?.queuePosition).toBe(0);
    expect(session?.decision).toBeNull();
    expect(session?.createdAt).toBeLessThanOrEqual(Date.now());

    await cancelPillReview(pending);
  });

  it("defaults the source to dictation", async () => {
    const pending = startPillReview("spoken words");
    await flush(() => getAppState().pendingPillReview !== null);

    const [queued] = getQueuedSessions();
    expect(getReviewSession(queued.id)?.source).toBe("dictation");

    await cancelPillReview(pending);
  });

  it("positions queued sessions behind the open head", async () => {
    const first = startPillReview("first");
    await flush(() => getAppState().pendingPillReview !== null);
    const second = reviewTranscriptOnPill("second");
    await flush(() => getQueuedSessions().length === 2);

    const [head, tail] = getQueuedSessions();
    expect(head.status).toBe("open");
    expect(head.queuePosition).toBe(0);
    expect(tail.status).toBe("queued");
    expect(tail.queuePosition).toBe(1);

    decide?.({ payload: { reviewId: head.id, action: "cancel" } });
    await expect(first).resolves.toBeNull();
    expect(getQueuedSessions()[0]).toEqual(getReviewSession(tail.id));
    expect(getQueuedSessions()[0].status).toBe("open");
    decide?.({ payload: { reviewId: tail.id, action: "cancel" } });
    await expect(second).resolves.toBeNull();
  });

  it("records the draft on the decided session", async () => {
    const pending = startPillReview("rough take");
    await flush(() => getAppState().pendingPillReview !== null);
    const id = currentReviewId();

    decide?.({
      payload: { reviewId: id, action: "insert", text: "polished take" },
    });
    await expect(pending).resolves.toBe("polished take");

    const session = getReviewSession(id);
    expect(session?.status).toBe("decided");
    expect(session?.decision).toBe("insert");
    expect(session?.draftText).toBe("polished take");
    expect(session?.decidedAt).not.toBeNull();
  });

  it("pauses expiry while clipboard insertion is pending", async () => {
    vi.useFakeTimers();
    let finishClipboard: (() => void) | undefined;
    const onExpire = vi.fn();
    const onCopy = vi.fn();
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClipboard = resolve;
        }),
    );
    try {
      const pending = reviewTranscriptOnPill("rough take", "assistant-tool", {
        onExpire,
        onCopy,
      });
      await flush(() => getAppState().pendingPillReview !== null);
      const id = currentReviewId();
      decide?.({ payload: { reviewId: id, action: "copy" } });
      await flush(() => mocks.invoke.mock.calls.length > 0);

      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(getReviewSession(id)?.status).toBe("open");
      expect(onExpire).not.toHaveBeenCalled();

      finishClipboard?.();
      await expect(pending).resolves.toBeNull();
      expect(onCopy).toHaveBeenCalledOnce();
    } finally {
      finishClipboard?.();
      cancelAllPillReviews();
      vi.useRealTimers();
    }
  });

  it("transfers the timeout to the composer without rearming it on enqueue", async () => {
    vi.useFakeTimers();
    // Replaced by the Promise executor below; the initializer only types the
    // binding until that runs.
    let complete: (value: string | null) => void = () => undefined;
    mocks.reviewTextInComposer.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          complete = resolve;
        }),
    );
    try {
      const pending = startPillReview("first");
      const resolved = vi.fn();
      // Not awaited on purpose: the test asserts `resolved` was never called
      // across the transferred timeout. The rejection handler keeps a late
      // rejection from escaping as an unhandled rejection.
      pending.then(resolved, () => undefined);
      await flush(() => getAppState().pendingPillReview !== null);
      const id = currentReviewId();
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      decide?.({ payload: { reviewId: id, action: "edit" } });
      await flush(() => mocks.reviewTextInComposer.mock.calls.length > 0);
      const second = startPillReview("second");
      await flush(() => getQueuedSessions().length === 2);
      expect(getAppState().pendingPillReview).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(61 * 1000);
      expect(resolved).not.toHaveBeenCalled();
      expect(getReviewSession(id)?.status).toBe("open");
      complete("edited");
      await expect(pending).resolves.toBe("edited");
      expect(getAppState().pendingPillReview?.text).toBe("second");
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await expect(second).resolves.toBeNull();
      expect(getReviewSession(id)?.status).toBe("decided");
    } finally {
      complete(null);
      cancelAllPillReviews();
      await flush(() => false);
      vi.useRealTimers();
    }
  });

  it("ignores a late composer result after cancellation and a new review", async () => {
    // Replaced by the Promise executor below; the initializer only types the
    // binding until that runs.
    let complete: (value: string | null) => void = () => undefined;
    mocks.reviewTextInComposer.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          complete = resolve;
        }),
    );
    const first = startPillReview("first");
    await flush(() => getAppState().pendingPillReview !== null);
    const firstId = currentReviewId();
    decide?.({ payload: { reviewId: firstId, action: "edit" } });
    cancelAllPillReviews();
    await expect(first).resolves.toBeNull();
    const second = startPillReview("second");
    await flush(() => getAppState().pendingPillReview !== null);
    const secondId = currentReviewId();
    complete("late edit");
    await flush(() => false);
    expect(getAppState().pendingPillReview?.id).toBe(secondId);
    expect(getReviewSession(firstId)?.status).toBe("cancelled");
    await cancelPillReview(second);
  });

  it("restores a timed pill review when the composer rejects", async () => {
    vi.useFakeTimers();
    mocks.reviewTextInComposer.mockRejectedValueOnce(
      new Error("composer failed"),
    );
    try {
      const pending = startPillReview("retry me");
      await flush(() => getAppState().pendingPillReview !== null);
      const id = currentReviewId();
      decide?.({ payload: { reviewId: id, action: "edit" } });
      await flush(() => getReviewSession(id)?.presentation === "pill");
      expect(getReviewSession(id)?.presentation).toBe("pill");
      expect(getAppState().pendingPillReview?.id).toBe(id);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await expect(pending).resolves.toBeNull();
    } finally {
      cancelAllPillReviews();
      vi.useRealTimers();
    }
  });

  it("hands Edit to the composer and settles with its result", async () => {
    mocks.reviewTextInComposer.mockResolvedValueOnce("composed take");
    const pending = startPillReview("rough take");
    await flush(() => getAppState().pendingPillReview !== null);
    const id = currentReviewId();

    decide?.({
      payload: { reviewId: id, action: "edit", text: "pill edit" },
    });
    await expect(pending).resolves.toBe("composed take");

    expect(mocks.reviewTextInComposer).toHaveBeenCalledWith(
      "pill edit",
      expect.objectContaining({
        originalText: "rough take",
        source: "dictation",
      }),
    );
    const session = getReviewSession(id);
    expect(session?.status).toBe("decided");
    expect(session?.decision).toBe("edit");
    expect(session?.presentation).toBe("composer");
    expect(session?.draftText).toBe("composed take");
  });

  it("does not open a composer for assistant-tool Open without a conversation", async () => {
    const pending = reviewTranscriptOnPill("agent text", "assistant-tool");
    await flush(() => getAppState().pendingPillReview !== null);
    const id = currentReviewId();

    decide?.({ payload: { reviewId: id, action: "open" } });
    await flush(() => mocks.showToast.mock.calls.length > 0);

    expect(getAppState().pendingPillReview).toEqual({ id, text: "agent text" });
    expect(mocks.reviewTextInComposer).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("without an active conversation"),
        toastType: "error",
      }),
    );

    decide?.({ payload: { reviewId: id, action: "insert" } });
    await expect(pending).resolves.toBe("agent text");
  });

  it("hands agent Paste Open to its durable Chats callback", async () => {
    const onOpen = vi.fn(() => Promise.resolve());
    const { id, pending } = await beginAssistantToolOpen(onOpen);
    await expect(pending).resolves.toBeNull();

    expect(onOpen).toHaveBeenCalledWith("pill draft", expect.any(AbortSignal));
    expect(mocks.reviewTextInComposer).not.toHaveBeenCalled();
    const session = getReviewSession(id);
    expect(session?.status).toBe("decided");
    expect(session?.decision).toBe("open");
    expect(session?.draftText).toBe("pill draft");
  });

  it("aborts an Open hand-off when its review is dismissed during save", async () => {
    let finishSave: (() => void) | undefined;
    let openSignal: AbortSignal | undefined;
    const opened = vi.fn();
    const onOpen = vi.fn((_text: string, signal?: AbortSignal) => {
      if (!signal) throw new Error("expected the Open cancellation signal");
      openSignal = signal;
      return new Promise<void>((resolve) => {
        finishSave = () => {
          if (!signal.aborted) opened();
          resolve();
        };
      });
    });
    const { id, pending } = await beginAssistantToolOpen(onOpen);
    await flush(() => onOpen.mock.calls.length > 0);

    cancelAllPillReviews();
    await expect(pending).resolves.toBeNull();
    expect(openSignal?.aborted).toBe(true);
    finishSave?.();
    await flush(() => false);

    expect(opened).not.toHaveBeenCalled();
    expect(getReviewSession(id)?.status).toBe("cancelled");
  });

  it("keeps agent Paste review open when its Open hand-off cannot be saved", async () => {
    const onOpen = vi.fn(() => Promise.reject(new Error("disk full")));
    const { id, pending } = await beginAssistantToolOpen(onOpen);
    await flush(() => mocks.logger.error.mock.calls.length > 0);

    expect(getAppState().pendingPillReview?.id).toBe(id);
    expect(getReviewSession(id)?.status).toBe("open");
    expect(mocks.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ toastType: "error" }),
    );
    await cancelPillReview(pending);
  });

  it("recovers when an Open hand-off save stalls and remains retryable", async () => {
    vi.useFakeTimers();
    let finishOpen: () => void = () => undefined;
    let openSignal: AbortSignal | undefined;
    try {
      const onExpire = vi.fn();
      const onOpen = vi
        .fn()
        .mockImplementationOnce((_text: string, signal: AbortSignal) => {
          openSignal = signal;
          return new Promise<void>((resolve) => {
            finishOpen = resolve;
          });
        })
        .mockImplementationOnce(() => Promise.resolve());
      const pending = reviewTranscriptOnPill("rough take", "assistant-tool", {
        onOpen,
        onExpire,
      });
      await flush(() => getAppState().pendingPillReview !== null);

      const id = currentReviewId();
      decide?.({
        payload: { reviewId: id, action: "open", text: "pill draft" },
      });
      await flush(() => onOpen.mock.calls.length > 0);
      const next = startPillReview("next review");
      await flush(() => getQueuedSessions().length === 2);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(getReviewSession(id)?.status).toBe("open");
      expect(getAppState().pendingPillReview?.id).toBe(id);
      expect(onExpire).not.toHaveBeenCalled();
      expect(openSignal?.aborted).toBe(true);
      expect(mocks.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ toastType: "error" }),
      );

      decide?.({
        payload: { reviewId: id, action: "open", text: "pill draft" },
      });
      await expect(pending).resolves.toBeNull();
      expect(onOpen).toHaveBeenCalledTimes(2);
      expect(getReviewSession(id)?.status).toBe("decided");
      expect(getReviewSession(id)?.decision).toBe("open");
      expect(getAppState().pendingPillReview?.text).toBe("next review");
      await cancelPillReview(next);
    } finally {
      finishOpen();
      cancelAllPillReviews();
      vi.useRealTimers();
    }
  });

  it("preserves composer expiry instead of recording an unanswered Edit as cancel", async () => {
    const onExpire = vi.fn();
    mocks.reviewTextInComposer.mockImplementationOnce(
      (_text: string, options?: { onExpire?: () => void }) => {
        options?.onExpire?.();
        return Promise.resolve(null);
      },
    );
    const pending = reviewTranscriptOnPill("rough take", "assistant-tool", {
      onExpire,
    });
    await flush(() => getAppState().pendingPillReview !== null);

    const id = currentReviewId();
    decide?.({ payload: { reviewId: id, action: "edit" } });
    await expect(pending).resolves.toBeNull();

    expect(getReviewSession(id)?.status).toBe("expired");
    expect(getReviewSession(id)?.decision).toBeNull();
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("records a composer setup failure instead of an explicit cancel", async () => {
    const onFailure = vi.fn();
    mocks.reviewTextInComposer.mockImplementationOnce(
      (_text: string, options?: { onFailure?: () => void }) => {
        options?.onFailure?.();
        return Promise.resolve(null);
      },
    );
    const pending = reviewTranscriptOnPill("rough take", "assistant-tool", {
      onFailure,
    });
    await flush(() => getAppState().pendingPillReview !== null);

    const id = currentReviewId();
    decide?.({ payload: { reviewId: id, action: "edit" } });
    await expect(pending).resolves.toBeNull();

    expect(getReviewSession(id)?.status).toBe("failed");
    expect(getReviewSession(id)?.decision).toBeNull();
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("does not overwrite teardown cancellation with a late composer expiry", async () => {
    let expireReview: (() => void) | undefined;
    let finishComposer!: (value: string | null) => void;
    mocks.reviewTextInComposer.mockImplementationOnce(
      (_text: string, options?: { onExpire?: () => void }) =>
        new Promise<string | null>((resolve) => {
          expireReview = options?.onExpire;
          finishComposer = resolve;
        }),
    );
    const pending = reviewTranscriptOnPill("rough take", "assistant-tool");
    await flush(() => getAppState().pendingPillReview !== null);
    const id = currentReviewId();
    decide?.({ payload: { reviewId: id, action: "edit" } });
    await flush(() => expireReview !== undefined);

    cancelAllPillReviews();
    await expect(pending).resolves.toBeNull();
    expireReview?.();
    finishComposer(null);
    await flush(() => false);

    expect(getReviewSession(id)?.status).toBe("cancelled");
  });

  it("delegates dictation Open to the composer", async () => {
    mocks.reviewTextInComposer.mockResolvedValueOnce("composed from open");
    const pending = startPillReview("rough take");
    await flush(() => getAppState().pendingPillReview !== null);

    const id = currentReviewId();
    decide?.({
      payload: { reviewId: id, action: "open", text: "pill draft" },
    });
    await expect(pending).resolves.toBe("composed from open");

    expect(mocks.reviewTextInComposer).toHaveBeenCalledWith(
      "pill draft",
      expect.objectContaining({
        originalText: "rough take",
        source: "dictation",
      }),
    );
    const session = getReviewSession(id);
    expect(session?.status).toBe("decided");
    expect(session?.decision).toBe("open");
    expect(session?.presentation).toBe("composer");
    expect(session?.draftText).toBe("composed from open");
  });

  it("falls back to the original when the pill sends an empty edit for Edit", async () => {
    mocks.reviewTextInComposer.mockResolvedValueOnce("composed take");
    const pending = startPillReview("rough take");
    await flush(() => getAppState().pendingPillReview !== null);

    decide?.({
      payload: { reviewId: currentReviewId(), action: "edit", text: "   " },
    });
    await expect(pending).resolves.toBe("composed take");

    expect(mocks.reviewTextInComposer).toHaveBeenCalledWith(
      "rough take",
      expect.objectContaining({
        originalText: "rough take",
        source: "dictation",
      }),
    );
  });

  it("does not extend the open review timeout when more reviews queue", async () => {
    vi.useFakeTimers();
    try {
      const first = startPillReview("first review");
      await flush(() => getAppState().pendingPillReview !== null);
      const firstId = currentReviewId();
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);

      const second = startPillReview("second review");
      await flush(() => getQueuedSessions().length === 2);
      await vi.advanceTimersByTimeAsync(60_001);

      await expect(first).resolves.toBeNull();
      expect(getReviewSession(firstId)?.status).toBe("expired");
      expect(getAppState().pendingPillReview?.text).toBe("second review");
      await cancelPillReview(second);
    } finally {
      cancelAllPillReviews();
      vi.useRealTimers();
    }
  });

  it("expires unanswered reviews and offers the history route", async () => {
    vi.useFakeTimers();
    try {
      const pending = reviewTranscriptOnPill("ignored");
      await flush(() => getAppState().pendingPillReview !== null);
      const id = currentReviewId();

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      await expect(pending).resolves.toBeNull();
      expect(getAppState().pendingPillReview).toBeNull();
      expect(getReviewSession(id)?.status).toBe("expired");
      expect(mocks.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ action: "open_transcriptions" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires agent Paste reviews without claiming the text is in History", async () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      const pending = reviewTranscriptOnPill(
        "agent paste text",
        "assistant-tool",
        {
          onExpire,
        },
      );
      await flush(() => getAppState().pendingPillReview !== null);
      const id = currentReviewId();

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      await expect(pending).resolves.toBeNull();
      expect(getReviewSession(id)?.status).toBe("expired");
      expect(onExpire).toHaveBeenCalledOnce();
      const expiryToast = mocks.showToast.mock.lastCall?.[0];
      expect(expiryToast).toEqual(
        expect.objectContaining({
          message:
            "Paste review expired. Nothing was inserted. Run Paste again to retry.",
          toastType: "info",
          duration: 8000,
        }),
      );
      expect(expiryToast).not.toHaveProperty("action");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the unanswered-review timer when teardown empties the queue", async () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      const pending = reviewTranscriptOnPill("first", "assistant-tool", {
        onExpire,
      });
      await flush(() => getAppState().pendingPillReview !== null);

      cancelAllPillReviews();
      await expect(pending).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(onExpire).not.toHaveBeenCalled();
    } finally {
      cancelAllPillReviews();
      vi.useRealTimers();
    }
  });

  it("marks queued reviews cancelled on teardown", async () => {
    const first = startPillReview("first");
    await flush(() => getAppState().pendingPillReview !== null);
    const second = reviewTranscriptOnPill("second");
    await flush(() => getQueuedSessions().length === 2);
    const ids = getQueuedSessions().map((session) => session.id);

    cancelAllPillReviews();
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();

    for (const id of ids) {
      expect(getReviewSession(id)?.status).toBe("cancelled");
    }
  });

  it("returns null for an unknown session id", () => {
    expect(getReviewSession("never-enqueued")).toBeNull();
  });

  it("reviews in the composer without touching the pill when no pill exists", async () => {
    mocks.isNativePillAvailable.mockResolvedValue(false);
    mocks.reviewTextInComposer.mockResolvedValueOnce("composed take");

    await expect(
      reviewTranscriptBeforeInsert("rough take", "assistant-tool"),
    ).resolves.toBe("composed take");

    expect(mocks.reviewTextInComposer).toHaveBeenCalledWith(
      "rough take",
      expect.objectContaining({ source: "assistant-tool" }),
    );
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(getAppState().pendingPillReview).toBeNull();
    expect(getQueuedSessions()).toEqual([]);
  });

  it("uses the pill when one is available", async () => {
    mocks.isNativePillAvailable.mockResolvedValue(true);
    const pending = reviewTranscriptBeforeInsert("spoken words");
    await flush(() => getAppState().pendingPillReview !== null);

    expect(getAppState().pendingPillReview?.text).toBe("spoken words");
    expect(mocks.reviewTextInComposer).not.toHaveBeenCalled();

    await cancelPillReview(pending);
  });
});
