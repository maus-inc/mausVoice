import {
  type AgentMode,
  DictationPillVisibility,
  Nullable,
  PillResetMonitorStrategy,
  StylingMode,
  User,
  UserPreferences,
} from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import dayjs from "dayjs";
import { getIntl } from "../i18n";
import { getUserPreferencesRepo, getUserRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import {
  type PostProcessingMode,
  type TranscriptionMode,
} from "../types/ai.types";
import { AsyncLock } from "../utils/async-lock.utils";
import {
  DEFAULT_DICTATION_LIMIT_MINUTES,
  normalizeDictationLimitMinutes,
} from "../utils/dictation-limit.utils";
import { PRIMARY_LANGUAGE_SENTINEL } from "../utils/language.utils";
import {
  isGpuPreferredTranscriptionDevice,
  normalizeLocalWhisperModel,
  normalizeTranscriptionDevice,
  supportsGpuTranscriptionDevice,
} from "../utils/local-transcription.utils";
import { getLogger } from "../utils/log.utils";
import { createMutationQueue } from "../utils/mutation-queue";
import { sendPillFireworks, sendPillFlame } from "../utils/overlay.utils";
import {
  getMyEffectiveUserId,
  getMyUser,
  getMyUserPreferences,
  LOCAL_USER_ID,
  setCurrentUser,
  setUserPreferences,
} from "../utils/user.utils";
import { showErrorSnackbar } from "./app.actions";
import { setLocalStorageValue } from "./local-storage.actions";

const userSaveLock = new AsyncLock();

const updateUser = async (
  updateCallback: (user: User) => void,
  errorMessage: string,
  saveErrorMessage: string,
): Promise<void> => {
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

  await userSaveLock.run(async () => {
    try {
      getLogger().verbose(`Saving user (id=${payload.id})`);
      await repo.setMyUser(payload);
      getLogger().verbose("User saved successfully");
    } catch (error) {
      getLogger().error(`Failed to update user: ${error}`);
      produceAppState((draft) => {
        setCurrentUser(draft, existing);
      });
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
  dictationLimitMinutes: DEFAULT_DICTATION_LIMIT_MINUTES,
  dictationPillVisibility: "while_active",
  pillResetMonitorStrategy: "current",

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
  inDictationStyleSwitchingEnabled: false,
  hallucinationFilterEnabled: true,
  reviewBeforeInsert: null,
  agentEnabledTools: null,
  agentMaxIterations: 20,
  agentPermissionTimeoutMs: 60_000,
});

// Serializes preference mutations so overlapping tool toggles or numeric edits
// cannot read a stale snapshot and clobber each other's change. Each task reads
// the latest committed preferences when it actually runs.
const { enqueue: enqueuePrefsMutation } = createMutationQueue();

export const updateUserPreferences = (
  updateCallback: (preferences: UserPreferences) => void,
  saveErrorMessage = "Failed to save AI preferences. Please try again.",
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

const getStreakInfo = (streak: number): StreakInfo => {
  const intl = getIntl();

  if (streak === 1) {
    return [
      "flame",
      intl.formatMessage({ defaultMessage: "Let the streak begin! 🔥" }),
    ];
  }

  if (streak === 2) {
    return [
      "flame",
      intl.formatMessage({ defaultMessage: "2 days in a row! ✌️" }),
    ];
  }

  if (streak === 3) {
    return [
      "flame",
      intl.formatMessage({ defaultMessage: "3 days strong! 💪" }),
    ];
  }

  if (streak === 5) {
    return [
      "flame",
      intl.formatMessage({ defaultMessage: "High five! 5 days! 🖐️" }),
    ];
  }

  if (streak === 7) {
    return [
      "fireworks",
      intl.formatMessage({ defaultMessage: "A full week! 🎉" }),
    ];
  }

  if (streak === 10) {
    return [
      "fireworks",
      intl.formatMessage({ defaultMessage: "Double digits! 🔥" }),
    ];
  }

  if (streak === 30) {
    return [
      "fireworks",
      intl.formatMessage({ defaultMessage: "One month! Unstoppable! 🚀" }),
    ];
  }

  if (streak === 50) {
    return [
      "fireworks",
      intl.formatMessage({ defaultMessage: "50 days! Legend! 🏆" }),
    ];
  }

  if (streak === 100) {
    return [
      "fireworks",
      intl.formatMessage({ defaultMessage: "100 days! 💯" }),
    ];
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

export const recordStreak = async (): Promise<void> => {
  const state = getAppState();
  const user = getMyUser(state);
  if (!user) {
    return;
  }

  const today = getCurrentDateString();
  if (user.streakRecordedAt === today) {
    return;
  }

  const yesterday = getYesterdayDateString();
  const isConsecutive = user.streakRecordedAt === yesterday;
  const newStreak = isConsecutive ? (user.streak ?? 0) + 1 : 1;

  await updateUser(
    (u) => {
      u.streak = newStreak;
      u.streakRecordedAt = today;
    },
    "Unable to update streak. User not found.",
    "Failed to update streak. Please try again.",
  );

  const info = getStreakInfo(newStreak);
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

export const refreshCurrentUser = async (): Promise<void> => {
  await userSaveLock.wait();

  try {
    getLogger().verbose("Refreshing current user and preferences");
    const [userResult, preferencesResult] = await Promise.allSettled([
      getUserRepo().getMyUser(),
      getUserPreferencesRepo().getUserPreferences(),
    ]);

    const user = userResult.status === "fulfilled" ? userResult.value : null;
    const hasPreferencesResult = preferencesResult.status === "fulfilled";
    const preferences = hasPreferencesResult ? preferencesResult.value : null;
    if (userResult.status === "rejected") {
      getLogger().warning(`Failed to refresh user: ${userResult.reason}`);
    }
    if (preferencesResult.status === "rejected") {
      getLogger().warning(
        `Failed to refresh user preferences: ${preferencesResult.reason}`,
      );
    }

    produceAppState((draft) => {
      if (user) {
        setCurrentUser(draft, user);
      }

      if (!hasPreferencesResult) {
        return;
      }

      if (preferences) {
        setUserPreferences(draft, preferences);
      } else {
        draft.userPrefs = null;
      }
    });
    getLogger().verbose(
      `User refreshed (hasUser=${!!user}, hasPrefs=${hasPreferencesResult ? !!preferences : "unavailable"})`,
    );
  } catch (error) {
    getLogger().error(`Failed to refresh user: ${error}`);
  }
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
  // command only controls the in-memory flag used by audio_feedback.
  invoke("set_interaction_chime_enabled", { enabled }).catch(() => {});
};

export const setInteractionFeedbackVolume = async (
  volume: number,
): Promise<void> => {
  // Persist the user-facing preference (full 0..=1) and mirror the clamped
  // value into Rust so the thock gain is honored on the warm path AND the
  // fallback path. The Rust side clamps again to its safe window as a
  // defence-in-depth measure.
  await updateUser(
    (user) => {
      user.interactionFeedbackVolume = Math.max(0, Math.min(1, volume));
    },
    "Unable to update interaction feedback volume. User not found.",
    "Failed to save interaction feedback volume. Please try again.",
  );
  invoke("set_interaction_feedback_volume", { volume }).catch(() => {});
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

export const setGpuEnumerationEnabled = async (
  enabled: boolean,
): Promise<void> => {
  const nextEnabled = supportsGpuTranscriptionDevice() && enabled;
  produceAppState((draft) => {
    draft.settings.aiTranscription.gpuEnumerationEnabled = nextEnabled;
  });

  await updateUserPreferences((preferences) => {
    preferences.gpuEnumerationEnabled = nextEnabled;
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

export const setDictationPillVisibility = async (
  visibility: DictationPillVisibility,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.dictationPillVisibility = visibility;
  }, "Failed to save dictation pill visibility preference. Please try again.");
};

export const setPillResetMonitorStrategy = async (
  strategy: PillResetMonitorStrategy,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.pillResetMonitorStrategy = strategy;
  }, "Failed to save pill reset monitor strategy. Please try again.");
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
    // A composer review step conflicts with live interim streaming; see the
    // realtime counterpart above. Turning review on therefore turns
    // real-time output off in the same persisted write.
    if (enabled) {
      preferences.realtimeOutputEnabled = false;
    }
  }, "Failed to save review-before-insert preference. Please try again.");
};

export const setAgentEnabledTools = async (
  toolIds: string[] | null,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.agentEnabledTools = toolIds;
  }, "Failed to save enabled agent tools. Please try again.");
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

export const setSelectedToneId = async (toneId: string): Promise<void> => {
  await updateUser(
    (user) => {
      user.selectedToneId = toneId;
    },
    "Unable to select style. User not found.",
    "Failed to select style. Please try again.",
  );
  setLocalStorageValue("mausvoice:checklist-writing-style", true);
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

export const markUpgradeDialogSeen = async (): Promise<void> => {
  await updateUser(
    (user) => {
      user.shouldShowUpgradeDialog = false;
    },
    "Unable to mark upgrade dialog as seen. User not found.",
    "Failed to mark upgrade dialog as seen. Please try again.",
  );
};
