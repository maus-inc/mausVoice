import {
  type AgentMode,
  DictationPillVisibility,
  Nullable,
  PillPlacement,
  PillResetMonitorStrategy,
} from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import { getAppState, produceAppState } from "../store";
import {
  type PostProcessingMode,
  type TranscriptionMode,
} from "../types/ai.types";
import {
  isGpuPreferredTranscriptionDevice,
  normalizeLocalWhisperModel,
  normalizeTranscriptionDevice,
  supportsGpuTranscriptionDevice,
} from "../utils/local-transcription.utils";
import { getLogger } from "../utils/log.utils";
import { getMyUser } from "../utils/user.utils";
import { pushPillPlacementToNative } from "./windows-sync.actions";

import { updateUser, updateUserPreferences } from "./user-actions-core";

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
