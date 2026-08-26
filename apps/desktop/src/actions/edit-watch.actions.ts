import { invoke } from "@tauri-apps/api/core";
import { getIntl } from "../i18n/intl";
import { getAppState, produceAppState } from "../store";
import { findEditCorrections } from "../utils/edit-watch.utils";
import { getLogger } from "../utils/log.utils";
import { getLocalStorage } from "../utils/local-storage.utils";
import { getMyUserPreferences } from "../utils/user.utils";
import { showSnackbar } from "./app.actions";
import { createGlossaryTerms } from "./dictionary.actions";
import { showToast } from "./toast.actions";

const WATCH_WINDOW_MS = 90_000;
const DENIED_TERMS_KEY = "mausvoice:auto-learn-denied";
const MAX_DENIED_TERMS = 50;

type WatchSnapshot = {
  text: string;
  startedAt: number;
  /** Focused app captured right after insertion; null when lookup failed. */
  appName: string | null;
};

// The in-flight dictation snapshot is transient polling state, not UI state,
// so it lives here rather than in the Zustand store.
let activeWatch: WatchSnapshot | null = null;

const isFeatureEnabled = (): boolean =>
  getMyUserPreferences(getAppState())?.autoLearnFromEditsEnabled ?? false;

const readDeniedTerms = (): Set<string> => {
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
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }
  const key = term.toLowerCase();
  const denied = readDeniedTerms();
  denied.add(key);
  const trimmed = Array.from(denied).slice(-MAX_DENIED_TERMS);
  try {
    storage.setItem(DENIED_TERMS_KEY, JSON.stringify(trimmed));
  } catch (error) {
    getLogger().warning(`Failed to persist denied auto-learn terms: ${error}`);
  }
};

/**
 * Starts watching the target app for corrections after a dictation was
 * inserted. Replaces any previous snapshot; a no-op when the feature is off.
 */
export const beginEditWatch = (text: string): void => {
  const normalized = text.trim();
  if (!normalized || !isFeatureEnabled()) {
    activeWatch = null;
    return;
  }
  activeWatch = { text: normalized, startedAt: Date.now(), appName: null };

  // Capture the focused app while the paste has just landed, so later polls
  // can stop watching once the user moves focus to a different app.
  void invoke<{ appName: string }>("get_current_app_info")
    .then((info) => {
      if (activeWatch && activeWatch.text === normalized) {
        activeWatch.appName = info.appName;
      }
    })
    .catch(() => {});
};

export const endEditWatch = (): void => {
  activeWatch = null;
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

const collectExistingTerms = (): string[] =>
  Object.values(getAppState().termById).flatMap((term) =>
    term.destinationValue
      ? [term.sourceValue, term.destinationValue]
      : [term.sourceValue],
  );

const proposeAutoLearnTerm = async (term: string): Promise<void> => {
  const intl = getIntl();
  await showToast({
    message: intl.formatMessage(
      { defaultMessage: 'Add "{term}" to your dictionary?' },
      { term },
    ),
    toastType: "info",
    duration: 10_000,
    action: "auto_learn_accept",
    rejectAction: "auto_learn_reject",
  });
};

/**
 * Reads the focused text field and, when it contains the inserted dictation
 * with a small proper-noun correction, proposes the corrected term.
 */
export const pollEditWatch = async (): Promise<void> => {
  if (!isWatchActive()) {
    return;
  }

  const snapshot = activeWatch as WatchSnapshot;
  if (getAppState().autoLearn.proposal) {
    return;
  }

  try {
    const [fieldInfo, appInfo] = await Promise.all([
      invoke<{ textContent: string | null }>("get_text_field_info"),
      invoke<{ appName: string }>("get_current_app_info").catch(() => null),
    ]);

    // Focus moved to another app after the dictation landed; corrections
    // made there are not ours to learn.
    if (snapshot.appName && appInfo && appInfo.appName !== snapshot.appName) {
      endEditWatch();
      return;
    }

    const fieldText = fieldInfo.textContent?.trim();
    if (!fieldText) {
      return;
    }

    const corrections = findEditCorrections({
      insertedText: snapshot.text,
      fieldText,
      existingTerms: collectExistingTerms(),
    });
    if (corrections.length === 0) {
      return;
    }

    const term = corrections[0];
    if (readDeniedTerms().has(term.toLowerCase())) {
      return;
    }

    produceAppState((draft) => {
      draft.autoLearn.proposal = { term };
    });
    await proposeAutoLearnTerm(term);
  } catch (error) {
    getLogger().warning(`Edit watch poll failed: ${error}`);
  }
};

/** Clears the active auto-learn proposal so the pill can show the next one. */
export const clearAutoLearnProposal = (): void => {
  produceAppState((draft) => {
    draft.autoLearn.proposal = null;
  });
};

/**
 * Accepts the proposed correction and persists it as a glossary term. Shows
 * a confirmation snackbar on success and logs a warning on persistence failure
 * since the pill offers no retry path.
 */
export const acceptAutoLearnProposal = async (): Promise<void> => {
  const proposal = getAppState().autoLearn.proposal;
  if (!proposal) {
    return;
  }

  const { term } = proposal;
  clearAutoLearnProposal();

  const { created, failed } = await createGlossaryTerms([term]);
  if (created.length > 0) {
    showSnackbar(
      getIntl().formatMessage(
        { defaultMessage: 'Added "{term}" to your dictionary' },
        { term },
      ),
      { mode: "success" },
    );
  }
  if (failed > 0) {
    // createGlossaryTerms already logged the underlying error; make the
    // failure observable here too, since the pill offers no retry.
    getLogger().warning(
      `Failed to add accepted auto-learn term "${term}" to the dictionary.`,
    );
  }
};

export const rejectAutoLearnProposal = (): void => {
  const proposal = getAppState().autoLearn.proposal;
  if (!proposal) {
    return;
  }

  rememberDeniedTerm(proposal.term);
  clearAutoLearnProposal();
};
