import { User, UserPreferences } from "@maus-inc/types";
import { getIntl } from "../i18n";
import { getUserPreferencesRepo, getUserRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import { DEFAULT_DICTATION_LIMIT_MINUTES } from "../utils/dictation-limit.utils";
import { DEFAULT_HANDS_FREE_DELAY_MS } from "../utils/hands-free-delay.utils";
import { PRIMARY_LANGUAGE_SENTINEL } from "../utils/language.utils";
import { getLogger } from "../utils/log.utils";
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

export const updateUser = (
  updateCallback: (user: User) => void,
  errorMessage: string,
  saveErrorMessage: string,
): Promise<void> =>
  enqueueUserMutation(async () => {
    const state = getAppState();
    const existing = getMyUser(state);
    if (!existing) {
      getLogger().warning(`updateUser: user not found (${errorMessage})`);
      showErrorSnackbar(errorMessage);
      return;
    }

    const repo = getUserRepo();
    const payload: User = {
      ...existing,
      updatedAt: new Date().toISOString(),
    };

    updateCallback(payload);
    produceAppState((draft) => {
      setCurrentUser(draft, payload);
    });

    try {
      getLogger().verbose(`Saving user (id=${payload.id})`);
      await repo.setMyUser(payload);
      getLogger().verbose("User saved successfully");
    } catch (error) {
      getLogger().error(`Failed to update user: ${error}`);
      // Re-read instead of restoring the pre-call snapshot. Another task may
      // have committed a change after this one started, and writing the
      // snapshot back would erase it. If the re-read also fails the optimistic
      // value stays and the error surfaces, which is the honest outcome.
      const reloaded = await getUserRepo()
        .getMyUser()
        .catch((reloadError: unknown) => {
          getLogger().error(
            `Failed to re-read user after a failed save: ${reloadError}`,
          );
          return null;
        });
      produceAppState((draft) => {
        if (reloaded) {
          setCurrentUser(draft, reloaded);
        }
      });
      showErrorSnackbar(saveErrorMessage);
      throw error;
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

export const updateUserPreferences = (
  updateCallback: (preferences: UserPreferences) => void,
  saveErrorMessage = getIntl().formatMessage({
    defaultMessage: "Failed to save AI preferences. Please try again.",
  }),
): Promise<void> =>
  enqueuePrefsMutation(async () => {
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
        showErrorSnackbar(saveErrorMessage);
        throw error;
      }
    }

    const safeExisting = existing ?? createDefaultPreferences();
    // The mutation runs when this task reaches the front of the queue, so it
    // always derives from the most recently committed preferences.
    const payload: UserPreferences = { ...safeExisting, userId: myUserId };
    updateCallback(payload);

    try {
      getLogger().verbose(`Saving user preferences (userId=${myUserId})`);
      const saved = await getUserPreferencesRepo().setUserPreferences(payload);
      produceAppState((draft) => {
        setUserPreferences(draft, saved);
      });
      getLogger().verbose("User preferences saved successfully");
    } catch (error) {
      getLogger().error(`Failed to update user preferences: ${error}`);
      showErrorSnackbar(saveErrorMessage);
      throw error;
    }
  });
