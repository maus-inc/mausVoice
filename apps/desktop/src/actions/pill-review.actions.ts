import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getIntl } from "../i18n/intl";
import { getAppState, produceAppState } from "../store";
import { reviewTextInComposer } from "../utils/composer.utils";
import { isNativePillAvailable } from "../utils/native-pill.utils";
import { createId } from "../utils/id.utils";
import { getLogger } from "../utils/log.utils";
import { runToast, showToast } from "./toast.actions";

/**
 * Review-before-insert on the native pill.
 *
 * The transcript is shown on the pill itself (the surface the user is already
 * looking at) instead of a separate window that opens away from the caret. The
 * pill renders one review at a time, so concurrent transcripts queue here and
 * are presented in arrival order; the queue never drops one silently.
 */
export type PillReviewAction = "insert" | "copy" | "edit" | "cancel";

export type PendingPillReview = {
  id: string;
  text: string;
};

type QueuedReview = {
  review: PendingPillReview;
  resolve: (text: string | null) => void;
  /**
   * Set while a decision is being carried out (the editor is open, the
   * clipboard write is in flight). Further clicks on the same card are
   * ignored instead of starting the work twice.
   */
  busy: boolean;
};

const queue: QueuedReview[] = [];
let unlistenDecision: (() => void) | null = null;
let listenerSetup: Promise<void> | null = null;

const head = (): QueuedReview | undefined => queue[0];

const publishHead = (): void => {
  const current = head()?.review ?? null;
  produceAppState((draft) => {
    draft.pendingPillReview = current;
  });
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
          defaultMessage: "Transcript copied to the clipboard",
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
  const { text } = current.review;

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
    case "edit": {
      // Editing happens in the composer window: the pill has no text input
      // sized for a full transcript. The edited text is returned to the
      // caller, so it is inserted through the same path as an accepted
      // review (typing, pasting or remote delivery).
      const edited = await reviewTextInComposer(text);
      settle(id, edited?.trim() ? edited : null);
      return;
    }
  }
};

const isPillReviewAction = (value: unknown): value is PillReviewAction =>
  value === "insert" ||
  value === "copy" ||
  value === "edit" ||
  value === "cancel";

const startListening = async (): Promise<void> => {
  if (listenerSetup) return listenerSetup;
  listenerSetup = (async () => {
    unlistenDecision = await listen<{ reviewId: string; action: string }>(
      "pill-review-decision",
      (event) => {
        const { reviewId, action } = event.payload;
        if (!isPillReviewAction(action)) {
          getLogger().warning(`Unknown pill review action: ${action}`);
          return;
        }
        void applyDecision(reviewId, action);
      },
    );
  })();
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
  const review: PendingPillReview = { id: createId(), text };
  const decision = new Promise<string | null>((resolve) => {
    queue.push({ review, resolve, busy: false });
  });

  // Register the decision listener before the pill can answer. The card is
  // only published to the pill once the listener is live, so a very fast
  // click cannot land before we are listening for it.
  await startListening();
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

/** True when a transcript is currently displayed on the pill for review. */
export const hasPendingPillReview = (): boolean =>
  getAppState().pendingPillReview !== null;

/**
 * Review a transcript before it is inserted.
 *
 * The native pill owns the review when it is running; the composer window
 * remains the surface on builds that fall back to the Tauri overlay (and is
 * still used for "Edit", which needs a real text field).
 */
export const reviewTranscriptBeforeInsert = async (
  text: string,
): Promise<string | null> => {
  if (await isNativePillAvailable()) {
    return reviewTranscriptOnPill(text);
  }
  return reviewTextInComposer(text);
};
