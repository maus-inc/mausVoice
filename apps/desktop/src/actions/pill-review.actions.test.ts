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

  it("keeps a failed copy open with its edited draft and lets the user retry", async () => {
    const first = startPillReview("original");
    await flush(() => getAppState().pendingPillReview !== null);
    const id = currentReviewId();
    const second = startPillReview("queued");
    await flush(() => getQueuedSessions().length === 2);
    const resolved = vi.fn();
    void first.then(resolved);
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

  it("falls back to the composer when the decision listener cannot be registered", async () => {
    mocks.listen.mockRejectedValueOnce(new Error("no event bus"));
    mocks.reviewTextInComposer.mockResolvedValue("from the composer");

    await expect(reviewTranscriptOnPill("stranded")).resolves.toBe(
      "from the composer",
    );
    // Nothing was queued, so the next review can still use the pill.
    expect(getAppState().pendingPillReview).toBeNull();
    expect(mocks.reviewTextInComposer).toHaveBeenCalledWith("stranded");
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

  it("transfers the timeout to the composer without rearming it on enqueue", async () => {
    vi.useFakeTimers();
    let complete = (_value: string | null) => {};
    mocks.reviewTextInComposer.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          complete = resolve;
        }),
    );
    try {
      const pending = startPillReview("first");
      const resolved = vi.fn();
      void pending.then(resolved);
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
    let complete = (_value: string | null) => {};
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

    expect(mocks.reviewTextInComposer).toHaveBeenCalledWith("pill edit", {
      originalText: "rough take",
    });
    const session = getReviewSession(id);
    expect(session?.status).toBe("decided");
    expect(session?.decision).toBe("edit");
    expect(session?.presentation).toBe("composer");
    expect(session?.draftText).toBe("composed take");
  });

  it("delegates to the composer when the pill sends an Open action", async () => {
    mocks.reviewTextInComposer.mockResolvedValueOnce("composed from open");
    const pending = startPillReview("rough take");
    await flush(() => getAppState().pendingPillReview !== null);

    const id = currentReviewId();
    decide?.({
      payload: { reviewId: id, action: "open", text: "pill draft" },
    });
    await expect(pending).resolves.toBe("composed from open");

    expect(mocks.reviewTextInComposer).toHaveBeenCalledWith("pill draft", {
      originalText: "rough take",
    });
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

    expect(mocks.reviewTextInComposer).toHaveBeenCalledWith("rough take", {
      originalText: "rough take",
    });
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

    expect(mocks.reviewTextInComposer).toHaveBeenCalledWith("rough take");
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
