import { invoke } from "@tauri-apps/api/core";
import { delayed } from "@maus-inc/utilities";
import { getIntl } from "../i18n/intl";
import { getAppState, produceAppState } from "../store";
import { collectTermValues } from "../utils/app.utils";
import {
  countDictationOccurrences,
  findEditCorrections,
} from "../utils/edit-watch.utils";
import { getLogger } from "../utils/log.utils";
import { getLocalStorage } from "../utils/local-storage.utils";
import { getMyUserPreferences } from "../utils/user.utils";
import { createGlossaryTerms } from "./dictionary.actions";
import { showToast } from "./toast.actions";

const WATCH_WINDOW_MS = 90_000;
const DENIED_TERMS_KEY = "mausvoice:auto-learn-denied";
const MAX_DENIED_TERMS = 50;
/**
 * How often the side-effect poll samples the focused field. It has to stay
 * below EDIT_QUIESCENCE_MS for the quiet window to be reachable; see the note
 * on that constant. Exported so the component cannot drift away from it.
 */
export const EDIT_POLL_MS = 500;
// The proposal toast is shown for this long. The TTL adds a small grace so a
// delayed native toast IPC delivery cannot outlive the pending proposal.
const PROPOSAL_TOAST_DURATION_MS = 10_000;
const PROPOSAL_TTL_MS = PROPOSAL_TOAST_DURATION_MS + 2_000;
/**
 * How long the focused field must read identically before its text counts as
 * finished. The watcher samples through an accessibility poll instead of
 * keystroke events, so this is a trailing-edge debounce measured against the
 * poll: a sample has to survive further polls unchanged and only then is it
 * still unchanged once the quiet window has elapsed. Proposing on a mid-edit
 * sample is what produced toasts for half-typed fragments such as "Son" while
 * the user was still typing "Soniya".
 *
 * EDIT_POLL_MS has to stay below this for the constant to do any work. A poll
 * slower than the quiet window can only ever observe samples that are
 * EDIT_POLL_MS apart, so the window is already satisfied on the second poll and
 * a user who pauses mid-word is offered a half-typed fragment.
 */
export const EDIT_QUIESCENCE_MS = 1_200;
/**
 * The baseline has to be read while the dictation is still intact, so the
 * capture starts the moment the dictation lands rather than waiting for the
 * first watcher poll. Insertion is asynchronous in the target app, so the first
 * read can still return the pre-paste field; retrying on a short interval
 * catches the intact dictation long before a user could select a word and
 * retype it. Without this, a correction finished before the first poll left the
 * watcher with no baseline and nothing was ever learned.
 */
const BASELINE_CAPTURE_INTERVAL_MS = 150;
const BASELINE_CAPTURE_ATTEMPTS = 8;

type WatchSnapshot = {
  text: string;
  startedAt: number;
  /**
   * The focused field as it read while the dictation was still intact. Captured
   * as soon as the dictation lands, with the first settled poll that still
   * contains the dictation as the fallback. Either way the watcher only ever
   * diffs against a snapshot it verified, never against a guess.
   */
  baselineText: string | null;
  /**
   * How many times the dictated text was present in `baselineText`. A paste
   * adds an occurrence, so this is how the capture recognises a baseline taken
   * before the dictation landed and replaces it with the post-paste read.
   */
  baselineOccurrences: number;
  /**
   * Terms already offered during this watch. The prompt can be left to time out
   * without the user ever seeing it, so an expired prompt only suppresses itself
   * for the rest of the watch. Only an explicit Ignore is remembered beyond it.
   */
  proposedTerms: Set<string>;
  /**
   * Whether this watch has already reported that its field is too long to
   * align. The report is a diagnostic for a condition that cannot change while
   * the field keeps its length, and every settled poll would otherwise repeat
   * it, so one watch logs it once.
   */
  unalignableReported: boolean;
  /** Last observed field text, and when it was first observed. */
  settledText: string | null;
  settledAt: number;
};

// The in-flight dictation snapshot is transient polling state, not UI state,
// so it lives here rather than in the Zustand store.
let activeWatch: WatchSnapshot | null = null;

const isFeatureEnabled = (): boolean =>
  getMyUserPreferences(getAppState())?.autoLearnFromEditsEnabled ?? false;

/**
 * The session copy of the deny list. Local storage is the durable record, but
 * a blocked or quota-limited origin leaves nowhere to write, so a denial made
 * there would be lost the moment storage answered again and the same prompt
 * would return on every poll, in exactly the case the list exists to prevent.
 * The two are therefore merged on read. A term only reaches either list because
 * the user pressed Ignore, so merging can only ever over-deny a word they have
 * already turned down, never suppress something new.
 */
let sessionDeniedTerms = new Set<string>();

const readDeniedTerms = (): Set<string> => {
  const stored = readStoredDeniedTerms();
  if (stored.size === 0) {
    return new Set(sessionDeniedTerms);
  }
  return new Set([...stored, ...sessionDeniedTerms]);
};

const readStoredDeniedTerms = (): Set<string> => {
  const storage = getLocalStorage();
  if (!storage) {
    return new Set();
  }
  try {
    const raw = storage.getItem(DENIED_TERMS_KEY);
    if (!raw) {
      return new Set();
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
};

const rememberDeniedTerm = (term: string): void => {
  const key = term.toLowerCase();
  sessionDeniedTerms = new Set([...sessionDeniedTerms, key]);
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }
  const trimmed = Array.from(new Set([...readDeniedTerms(), key])).slice(
    -MAX_DENIED_TERMS,
  );
  try {
    storage.setItem(DENIED_TERMS_KEY, JSON.stringify(trimmed));
  } catch (error) {
    getLogger().warning(`Failed to persist denied auto-learn terms: ${error}`);
  }
};

export const clearAutoLearnProposal = (): void => {
  produceAppState((draft) => {
    draft.autoLearn.proposal = null;
  });
};

const readFieldText = async (): Promise<string | null> => {
  const info = await invoke<{ textContent: string | null }>(
    "get_text_field_info",
  );
  return info.textContent?.trim() || null;
};

/**
 * Records the sample as the baseline when it is the first one that can be
 * trusted, and keeps looking for a later paste.
 *
 * A read taken before the dictation lands is indistinguishable from one taken
 * straight after it by containment alone, so the sample is only latched once
 * the field is seen to hold the dictated text, and a later sample holding more
 * copies of it than the latched one means the capture raced the paste and the
 * baseline moves to that later read. Without the second rule, dictating the
 * same sentence into the same field twice latches the pre-paste text, and the
 * correction to the second copy is then read as an edit to unrelated text and
 * never learned.
 *
 * A failed read is expected rather than fatal: the native command rejects on a
 * timeout, which is the normal outcome while the target app is busy inserting.
 * The loop spends its remaining attempts instead of ending the capture, because
 * the settled-poll fallback cannot cover the same gap. It only sees samples
 * from at least one poll after the field went quiet, by which time a fast
 * correction has already replaced the dictation.
 */
const captureBaseline = async (snapshot: WatchSnapshot): Promise<void> => {
  for (let attempt = 0; attempt < BASELINE_CAPTURE_ATTEMPTS; attempt += 1) {
    if (activeWatch !== snapshot) {
      return;
    }

    try {
      const fieldText = await readFieldText();
      if (activeWatch !== snapshot) {
        return;
      }
      if (fieldText) {
        const occurrences = countDictationOccurrences(snapshot.text, fieldText);
        const isNewerPaste =
          !snapshot.baselineText || occurrences > snapshot.baselineOccurrences;
        if (occurrences > 0 && isNewerPaste) {
          snapshot.baselineText = fieldText;
          snapshot.baselineOccurrences = occurrences;
        }
      }
    } catch (error) {
      getLogger().warning(`Edit watch baseline capture failed: ${error}`);
    }

    await delayed(BASELINE_CAPTURE_INTERVAL_MS);
  }
};

/**
 * Starts watching the target app for corrections after a dictation was
 * inserted. Replaces any previous snapshot; a no-op when the feature is off.
 */
export const beginEditWatch = (text: string): void => {
  // A new dictation supersedes any pending proposal from the previous one:
  // its toast is gone (or about to be displaced by the next one), and a
  // stale proposal would block the new watch's polls.
  clearAutoLearnProposal();
  const normalized = text.trim();
  if (!normalized || !isFeatureEnabled()) {
    activeWatch = null;
    return;
  }
  const snapshot: WatchSnapshot = {
    text: normalized,
    startedAt: Date.now(),
    baselineText: null,
    baselineOccurrences: 0,
    proposedTerms: new Set<string>(),
    unalignableReported: false,
    settledText: null,
    settledAt: 0,
  };
  activeWatch = snapshot;
  // Fire and forget. captureBaseline swallows its own errors, so this cannot
  // surface as an unhandled rejection.
  void captureBaseline(snapshot);
};

export const endEditWatch = (): void => {
  activeWatch = null;
  // The accept/reject listener (EditWatchSideEffects) is torn down with the
  // watch, so a surviving proposal could never be answered and would only
  // block future polls.
  clearAutoLearnProposal();
};

const isWatchActive = (): boolean => {
  if (!activeWatch) {
    return false;
  }
  if (Date.now() - activeWatch.startedAt > WATCH_WINDOW_MS) {
    activeWatch = null;
    return false;
  }
  return true;
};

/**
 * Trailing-edge debounce over the poll. Reports settled only once the field has
 * read identically for at least EDIT_QUIESCENCE_MS, so a poll that lands while
 * the user is still typing records the sample and waits instead of proposing.
 */
const hasSettled = (snapshot: WatchSnapshot, fieldText: string): boolean => {
  if (snapshot.settledText !== fieldText) {
    snapshot.settledText = fieldText;
    snapshot.settledAt = Date.now();
    return false;
  }
  return Date.now() - snapshot.settledAt >= EDIT_QUIESCENCE_MS;
};

/**
 * Fallback for when the eager capture never saw the dictation intact, which
 * happens when the accessibility read fails at insertion time. Adopts the first
 * settled field text that still contains the dictation. Returns null until such
 * a sample exists, which keeps the watcher silent rather than guessing at a
 * region of a document it never dictated into.
 */
const resolveBaseline = (
  snapshot: WatchSnapshot,
  fieldText: string,
): string | null => {
  if (snapshot.baselineText) {
    return snapshot.baselineText;
  }
  const occurrences = countDictationOccurrences(snapshot.text, fieldText);
  if (occurrences === 0) {
    return null;
  }
  snapshot.baselineText = fieldText;
  snapshot.baselineOccurrences = occurrences;
  return fieldText;
};

const collectExistingTerms = (): string[] => collectTermValues(getAppState());

const proposeAutoLearnTerm = async (term: string): Promise<void> => {
  const intl = getIntl();
  await showToast({
    message: intl.formatMessage(
      { defaultMessage: 'Add "{term}" to your dictionary?' },
      { term },
    ),
    toastType: "info",
    duration: PROPOSAL_TOAST_DURATION_MS,
    action: "auto_learn_accept",
    rejectAction: "auto_learn_reject",
  });
};

/**
 * Reads the focused field once it has stopped changing and, when the user made
 * a small proper-noun correction to the dictation, proposes the corrected term.
 */
export const pollEditWatch = async (): Promise<void> => {
  if (!isWatchActive()) {
    return;
  }

  const snapshot = activeWatch as WatchSnapshot;
  // A pending proposal blocks re-proposing while its toast is on screen. The
  // pill dismisses that toast on its own timer without emitting any event
  // (only the Add/Ignore buttons do), so an ignored prompt must self-expire
  // here. Otherwise it silently blocks every future poll until restart.
  const pending = getAppState().autoLearn.proposal;
  if (pending) {
    if (Date.now() - pending.proposedAt <= PROPOSAL_TTL_MS) {
      return;
    }
    // The term is already in snapshot.proposedTerms from the poll that raised
    // the prompt, so expiring it only stops this watch from repeating itself.
    // It is deliberately not a permanent denial: the toast is delivered on a
    // queue behind every other toast, so this TTL can fire while the pill is
    // still on screen, and it fires with nothing at all when the delivery
    // failed. Writing a lasting denial there would blacklist a term the user
    // may never have been shown, and would blacklist it before the Add click
    // landed, so the click would do nothing.
    clearAutoLearnProposal();
  }

  try {
    const fieldText = await readFieldText();
    if (!fieldText) {
      return;
    }

    // A dictation can land while this poll is in flight, which replaces the
    // watch and clears any proposal. Drop the stale sample rather than
    // proposing against a dictation the user has already moved past.
    if (activeWatch !== snapshot) {
      return;
    }

    if (!hasSettled(snapshot, fieldText)) {
      return;
    }

    const baselineText = resolveBaseline(snapshot, fieldText);
    if (!baselineText) {
      return;
    }

    const corrections = findEditCorrections({
      insertedText: snapshot.text,
      baselineText,
      fieldText,
      existingTerms: collectExistingTerms(),
      onUnalignable: (tokenCount) => {
        if (snapshot.unalignableReported) {
          return;
        }
        snapshot.unalignableReported = true;
        getLogger().warning(
          `Edit watch skipped a ${tokenCount} token field: above the ` +
            `alignment bound, so a correction in it cannot be located`,
        );
      },
    });
    if (corrections.length === 0) {
      return;
    }

    const term = corrections[0];
    if (
      snapshot.proposedTerms.has(term) ||
      readDeniedTerms().has(term.toLowerCase())
    ) {
      return;
    }

    snapshot.proposedTerms.add(term);
    produceAppState((draft) => {
      draft.autoLearn.proposal = { term, proposedAt: Date.now() };
    });
    await proposeAutoLearnTerm(term);
  } catch (error) {
    getLogger().warning(`Edit watch poll failed: ${error}`);
  }
};

export const acceptAutoLearnProposal = async (): Promise<void> => {
  const proposal = getAppState().autoLearn.proposal;
  if (!proposal) {
    return;
  }

  const { term } = proposal;
  clearAutoLearnProposal();
  await createGlossaryTerms([term]);
};

export const rejectAutoLearnProposal = (): void => {
  const proposal = getAppState().autoLearn.proposal;
  if (!proposal) {
    return;
  }

  rememberDeniedTerm(proposal.term);
  clearAutoLearnProposal();
};
