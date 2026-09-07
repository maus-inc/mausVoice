import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const invoke = vi.fn();
  const listen = vi.fn();
  const reviewTextInComposer = vi.fn();
  return { invoke, listen, reviewTextInComposer };
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
  runToast: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  }),
}));

import {
  cancelAllPillReviews,
  reviewTranscriptOnPill,
} from "./pill-review.actions";
import { getAppState } from "../store";

type DecisionListener = (event: {
  payload: { reviewId: string; action: string; text?: string | null };
}) => void;

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

describe("reviewTranscriptOnPill", () => {
  beforeEach(() => {
    cancelAllPillReviews();
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation(() => Promise.resolve());
    mocks.reviewTextInComposer.mockReset();
    decide = null;
    mocks.listen.mockReset();
    mocks.listen.mockImplementation((_event: string, cb: unknown) => {
      decide = cb as DecisionListener;
      return Promise.resolve(vi.fn());
    });
  });

  it("publishes the transcript to the pill and inserts it on Insert", async () => {
    const pending = reviewTranscriptOnPill("hello world");
    await flush(() => getAppState().pendingPillReview !== null);

    expect(getAppState().pendingPillReview?.text).toBe("hello world");

    decide?.({
      payload: { reviewId: currentReviewId(), action: "insert" },
    });

    await expect(pending).resolves.toBe("hello world");
    expect(getAppState().pendingPillReview).toBeNull();
  });

  it("returns null and keeps the transcript out of the target on Cancel", async () => {
    const pending = reviewTranscriptOnPill("draft");
    await flush(() => getAppState().pendingPillReview !== null);

    decide?.({ payload: { reviewId: currentReviewId(), action: "cancel" } });

    await expect(pending).resolves.toBeNull();
  });

  it("copies to the clipboard instead of inserting on Copy", async () => {
    const pending = reviewTranscriptOnPill("copy me");
    await flush(() => getAppState().pendingPillReview !== null);

    decide?.({ payload: { reviewId: currentReviewId(), action: "copy" } });

    await expect(pending).resolves.toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("copy_to_clipboard", {
      text: "copy me",
    });
  });

  it("inserts the text edited in the pill panel, not the original", async () => {
    const pending = reviewTranscriptOnPill("rough text");
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
    const pending = reviewTranscriptOnPill("rough text");
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
    const pending = reviewTranscriptOnPill("original words");
    await flush(() => getAppState().pendingPillReview !== null);

    decide?.({
      payload: { reviewId: currentReviewId(), action: "insert", text: "   " },
    });

    await expect(pending).resolves.toBe("original words");
  });

  it("queues a second transcript behind the one on the pill", async () => {
    const first = reviewTranscriptOnPill("first");
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

    decide?.({ payload: { reviewId: currentReviewId(), action: "cancel" } });
    await expect(second).resolves.toBeNull();
    expect(getAppState().pendingPillReview).toBeNull();
  });

  it("ignores a decision for a review that is no longer on the pill", async () => {
    const pending = reviewTranscriptOnPill("current");
    await flush(() => getAppState().pendingPillReview !== null);

    decide?.({ payload: { reviewId: "stale-id", action: "insert" } });
    await flush(() => false);

    // The stale click neither resolved nor replaced the live review.
    expect(getAppState().pendingPillReview?.text).toBe("current");

    decide?.({ payload: { reviewId: currentReviewId(), action: "cancel" } });
    await expect(pending).resolves.toBeNull();
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
    const pending = reviewTranscriptOnPill("safe");
    await flush(() => getAppState().pendingPillReview !== null);

    decide?.({ payload: { reviewId: currentReviewId(), action: "explode" } });
    await flush(() => false);

    expect(getAppState().pendingPillReview?.text).toBe("safe");

    decide?.({ payload: { reviewId: currentReviewId(), action: "cancel" } });
    await expect(pending).resolves.toBeNull();
  });
});
