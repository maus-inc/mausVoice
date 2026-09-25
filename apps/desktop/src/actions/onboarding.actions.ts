import { User, UserPreferences } from "@maus-inc/types";
import { detectLocale } from "../i18n/intl";
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
import { DEFAULT_HANDS_FREE_DELAY_MS } from "../utils/hands-free-delay.utils";
import { PRIMARY_LANGUAGE_SENTINEL } from "../utils/language.utils";
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

export const resumeOnboardingPage = (): void => {
  const state = getAppState();
  const resume = state.local.onboardingResumePage;
  if (
    state.auth &&
    (!isOnboardingNameDraftOwnedByAuth(
      state.local.onboardingNameDraftUserId,
      state.auth.uid,
    ) ||
      state.local.onboardingSessionUserId !== state.auth.uid)
  ) {
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

export const setOnboardingIsMac = (isMac: boolean) => {
  produceAppState((draft) => {
    draft.onboarding.isMac = isMac;
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

export const submitOnboarding = async () => {
  const state = getAppState();
  const initiatingAuthSessionNonce = state.authSessionNonce;
  const trimmedName = resolveOnboardingName(
    state.onboarding,
    state.local.onboardingNameDraft,
  );
  const nameDraftBelongsToUser =
    !state.auth ||
    isOnboardingNameDraftOwnedByAuth(
      state.local.onboardingNameDraftUserId,
      state.auth.uid,
    );
  if (
    state.auth &&
    (!nameDraftBelongsToUser ||
      !state.onboarding.firstName.trim() ||
      !trimmedName)
  ) {
    showErrorSnackbar(new Error("Enter your name before continuing."));
    return null;
  }
  const preferredMicrophone = getOptionalText(
    state.onboarding.preferredMicrophone,
  );

  const transcriptionPreference: TranscriptionPrefs =
    getTranscriptionPrefs(state);

  const postProcessingPreference: GenerativePrefs = getGenerativePrefs(state);
  const agentModePreference = getAgentModePrefs(state);

  produceAppState((draft) => {
    draft.onboarding.submitting = true;
    draft.onboarding.name = trimmedName;
    draft.local.onboardingNameDraft = trimmedName;
    if (draft.auth?.uid) {
      draft.local.onboardingNameDraftUserId = draft.auth.uid;
      draft.local.onboardingSessionUserId = draft.auth.uid;
    }
  });

  try {
    const repo = getUserRepo();
    const preferencesRepo = getUserPreferencesRepo();
    const now = new Date().toISOString();
    const userId = getMyEffectiveUserId(state);

    const user: User = {
      id: userId,
      createdAt: now,
      updatedAt: now,
      name: trimmedName,
      title: getOptionalText(state.onboarding.title),
      company: getOptionalText(state.onboarding.company),
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
      referralSource: state.onboarding.referralSource || null,
    };

    const preferences: UserPreferences = {
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
        agentModePreference.mode === "api"
          ? agentModePreference.apiKeyId
          : null,
      openclawGatewayUrl:
        agentModePreference.mode === "openclaw"
          ? agentModePreference.gatewayUrl
          : null,
      openclawToken:
        agentModePreference.mode === "openclaw"
          ? agentModePreference.token
          : null,
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
    };

    const [savedUser, savedPreferences] = await Promise.all([
      repo.setMyUser(user),
      preferencesRepo.setUserPreferences(preferences),
    ]);

    if (getAppState().authSessionNonce !== initiatingAuthSessionNonce) {
      return null;
    }
    produceAppState((draft) => {
      setCurrentUser(draft, savedUser);
      setUserPreferences(draft, savedPreferences);
      draft.onboarding.submitting = false;
      draft.onboarding.name = savedUser.name;
      draft.local.onboardingNameDraft = savedUser.name;
      if (draft.auth?.uid) {
        draft.local.onboardingNameDraftUserId = draft.auth.uid;
        draft.local.onboardingSessionUserId = draft.auth.uid;
      }
    });

    await refreshMember();
    if (getAppState().authSessionNonce !== initiatingAuthSessionNonce) {
      return null;
    }
    return savedUser;
  } catch (err) {
    if (getAppState().authSessionNonce !== initiatingAuthSessionNonce) {
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
  const initiatingAuthSessionNonce = state.authSessionNonce;
  const existingUser = getMyUser(state);
  if (!existingUser) {
    throw new Error("Cannot finish onboarding: user not found");
  }

  clearLocalStorageValue("mausvoice:checklist-writing-style");
  clearLocalStorageValue("mausvoice:checklist-dictionary");
  clearLocalStorageValue("mausvoice:checklist-dismissed");

  try {
    const repo = getUserRepo();
    const now = new Date().toISOString();

    const updatedUser: User = {
      ...existingUser,
      updatedAt: now,
      onboarded: true,
      onboardedAt: now,
      hasFinishedTutorial: true,
    };

    const savedUser = await repo.setMyUser(updatedUser);
    if (getAppState().authSessionNonce !== initiatingAuthSessionNonce) {
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
    if (getAppState().authSessionNonce !== initiatingAuthSessionNonce) {
      return null;
    }

    return savedUser;
  } catch (err) {
    if (getAppState().authSessionNonce !== initiatingAuthSessionNonce) {
      return null;
    }
    showErrorSnackbar(err);
    throw err;
  }
};
