import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getIntl } from "../i18n/intl";
import { produceAppState } from "../store";
import { reviewTextInComposer } from "../utils/composer.utils";
import { isNativePillAvailable } from "../utils/native-pill.utils";
import { createId } from "../utils/id.utils";
import { getLogger } from "../utils/log.utils";
import { runToast, showToast } from "./toast.actions";

/**
 * Review-before-insert on the native pill.
 *
 * The transcript opens in the pill's own assistant panel, the surface the user
 * is already looking at, with the text loaded into the panel's entry so it can
 * be edited in place. Nothing opens in a separate window. The pill shows one
 * transcript at a time, so concurrent ones queue here and are presented in
 * arrival order; the queue never drops one silently.
 */
export type PillReviewAction = "insert" | "copy" | "cancel";

export type PendingPillReview = {
  id: string;
  text: string;
};

type QueuedReview = {
  review: PendingPillReview;
  resolve: (text: string | null) => void;
  /** Set while a decision runs, so a second click cannot start it twice. */
  busy: boolean;
};

/**
 * How long a card may sit unanswered on the pill. Same cap as the composer
 * window: an ignored review must not block the dictation output path forever.
 * The transcript stays in history, so nothing is lost when it expires.
 */
const REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

const queue: QueuedReview[] = [];
let unlistenDecision: (() => void) | null = null;
let listenerSetup: Promise<void> | null = null;
let timeoutId: ReturnType<typeof setTimeout> | null = null;

const head = (): QueuedReview | undefined => queue[0];

const publishHead = (): void => {
  if (timeoutId !== null) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
  const current = head()?.review ?? null;
  produceAppState((draft) => {
    draft.pendingPillReview = current;
  });
  if (!current) return;

  const { id } = current;
  timeoutId = setTimeout(() => {
    timeoutId = null;
    getLogger().warning(
      `Pill review ${id} went unanswered; skipping the insert and keeping the transcript in history`,
    );
    settle(id, null);
  }, REVIEW_TIMEOUT_MS);
};

/**
 * Finish the review with `id` and hand `text` back to the caller. Decisions
 * that do not match the review currently on the pill are ignored: a click that
 * lands just after the card was replaced must never resolve the new review.
 */
const settle = (id: string, text: string | null): void => {
  const current = head();
  if (!current || current.review.id !== id) {
    getLogger().warning(
      `Ignoring pill review decision for a review that is no longer open (${id})`,
    );
    return;
  }
  queue.shift();
  publishHead();
  current.resolve(text);
  if (queue.length === 0) {
    stopListening();
  }
};

const stopListening = (): void => {
  unlistenDecision?.();
  unlistenDecision = null;
  listenerSetup = null;
};

const copyReviewToClipboard = async (text: string): Promise<void> => {
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
  } catch (error) {
    getLogger().error(`Failed to copy the reviewed transcript: ${error}`);
    runToast(
      showToast({
        message: getIntl().formatMessage({
          defaultMessage:
            "Could not copy the transcript. It is saved in your history.",
        }),
        toastType: "error",
        duration: 8000,
        action: "open_transcriptions",
      }),
    );
  }
};

const applyDecision = async (
  id: string,
  action: PillReviewAction,
  editedText: string | null,
): Promise<void> => {
  const current = head();
  if (!current || current.review.id !== id) {
    getLogger().warning(
      `Ignoring pill review decision for a review that is no longer open (${id})`,
    );
    return;
  }
  if (current.busy) return;
  current.busy = true;
  // The pill sends back whatever its entry held, so an edit made in the panel
  // is what gets used. An empty entry falls back to nothing to insert.
  const text = editedText?.trim() ? editedText : current.review.text;

  switch (action) {
    case "insert":
      settle(id, text);
      return;
    case "cancel":
      settle(id, null);
      return;
    case "copy":
      await copyReviewToClipboard(text);
      settle(id, null);
      return;
  }
};

const isPillReviewAction = (value: unknown): value is PillReviewAction =>
  value === "insert" || value === "copy" || value === "cancel";

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
    void applyDecision(reviewId, action, text ?? null);
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
 * Show `text` on the pill for review and resolve with the text to insert, or
 * null when the user cancelled, copied or moved the transcript to the editor.
 * Reviews queue: a transcript that arrives while another is on the pill waits
 * its turn instead of replacing it.
 */
export const reviewTranscriptOnPill = async (
  text: string,
): Promise<string | null> => {
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
    return reviewTextInComposer(text);
  }

  const review: PendingPillReview = { id: createId(), text };
  const decision = new Promise<string | null>((resolve) => {
    queue.push({ review, resolve, busy: false });
  });
  publishHead();

  return decision;
};

/** Cancel every queued review, e.g. when the window is tearing down. */
export const cancelAllPillReviews = (): void => {
  while (queue.length > 0) {
    const pending = queue.shift();
    pending?.resolve(null);
  }
  publishHead();
  stopListening();
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
): Promise<string | null> => {
  if (await isNativePillAvailable()) {
    return reviewTranscriptOnPill(text);
  }
  return reviewTextInComposer(text);
};
