import {
  AgentMode,
  DictationPillVisibility,
  Nullable,
  PillResetMonitorStrategy,
  PostProcessingMode,
  TranscriptionMode,
  UserPreferences,
} from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_DICTATION_LIMIT_MINUTES,
  normalizeDictationLimitMinutes,
} from "../utils/dictation-limit.utils";
import { PRIMARY_LANGUAGE_SENTINEL } from "../utils/language.utils";
import { orFalse, orNull, orValue } from "../utils/nullable.utils";
import { getEffectivePillVisibility, LOCAL_USER_ID } from "../utils/user.utils";
import { BaseRepo } from "./base.repo";

type LocalUserPreferences = {
  userId: string;
  // AI modes arrive as raw strings: SQLite rows written by older builds can
  // hold values that no longer exist in the mode unions (e.g. the removed
  // "cloud" mode), so the boundary types stay loose and the normalizers
  // below map them onto valid values.
  transcriptionMode: Nullable<string>;
  transcriptionApiKeyId: Nullable<string>;
  transcriptionDevice: Nullable<string>;
  transcriptionModelSize: Nullable<string>;
  postProcessingMode: Nullable<string>;
  postProcessingApiKeyId: Nullable<string>;
  postProcessingOllamaUrl: Nullable<string>;
  postProcessingOllamaModel: Nullable<string>;
  activeToneId: Nullable<string>;
  gotStartedAt: Nullable<number>;
  gpuEnumerationEnabled: boolean;
  agentMode: Nullable<string>;
  agentModeApiKeyId: Nullable<string>;
  openclawGatewayUrl: Nullable<string>;
  openclawToken: Nullable<string>;
  lastSeenFeature: Nullable<string>;
  languageSwitchEnabled: boolean;
  secondaryDictationLanguage: Nullable<string>;
  activeDictationLanguage: Nullable<string>;
  preferredMicrophone: Nullable<string>;
  ignoreUpdateDialog: boolean;
  incognitoModeEnabled: boolean;
  incognitoModeIncludeInStats: boolean;
  dictationLimitMinutes?: Nullable<number>;
  dictationPillVisibility: DictationPillVisibility;
  realtimeOutputEnabled: boolean;
  remoteOutputEnabled: boolean;
  remoteTargetDeviceId: Nullable<string>;
  remoteReceiverPort: Nullable<number>;
  remoteReceiverAutoStart: boolean;
  dictationAudioDim: number;
  pasteKeybind: Nullable<string>;
  useNewBackend: boolean;
  menuBarIconHidden: boolean;
  insertionMethod: Nullable<string>;
  typingSpeedMs: Nullable<number>;
  pillResetMonitorStrategy?: Nullable<PillResetMonitorStrategy>;
  alwaysRequestAdminOnStartup?: boolean;
};

const normalizePillResetMonitorStrategy = (
  strategy: Nullable<string> | undefined,
): PillResetMonitorStrategy => (strategy === "cursor" ? "cursor" : "current");

// Backwards-compatibility normalization for the persisted AI modes. Older
// builds stored modes that no longer exist ("cloud" for all three, plus
// "ollama" for post-processing — users need to re-add Ollama via API keys).
// Letting a stale value through here leaves the settings dialogs rendering a
// segmented control with no matching tab and an empty body, so every invalid
// value is mapped onto the closest valid mode.
const normalizeTranscriptionMode = (
  mode: Nullable<string>,
): Nullable<TranscriptionMode> => {
  if (!mode) return null;
  if (mode === "local" || mode === "api") {
    return mode;
  }
  return "local";
};

const normalizePostProcessingMode = (
  mode: Nullable<string>,
): Nullable<PostProcessingMode> => {
  if (!mode) return null;
  if (mode === "api" || mode === "none") {
    return mode;
  }
  return "none";
};

const normalizeAgentMode = (mode: Nullable<string>): Nullable<AgentMode> => {
  if (!mode) return null;
  if (mode === "api" || mode === "none" || mode === "openclaw") {
    return mode;
  }
  return "none";
};

export const fromLocalPreferences = (
  preferences: LocalUserPreferences,
): UserPreferences => ({
  userId: preferences.userId,
  transcriptionMode: normalizeTranscriptionMode(preferences.transcriptionMode),
  transcriptionApiKeyId: preferences.transcriptionApiKeyId,
  transcriptionDevice: preferences.transcriptionDevice,
  transcriptionModelSize: preferences.transcriptionModelSize,
  postProcessingMode: normalizePostProcessingMode(
    preferences.postProcessingMode,
  ),
  postProcessingApiKeyId: preferences.postProcessingApiKeyId,
  postProcessingOllamaUrl: preferences.postProcessingOllamaUrl,
  postProcessingOllamaModel: preferences.postProcessingOllamaModel,
  activeToneId: preferences.activeToneId,
  gotStartedAt: preferences.gotStartedAt,
  gpuEnumerationEnabled: preferences.gpuEnumerationEnabled,
  agentMode: normalizeAgentMode(preferences.agentMode),
  agentModeApiKeyId: preferences.agentModeApiKeyId,
  openclawGatewayUrl: orNull(preferences.openclawGatewayUrl),
  openclawToken: orNull(preferences.openclawToken),
  lastSeenFeature: preferences.lastSeenFeature,
  activeDictationLanguage: orNull(preferences.activeDictationLanguage),
  preferredMicrophone: orNull(preferences.preferredMicrophone),
  ignoreUpdateDialog: orFalse(preferences.ignoreUpdateDialog),
  incognitoModeEnabled: orFalse(preferences.incognitoModeEnabled),
  incognitoModeIncludeInStats: orFalse(preferences.incognitoModeIncludeInStats),
  dictationLimitMinutes: normalizeDictationLimitMinutes(
    preferences.dictationLimitMinutes,
  ),
  dictationPillVisibility: getEffectivePillVisibility(
    preferences.dictationPillVisibility,
  ),
  realtimeOutputEnabled: orFalse(preferences.realtimeOutputEnabled),
  remoteOutputEnabled: orFalse(preferences.remoteOutputEnabled),
  remoteTargetDeviceId: orNull(preferences.remoteTargetDeviceId),
  remoteReceiverPort: orNull(preferences.remoteReceiverPort),
  remoteReceiverAutoStart: orFalse(preferences.remoteReceiverAutoStart),
  dictationAudioDim: orValue(preferences.dictationAudioDim, 1.0),
  pasteKeybind: orNull(preferences.pasteKeybind),
  menuBarIconHidden: orFalse(preferences.menuBarIconHidden),
  insertionMethod: orNull(preferences.insertionMethod),
  typingSpeedMs: orNull(preferences.typingSpeedMs),
  pillResetMonitorStrategy: normalizePillResetMonitorStrategy(
    preferences.pillResetMonitorStrategy,
  ),
  alwaysRequestAdminOnStartup: orFalse(preferences.alwaysRequestAdminOnStartup),
});

export const toLocalPreferences = (
  preferences: UserPreferences,
): LocalUserPreferences => ({
  userId: LOCAL_USER_ID,
  transcriptionMode: orNull(preferences.transcriptionMode),
  transcriptionApiKeyId: orNull(preferences.transcriptionApiKeyId),
  transcriptionDevice: orNull(preferences.transcriptionDevice),
  transcriptionModelSize: orNull(preferences.transcriptionModelSize),
  postProcessingMode: orNull(preferences.postProcessingMode),
  postProcessingApiKeyId: orNull(preferences.postProcessingApiKeyId),
  postProcessingOllamaUrl: orNull(preferences.postProcessingOllamaUrl),
  postProcessingOllamaModel: orNull(preferences.postProcessingOllamaModel),
  activeToneId: orNull(preferences.activeToneId),
  gotStartedAt: orNull(preferences.gotStartedAt),
  gpuEnumerationEnabled: preferences.gpuEnumerationEnabled,
  agentMode: orNull(preferences.agentMode),
  agentModeApiKeyId: orNull(preferences.agentModeApiKeyId),
  openclawGatewayUrl: orNull(preferences.openclawGatewayUrl),
  openclawToken: orNull(preferences.openclawToken),
  lastSeenFeature: orNull(preferences.lastSeenFeature),
  languageSwitchEnabled: false,
  secondaryDictationLanguage: null,
  activeDictationLanguage: orValue(
    preferences.activeDictationLanguage,
    PRIMARY_LANGUAGE_SENTINEL,
  ),
  preferredMicrophone: orNull(preferences.preferredMicrophone),
  ignoreUpdateDialog: orFalse(preferences.ignoreUpdateDialog),
  incognitoModeEnabled: orFalse(preferences.incognitoModeEnabled),
  incognitoModeIncludeInStats: orFalse(preferences.incognitoModeIncludeInStats),
  dictationLimitMinutes: normalizeDictationLimitMinutes(
    orValue(preferences.dictationLimitMinutes, DEFAULT_DICTATION_LIMIT_MINUTES),
  ),
  dictationPillVisibility: getEffectivePillVisibility(
    preferences.dictationPillVisibility,
  ),
  realtimeOutputEnabled: orFalse(preferences.realtimeOutputEnabled),
  remoteOutputEnabled: orFalse(preferences.remoteOutputEnabled),
  remoteTargetDeviceId: orNull(preferences.remoteTargetDeviceId),
  remoteReceiverPort: orNull(preferences.remoteReceiverPort),
  remoteReceiverAutoStart: orFalse(preferences.remoteReceiverAutoStart),
  dictationAudioDim: orValue(preferences.dictationAudioDim, 1.0),
  pasteKeybind: orNull(preferences.pasteKeybind),
  useNewBackend: true,
  menuBarIconHidden: orFalse(preferences.menuBarIconHidden),
  insertionMethod: orNull(preferences.insertionMethod),
  typingSpeedMs: orNull(preferences.typingSpeedMs),
  pillResetMonitorStrategy: normalizePillResetMonitorStrategy(
    preferences.pillResetMonitorStrategy,
  ),
  alwaysRequestAdminOnStartup: orFalse(preferences.alwaysRequestAdminOnStartup),
});

export abstract class BaseUserPreferencesRepo extends BaseRepo {
  abstract setUserPreferences(
    preferences: UserPreferences,
  ): Promise<UserPreferences>;
  abstract getUserPreferences(): Promise<Nullable<UserPreferences>>;
}

export class LocalUserPreferencesRepo extends BaseUserPreferencesRepo {
  async setUserPreferences(
    preferences: UserPreferences,
  ): Promise<UserPreferences> {
    const saved = await invoke<LocalUserPreferences>("user_preferences_set", {
      preferences: toLocalPreferences(preferences),
    });

    return fromLocalPreferences(saved);
  }

  async getUserPreferences(): Promise<Nullable<UserPreferences>> {
    const result = await invoke<Nullable<LocalUserPreferences>>(
      "user_preferences_get",
      {
        args: { userId: LOCAL_USER_ID },
      },
    );

    return result ? fromLocalPreferences(result) : null;
  }
}
