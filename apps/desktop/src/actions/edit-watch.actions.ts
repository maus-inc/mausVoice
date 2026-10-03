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
import { dismissToast, runToast, showToast } from "./toast.actions";

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
  /**
   * Identifies this dictation for the lapsed-proposal record. The record has to
   * outlive the watch by a grace window, and naming the watch by its id lets the
   * snapshot itself be released with the watch.
   */
  id: number;
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
  /**
   * The field text the correction scan last ran against. The scan is the
   * expensive part of a poll -- it tokenizes both sides and runs the alignment --
   * and the field does not change between ticks once the user stops typing, so
   * remembering it turns a settled idle field into a comparison instead.
   */
  lastCorrectedFieldText: string | null;
  settledAt: number;
};

// The in-flight dictation snapshot is transient polling state, not UI state,
// so it lives here rather than in the Zustand store.
let activeWatch: WatchSnapshot | null = null;

/**
 * The id of the most recent dictation, and where the next one comes from.
 *
 * Every dictation takes the next value, whether or not it goes on to start a
 * watch: a dictation whose text is empty, or one made while the feature is off,
 * still ends whatever watch was running. `activeWatch` cannot record that on its
 * own, because such a dictation leaves it null exactly like a watch that merely
 * ended, and the two must not be confused.
 */
let latestWatchId = 0;
let nextWatchId = 1;

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

/**
 * The last proposal this watch expired on its TTL, and when.
 *
 * `proposedAt` is stamped before the toast is handed to the delivery queue, and
 * that queue is serialised behind every other toast, so the TTL can expire while
 * the pill is still on screen. The click then arrives to find no proposal and
 * `acceptAutoLearnProposal` returned without adding anything, so a user who saw
 * the prompt and answered it got silence.
 *
 * Re-offering the term instead would be worse: the same watch would ask again
 * about a word the user had already been prompted for, and the existing
 * `proposedTerms` set exists to prevent exactly that. Holding the lapsed term
 * for one toast duration instead honours the click without re-asking, and lets
 * it expire on its own so it cannot accept a click from a later, unrelated
 * prompt.
 *
 * It names its watch by id rather than by snapshot. Holding the snapshot kept a
 * whole focused document alive in `baselineText` for the length of the grace
 * window, after the watch and the document had both moved on.
 */
let recentlyLapsedProposal: {
  term: string;
  at: number;
  /** The id of the watch the proposal came from, so a later one cannot claim the click. */
  watchId: number;
} | null = null;

/** How long a lapsed proposal still honours a click. */
const LAPSED_PROPOSAL_GRACE_MS = PROPOSAL_TOAST_DURATION_MS;

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

const readDeniedTerms = (): Set<string> => {
  const stored = readStoredDeniedTerms();
  if (stored.size === 0) {
    return new Set(sessionDeniedTerms);
  }
  return new Set([...stored, ...sessionDeniedTerms]);
};

const rememberDeniedTerm = (term: string): void => {
  const key = term.toLowerCase();
  // Bounded the same way the durable copy is. `MAX_DENIED_TERMS` only trimmed
  // what went to local storage, so this set grew for the life of the session
  // even after the persisted list had rotated the entry out.
  sessionDeniedTerms = new Set(
    [...sessionDeniedTerms, key].slice(-MAX_DENIED_TERMS),
  );
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
 * The capture spends its remaining attempts instead of ending early, because
 * the settled-poll fallback cannot cover the same gap. It only sees samples
 * from at least one poll after the field went quiet, by which time a fast
 * correction has already replaced the dictation.
 *
 * The passes recurse rather than loop over an await: each one is separated from
 * the last by a fixed interval, and a timer that measured the target app after
 * it settled has no reason to be measured twice at once.
 */
const captureBaseline = async (
  snapshot: WatchSnapshot,
  attemptsLeft = BASELINE_CAPTURE_ATTEMPTS,
): Promise<void> => {
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
  if (attemptsLeft > 1) {
    await captureBaseline(snapshot, attemptsLeft - 1);
  }
};

/**
 * The id of the proposal the on-screen prompt belongs to, or null when no
 * prompt of ours is showing.
 *
 * The toast outlives both the store proposal and the watch: the pill dismisses
 * it on its own timer, and a TTL expiry clears the proposal while the prompt is
 * still there. A click on such a prompt must answer the prompt the user is
 * looking at, not whatever proposal has taken its place since, so the id is
 * held here for as long as the prompt could still be clicked.
 */
let visibleProposalId: string | null = null;

/**
 * Forget the on-screen prompt.
 *
 * Deliberately not part of `clearAutoLearnProposal`: a TTL expiry clears the
 * store proposal while the prompt is still on the pill, and the click it is
 * holding a grace window for has to stay answerable. Call this where the prompt
 * itself is gone or superseded.
 */
const clearVisibleProposalId = (): void => {
  visibleProposalId = null;
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
  // Claimed before the snapshot exists, so a dictation that starts no watch at
  // all still counts as a later one for the lapsed-proposal record.
  const id = nextWatchId;
  nextWatchId += 1;
  latestWatchId = id;
  const normalized = text.trim();
  if (!normalized || !isFeatureEnabled()) {
    activeWatch = null;
    return;
  }
  const snapshot: WatchSnapshot = {
    id,
    text: normalized,
    startedAt: Date.now(),
    baselineText: null,
    baselineOccurrences: 0,
    proposedTerms: new Set<string>(),
    unalignableReported: false,
    settledText: null,
    lastCorrectedFieldText: null,
    settledAt: 0,
  };
  activeWatch = snapshot;
  // A new dictation starts a new question. The held term belongs to the watch
  // that proposed it, so it is dropped here rather than left for the accept
  // path to compare against: nothing the user is now looking at refers to it.
  recentlyLapsedProposal = null;
  // The prompt from the previous dictation may still be on the pill, but it
  // answered a question this watch no longer owns. Clearing the id is not
  // enough: the native toast is a separate object with its own lifetime, so
  // without this the user is left looking at a prompt whose buttons act on a
  // proposal that no longer exists. Enqueued before any proposal this watch goes
  // on to raise, so the ordering on the toast queue is the right way round.
  //
  // Deliberately not part of `clearVisibleProposalId`: a TTL expiry clears the
  // store proposal while the prompt is still up, and that click has to stay
  // answerable. Only a supersession dismisses.
  clearVisibleProposalId();
  runToast(dismissToast());
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
  // The listener is gone too, so a click that is already on its way must not be
  // answered by whatever proposal is current when it lands.
  clearVisibleProposalId();
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

let nextProposalId = 1;

/**
 * The proposal id a click answers, or null when no prompt is outstanding.
 *
 * Read by the toast listener before it acts on a click, so the click can be
 * checked against the prompt it was actually raised for.
 */
export const getVisibleProposalId = (): string | null => visibleProposalId;

const proposeAutoLearnTerm = async (term: string): Promise<void> => {
  const intl = getIntl();
  // Minted per prompt, not per term: a term proposed twice in one watch is two
  // different prompts, and only the newest one may be answered.
  const proposalId = String(nextProposalId);
  nextProposalId += 1;
  visibleProposalId = proposalId;
  await showToast({
    message: intl.formatMessage(
      { defaultMessage: 'Add "{term}" to your dictionary?' },
      { term },
    ),
    toastType: "info",
    duration: PROPOSAL_TOAST_DURATION_MS,
    action: "auto_learn_accept",
    rejectAction: "auto_learn_reject",
    proposalId,
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
    // Deliberately not a permanent denial: the toast is delivered on a queue
    // behind every other toast, so this TTL can fire while the pill is still on
    // screen, and it fires with nothing at all when the delivery failed. Writing
    // a lasting denial there would blacklist a term the user may never have been
    // shown.
    //
    //
    // The term stays in `snapshot.proposedTerms`, so this dictation does not nag
    // about it again. What it must not do is lose a click that was already on its
    // way -- see `lapsedProposal`.
    const lapsed = { term: pending.term, at: Date.now(), watchId: snapshot.id };
    recentlyLapsedProposal = lapsed;
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

    // `hasSettled` reports true forever once the field stops changing, and
    // nothing downstream short-circuits on that, so every 500 ms tick re-tokenized
    // both sides and re-ran `alignTokens` -- up to 601 by 601 cells, 180 times
    // over a three minute watch, for an idle user. `proposedTerms` and
    // `unalignableReported` only suppressed work after that computation. The
    // inputs are identical when the text has not moved, so the result is too.
    //
    // Written only once the scan has nothing left to offer, which is below and
    // not here: stamping it before the proposal loop froze the field at the
    // first candidate it found, so the multi-candidate selection below could
    // only ever see that one and every later correction in the same field went
    // unasked for as long as the dictation ran.
    if (snapshot.lastCorrectedFieldText === fieldText) {
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
            "alignment bound, so a correction in it cannot be located",
        );
      },
    });
    if (corrections.length === 0) {
      snapshot.lastCorrectedFieldText = fieldText;
      return;
    }

    // The first gap in the field is not always the first one worth offering.
    // `proposedTerms` and the denial set both persist for the rest of the watch,
    // so taking `corrections[0]` unconditionally meant that a single offered or
    // ignored correction at the start of a field suppressed every later
    // correction in that same field for as long as the dictation ran.
    const denied = readDeniedTerms();
    const term = corrections.find(
      (candidate) =>
        !snapshot.proposedTerms.has(candidate) &&
        !denied.has(candidate.toLowerCase()),
    );
    if (!term) {
      snapshot.lastCorrectedFieldText = fieldText;
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
    // The TTL expired while the click was still in flight. The user answered a
    // prompt they could see, so honour it rather than dropping it silently --
    // but only inside the grace window, so a stray click cannot accept a term
    // from a prompt that ended long ago.
    const lapsed = recentlyLapsedProposal;
    if (!lapsed || Date.now() - lapsed.at > LAPSED_PROPOSAL_GRACE_MS) {
      return;
    }
    // The held term belongs to one dictation. Any dictation that started after it
    // owns this click: that prompt is what the user is looking at, and adding
    // this one's term would put a correction in the dictionary for a prompt the
    // user never answered. Comparing against the latest dictation rather than
    // against `activeWatch` is what covers a later dictation that has already
    // ended, or that started no watch at all, since both leave `activeWatch` null
    // exactly like a watch that merely ended.
    //
    // A watch that has merely ended is the case the grace window exists for: the
    // dictation finished, the pill was still on screen, and the click was
    // already on its way. No dictation started in between, so the ids still
    // match.
    if (latestWatchId !== lapsed.watchId) {
      return;
    }
    recentlyLapsedProposal = null;
    // The prompt has been answered; nothing on the pill refers to it now.
    clearVisibleProposalId();
    await createGlossaryTerms([lapsed.term]);
    return;
  }

  const { term } = proposal;
  recentlyLapsedProposal = null;
  clearVisibleProposalId();
  clearAutoLearnProposal();
  await createGlossaryTerms([term]);
};

export const rejectAutoLearnProposal = (): void => {
  const proposal = getAppState().autoLearn.proposal;
  if (!proposal) {
    return;
  }

  rememberDeniedTerm(proposal.term);
  clearVisibleProposalId();
  clearAutoLearnProposal();
};
