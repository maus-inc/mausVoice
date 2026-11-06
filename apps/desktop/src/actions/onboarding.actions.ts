import { User, UserPreferences } from "@maus-inc/types";
import { detectLocale } from "../i18n/intl";
import type { AppState } from "../state/app.state";
import { getUserPreferencesRepo, getUserRepo } from "../repos";
import {
  applyOnboardingNameDraft,
  createOnboardingNameDraft,
  INITIAL_ONBOARDING_STATE,
  isOnboardingNameDraftOwnedByAuth,
  OnboardingPageKey,
  OnboardingState,
  resolveOnboardingName,
} from "../state/onboarding.state";
import { getAppState, produceAppState } from "../store";
import { CURRENT_COHORT } from "../utils/analytics.utils";
import { DEFAULT_DICTATION_LIMIT_MINUTES } from "../utils/dictation-limit.utils";
import {
  captureExpansionFlags,
  preserveNewerExpansionFlags,
} from "../utils/expansion-flags-revision";
import { DEFAULT_HANDS_FREE_DELAY_MS } from "../utils/hands-free-delay.utils";
import { PRIMARY_LANGUAGE_SENTINEL } from "../utils/language.utils";
import { captureUserSession } from "../utils/user-session.utils";
import {
  EMAIL_TONE_ID,
  POLISHED_TONE_ID,
  VERBATIM_TONE_ID,
} from "../utils/tone.utils";
import {
  GenerativePrefs,
  getAgentModePrefs,
  getGenerativePrefs,
  getMyEffectiveUserId,
  getMyUser,
  getTranscriptionPrefs,
  setCurrentUser,
  setUserPreferences,
  TranscriptionPrefs,
} from "../utils/user.utils";
import { showErrorSnackbar } from "./app.actions";
import { clearLocalStorageValue } from "./local-storage.actions";
import { refreshMember } from "./member.actions";
import { setAutoLaunchEnabled } from "./settings.actions";
import {
  trackButtonClick,
  trackOnboardingOutcome,
  type OnboardingOutcome,
} from "../utils/analytics.utils";
import { isMacOS } from "../utils/env.utils";
import { isPermissionAuthorized } from "../utils/permission.utils";

export const CURRENT_ONBOARDING_FLOW_VERSION = 3;

const postPermissionsPage = (): OnboardingPageKey =>
  isMacOS() ? "micPerms" : "keybindings";

const stepEnteredAt = new Map<OnboardingPageKey, number>();

export const markOnboardingStepEntered = (page: OnboardingPageKey): void => {
  stepEnteredAt.set(page, Date.now());
};

const recordStepOutcome = (
  page: OnboardingPageKey,
  outcome: OnboardingOutcome,
): void => {
  const startedAt = stepEnteredAt.get(page);
  trackOnboardingOutcome(
    page,
    outcome,
    startedAt !== undefined ? Date.now() - startedAt : undefined,
  );
  stepEnteredAt.delete(page);
};

/**
 * Pages cut from the v3 first run. Anyone resuming onto one (persisted
 * progress from an older flow) lands on the nearest kept page instead of
 * a blank screen. Migrations never replay completed permission steps.
 */
const nearestKeptPage = (page: OnboardingPageKey): OnboardingPageKey => {
  switch (page) {
    case "chooseLlm":
    case "referralSource":
      return postPermissionsPage();
    case "userDetails":
      return "chooseTranscription";
    case "unlockedPro":
      return "tutorial";
    default:
      return page;
  }
};

export const ensureOnboardingFlow = (): void => {
  const state = getAppState();
  if (state.local.onboardingFlowVersion >= CURRENT_ONBOARDING_FLOW_VERSION) {
    return;
  }
  produceAppState((draft) => {
    draft.onboarding.currentPage = nearestKeptPage(
      draft.onboarding.currentPage,
    );
    draft.onboarding.history = draft.onboarding.history.map(nearestKeptPage);
    if (draft.local.onboardingResumePage) {
      draft.local.onboardingResumePage = nearestKeptPage(
        draft.local.onboardingResumePage,
      );
    }
    draft.local.onboardingFlowVersion = CURRENT_ONBOARDING_FLOW_VERSION;
  });
};

export const markPrerequisite = (id: string): void => {
  produceAppState((draft) => {
    if (!draft.local.completedPrerequisites.includes(id)) {
      draft.local.completedPrerequisites.push(id);
    }
  });
};

export const dismissTip = (id: string): void => {
  trackButtonClick("tip_dismiss", { tipId: id });
  produceAppState((draft) => {
    if (!draft.local.dismissedTipIds.includes(id)) {
      draft.local.dismissedTipIds.push(id);
    }
  });
};

export const resetTip = (id: string): void => {
  trackButtonClick("tip_show_again", { tipId: id });
  produceAppState((draft) => {
    draft.local.dismissedTipIds = draft.local.dismissedTipIds.filter(
      (tipId) => tipId !== id,
    );
  });
};

const hasStaleOnboardingAccountState = (onboarding: OnboardingState): boolean =>
  onboarding.name.trim() !== "" ||
  onboarding.firstName.trim() !== "" ||
  onboarding.lastName.trim() !== "" ||
  onboarding.title.trim() !== "" ||
  onboarding.company.trim() !== "" ||
  onboarding.referralSource.trim() !== "" ||
  onboarding.preferredMicrophone !== null;

/** Detect persisted onboarding data belonging to a different or unknown account. */
const hasStaleAccountSession = (state: AppState): boolean => {
  if (!state.auth) return false;
  const hasForeignNameDraft =
    state.local.onboardingNameDraftUserId !== null &&
    !isOnboardingNameDraftOwnedByAuth(
      state.local.onboardingNameDraftUserId,
      state.auth.uid,
    );
  const hasForeignSession =
    state.local.onboardingSessionUserId !== null &&
    state.local.onboardingSessionUserId !== state.auth.uid;
  const hasUnownedCompletedSession =
    state.local.onboardingSessionUserId === null &&
    state.local.onboardingResumePage === null &&
    state.local.onboardingNameDraft === "" &&
    hasStaleOnboardingAccountState(state.onboarding);
  return hasForeignNameDraft || hasForeignSession || hasUnownedCompletedSession;
};

export const resumeOnboardingPage = (): void => {
  const state = getAppState();
  if (state.auth && !state.initialized) return;
  const resume = state.local.onboardingResumePage;
  if (hasStaleAccountSession(state)) {
    const existingName = getMyUser(state)?.name.trim() ?? "";
    produceAppState((draft) => {
      Object.assign(draft.onboarding, INITIAL_ONBOARDING_STATE);
      applyOnboardingNameDraft(
        draft.onboarding,
        createOnboardingNameDraft(existingName),
      );
      draft.onboarding.currentPage = "signIn";
      draft.onboarding.isResuming = false;
      draft.local.onboardingResumePage = null;
      draft.local.onboardingNameDraft = existingName;
      draft.local.onboardingNameDraftUserId = draft.auth?.uid ?? null;
      draft.local.onboardingSessionUserId = draft.auth?.uid ?? null;
    });
    return;
  }
  if (
    resume &&
    resume !== state.onboarding.currentPage &&
    state.onboarding.history.length === 0
  ) {
    const resumeName =
      state.local.onboardingNameDraft || getMyUser(state)?.name || "";
    if (state.auth && resume !== "signIn" && !resumeName) {
      produceAppState((draft) => {
        draft.onboarding.currentPage = "signIn";
        draft.onboarding.isResuming = false;
        draft.local.onboardingResumePage = null;
        draft.local.onboardingNameDraft = "";
        draft.local.onboardingNameDraftUserId = null;
        draft.local.onboardingSessionUserId = null;
      });
      return;
    }
    // Restoring persisted state is not completing the initial sign-in step.
    // Keep the empty navigation stack rather than inventing a back target.
    produceAppState((draft) => {
      applyOnboardingNameDraft(
        draft.onboarding,
        createOnboardingNameDraft(resumeName),
      );
      draft.onboarding.currentPage = nearestKeptPage(resume);
      draft.onboarding.isResuming = true;
      draft.local.onboardingResumePage = draft.onboarding.currentPage;
      draft.local.onboardingNameDraft = resumeName;
      if (draft.auth?.uid) {
        draft.local.onboardingNameDraftUserId = draft.auth.uid;
        draft.local.onboardingSessionUserId = draft.auth.uid;
      }
    });
  }
};

/** Skip already-granted permission pages only while restoring a saved flow. */
export const advanceResumedPermissionPage = (
  page: "micPerms" | "a11yPerms",
): void => {
  const state = getAppState();
  const permission = page === "micPerms" ? "microphone" : "accessibility";
  if (
    !state.onboarding.isResuming ||
    state.onboarding.currentPage !== page ||
    !isPermissionAuthorized(state.permissions[permission]?.state)
  )
    return;
  const next = page === "micPerms" && isMacOS() ? "a11yPerms" : "keybindings";
  produceAppState((draft) => {
    if (!draft.local.completedPrerequisites.includes(permission)) {
      draft.local.completedPrerequisites.push(permission);
    }
    draft.onboarding.currentPage = next;
    draft.local.onboardingResumePage = next;
  });
};

const navigateToOnboardingPage = (
  onboarding: OnboardingState,
  nextPage: OnboardingPageKey,
) => {
  if (onboarding.currentPage === nextPage) {
    return;
  }

  onboarding.history.push(onboarding.currentPage);
  onboarding.currentPage = nextPage;
};

export const goBackOnboardingPage = () => {
  const leaving = getAppState().onboarding.currentPage;
  produceAppState((draft) => {
    draft.onboarding.isResuming = false;
    const previousPage = draft.onboarding.history.pop();
    if (previousPage) {
      draft.onboarding.currentPage = previousPage;
      draft.local.onboardingResumePage = previousPage;
    }
  });
  if (leaving !== getAppState().onboarding.currentPage) {
    recordStepOutcome(leaving, "back");
  }
};

export const goToOnboardingPage = (
  nextPage: OnboardingPageKey,
  outcome: Extract<OnboardingOutcome, "complete" | "skip"> = "complete",
) => {
  const leaving = getAppState().onboarding.currentPage;
  produceAppState((draft) => {
    draft.onboarding.isResuming = false;
    navigateToOnboardingPage(draft.onboarding, nextPage);
    draft.local.onboardingResumePage = draft.onboarding.currentPage;
  });
  if (leaving !== nextPage) {
    recordStepOutcome(leaving, outcome);
  }
};

export const resetOnboarding = () => {
  produceAppState((draft) => {
    Object.assign(draft.onboarding, INITIAL_ONBOARDING_STATE);
    draft.local.onboardingNameDraft = "";
    draft.local.onboardingNameDraftUserId = null;
    draft.local.onboardingSessionUserId = null;
  });
};

export const setDidSignUpWithAccount = (didSignUp: boolean) => {
  produceAppState((draft) => {
    draft.onboarding.didSignUpWithAccount = didSignUp;
  });
};

export const setOnboardingPreferredMicrophone = (microphone: string | null) => {
  produceAppState((draft) => {
    draft.onboarding.preferredMicrophone = microphone;
  });
};

const getOptionalText = (value: string | null | undefined): string | null =>
  value?.trim() || null;

const createOnboardingPreferences = (
  userId: string,
  preferredMicrophone: string | null,
  transcriptionPreference: TranscriptionPrefs,
  postProcessingPreference: GenerativePrefs,
  agentModePreference: ReturnType<typeof getAgentModePrefs>,
): UserPreferences => ({
  updateChannel: "stable",
  gpuEnumerationEnabled:
    transcriptionPreference.mode === "local"
      ? transcriptionPreference.gpuEnumerationEnabled
      : false,
  userId,
  transcriptionMode: transcriptionPreference.mode,
  transcriptionApiKeyId:
    transcriptionPreference.mode === "api"
      ? transcriptionPreference.apiKeyId
      : null,
  transcriptionDevice:
    transcriptionPreference.mode === "local"
      ? transcriptionPreference.transcriptionDevice
      : null,
  transcriptionModelSize:
    transcriptionPreference.mode === "local"
      ? transcriptionPreference.transcriptionModelSize
      : null,
  postProcessingMode: postProcessingPreference.mode,
  postProcessingApiKeyId:
    postProcessingPreference.mode === "api"
      ? postProcessingPreference.apiKeyId
      : null,
  postProcessingOllamaUrl: null,
  postProcessingOllamaModel: null,
  activeToneId: null,
  gotStartedAt: null,
  agentMode: agentModePreference.mode,
  agentModeApiKeyId:
    agentModePreference.mode === "api" ? agentModePreference.apiKeyId : null,
  openclawGatewayUrl:
    agentModePreference.mode === "openclaw"
      ? agentModePreference.gatewayUrl
      : null,
  openclawToken:
    agentModePreference.mode === "openclaw" ? agentModePreference.token : null,
  lastSeenFeature: null,
  activeDictationLanguage: PRIMARY_LANGUAGE_SENTINEL,
  preferredMicrophone,
  ignoreUpdateDialog: false,
  incognitoModeEnabled: false,
  incognitoModeIncludeInStats: false,
  preserveAudioOnFailure: true,
  dictationLimitMinutes: DEFAULT_DICTATION_LIMIT_MINUTES,
  dictationPillVisibility: "persistent",
  realtimeOutputEnabled: false,
  remoteOutputEnabled: false,
  remoteTargetDeviceId: null,
  remoteReceiverPort: null,
  remoteReceiverAutoStart: false,
  dictationAudioDim: 1.0,
  pasteKeybind: null,
  menuBarIconHidden: false,
  insertionMethod: null,
  typingSpeedMs: null,
  pillResetMonitorStrategy: "current",
  pillPlacement: "bottom",
  alwaysRequestAdminOnStartup: false,
  handsFreeDelayMs: DEFAULT_HANDS_FREE_DELAY_MS,
  inDictationStyleSwitchingEnabled: false,
  hallucinationFilterEnabled: true,
  reviewBeforeInsert: null,
  agentEnabledTools: null,
  agentMaxIterations: 20,
  agentPermissionTimeoutMs: 60_000,
  spokenCommandsEnabled: true,
  autoLearnDictionaryEnabled: true,
  autoLearnFromEditsEnabled: false,
  elevenLabsKeytermsEnabled: false,
  expansionFlags: "{}",
});

type OnboardingPreferences = ReturnType<typeof createOnboardingPreferences>;

/**
 * The Continue button is already disabled when the name is blank, so this is
 * the defensive twin: an unowned draft or a blank name must never be written.
 */
const onboardingNameIsSubmittable = (
  state: ReturnType<typeof getAppState>,
): boolean => {
  if (!state.auth) return true;
  return (
    isOnboardingNameDraftOwnedByAuth(
      state.local.onboardingNameDraftUserId,
      state.auth.uid,
    ) &&
    state.onboarding.firstName.trim() !== "" &&
    resolveOnboardingName(state.onboarding, state.local.onboardingNameDraft) !==
      ""
  );
};

/** Publish the submitted name and mark the flow busy until the writes settle. */
const markOnboardingSubmitting = (trimmedName: string): void => {
  produceAppState((draft) => {
    draft.onboarding.submitting = true;
    draft.onboarding.name = trimmedName;
    draft.local.onboardingNameDraft = trimmedName;
    if (draft.auth?.uid) {
      draft.local.onboardingNameDraftUserId = draft.auth.uid;
      draft.local.onboardingSessionUserId = draft.auth.uid;
    }
  });
};

/** Project the onboarding answers onto the user row that gets written. */
const buildOnboardingUser = ({
  userId,
  now,
  trimmedName,
  currentState,
}: {
  userId: string;
  now: string;
  trimmedName: string;
  currentState: ReturnType<typeof getAppState>;
}): User => ({
  id: userId,
  createdAt: now,
  updatedAt: now,
  name: trimmedName,
  title: getOptionalText(currentState.onboarding.title),
  company: getOptionalText(currentState.onboarding.company),
  bio: null,
  onboarded: false,
  onboardedAt: null,
  timezone: null,
  preferredMicrophone: null,
  preferredLanguage: detectLocale(),
  wordsThisMonth: 0,
  wordsThisMonthMonth: null,
  wordsTotal: 0,
  playInteractionChime: true,
  hasFinishedTutorial: false,
  hasMigratedPreferredMicrophone: true,
  cohort: CURRENT_COHORT,
  stylingMode: "manual",
  activeToneIds: [POLISHED_TONE_ID, EMAIL_TONE_ID, VERBATIM_TONE_ID],
  selectedToneId: POLISHED_TONE_ID,
  referralSource: currentState.onboarding.referralSource || null,
});

type OnboardingWrites =
  | { retired: true }
  | {
      retired: false;
      savedUser: User;
      savedPreferences: OnboardingPreferences;
    };

/**
 * Dispatch both rows and classify the outcome. A failed write does not cancel
 * the other, so the caller keeps the submitting flag set until both settle
 * rather than inviting a retry while the other write can still overwrite it.
 */
const settleOnboardingWrites = async ({
  repo,
  preferencesRepo,
  user,
  preferences,
  isCurrentSession,
}: {
  repo: ReturnType<typeof getUserRepo>;
  preferencesRepo: ReturnType<typeof getUserPreferencesRepo>;
  user: User;
  preferences: OnboardingPreferences;
  isCurrentSession: () => boolean;
}): Promise<OnboardingWrites> => {
  const invokeWrite = <T>(write: () => Promise<T>): Promise<T> => {
    try {
      return Promise.resolve(write());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const userWrite = invokeWrite(() => repo.setMyUser(user));
  const preferencesWrite = isCurrentSession()
    ? invokeWrite(() => preferencesRepo.setUserPreferences(preferences))
    : Promise.resolve(null);
  const [userResult, preferencesResult] = await Promise.allSettled([
    userWrite,
    preferencesWrite,
  ]);
  // Auth handoff resets the onboarding state and submitting flag. A stale
  // operation must neither write new data nor clear its successor's flag.
  if (!isCurrentSession()) return { retired: true };
  if (userResult.status === "rejected") throw userResult.reason;
  if (preferencesResult.status === "rejected") throw preferencesResult.reason;
  if (!preferencesResult.value)
    throw new Error("Onboarding preferences were not saved");
  return {
    retired: false,
    savedUser: userResult.value,
    savedPreferences: preferencesResult.value,
  };
};

/** Adopt both saved rows, keeping expansion flags that arrived meanwhile. */
const commitOnboardingRows = (
  savedUser: User,
  savedPreferences: OnboardingPreferences,
  flagsSnapshot: ReturnType<typeof captureExpansionFlags>,
): void => {
  produceAppState((draft) => {
    setCurrentUser(draft, savedUser);
    setUserPreferences(
      draft,
      preserveNewerExpansionFlags(
        savedPreferences,
        draft.userPrefs,
        flagsSnapshot,
      ),
    );
    draft.onboarding.submitting = false;
    draft.onboarding.name = savedUser.name;
    draft.local.onboardingNameDraft = savedUser.name;
    if (draft.auth?.uid) {
      draft.local.onboardingNameDraftUserId = draft.auth.uid;
      draft.local.onboardingSessionUserId = draft.auth.uid;
    }
  });
};

export const submitOnboarding = async () => {
  const state = getAppState();
  if (state.auth && !state.initialized) return null;
  const isCurrentSession = captureUserSession();
  if (!onboardingNameIsSubmittable(state)) {
    // Defensive: return silently instead of surfacing an unlocalized message
    // (this action module cannot import react-intl).
    return null;
  }
  const trimmedName = resolveOnboardingName(
    state.onboarding,
    state.local.onboardingNameDraft,
  );
  markOnboardingSubmitting(trimmedName);

  try {
    const repo = getUserRepo();
    const preferencesRepo = getUserPreferencesRepo();
    const now = new Date().toISOString();

    // Auth handoff resets the onboarding state and submitting flag.
    if (!isCurrentSession()) {
      return null;
    }
    const currentState = getAppState();
    const userId = getMyEffectiveUserId(currentState);
    const user = buildOnboardingUser({
      userId,
      now,
      trimmedName,
      currentState,
    });
    const preferences = createOnboardingPreferences(
      userId,
      getOptionalText(currentState.onboarding.preferredMicrophone),
      getTranscriptionPrefs(currentState),
      getGenerativePrefs(currentState),
      getAgentModePrefs(currentState),
    );

    // Both repositories write the same local database. Check again before
    // dispatch, but a later auth handoff cannot revoke already-dispatched writes.
    if (!isCurrentSession()) {
      return null;
    }
    const flagsSnapshot = captureExpansionFlags(getAppState().userPrefs);
    const writes = await settleOnboardingWrites({
      repo,
      preferencesRepo,
      user,
      preferences,
      isCurrentSession,
    });
    if (writes.retired) {
      return null;
    }
    commitOnboardingRows(
      writes.savedUser,
      writes.savedPreferences,
      flagsSnapshot,
    );

    await refreshMember();
    if (!isCurrentSession()) {
      return null;
    }
    return writes.savedUser;
  } catch (err) {
    if (!isCurrentSession()) {
      return null;
    }
    produceAppState((draft) => {
      draft.onboarding.submitting = false;
    });
    showErrorSnackbar(err);
    return null;
  }
};

export const finishOnboarding = async () => {
  const state = getAppState();
  if (state.auth && !state.initialized) return null;
  const isCurrentSession = captureUserSession();
  const existingUser = getMyUser(state);
  if (!existingUser) {
    // Called before the post-auth init has hydrated the user row for this
    // session; bail out silently. The init path will re-run onboarding once
    // the new user loads.
    return null;
  }

  clearLocalStorageValue("mausvoice:checklist-writing-style");
  clearLocalStorageValue("mausvoice:checklist-dictionary");
  clearLocalStorageValue("mausvoice:checklist-dismissed");

  try {
    const repo = getUserRepo();
    const now = new Date().toISOString();

    // Avoid dispatching from a retired session. This cannot revoke a write
    // after it has been handed off to the shared local database.
    if (!isCurrentSession()) {
      return null;
    }
    const currentUser = getMyUser(getAppState());
    if (!currentUser) return null;

    const updatedUser: User = {
      ...currentUser,
      updatedAt: now,
      onboarded: true,
      onboardedAt: now,
      hasFinishedTutorial: true,
    };

    const savedUser = await repo.setMyUser(updatedUser);
    if (!isCurrentSession()) {
      return null;
    }
    produceAppState((draft) => {
      setCurrentUser(draft, savedUser);
      draft.local.onboardingResumePage = null;
      draft.local.onboardingNameDraft = "";
      draft.local.onboardingNameDraftUserId = null;
      draft.local.onboardingSessionUserId = null;
      draft.local.onboardingFlowVersion = CURRENT_ONBOARDING_FLOW_VERSION;
    });

    await setAutoLaunchEnabled(true);
    if (!isCurrentSession()) {
      return null;
    }

    return savedUser;
  } catch (err) {
    if (!isCurrentSession()) {
      return null;
    }
    showErrorSnackbar(err);
    return null;
  }
};
