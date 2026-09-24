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
export type PillReviewAction = "insert" | "copy" | "cancel" | "edit" | "open";

export type PendingPillReview = {
  id: string;
  text: string;
};

/** Where the reviewed text came from. Preserved on the session for history. */
export type ReviewSource = "dictation" | "assistant-tool";

/** Which surface currently owns the review. */
export type ReviewPresentation = "pill" | "composer";

export type ReviewStatus =
  "queued" | "open" | "decided" | "expired" | "failed" | "cancelled";

export type ReviewDecision = "insert" | "copy" | "cancel" | "edit" | "open";

/**
 * One typed review session. The pill only ever sees `{ id, text }` (see
 * `PendingPillReview`, the native contract), while everything the desktop
 * needs to reason about the review — origin, draft, queue slot, lifecycle —
 * lives here, keyed by the same id.
 */
export type ReviewSession = {
  id: string;
  originalText: string;
  /** Latest text the user left behind: pill edits, then composer results. */
  draftText: string | null;
  source: ReviewSource;
  presentation: ReviewPresentation;
  status: ReviewStatus;
  decision: ReviewDecision | null;
  /** Zero-based slot in the queue; the open review sits at 0. */
  queuePosition: number;
  createdAt: number;
  updatedAt: number;
  decidedAt: number | null;
};

type QueuedReview = {
  session: ReviewSession;
  resolve: (text: string | null) => void;
  /** Set while a decision runs, so a second click cannot start it twice. */
  busy: boolean;
};

type ReviewAnswer = {
  text: string | null;
  decision?: ReviewDecision;
};

/** Decided sessions stay readable for history and reopen; the live queue is separate. */
const sessions = new Map<string, ReviewSession>();
const queue: QueuedReview[] = [];
const pendingRegistrations = new Map<string, () => void>();
let reviewGeneration = 0;
let listenerGeneration = 0;
const MAX_RETAINED_SESSIONS = 20;

const touchSession = (
  id: string,
  patch: Partial<ReviewSession>,
): ReviewSession | null => {
  const session = sessions.get(id);
  if (!session) {
    return null;
  }
  const next = { ...session, ...patch, updatedAt: Date.now() };
  sessions.set(id, next);
  return next;
};

const pruneSessions = (): void => {
  const settled = [...sessions.values()]
    .filter((session) => session.decidedAt !== null)
    .sort((left, right) => (left.decidedAt ?? 0) - (right.decidedAt ?? 0));
  for (
    let index = 0;
    index + MAX_RETAINED_SESSIONS < settled.length;
    index += 1
  ) {
    sessions.delete(settled[index].id);
  }
};

/** Mark the session decided from a composer result and drop old sessions. */
const decideSession = (id: string, result: string | null): string | null => {
  touchSession(id, {
    status: "decided",
    decision: result === null ? "cancel" : "insert",
    draftText: result,
    decidedAt: Date.now(),
  });
  pruneSessions();
  return result;
};

/** The session for `id`, if this desktop has ever seen it. */
export const getReviewSession = (id: string): ReviewSession | null =>
  sessions.get(id) ?? null;

/** Live queue snapshots, head first. Decided sessions leave the queue. */
export const getQueuedSessions = (): ReviewSession[] =>
  queue.map((queued) => queued.session);

/**
 * How long a card may sit unanswered on the pill. Same cap as the composer
 * window: an ignored review must not block the dictation output path forever.
 * The transcript stays in history, so nothing is lost when it expires.
 */
const REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

let unlistenDecision: (() => void) | null = null;
let listenerSetup: Promise<void> | null = null;
let timeoutId: ReturnType<typeof setTimeout> | null = null;

const head = (): QueuedReview | undefined => queue[0];

const stopListening = (): void => {
  listenerGeneration += 1;
  const unlisten = unlistenDecision;
  unlistenDecision = null;
  listenerSetup = null;
  unlisten?.();
};

const stopUnusedListener = (): void => {
  if (queue.length === 0 && pendingRegistrations.size === 0) stopListening();
};

const recordReviewAnswer = (
  answered: QueuedReview,
  answer: ReviewAnswer,
): void => {
  // The timeout path marks the session expired before shifting it off, so
  // read the live map: the shifted copy predates that write. A terminal
  // status is never overwritten by the generic decided stamp.
  const live = sessions.get(answered.session.id);
  const terminal =
    live !== undefined && live.status !== "open" && live.status !== "queued";
  if (!terminal) {
    touchSession(answered.session.id, {
      status: "decided",
      decision: answer.decision ?? answered.session.decision,
      decidedAt: Date.now(),
      draftText: answer.text ?? answered.session.draftText,
    });
  }
  pruneSessions();
};

const openNextReview = (): ReviewSession | null => {
  queue.forEach((queued, index) => {
    const next = touchSession(queued.session.id, { queuePosition: index });
    if (next) {
      queued.session = next;
    }
  });
  const queuedHead = head();
  if (queuedHead) {
    const opened = touchSession(queuedHead.session.id, {
      status: "open",
      queuePosition: 0,
    });
    if (opened) queuedHead.session = opened;
  }
  return queuedHead?.session ?? null;
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
const advanceQueue = (answer?: ReviewAnswer): void => {
  if (timeoutId !== null) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }

  const answered = answer ? queue.shift() : undefined;
  if (answered && answer) recordReviewAnswer(answered, answer);
  const current = openNextReview();
  produceAppState((draft) => {
    draft.pendingPillReview =
      current?.presentation === "pill"
        ? { id: current.id, text: current.draftText ?? current.originalText }
        : null;
  });
  answered?.resolve(answer ? answer.text : null);
  stopUnusedListener();
  if (!current) return;

  // The composer owns its own readiness/decision timeout. Enqueuing another
  // transcript must not republish or expire a review handed to that surface.
  if (current.presentation === "composer") return;
  const { id } = current;
  timeoutId = setTimeout(() => {
    timeoutId = null;
    getLogger().warning(
      `Pill review ${id} went unanswered; skipping the insert and keeping the transcript in history`,
    );
    touchSession(id, { status: "expired", decidedAt: Date.now() });
    pruneSessions();
    runToast(
      showToast({
        message: getIntl().formatMessage({
          defaultMessage:
            "Review expired — the transcript is kept in your history.",
        }),
        toastType: "info",
        duration: 8000,
        action: "open_transcriptions",
      }),
    );
    advanceQueue({ text: null });
  }, REVIEW_TIMEOUT_MS);
};

/**
 * The queued review that `id` refers to, or null when it is no longer the one
 * on the pill. A click that lands just after the transcript was replaced must
 * never answer for the new one.
 */
const openReview = (id: string): QueuedReview | null => {
  const current = head();
  if (current?.session.id !== id) {
    getLogger().warning(
      "Ignoring pill review decision for a review that is no longer open",
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
  originalText: string,
  editedText: string | null,
): string => (editedText?.trim() ? editedText : originalText);

/** Finish the review with `id` and hand `text` back to the caller. */
const settle = (
  id: string,
  text: string | null,
  decision: ReviewDecision,
): void => {
  if (!openReview(id)) return;
  advanceQueue({ text, decision });
};

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
  } catch {
    getLogger().error("Failed to copy the reviewed transcript");
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
    return false;
  }
};

const reviewInComposer = async (
  current: QueuedReview,
  text: string,
  action: "edit" | "open" = "edit",
): Promise<void> => {
  const { id, originalText } = current.session;
  current.session =
    touchSession(id, { presentation: "composer" }) ?? current.session;
  advanceQueue();
  try {
    const composed = await reviewTextInComposer(text, { originalText });
    settle(id, composed, action);
  } catch (error) {
    // Restore only this still-owned head, never a newer review after teardown.
    if (head() === current) {
      current.session =
        touchSession(id, { presentation: "pill" }) ?? current.session;
      advanceQueue();
    }
    throw error;
  }
};

const updateReviewDraft = (
  current: QueuedReview,
  editedText: string | null,
): void => {
  if (editedText?.trim()) {
    const next = touchSession(current.session.id, { draftText: editedText });
    if (next) {
      current.session = next;
    }
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
  const session = current.session;
  const text = reviewAnswerText(session.originalText, editedText);
  updateReviewDraft(current, editedText);

  try {
    if (action === "copy" && !(await copyReviewToClipboard(text))) {
      if (head() === current) advanceQueue();
      return;
    }
    if (action === "edit" || action === "open") {
      await reviewInComposer(current, text, action);
      return;
    }
    settle(id, action === "insert" ? text : null, action);
  } finally {
    // A failure leaves the review open so the click can be repeated, rather
    // than stranding the transcript behind a busy flag nobody can clear. On
    // the way out through success the review has already left the queue, so
    // clearing the flag there changes nothing.
    current.busy = false;
  }
};

const isPillReviewAction = (value: unknown): value is PillReviewAction =>
  value === "insert" ||
  value === "copy" ||
  value === "cancel" ||
  value === "edit" ||
  value === "open";

const parsePillReviewDecision = (
  payload: unknown,
): {
  reviewId: string;
  action: PillReviewAction;
  text: string | null;
} | null => {
  if (payload === null || typeof payload !== "object") return null;
  const { reviewId, action, text } = payload as Record<string, unknown>;
  if (
    typeof reviewId !== "string" ||
    !isPillReviewAction(action) ||
    (text != null && typeof text !== "string")
  )
    return null;
  return { reviewId, action, text: text ?? null };
};

const startListening = (): Promise<void> => {
  if (listenerSetup) return listenerSetup;
  const generation = listenerGeneration;
  listenerSetup = listen<unknown>("pill-review-decision", (event) => {
    if (generation !== listenerGeneration) return;
    const decision = parsePillReviewDecision(event.payload);
    if (!decision) {
      getLogger().warning("Ignoring invalid pill review decision");
      return;
    }
    applyDecision(decision.reviewId, decision.action, decision.text).catch(
      () => {
        getLogger().error("Could not apply the pill review decision");
      },
    );
  })
    .then((unlisten) => {
      if (generation !== listenerGeneration) {
        unlisten();
        return;
      }
      unlistenDecision = unlisten;
    })
    .catch((error: unknown) => {
      // An obsolete registration must not clear a newer shared setup.
      if (generation === listenerGeneration) listenerSetup = null;
      throw error;
    });
  return listenerSetup;
};

const waitForDecisionListener = async (id: string): Promise<boolean> => {
  const cancelled = new Promise<boolean>((resolve) => {
    pendingRegistrations.set(id, () => resolve(false));
  });
  return Promise.race([startListening().then(() => true), cancelled]);
};

const markSessionCancelled = (id: string): void => {
  if (sessions.get(id)?.status !== "cancelled") {
    touchSession(id, { status: "cancelled", decidedAt: Date.now() });
  }
};

const cancelUnpublishedReview = (id: string): null => {
  markSessionCancelled(id);
  pruneSessions();
  return null;
};

/**
 * Show `text` on the pill for review and resolve with the text to insert, or
 * null when the user cancelled or copied. Edit waits for the composer result.
 * Reviews queue: a transcript that arrives while another is on the pill waits
 * its turn instead of replacing it.
 */
export const reviewTranscriptOnPill = async (
  text: string,
  source: ReviewSource = "dictation",
): Promise<string | null> => {
  const generation = reviewGeneration;
  const id = createId();
  const now = Date.now();
  sessions.set(id, {
    id,
    originalText: text,
    draftText: null,
    source,
    presentation: "pill",
    status: "queued",
    decision: null,
    queuePosition: queue.length,
    createdAt: now,
    updatedAt: now,
    decidedAt: null,
  });

  try {
    // Listen before the card is published, so a very fast click cannot land
    // before we can hear it. Without a listener the user could never answer, so
    // a failure here falls back to the composer window rather than queueing a
    // review nobody can resolve.
    let listening: boolean;
    try {
      listening = await waitForDecisionListener(id);
    } catch {
      if (generation !== reviewGeneration) return cancelUnpublishedReview(id);
      getLogger().error(
        "Could not listen for pill review decisions; reviewing in the composer instead",
      );
      touchSession(id, {
        status: "failed",
        presentation: "composer",
        decidedAt: Date.now(),
      });
      return decideSession(id, await reviewTextInComposer(text));
    }

    if (!listening || generation !== reviewGeneration)
      return cancelUnpublishedReview(id);

    const session = sessions.get(id);
    if (!session) {
      return reviewTextInComposer(text);
    }
    const decision = new Promise<string | null>((resolve) => {
      queue.push({ session, resolve, busy: false });
    });
    advanceQueue();

    return decision;
  } finally {
    pendingRegistrations.delete(id);
    stopUnusedListener();
  }
};

/** Cancel every queued review, e.g. when the window is tearing down. */
export const cancelAllPillReviews = (): void => {
  reviewGeneration += 1;
  for (const [id, cancel] of pendingRegistrations) {
    markSessionCancelled(id);
    cancel();
  }
  pendingRegistrations.clear();
  while (queue.length > 0) {
    const pending = queue.shift();
    if (pending) {
      markSessionCancelled(pending.session.id);
      pending.resolve(null);
    }
  }
  pruneSessions();
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
  source: ReviewSource = "dictation",
): Promise<string | null> => {
  if (await isNativePillAvailable()) {
    return reviewTranscriptOnPill(text, source);
  }
  // No pill surface: the composer owns the review directly, but it still gets
  // a session so history and audit see the same shape as a pill review.
  const id = createId();
  const now = Date.now();
  sessions.set(id, {
    id,
    originalText: text,
    draftText: null,
    source,
    presentation: "composer",
    status: "open",
    decision: null,
    queuePosition: 0,
    createdAt: now,
    updatedAt: now,
    decidedAt: null,
  });
  return decideSession(id, await reviewTextInComposer(text));
};
