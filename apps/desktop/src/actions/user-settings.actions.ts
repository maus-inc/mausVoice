import type { LocalDataWriteLease } from "../utils/local-data-write-gate";
import { Nullable, UpdateChannel } from "@maus-inc/types";
import { getIntl } from "../i18n";
import { getAppState } from "../store";
import { normalizeDictationLimitMinutes } from "../utils/dictation-limit.utils";
import { normalizeHandsFreeDelayMs } from "../utils/hands-free-delay.utils";
import { refreshUpdatesForChannelChange } from "./updater.actions";

import { updateUserPreferences } from "./user-actions-core";

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
  await updateUserPreferences(
    (preferences) => {
      preferences.alwaysRequestAdminOnStartup = enabled;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save admin on startup preference. Please try again.",
    }),
  );
};

export const setSpokenCommandsEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.spokenCommandsEnabled = enabled;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save spoken commands preference. Please try again.",
    }),
  );
};

export const setDictationLimitMinutes = async (
  minutes: number,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.dictationLimitMinutes =
        normalizeDictationLimitMinutes(minutes);
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save dictation limit preference. Please try again.",
    }),
  );
};

export const setHandsFreeDelayMs = async (
  delayMs: Nullable<number>,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.handsFreeDelayMs =
        delayMs == null ? null : normalizeHandsFreeDelayMs(delayMs);
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save hands-free delay preference. Please try again.",
    }),
  );
};

export const setAutoLearnDictionaryEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.autoLearnDictionaryEnabled = enabled;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save auto-learn dictionary preference. Please try again.",
    }),
  );
};

export const setAutoLearnFromEditsEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.autoLearnFromEditsEnabled = enabled;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save learn-from-corrections preference. Please try again.",
    }),
  );
};

export const setElevenLabsKeytermsEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.elevenLabsKeytermsEnabled = enabled;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save ElevenLabs keyterms preference. Please try again.",
    }),
  );
};

export const setRealtimeOutputEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.realtimeOutputEnabled = enabled;
      // Real-time output streams interim segments straight into the focused
      // app (skipReview), so review-before-insert can never apply while it is
      // on. Keep the pair mutually exclusive instead of silently ignoring the
      // review preference.
      if (enabled) {
        preferences.reviewBeforeInsert = false;
      }
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save real-time output preference. Please try again.",
    }),
  );
};

export const setRemoteOutputEnabled = async (
  enabled: boolean,
  lease?: LocalDataWriteLease,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.remoteOutputEnabled = enabled;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save multi-device sender preference. Please try again.",
    }),
    { existingLease: lease },
  );
};

export const setRemoteTargetDeviceId = async (
  deviceId: Nullable<string>,
  lease?: LocalDataWriteLease,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.remoteTargetDeviceId = deviceId;
      preferences.remoteOutputEnabled = Boolean(deviceId);
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save paired receiver selection. Please try again.",
    }),
    { existingLease: lease },
  );
};

export const setRemoteReceiverPort = async (
  port: Nullable<number>,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.remoteReceiverPort = port;
    },
    getIntl().formatMessage({
      defaultMessage: "Failed to save remote receiver port. Please try again.",
    }),
  );
};

export const setRemoteReceiverAutoStart = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.remoteReceiverAutoStart = enabled;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save receiver auto-start preference. Please try again.",
    }),
  );
};

export const setMenuBarIconHidden = async (hidden: boolean): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.menuBarIconHidden = hidden;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save menu bar icon preference. Please try again.",
    }),
  );
};

export const setDictationAudioDim = async (value: number): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.dictationAudioDim = Math.max(0, Math.min(1, value));
    },
    getIntl().formatMessage({
      defaultMessage: "Failed to save audio dim preference. Please try again.",
    }),
  );
};

export const setInDictationStyleSwitchingEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.inDictationStyleSwitchingEnabled = enabled;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save in-dictation style switching preference. Please try again.",
    }),
  );
};

export const setHallucinationFilterEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.hallucinationFilterEnabled = enabled;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save silence filtering preference. Please try again.",
    }),
  );
};

export const setFastStyleShortDictationsEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.fastStyleShortDictationsEnabled = enabled;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save short dictation preference. Please try again.",
    }),
  );
};

export const setReviewBeforeInsert = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.reviewBeforeInsert = enabled;
      // A review step conflicts with live interim streaming; see the realtime
      // counterpart above. Turning review on therefore turns real-time output
      // off in the same persisted write.
      if (enabled) {
        preferences.realtimeOutputEnabled = false;
      }
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save review-before-insert preference. Please try again.",
    }),
  );
};

export const setAgentEnabledTools = async (
  toolIds: string[] | null,
): Promise<void> => {
  await updateUserPreferences(
    (preferences) => {
      preferences.agentEnabledTools = toolIds;
    },
    getIntl().formatMessage({
      defaultMessage: "Failed to save enabled agent tools. Please try again.",
    }),
  );
};

export const setAgentToolEnabled = (
  toolId: string,
  enabled: boolean,
): Promise<void> =>
  updateUserPreferences(
    (preferences) => {
      const toolInfos = Object.values(getAppState().toolInfoById);
      const current =
        preferences.agentEnabledTools ??
        toolInfos.map((toolInfo) => toolInfo.id);
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
    },
    getIntl().formatMessage({
      defaultMessage: "Failed to save enabled agent tools. Please try again.",
    }),
  );

export const setAgentMaxIterations = async (
  iterations: number,
): Promise<void> => {
  const normalized = Math.min(100, Math.max(1, Math.trunc(iterations)));
  await updateUserPreferences(
    (preferences) => {
      preferences.agentMaxIterations = normalized;
    },
    getIntl().formatMessage({
      defaultMessage: "Failed to save agent iteration limit. Please try again.",
    }),
  );
};

export const setAgentPermissionTimeoutMs = async (
  timeoutMs: number,
): Promise<void> => {
  const normalized = Math.min(
    10 * 60_000,
    Math.max(5_000, Math.trunc(timeoutMs)),
  );
  await updateUserPreferences(
    (preferences) => {
      preferences.agentPermissionTimeoutMs = normalized;
    },
    getIntl().formatMessage({
      defaultMessage:
        "Failed to save agent permission timeout. Please try again.",
    }),
  );
};
