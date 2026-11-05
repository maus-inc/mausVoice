import {
  DictationPillVisibility,
  Nullable,
  PillPlacement,
  PillResetMonitorStrategy,
} from "@maus-inc/types";
import { getIntl } from "../i18n";
import { getAppState, produceAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import type { LocalDataWriteLease } from "../utils/local-data-write-gate";
import { getMyUser } from "../utils/user.utils";
import { pushPillPlacementToNative } from "./windows-sync.actions";
import { updateUser, updateUserPreferences } from "./user-actions-core";

export * from "./user-ai-preferences.actions";

export const setPreferredMicrophone = async (
  preferredMicrophone: Nullable<string>,
) => {
  const trimmed = preferredMicrophone?.trim() ?? null;
  const normalized = trimmed && trimmed.length > 0 ? trimmed : null;

  await updateUserPreferences(
    (preferences) => {
      preferences.preferredMicrophone = normalized;
    },
    getIntl().formatMessage({
      defaultMessage: "Failed to save microphone preference. Please try again.",
    }),
    { showErrorToast: false },
  );
};

export const migratePreferredMicrophoneToPreferences =
  async (): Promise<void> => {
    const state = getAppState();
    const user = getMyUser(state);
    if (!user || user.hasMigratedPreferredMicrophone) {
      return;
    }

    const intl = getIntl();
    const microphoneToMigrate = user.preferredMicrophone ?? null;
    if (microphoneToMigrate) {
      await updateUserPreferences(
        (preferences) => {
          preferences.preferredMicrophone = microphoneToMigrate;
        },
        intl.formatMessage({
          defaultMessage: "Failed to migrate microphone preference.",
        }),
      );
    }

    await updateUser(
      (u) => {
        u.hasMigratedPreferredMicrophone = true;
      },
      intl.formatMessage({
        defaultMessage:
          "Unable to mark microphone as migrated. User not found.",
      }),
      intl.formatMessage({
        defaultMessage: "Failed to mark microphone as migrated.",
      }),
    );
  };

export const setPreferredLanguage = async (
  language: Nullable<string>,
  lease?: LocalDataWriteLease,
  options: { showErrorToast?: boolean } = {},
): Promise<void> => {
  const intl = getIntl();
  await updateUser(
    (user) => {
      user.preferredLanguage = language;
    },
    intl.formatMessage({
      defaultMessage: "Unable to update preferred language. User not found.",
    }),
    intl.formatMessage({
      defaultMessage: "Failed to save preferred language. Please try again.",
    }),
    lease,
    { requireUser: true, showErrorToast: options.showErrorToast },
  );
};

export const setActiveDictationLanguage = async (
  language: string,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.activeDictationLanguage = language;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save active dictation language. Please try again.",
    }),
  );
};

export const setInteractionChimeEnabled = async (enabled: boolean) => {
  const intl = getIntl();
  await updateUser(
    (user) => {
      user.playInteractionChime = enabled;
    },
    intl.formatMessage({
      defaultMessage: "Unable to update interaction chime. User not found.",
    }),
    intl.formatMessage({
      defaultMessage:
        "Failed to save interaction chime preference. Please try again.",
    }),
  );
  // AppSideEffects mirrors the store value from the main window, including
  // rollback or reconciliation after a failed save.
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
  // identical; a slider at maximum must not silently play at half.
  const clamped = Math.max(0.05, Math.min(0.5, volume));
  const intl = getIntl();
  await updateUser(
    (user) => {
      user.interactionFeedbackVolume = clamped;
    },
    intl.formatMessage({
      defaultMessage:
        "Unable to update interaction feedback volume. User not found.",
    }),
    intl.formatMessage({
      defaultMessage:
        "Failed to save interaction feedback volume. Please try again.",
    }),
  );
  // AppSideEffects is the sole native mirror, including for restored values.
};

export const setUserName = async (name: string): Promise<void> => {
  const normalized = name.trim();
  const intl = getIntl();

  await updateUser(
    (user) => {
      user.name = normalized;
    },
    intl.formatMessage({
      defaultMessage: "Unable to update username. User not found.",
    }),
    intl.formatMessage({
      defaultMessage: "Failed to save username. Please try again.",
    }),
  );
};

export const setGotStartedAtNow = async (): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.gotStartedAt = Date.now();
    },
    getIntl().formatMessage({
      defaultMessage: "Failed to save got started timestamp. Please try again.",
    }),
  );
};

export const clearGotStartedAt = async (): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.gotStartedAt = null;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to clear got started timestamp. Please try again.",
    }),
  );
};

export const markFeatureSeen = (featureDate: string): void => {
  produceAppState((draft) => {
    draft.local.featureSeenAt = featureDate;
  });
};

export const setIgnoreUpdateDialog = async (ignore: boolean): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.ignoreUpdateDialog = ignore;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save update dialog preference. Please try again.",
    }),
  );
};

export const setIncognitoModeEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.incognitoModeEnabled = enabled;
      if (!enabled) {
        // Reset to default when disabling for clarity.
        preferences.incognitoModeIncludeInStats = false;
      }
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save incognito mode preference. Please try again.",
    }),
  );
};

export const setIncognitoModeIncludeInStats = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.incognitoModeIncludeInStats = enabled;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save incognito mode stats preference. Please try again.",
    }),
  );
};

export const setPreserveAudioOnFailure = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.preserveAudioOnFailure = enabled;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save failed-transcription audio preference. Please try again.",
    }),
  );
};

export const setDictationPillVisibility = async (
  visibility: DictationPillVisibility,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.dictationPillVisibility = visibility;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save dictation pill visibility preference. Please try again.",
    }),
  );
};

export const setPillResetMonitorStrategy = async (
  strategy: PillResetMonitorStrategy,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.pillResetMonitorStrategy = strategy;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save pill reset monitor strategy. Please try again.",
    }),
  );
};

export const setPillPlacement = async (
  placement: PillPlacement,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.pillPlacement = placement;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save pill placement preference. Please try again.",
    }),
  );
  try {
    await pushPillPlacementToNative(placement);
  } catch (error) {
    getLogger().warning(
      `Failed to push pill placement to native pill: ${error}`,
    );
  }
};
