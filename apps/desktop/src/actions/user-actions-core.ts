import { User, UserPreferences } from "@maus-inc/types";
import { getIntl } from "../i18n";
import { getUserPreferencesRepo, getUserRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import { DEFAULT_DICTATION_LIMIT_MINUTES } from "../utils/dictation-limit.utils";
import { DEFAULT_HANDS_FREE_DELAY_MS } from "../utils/hands-free-delay.utils";
import { PRIMARY_LANGUAGE_SENTINEL } from "../utils/language.utils";
import { getLogger } from "../utils/log.utils";
import {
  type LocalDataWriteLease,
  beginLocalDataWrite,
  withLocalDataWrite,
} from "../utils/local-data-write-gate";
import { createMutationQueue } from "../utils/mutation-queue";
import {
  getMyEffectiveUserId,
  getMyUser,
  getMyUserPreferences,
  LOCAL_USER_ID,
  setCurrentUser,
  setUserPreferences,
} from "../utils/user.utils";
import { showErrorSnackbar } from "./app.actions";

// Serializes profile mutations. `setMyUser` upserts the whole row, so two
// overlapping writes can clobber each other: whichever lands last wins, and a
// stale payload reverts every field the newer one changed. Each task reads the
// latest committed user when it actually runs, so its payload builds on the
// previous task's result rather than on a snapshot taken at call time.
export const { enqueue: enqueueUserMutation } = createMutationQueue();

// A rejected repository call can have committed before its response failed.
// Do not base the next whole-row update on an unverified profile in that case.
let userNeedsReconciliation = false;

const reconcileUser = async (lease: LocalDataWriteLease): Promise<void> => {
  const latest = await getUserRepo().getMyUser();
  if (!latest) throw new Error("Unable to reload the user profile.");
  produceAppState((draft) => setCurrentUser(draft, latest), lease);
  userNeedsReconciliation = false;
};

const recoverUserAfterFailedWrite = async (
  existing: User,
  payload: User,
  lease: LocalDataWriteLease,
): Promise<void> => {
  const reloaded = await getUserRepo()
    .getMyUser()
    .catch((error: unknown) => {
      getLogger().error(`Failed to re-read user after a failed save: ${error}`);
      return null;
    });
  if (reloaded) {
    produceAppState((draft) => setCurrentUser(draft, reloaded), lease);
    return;
  }
  userNeedsReconciliation = true;
  if (getMyUser(getAppState()) === payload) {
    produceAppState((draft) => setCurrentUser(draft, existing), lease);
  }
};

export const updateUser = (
  updateCallback: (user: User) => void,
  errorMessage: string,
  saveErrorMessage: string,
  existingLease?: LocalDataWriteLease,
  options: { requireUser?: boolean; showErrorToast?: boolean } = {},
): Promise<void> =>
  enqueueUserMutation(async () => {
    const saveUser = async (lease: LocalDataWriteLease): Promise<void> => {
      if (userNeedsReconciliation) {
        try {
          await reconcileUser(lease);
        } catch (error) {
          getLogger().error(`Failed to reconcile user before update: ${error}`);
          if (options.showErrorToast !== false)
            showErrorSnackbar(saveErrorMessage);
          throw error;
        }
      }
      const state = getAppState();
      const existing = getMyUser(state);
      if (!existing) {
        getLogger().warning(`updateUser: user not found (${errorMessage})`);
        if (options.showErrorToast !== false) showErrorSnackbar(errorMessage);
        if (options.requireUser) throw new Error(errorMessage);
        return;
      }

      const repo = getUserRepo();
      const payload: User = {
        ...existing,
        updatedAt: new Date().toISOString(),
      };

      updateCallback(payload);
      produceAppState((draft) => setCurrentUser(draft, payload), lease);

      try {
        getLogger().verbose(`Saving user (id=${payload.id})`);
        const saved = await repo.setMyUser(payload, lease);
        produceAppState((draft) => {
          setCurrentUser(draft, saved);
        }, lease);
        getLogger().verbose("User saved successfully");
      } catch (error) {
        getLogger().error(`Failed to update user: ${error}`);
        // A rejected write can have an uncertain outcome. Re-read if possible.
        // If that fails, withdraw our optimistic value only if it is still the
        // current object, and require a fresh read before the next profile edit.
        await recoverUserAfterFailedWrite(existing, payload, lease);
        if (options.showErrorToast !== false)
          showErrorSnackbar(saveErrorMessage);
        throw error;
      }
    };

    if (existingLease) {
      await withLocalDataWrite(saveUser, existingLease);
      return;
    }

    const releaseWrite = beginLocalDataWrite();
    if (!releaseWrite) return;
    try {
      await saveUser(releaseWrite.lease);
    } finally {
      releaseWrite();
    }
  });

export const createDefaultPreferences = (): UserPreferences => ({
  userId: LOCAL_USER_ID,
  transcriptionMode: null,
  transcriptionApiKeyId: null,
  transcriptionDevice: null,
  transcriptionModelSize: null,
  postProcessingMode: null,
  postProcessingApiKeyId: null,
  postProcessingOllamaUrl: null,
  postProcessingOllamaModel: null,
  activeToneId: null,
  gotStartedAt: null,
  gpuEnumerationEnabled: false,
  agentMode: null,
  agentModeApiKeyId: null,
  openclawGatewayUrl: null,
  openclawToken: null,
  lastSeenFeature: null,
  activeDictationLanguage: PRIMARY_LANGUAGE_SENTINEL,
  preferredMicrophone: null,
  ignoreUpdateDialog: false,
  incognitoModeEnabled: false,
  incognitoModeIncludeInStats: false,
  preserveAudioOnFailure: true,
  dictationLimitMinutes: DEFAULT_DICTATION_LIMIT_MINUTES,
  dictationPillVisibility: "while_active",
  pillResetMonitorStrategy: "current",
  pillPlacement: "bottom",
  updateChannel: "stable",

  alwaysRequestAdminOnStartup: false,
  spokenCommandsEnabled: true,
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
  handsFreeDelayMs: DEFAULT_HANDS_FREE_DELAY_MS,
  inDictationStyleSwitchingEnabled: false,
  hallucinationFilterEnabled: true,
  reviewBeforeInsert: null,
  agentEnabledTools: null,
  agentMaxIterations: 20,
  agentPermissionTimeoutMs: 60_000,
  autoLearnDictionaryEnabled: true,
  autoLearnFromEditsEnabled: false,
  elevenLabsKeytermsEnabled: false,
  expansionFlags: "{}",
});

// Serializes preference mutations so overlapping tool toggles or numeric edits
// cannot read a stale snapshot and clobber each other's change. Each task reads
// the latest committed preferences when it actually runs.
const { enqueue: enqueuePrefsMutation } = createMutationQueue();
let preferencesNeedReconciliation = false;

const reconcilePreferences = async (
  lease: LocalDataWriteLease,
): Promise<void> => {
  const latest = await getUserPreferencesRepo().getUserPreferences();
  produceAppState((draft) => {
    setUserPreferences(draft, latest ?? createDefaultPreferences());
  }, lease);
  preferencesNeedReconciliation = false;
};

type UpdateUserPreferencesOptions = {
  /** Set false when the caller presents the failure inline. */
  showErrorToast?: boolean;
  /** Reuse a write lease the caller already holds instead of taking one. */
  existingLease?: LocalDataWriteLease;
};

export const updateUserPreferences = (
  updateCallback: (preferences: UserPreferences) => void | false,
  saveErrorMessage = getIntl().formatMessage({
    defaultMessage: "Failed to save AI preferences. Please try again.",
  }),
  options: UpdateUserPreferencesOptions = {},
): Promise<void> =>
  enqueuePrefsMutation(async () => {
    const savePreferences = async (
      lease: LocalDataWriteLease,
    ): Promise<void> => {
      if (preferencesNeedReconciliation) {
        try {
          await reconcilePreferences(lease);
        } catch (error) {
          getLogger().error(
            `Failed to reconcile preferences before update: ${error}`,
          );
          if (options.showErrorToast !== false)
            showErrorSnackbar(saveErrorMessage);
          throw error;
        }
      }
      const state = getAppState();
      const myUserId = getMyEffectiveUserId(state);

      let existing = getMyUserPreferences(state);
      if (!existing) {
        try {
          existing = await getUserPreferencesRepo().getUserPreferences();
        } catch (error) {
          getLogger().error(
            `Failed to load existing preferences before update: ${error}`,
          );
          if (options.showErrorToast !== false) {
            showErrorSnackbar(saveErrorMessage);
          }
          throw error;
        }
      }

      const safeExisting = existing ?? createDefaultPreferences();
      // The mutation runs when this task reaches the front of the queue, so it
      // always derives from the most recently committed preferences.
      const payload: UserPreferences = { ...safeExisting, userId: myUserId };
      if (updateCallback(payload) === false) return;

      try {
        getLogger().verbose(`Saving user preferences (userId=${myUserId})`);
        const saved = await getUserPreferencesRepo().setUserPreferences(
          payload,
          lease,
        );
        produceAppState((draft) => {
          setUserPreferences(draft, saved);
        }, lease);
        getLogger().verbose("User preferences saved successfully");
      } catch (error) {
        getLogger().error(`Failed to update user preferences: ${error}`);
        preferencesNeedReconciliation = true;
        try {
          await reconcilePreferences(lease);
        } catch (recoveryError) {
          getLogger().error(
            `Failed to re-read preferences after a failed save: ${recoveryError}`,
          );
        }
        if (options.showErrorToast !== false) {
          showErrorSnackbar(saveErrorMessage);
        }
        throw error;
      }
    };

    if (options.existingLease) {
      await withLocalDataWrite(savePreferences, options.existingLease);
      return;
    }

    const releaseWrite = beginLocalDataWrite();
    if (!releaseWrite) return;
    try {
      await savePreferences(releaseWrite.lease);
    } finally {
      releaseWrite();
    }
  });
