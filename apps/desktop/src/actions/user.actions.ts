import {
  type AgentMode,
  DictationPillVisibility,
  Nullable,
  PillPlacement,
  PillResetMonitorStrategy,
  StylingMode,
  UpdateChannel,
  User,
  UserPreferences,
} from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import dayjs from "dayjs";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { getIntl } from "../i18n";
import { getUserPreferencesRepo, getUserRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import {
  type PostProcessingMode,
  type TranscriptionMode,
} from "../types/ai.types";
import {
  DEFAULT_DICTATION_LIMIT_MINUTES,
  normalizeDictationLimitMinutes,
} from "../utils/dictation-limit.utils";
import {
  DEFAULT_HANDS_FREE_DELAY_MS,
  normalizeHandsFreeDelayMs,
} from "../utils/hands-free-delay.utils";
import { PRIMARY_LANGUAGE_SENTINEL } from "../utils/language.utils";
import {
  isGpuPreferredTranscriptionDevice,
  normalizeLocalWhisperModel,
  normalizeTranscriptionDevice,
} from "../utils/local-transcription.utils";
import { getLogger } from "../utils/log.utils";
import {
  captureExpansionFlags,
  getExpansionFlagsRevision,
  preserveNewerExpansionFlags,
} from "../utils/expansion-flags-revision";
import { getPairedRemoteDeviceById } from "../utils/device.utils";
import { createMutationQueue } from "../utils/mutation-queue";
import { pushPillPlacementToNative } from "./windows-sync.actions";
import { sendPillFireworks, sendPillFlame } from "../utils/overlay.utils";
import {
  getEffectivePillVisibility,
  getMyEffectiveUserId,
  getMyUser,
  getMyUserPreferences,
  LOCAL_USER_ID,
  setCurrentUser,
  setUserPreferences,
} from "../utils/user.utils";
import { getNextPillVisibility } from "../utils/tray-pill-visibility.utils";
import {
  captureUserSession,
  requireUserSession,
} from "../utils/user-session.utils";
import { showErrorSnackbar } from "./app.actions";
import { refreshUpdatesForChannelChange } from "./updater.actions";
import { setLocalStorageValue } from "./local-storage.actions";

// Serializes profile mutations. `setMyUser` upserts the whole row, so two
// overlapping writes can clobber each other: whichever lands last wins, and a
// stale payload reverts every field the newer one changed. Each task reads the
// latest committed user when it actually runs, so its payload builds on the
// previous task's result rather than on a snapshot taken at call time.
const { enqueue: enqueueUserMutation } = createMutationQueue();

const updateUser = (
  updateCallback: (user: User) => void,
  errorMessage: string,
  saveErrorMessage: string,
  shouldUpdate: () => boolean = () => true,
): Promise<void> => {
  const isCurrent = captureUserSession();
  return enqueueUserMutation(async () => {
    // Conditional changes must be checked when the serialized mutation starts,
    // not merely when it was queued behind another user write.
    if (!shouldUpdate()) return;
    requireUserSession(isCurrent);
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
    requireUserSession(isCurrent);
    produceAppState((draft) => {
      setCurrentUser(draft, payload);
    });

    try {
      requireUserSession(isCurrent);
      getLogger().verbose(`Saving user (id=${payload.id})`);
      await repo.setMyUser(payload);
      requireUserSession(isCurrent);
      getLogger().verbose("User saved successfully");
    } catch (error) {
      // An already-dispatched write cannot be revoked. Do not reload or report
      // its result into an account that replaced the one that requested it.
      requireUserSession(isCurrent);
      getLogger().error(`Failed to update user: ${error}`);
      // Re-read instead of restoring the pre-call snapshot. Another task may
      // have committed a change after this one started, and writing the
      // snapshot back would erase it. If the re-read also fails the optimistic
      // value stays and the error surfaces, which is the honest outcome.
      const reloaded = await getUserRepo()
        .getMyUser()
        .catch((reloadError: unknown) => {
          if (isCurrent()) {
            getLogger().error(
              `Failed to re-read user after a failed save: ${reloadError}`,
            );
          }
          return null;
        });
      requireUserSession(isCurrent);
      produceAppState((draft) => {
        if (reloaded) {
          setCurrentUser(draft, reloaded);
        }
      });
      requireUserSession(isCurrent);
      showErrorSnackbar(saveErrorMessage);
      throw error;
    }
  });
};

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
let preferencesRevision = 0;
let pendingPreferenceMutations = 0;

export const updateUserPreferences = (
  updateCallback: (preferences: UserPreferences) => void,
  saveErrorMessage = getIntl().formatMessage({
    defaultMessage: "Failed to save AI preferences. Please try again.",
  }),
  shouldUpdate: (preferences: UserPreferences) => boolean = () => true,
): Promise<void> => {
  const isCurrent = captureUserSession();
  preferencesRevision += 1;
  pendingPreferenceMutations += 1;
  return enqueuePrefsMutation(async () => {
    requireUserSession(isCurrent);
    const state = getAppState();
    const myUserId = getMyEffectiveUserId(state);

    let existing = getMyUserPreferences(state);
    if (!existing) {
      try {
        existing = await getUserPreferencesRepo().getUserPreferences();
        requireUserSession(isCurrent);
      } catch (error) {
        requireUserSession(isCurrent);
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
    // Evaluate conditional repairs only after this task reaches the queue head.
    if (!shouldUpdate(payload)) return;
    updateCallback(payload);
    requireUserSession(isCurrent);

    try {
      const flagsSnapshot = captureExpansionFlags(getAppState().userPrefs);
      getLogger().verbose(`Saving user preferences (userId=${myUserId})`);
      const saved = await getUserPreferencesRepo().setUserPreferences(payload);
      requireUserSession(isCurrent);
      produceAppState((draft) => {
        setUserPreferences(
          draft,
          preserveNewerExpansionFlags(saved, draft.userPrefs, flagsSnapshot),
        );
      });
      requireUserSession(isCurrent);
      getLogger().verbose("User preferences saved successfully");
    } catch (error) {
      requireUserSession(isCurrent);
      getLogger().error(`Failed to update user preferences: ${error}`);
      showErrorSnackbar(saveErrorMessage);
      throw error;
    }
  }).finally(() => {
    pendingPreferenceMutations -= 1;
  });
};

const getCurrentUsageMonth = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
};

const getCurrentDateString = (): string => dayjs().format("YYYY-MM-DD");

const getYesterdayDateString = (): string =>
  dayjs().subtract(1, "day").format("YYYY-MM-DD");

type StreakInfo = ["flame" | "fireworks", string] | null;

const streakMessages = defineMessages({
  first: { defaultMessage: "Let the streak begin! 🔥" },
  second: { defaultMessage: "2 days in a row! ✌️" },
  third: { defaultMessage: "3 days strong! 💪" },
  fifth: { defaultMessage: "High five! 5 days! 🖐️" },
  seventh: { defaultMessage: "A full week! 🎉" },
  tenth: { defaultMessage: "Double digits! 🔥" },
  thirtieth: { defaultMessage: "One month! Unstoppable! 🚀" },
  fiftieth: { defaultMessage: "50 days! Legend! 🏆" },
  hundredth: { defaultMessage: "100 days! 💯" },
});

const streakMilestones = new Map<
  number,
  readonly ["flame" | "fireworks", MessageDescriptor]
>([
  [1, ["flame", streakMessages.first]],
  [2, ["flame", streakMessages.second]],
  [3, ["flame", streakMessages.third]],
  [5, ["flame", streakMessages.fifth]],
  [7, ["fireworks", streakMessages.seventh]],
  [10, ["fireworks", streakMessages.tenth]],
  [30, ["fireworks", streakMessages.thirtieth]],
  [50, ["fireworks", streakMessages.fiftieth]],
  [100, ["fireworks", streakMessages.hundredth]],
]);

const getStreakInfo = (streak: number): StreakInfo => {
  const intl = getIntl();
  const milestone = streakMilestones.get(streak);
  if (milestone) {
    return [milestone[0], intl.formatMessage(milestone[1])];
  }
  if (streak % 100 === 0) {
    return [
      "fireworks",
      intl.formatMessage(
        { defaultMessage: "{streak} days! Incredible! 🌟" },
        { streak },
      ),
    ];
  }
  if (streak % 10 === 0) {
    return [
      "fireworks",
      intl.formatMessage(
        { defaultMessage: "{streak} day streak! 🎉" },
        { streak },
      ),
    ];
  }
  return null;
};

export const recordStreak = async (
  isCurrent: () => boolean = () => true,
): Promise<void> => {
  const isSameSession = captureUserSession();
  const ownsUser = () => isCurrent() && isSameSession();
  const result: { streak?: number } = {};
  await updateUser(
    (user) => {
      // This runs inside the profile mutation queue, so concurrent stops see
      // the latest committed streak rather than the same stale snapshot.
      const today = getCurrentDateString();
      const isConsecutive = user.streakRecordedAt === getYesterdayDateString();
      const streak = isConsecutive ? (user.streak ?? 0) + 1 : 1;
      user.streak = streak;
      user.streakRecordedAt = today;
      result.streak = streak;
    },
    "Unable to update streak. User not found.",
    "Failed to update streak. Please try again.",
    () => {
      if (!ownsUser()) return false;
      const user = getMyUser(getAppState());
      return Boolean(user && user.streakRecordedAt !== getCurrentDateString());
    },
  );

  if (result.streak === undefined || !ownsUser()) return;
  const info = getStreakInfo(result.streak);
  const isEnabled = !getAppState().local.disablePillRewards;
  if (info && isEnabled) {
    const [mode, message] = info;
    if (mode === "fireworks") {
      sendPillFireworks(message);
    } else {
      sendPillFlame(message);
    }
  }
};

export const addWordsToCurrentUser = async (
  wordCount: number,
): Promise<void> => {
  if (wordCount <= 0) {
    return;
  }

  await updateUser(
    (user) => {
      const currentMonth = getCurrentUsageMonth();
      if (user.wordsThisMonthMonth !== currentMonth) {
        user.wordsThisMonth = 0;
        user.wordsThisMonthMonth = currentMonth;
      }

      user.wordsThisMonth += wordCount;
      user.wordsTotal += wordCount;
    },
    "Unable to update usage. User not found.",
    "Failed to update usage metrics. Please try again.",
  );
};

/**
 * Adopt what the read produced. A read that lost its revision check must not
 * touch preferences at all, and a completed read with no row clears them.
 */
const applyRefreshedState = (
  user: ReturnType<typeof getAppState>["userById"][string] | null,
  preferences: ReturnType<typeof getAppState>["userPrefs"],
  hasPreferencesResult: boolean,
): void => {
  produceAppState((draft) => {
    if (user) setCurrentUser(draft, user);
    if (!hasPreferencesResult) return;
    if (preferences) setUserPreferences(draft, preferences);
    else draft.userPrefs = null;
  });
};

type PreferencesReadGuard = {
  readRequested: boolean;
  revision: number;
  flagsRevision: number;
  initialPreferences: ReturnType<typeof getAppState>["userPrefs"];
  result: PromiseSettledResult<unknown>;
};

/**
 * A delayed read must not replace a preference value written while it was in
 * flight, and a failed read must not clear the stored one.
 */
const preferencesReadIsCurrent = ({
  readRequested,
  revision,
  flagsRevision,
  initialPreferences,
  result,
}: PreferencesReadGuard): boolean =>
  readRequested &&
  pendingPreferenceMutations === 0 &&
  revision === preferencesRevision &&
  flagsRevision === getExpansionFlagsRevision() &&
  getAppState().userPrefs === initialPreferences &&
  result.status === "fulfilled";

// Refresh shares the user queue with profile saves. Preference mutations use
// their own queue, so a revision check prevents a delayed refresh from
// replacing a newer preference value without blocking edits on the read.
const refreshUserAndPreferences = async (
  isCurrent: () => boolean,
): Promise<void> => {
  if (!isCurrent()) return;
  const revision = preferencesRevision;
  const flagsRevision = getExpansionFlagsRevision();
  const initialPreferences = getAppState().userPrefs;
  const readPreferences = pendingPreferenceMutations === 0;
  try {
    getLogger().verbose("Refreshing current user and preferences");
    const [userResult, preferencesResult] = await Promise.allSettled([
      getUserRepo().getMyUser(),
      readPreferences
        ? getUserPreferencesRepo().getUserPreferences()
        : Promise.resolve(null),
    ]);
    if (!isCurrent()) return;

    const user = userResult.status === "fulfilled" ? userResult.value : null;
    const hasPreferencesResult = preferencesReadIsCurrent({
      readRequested: readPreferences,
      revision,
      flagsRevision,
      initialPreferences,
      result: preferencesResult,
    });
    const preferences =
      hasPreferencesResult && preferencesResult.status === "fulfilled"
        ? preferencesResult.value
        : null;
    if (userResult.status === "rejected") {
      getLogger().warning(`Failed to refresh user: ${userResult.reason}`);
    }
    if (preferencesResult.status === "rejected") {
      getLogger().warning(
        `Failed to refresh user preferences: ${preferencesResult.reason}`,
      );
    }

    applyRefreshedState(user, preferences, hasPreferencesResult);
    getLogger().verbose(
      `User refreshed (hasUser=${!!user}, hasPrefs=${hasPreferencesResult ? !!preferences : "unavailable"})`,
    );
  } catch (error) {
    getLogger().error(`Failed to refresh user: ${error}`);
  }
};

export const refreshCurrentUser = (): Promise<void> => {
  const isCurrent = captureUserSession();
  return enqueueUserMutation(() => refreshUserAndPreferences(isCurrent));
};

export const setPreferredMicrophone = async (
  preferredMicrophone: Nullable<string>,
) => {
  const trimmed = preferredMicrophone?.trim() ?? null;
  const normalized = trimmed && trimmed.length > 0 ? trimmed : null;

  await updateUserPreferences((preferences) => {
    preferences.preferredMicrophone = normalized;
  }, "Failed to save microphone preference. Please try again.");
};

export const migratePreferredMicrophoneToPreferences =
  async (): Promise<void> => {
    const state = getAppState();
    const user = getMyUser(state);
    if (!user) {
      return;
    }

    if (user.hasMigratedPreferredMicrophone) {
      return;
    }

    const microphoneToMigrate = user.preferredMicrophone ?? null;
    if (microphoneToMigrate) {
      await updateUserPreferences((preferences) => {
        preferences.preferredMicrophone = microphoneToMigrate;
      }, "Failed to migrate microphone preference.");
    }

    await updateUser(
      (u) => {
        u.hasMigratedPreferredMicrophone = true;
      },
      "Unable to mark microphone as migrated. User not found.",
      "Failed to mark microphone as migrated.",
    );
  };

export const setPreferredLanguage = async (
  language: Nullable<string>,
): Promise<void> => {
  await updateUser(
    (user) => {
      user.preferredLanguage = language;
    },
    "Unable to update preferred language. User not found.",
    "Failed to save preferred language. Please try again.",
  );
};

export const setActiveDictationLanguage = async (
  language: string,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.activeDictationLanguage = language;
  }, "Failed to save active dictation language. Please try again.");
};

export const setInteractionChimeEnabled = async (enabled: boolean) => {
  await updateUser(
    (user) => {
      user.playInteractionChime = enabled;
    },
    "Unable to update interaction chime. User not found.",
    "Failed to save interaction chime preference. Please try again.",
  );
  // A23: Mirror the pref into Rust so native pill thocks honor it too.
  // Fire-and-forget: the persisted value is the source of truth and the
  // command only controls the in-memory flag used by audio_feedback. The
  // command can fail on a non-main window, which is expected and safe to
  // ignore, but we still surface it for diagnostics.
  invoke("set_interaction_chime_enabled", { enabled }).catch((error) =>
    getLogger().verbose(`Failed to set interaction chime on pill: ${error}`),
  );
};

export const setInteractionFeedbackVolume = async (
  volume: number,
): Promise<void> => {
  // Persist the user-facing preference (clamped to [0.05, 0.5]) and mirror the
  // same clamped value into Rust so the IPC payload matches the persisted
  // record. The Rust side clamps again to its safe window as a
  // defence-in-depth measure; this clamp guarantees the on-the-wire
  // payload never exceeds the effective [0.05, 0.5] range. The Rust
  // sink clamps playback to the same window, so clamping here keeps the
  // persisted value, the IPC payload, and what the user actually hears
  // identical — a slider at maximum must not silently play at half.
  const clamped = Math.max(0.05, Math.min(0.5, volume));
  await updateUser(
    (user) => {
      user.interactionFeedbackVolume = clamped;
    },
    "Unable to update interaction feedback volume. User not found.",
    "Failed to save interaction feedback volume. Please try again.",
  );
  invoke("set_interaction_feedback_volume", { volume: clamped }).catch(
    (error) =>
      getLogger().verbose(
        `Failed to set interaction feedback volume on pill: ${error}`,
      ),
  );
};

export const setUserName = async (name: string): Promise<void> => {
  const normalized = name.trim();

  await updateUser(
    (user) => {
      user.name = normalized;
    },
    "Unable to update username. User not found.",
    "Failed to save username. Please try again.",
  );
};

export const setPreferredTranscriptionMode = async (
  mode: TranscriptionMode,
): Promise<void> => {
  produceAppState((draft) => {
    draft.settings.aiTranscription.mode = mode;
  });

  await updateUserPreferences((preferences) => {
    preferences.transcriptionMode = mode;
  });
};

export const setPreferredTranscriptionApiKeyId = async (
  id: Nullable<string>,
): Promise<void> => {
  produceAppState((draft) => {
    draft.settings.aiTranscription.selectedApiKeyId = id;
  });

  await updateUserPreferences((preferences) => {
    preferences.transcriptionApiKeyId = id;
  });
};

export const setPreferredTranscriptionDevice = async (
  device: string,
): Promise<void> => {
  const normalizedDevice = normalizeTranscriptionDevice(device);
  const gpuEnumerationEnabled =
    isGpuPreferredTranscriptionDevice(normalizedDevice);

  produceAppState((draft) => {
    draft.settings.aiTranscription.device = normalizedDevice;
    draft.settings.aiTranscription.gpuEnumerationEnabled =
      gpuEnumerationEnabled;
  });

  await updateUserPreferences((preferences) => {
    preferences.transcriptionDevice = normalizedDevice;
    preferences.gpuEnumerationEnabled = gpuEnumerationEnabled;
  });
};

export const setPreferredTranscriptionModelSize = async (
  modelSize: string,
): Promise<void> => {
  const normalizedModelSize = normalizeLocalWhisperModel(modelSize);
  produceAppState((draft) => {
    draft.settings.aiTranscription.modelSize = normalizedModelSize;
  });

  await updateUserPreferences((preferences) => {
    preferences.transcriptionModelSize = normalizedModelSize;
  });
};

export const setPreferredPostProcessingMode = async (
  mode: PostProcessingMode,
): Promise<void> => {
  produceAppState((draft) => {
    draft.settings.aiPostProcessing.mode = mode;
  });

  await updateUserPreferences((preferences) => {
    preferences.postProcessingMode = mode;
  });
};

export const setPreferredPostProcessingApiKeyId = async (
  id: Nullable<string>,
): Promise<void> => {
  produceAppState((draft) => {
    draft.settings.aiPostProcessing.selectedApiKeyId = id;
  });

  await updateUserPreferences((preferences) => {
    preferences.postProcessingApiKeyId = id;
  });
};

export const setPreferredAgentMode = async (mode: AgentMode): Promise<void> => {
  produceAppState((draft) => {
    draft.settings.agentMode.mode = mode;
  });

  await updateUserPreferences((preferences) => {
    preferences.agentMode = mode;
  });
};

export const setPreferredAgentModeApiKeyId = async (
  id: Nullable<string>,
): Promise<void> => {
  produceAppState((draft) => {
    draft.settings.agentMode.selectedApiKeyId = id;
  });

  await updateUserPreferences((preferences) => {
    preferences.agentModeApiKeyId = id;
  });
};

export const setGotStartedAtNow = async (): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.gotStartedAt = Date.now();
  }, "Failed to save got started timestamp. Please try again.");
};

export const clearGotStartedAt = async (): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.gotStartedAt = null;
  }, "Failed to clear got started timestamp. Please try again.");
};

export const markFeatureSeen = (featureDate: string): void => {
  produceAppState((draft) => {
    draft.local.featureSeenAt = featureDate;
  });
};

export const setIgnoreUpdateDialog = async (ignore: boolean): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.ignoreUpdateDialog = ignore;
  }, "Failed to save update dialog preference. Please try again.");
};

export const setIncognitoModeEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.incognitoModeEnabled = enabled;
    if (!enabled) {
      // Reset to default when disabling for clarity.
      preferences.incognitoModeIncludeInStats = false;
    }
  }, "Failed to save incognito mode preference. Please try again.");
};

export const setIncognitoModeIncludeInStats = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.incognitoModeIncludeInStats = enabled;
  }, "Failed to save incognito mode stats preference. Please try again.");
};

export const setPreserveAudioOnFailure = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.preserveAudioOnFailure = enabled;
  }, "Failed to save failed-transcription audio preference. Please try again.");
};

export const setDictationPillVisibility = async (
  visibility: DictationPillVisibility,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.dictationPillVisibility = visibility;
  }, "Failed to save dictation pill visibility preference. Please try again.");
};

/** Toggle against the latest committed preference, inside the shared mutation queue. */
export const toggleDictationPillVisibility = async (): Promise<{
  previous: DictationPillVisibility;
  next: DictationPillVisibility;
}> => {
  let previous!: DictationPillVisibility;
  let next!: DictationPillVisibility;
  await updateUserPreferences((preferences) => {
    previous = getEffectivePillVisibility(preferences.dictationPillVisibility);
    next = getNextPillVisibility(previous);
    preferences.dictationPillVisibility = next;
  }, "Failed to save dictation pill visibility preference. Please try again.");
  return { previous, next };
};

export const setPillResetMonitorStrategy = async (
  strategy: PillResetMonitorStrategy,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.pillResetMonitorStrategy = strategy;
  }, "Failed to save pill reset monitor strategy. Please try again.");
};

export const setPillPlacement = async (
  placement: PillPlacement,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.pillPlacement = placement;
  }, "Failed to save pill placement preference. Please try again.");
  try {
    await pushPillPlacementToNative(placement);
  } catch (error) {
    getLogger().warning(
      `Failed to push pill placement to native pill: ${error}`,
    );
  }
};

export const setUpdateChannel = async (
  channel: UpdateChannel,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.updateChannel = channel;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save update channel preference. Please try again.",
    }),
  );
  await refreshUpdatesForChannelChange();
};

export const setAlwaysRequestAdminOnStartup = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.alwaysRequestAdminOnStartup = enabled;
  }, "Failed to save admin on startup preference. Please try again.");
};

export const setSpokenCommandsEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.spokenCommandsEnabled = enabled;
  }, "Failed to save spoken commands preference. Please try again.");
};

export const setDictationLimitMinutes = async (
  minutes: number,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.dictationLimitMinutes = normalizeDictationLimitMinutes(minutes);
  }, "Failed to save dictation limit preference. Please try again.");
};

export const setHandsFreeDelayMs = async (
  delayMs: Nullable<number>,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.handsFreeDelayMs =
      delayMs == null ? null : normalizeHandsFreeDelayMs(delayMs);
  }, "Failed to save hands-free delay preference. Please try again.");
};

export const setAutoLearnDictionaryEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.autoLearnDictionaryEnabled = enabled;
  }, "Failed to save auto-learn dictionary preference. Please try again.");
};

export const setAutoLearnFromEditsEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.autoLearnFromEditsEnabled = enabled;
  }, "Failed to save learn-from-corrections preference. Please try again.");
};

export const setElevenLabsKeytermsEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.elevenLabsKeytermsEnabled = enabled;
  }, "Failed to save ElevenLabs keyterms preference. Please try again.");
};

export const setRealtimeOutputEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.realtimeOutputEnabled = enabled;
    // Real-time output streams interim segments straight into the focused
    // app (skipReview), so review-before-insert can never apply while it is
    // on. Keep the pair mutually exclusive instead of silently ignoring the
    // review preference.
    if (enabled) {
      preferences.reviewBeforeInsert = false;
    }
  }, "Failed to save real-time output preference. Please try again.");
};

export const setRemoteOutputEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.remoteOutputEnabled = enabled;
  }, "Failed to save multi-device sender preference. Please try again.");
};

export const setRemoteTargetDeviceId = async (
  deviceId: Nullable<string>,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.remoteTargetDeviceId = deviceId;
    preferences.remoteOutputEnabled = Boolean(deviceId);
  }, "Failed to save paired receiver selection. Please try again.");
};

/** Repair only the still-missing target, without overwriting a newer selection. */
export const clearUnavailableRemoteTarget = (
  isCurrent: () => boolean,
): Promise<void> =>
  updateUserPreferences(
    (preferences) => {
      preferences.remoteTargetDeviceId = null;
      preferences.remoteOutputEnabled = false;
    },
    "Failed to save paired receiver selection. Please try again.",
    (preferences) => {
      const target = preferences.remoteTargetDeviceId;
      return Boolean(
        isCurrent() &&
        target &&
        !getPairedRemoteDeviceById(getAppState(), target),
      );
    },
  );

export const setRemoteReceiverPort = async (
  port: Nullable<number>,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.remoteReceiverPort = port;
  }, "Failed to save remote receiver port. Please try again.");
};

export const setRemoteReceiverAutoStart = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.remoteReceiverAutoStart = enabled;
  }, "Failed to save receiver auto-start preference. Please try again.");
};

export const setMenuBarIconHidden = async (hidden: boolean): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.menuBarIconHidden = hidden;
  }, "Failed to save menu bar icon preference. Please try again.");
};

export const setDictationAudioDim = async (value: number): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.dictationAudioDim = Math.max(0, Math.min(1, value));
  }, "Failed to save audio dim preference. Please try again.");
};

export const setInDictationStyleSwitchingEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.inDictationStyleSwitchingEnabled = enabled;
  }, "Failed to save in-dictation style switching preference. Please try again.");
};

export const setHallucinationFilterEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.hallucinationFilterEnabled = enabled;
  }, "Failed to save silence filtering preference. Please try again.");
};

export const setReviewBeforeInsert = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.reviewBeforeInsert = enabled;
    // A review step conflicts with live interim streaming; see the realtime
    // counterpart above. Turning review on therefore turns real-time output
    // off in the same persisted write.
    if (enabled) {
      preferences.realtimeOutputEnabled = false;
    }
  }, "Failed to save review-before-insert preference. Please try again.");
};

export const setAgentToolEnabled = (
  toolId: string,
  enabled: boolean,
): Promise<void> =>
  updateUserPreferences((preferences) => {
    const toolInfos = Object.values(getAppState().toolInfoById);
    const current =
      preferences.agentEnabledTools ?? toolInfos.map((toolInfo) => toolInfo.id);
    const next = new Set(current);
    if (enabled) {
      next.add(toolId);
    } else {
      next.delete(toolId);
    }
    const allEnabled =
      toolInfos.length > 0 &&
      toolInfos.every((toolInfo) => next.has(toolInfo.id));
    preferences.agentEnabledTools = allEnabled ? null : [...next];
  }, "Failed to save enabled agent tools. Please try again.");

export const setAgentMaxIterations = async (
  iterations: number,
): Promise<void> => {
  const normalized = Math.min(100, Math.max(1, Math.trunc(iterations)));
  await updateUserPreferences((preferences) => {
    preferences.agentMaxIterations = normalized;
  }, "Failed to save agent iteration limit. Please try again.");
};

export const setAgentPermissionTimeoutMs = async (
  timeoutMs: number,
): Promise<void> => {
  const normalized = Math.min(
    10 * 60_000,
    Math.max(5_000, Math.trunc(timeoutMs)),
  );
  await updateUserPreferences((preferences) => {
    preferences.agentPermissionTimeoutMs = normalized;
  }, "Failed to save agent permission timeout. Please try again.");
};

export const setStylingMode = async (
  mode: Nullable<StylingMode>,
): Promise<void> => {
  await updateUser(
    (user) => {
      user.stylingMode = mode;
    },
    "Unable to set styling mode. User not found.",
    "Failed to save styling mode preference. Please try again.",
  );
};

export const setActiveToneIds = async (toneIds: string[]): Promise<void> => {
  await updateUser(
    (user) => {
      user.activeToneIds = toneIds;
    },
    "Unable to update active styles. User not found.",
    "Failed to update active styles. Please try again.",
  );
};

export const setSelectedToneId = async (
  toneId: string,
  shouldUpdate: () => boolean = () => true,
): Promise<void> => {
  const isCurrentSession = captureUserSession();
  let applied = false;
  await updateUser(
    (user) => {
      user.selectedToneId = toneId;
      applied = true;
    },
    "Unable to select style. User not found.",
    "Failed to select style. Please try again.",
    shouldUpdate,
  );
  if (applied && isCurrentSession() && shouldUpdate()) {
    setLocalStorageValue("mausvoice:checklist-writing-style", true);
  }
};

export const activateAndSelectTone = async (toneId: string): Promise<void> => {
  await updateUser(
    (user) => {
      const currentIds = user.activeToneIds ?? [];
      if (!currentIds.includes(toneId)) {
        user.activeToneIds = [toneId, ...currentIds];
      }
      user.selectedToneId = toneId;
    },
    "Unable to activate style. User not found.",
    "Failed to activate style. Please try again.",
  );
};

export const deselectActiveTone = async (toneId: string): Promise<void> => {
  await updateUser(
    (user) => {
      const current = user.activeToneIds ?? [];
      user.activeToneIds = current.filter((id) => id !== toneId);
    },
    "Unable to deselect style. User not found.",
    "Failed to deselect style. Please try again.",
  );
};
