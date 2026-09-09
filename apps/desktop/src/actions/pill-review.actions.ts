import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getIntl } from "../i18n/intl";
import { produceAppState } from "../store";
import { reviewTextInComposer } from "../utils/composer.utils";
import { isNativePillAvailable } from "../utils/native-pill.utils";
import { createId } from "../utils/id.utils";
import { getLogger } from "../utils/log.utils";
import { runToast, showToast } from "./toast.actions";
import type { ReviewDecision } from "../types/review.types";

/**
 * Review-before-insert on the native pill.
 *
 * The transcript opens in the pill's own assistant panel, the surface the user
 * is already looking at, with the text loaded into the panel's entry so it can
 * be edited in place. Nothing opens in a separate window. The pill shows one
 * transcript at a time, so concurrent ones queue here and are presented in
 * arrival order; the queue never drops one silently.
 */
export type PillReviewAction = "insert" | "copy" | "cancel" | "open";

/** Returns true only after the caller durably preserved an Open edit. */
export type ReviewOpenHandler = (editedText: string) => Promise<boolean>;

export type PendingPillReview = {
  id: string;
  text: string;
};

type QueuedReview = {
  review: PendingPillReview;
  onOpen: ReviewOpenHandler | undefined;
  resolve: (decision: ReviewDecision) => void;
  /** Set while a decision runs, so a second click cannot start it twice. */
  busy: boolean;
};

/**
 * How long a card may sit unanswered on the pill. Same cap as the composer
 * window: an ignored review must not block the output path forever. The
 * original text remains in dictation History or in the agent tool-call record
 * when the review expires.
 */
const REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

const queue: QueuedReview[] = [];
let unlistenDecision: (() => void) | null = null;
let listenerSetup: Promise<void> | null = null;
let timeoutId: ReturnType<typeof setTimeout> | null = null;

const head = (): QueuedReview | undefined => queue[0];

const stopListening = (): void => {
  unlistenDecision?.();
  unlistenDecision = null;
  listenerSetup = null;
};

/**
 * Move the queue on and show whatever is left at its head.
 *
 * `answer` finishes the review currently on the pill and is only passed by
 * callers that have already checked it is still the open one. Publishing
 * happens before the answer is handed back, so the caller that resumes sees
 * the queue as it now stands. Every transition clears the unanswered-review
 * timer and arms a fresh one, so a timer that does fire always belongs to the
 * review still on the pill. The timer calls back in here, which is why one
 * function owns both halves of the transition.
 */
const advanceQueue = (answer?: ReviewDecision): void => {
  if (timeoutId !== null) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }

  const answered = answer ? queue.shift() : undefined;
  const current = head()?.review ?? null;
  produceAppState((draft) => {
    draft.pendingPillReview = current;
  });
  if (answered && answer) {
    answered.resolve(answer);
  }
  if (queue.length === 0) {
    stopListening();
  }
  if (!current) return;

  const { id } = current;
  timeoutId = setTimeout(() => {
    timeoutId = null;
    getLogger().warning(
      `Pill review ${id} went unanswered; skipping delivery and retaining the original text`,
    );
    advanceQueue({ action: "cancel", text: null });
  }, REVIEW_TIMEOUT_MS);
};

/**
 * The queued review that `id` refers to, or null when it is no longer the one
 * on the pill. A click that lands just after the transcript was replaced must
 * never answer for the new one.
 */
const openReview = (id: string): QueuedReview | null => {
  const current = head();
  if (current?.review.id !== id) {
    getLogger().warning(
      `Ignoring pill review decision for a review that is no longer open (${id})`,
    );
    return null;
  }
  return current;
};

/**
 * What to answer with: the text the pill sent back, or the transcript as it
 * arrived when the entry was emptied. An empty entry is not an edit.
 */
const reviewAnswerText = (
  review: PendingPillReview,
  editedText: string | null,
): string => (editedText?.trim() ? editedText : review.text);

/** Finish the review with `id` and hand its decision back to the caller. */
const settle = (id: string, decision: ReviewDecision): boolean => {
  if (!openReview(id)) return false;
  advanceQueue(decision);
  return true;
};

/**
 * Returns false when the native clipboard operation failed. The caller must
 * then leave the review in place: neither a failed clipboard write nor the
 * unavailable History fallback for agent output may discard an edited value.
 */
const copyReviewToClipboard = async (text: string): Promise<boolean> => {
  try {
    await invoke("copy_to_clipboard", { text });
    runToast(
      showToast({
        message: getIntl().formatMessage({
          defaultMessage: "Transcript copied to clipboard",
        }),
        toastType: "info",
        duration: 3000,
      }),
    );
    return true;
  } catch (error) {
    getLogger().error(`Failed to copy the reviewed transcript: ${error}`);
    runToast(
      showToast({
        message: getIntl().formatMessage({
          defaultMessage:
            "Could not copy the transcript. It remains available for review.",
        }),
        toastType: "error",
        duration: 8000,
      }),
    );
    return false;
  }
};

const applyDecision = async (
  id: string,
  action: PillReviewAction,
  editedText: string | null,
): Promise<void> => {
  const current = openReview(id);
  if (!current || current.busy) return;
  current.busy = true;
  // A valid click is now being handled. The unanswered-review expiry must not
  // race an in-flight persistence write and settle the promise as Cancel.
  if (timeoutId !== null) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
  const text = reviewAnswerText(current.review, editedText);

  try {
    if (action === "copy" && !(await copyReviewToClipboard(text))) {
      return;
    }
    if (action === "open") {
      // Do not remove the card until the dictation pipeline has persisted the
      // exact edit. If persistence is unavailable, the card remains usable so
      // a retry, Copy, Insert, or Cancel cannot lose the user's text.
      if (!current.onOpen || !(await current.onOpen(text))) {
        return;
      }
      settle(id, { action: "open", text });
      return;
    }
    settle(id, action === "insert" ? { action, text } : { action, text: null });
  } finally {
    // A failure leaves the review open so the click can be repeated, rather
    // than stranding the transcript behind a busy flag nobody can clear. Give
    // that newly available review a fresh unanswered-review window.
    current.busy = false;
    if (head() === current && timeoutId === null) {
      advanceQueue();
    }
  }
};

const isPillReviewAction = (value: unknown): value is PillReviewAction =>
  value === "insert" ||
  value === "copy" ||
  value === "cancel" ||
  value === "open";

const startListening = (): Promise<void> => {
  listenerSetup ??= listen<{
    reviewId: string;
    action: string;
    text?: string | null;
  }>("pill-review-decision", (event) => {
    const { reviewId, action, text } = event.payload;
    if (!isPillReviewAction(action)) {
      getLogger().warning(`Unknown pill review action: ${action}`);
      return;
    }
    applyDecision(reviewId, action, text ?? null).catch((error: unknown) => {
      getLogger().error(`Could not apply the pill review decision: ${error}`);
    });
  })
    .then((unlisten) => {
      unlistenDecision = unlisten;
    })
    .catch((error: unknown) => {
      // Let the next review try again instead of caching the failure.
      listenerSetup = null;
      throw error;
    });
  return listenerSetup;
};

/**
 * Show `text` on the pill for review and resolve with the user's decision.
 * An Open decision stays on the pill until its caller confirms the edited text
 * was persisted. Reviews queue: a transcript that arrives while another is on
 * the pill waits its turn instead of replacing it.
 */
export const reviewTranscriptOnPill = async (
  text: string,
  onOpen?: ReviewOpenHandler,
): Promise<ReviewDecision> => {
  // Listen before the card is published, so a very fast click cannot land
  // before we can hear it. Without a listener the user could never answer, so
  // a failure here falls back to the composer window rather than queueing a
  // review nobody can resolve.
  try {
    await startListening();
  } catch (error) {
    getLogger().error(
      `Could not listen for pill review decisions: ${error}; reviewing in the composer instead`,
    );
    const composerText = await reviewTextInComposer(text);
    return composerText?.trim()
      ? { action: "insert", text: composerText }
      : { action: "cancel", text: null };
  }

  const review: PendingPillReview = { id: createId(), text };
  const shouldPublish = queue.length === 0;
  const decision = new Promise<ReviewDecision>((resolve) => {
    queue.push({ review, onOpen, resolve, busy: false });
  });
  // Adding a later review is not a state transition for the card already on
  // the pill. Re-publishing it would restart its expiry each time another
  // transcript arrives, allowing a steady stream to block the queue forever.
  if (shouldPublish) {
    advanceQueue();
  }

  return decision;
};

/** Cancel every queued review, e.g. when the window is tearing down. */
export const cancelAllPillReviews = (): void => {
  while (queue.length > 0) {
    const pending = queue.shift();
    pending?.resolve({ action: "cancel", text: null });
  }
  // Clears the pill, drops the timer and stops listening, since the queue is
  // now empty.
  advanceQueue();
};

/**
 * Review a transcript before it is inserted.
 *
 * The native pill owns the review, editing included. The composer window is
 * only reached when there is no native pill at all, which is the fallback
 * build where the pill surface does not exist.
 */
export const reviewTranscriptBeforeInsert = async (
  text: string,
  onOpen?: ReviewOpenHandler,
): Promise<ReviewDecision> => {
  if (await isNativePillAvailable()) {
    return reviewTranscriptOnPill(text, onOpen);
  }
  const composerText = await reviewTextInComposer(text);
  return composerText?.trim()
    ? { action: "insert", text: composerText }
    : { action: "cancel", text: null };
};
