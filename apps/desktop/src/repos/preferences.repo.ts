import {
  AgentMode,
  DictationPillVisibility,
  Nullable,
  PillPlacement,
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
import { normalizeHandsFreeDelayMs } from "../utils/hands-free-delay.utils";
import { PRIMARY_LANGUAGE_SENTINEL } from "../utils/language.utils";
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
  preserveAudioOnFailure: boolean;
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
  pillPlacement?: Nullable<PillPlacement>;
  alwaysRequestAdminOnStartup?: boolean;
  handsFreeDelayMs?: Nullable<number>;
  autoLearnDictionaryEnabled?: boolean;
};

const normalizePillResetMonitorStrategy = (
  strategy: Nullable<string> | undefined,
): PillResetMonitorStrategy => (strategy === "cursor" ? "cursor" : "current");

const normalizePillPlacement = (
  placement: Nullable<string> | undefined,
): PillPlacement => (placement === "top" ? "top" : "bottom");

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

const withDefault = <T>(value: T | null | undefined, fallback: T): T =>
  (value ?? fallback) as T;

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
  openclawGatewayUrl: withDefault(preferences.openclawGatewayUrl, null),
  openclawToken: withDefault(preferences.openclawToken, null),
  lastSeenFeature: preferences.lastSeenFeature,
  activeDictationLanguage: withDefault(
    preferences.activeDictationLanguage,
    null,
  ),
  preferredMicrophone: withDefault(preferences.preferredMicrophone, null),
  ignoreUpdateDialog: preferences.ignoreUpdateDialog ?? false,
  incognitoModeEnabled: preferences.incognitoModeEnabled ?? false,
  incognitoModeIncludeInStats: withDefault(
    preferences.incognitoModeIncludeInStats,
    false,
  ),
  preserveAudioOnFailure: preferences.preserveAudioOnFailure ?? true,
  dictationLimitMinutes: normalizeDictationLimitMinutes(
    preferences.dictationLimitMinutes,
  ),
  dictationPillVisibility: getEffectivePillVisibility(
    preferences.dictationPillVisibility,
  ),
  realtimeOutputEnabled: preferences.realtimeOutputEnabled ?? false,
  remoteOutputEnabled: preferences.remoteOutputEnabled ?? false,
  remoteTargetDeviceId: withDefault(preferences.remoteTargetDeviceId, null),
  remoteReceiverPort: withDefault(preferences.remoteReceiverPort, null),
  remoteReceiverAutoStart: preferences.remoteReceiverAutoStart ?? false,
  dictationAudioDim: preferences.dictationAudioDim ?? 1.0,
  pasteKeybind: withDefault(preferences.pasteKeybind, null),
  menuBarIconHidden: preferences.menuBarIconHidden ?? false,
  insertionMethod: withDefault(preferences.insertionMethod, null),
  typingSpeedMs: withDefault(preferences.typingSpeedMs, null),
  pillResetMonitorStrategy: normalizePillResetMonitorStrategy(
    preferences.pillResetMonitorStrategy,
  ),
  pillPlacement: normalizePillPlacement(preferences.pillPlacement),
  alwaysRequestAdminOnStartup: withDefault(
    preferences.alwaysRequestAdminOnStartup,
    false,
  ),
  handsFreeDelayMs:
    preferences.handsFreeDelayMs == null
      ? null
      : normalizeHandsFreeDelayMs(preferences.handsFreeDelayMs),
  autoLearnDictionaryEnabled: preferences.autoLearnDictionaryEnabled ?? true,
});

export const toLocalPreferences = (
  preferences: UserPreferences,
): LocalUserPreferences => ({
  userId: LOCAL_USER_ID,
  transcriptionMode: withDefault(preferences.transcriptionMode, null),
  transcriptionApiKeyId: withDefault(preferences.transcriptionApiKeyId, null),
  transcriptionDevice: withDefault(preferences.transcriptionDevice, null),
  transcriptionModelSize: withDefault(preferences.transcriptionModelSize, null),
  postProcessingMode: withDefault(preferences.postProcessingMode, null),
  postProcessingApiKeyId: withDefault(preferences.postProcessingApiKeyId, null),
  postProcessingOllamaUrl: withDefault(
    preferences.postProcessingOllamaUrl,
    null,
  ),
  postProcessingOllamaModel: withDefault(
    preferences.postProcessingOllamaModel,
    null,
  ),
  activeToneId: withDefault(preferences.activeToneId, null),
  gotStartedAt: withDefault(preferences.gotStartedAt, null),
  gpuEnumerationEnabled: preferences.gpuEnumerationEnabled,
  agentMode: withDefault(preferences.agentMode, null),
  agentModeApiKeyId: withDefault(preferences.agentModeApiKeyId, null),
  openclawGatewayUrl: withDefault(preferences.openclawGatewayUrl, null),
  openclawToken: withDefault(preferences.openclawToken, null),
  lastSeenFeature: withDefault(preferences.lastSeenFeature, null),
  languageSwitchEnabled: false,
  secondaryDictationLanguage: null,
  activeDictationLanguage: withDefault(
    preferences.activeDictationLanguage,
    PRIMARY_LANGUAGE_SENTINEL,
  ),
  preferredMicrophone: withDefault(preferences.preferredMicrophone, null),
  ignoreUpdateDialog: preferences.ignoreUpdateDialog ?? false,
  incognitoModeEnabled: preferences.incognitoModeEnabled ?? false,
  incognitoModeIncludeInStats: withDefault(
    preferences.incognitoModeIncludeInStats,
    false,
  ),
  preserveAudioOnFailure: preferences.preserveAudioOnFailure ?? true,
  dictationLimitMinutes: normalizeDictationLimitMinutes(
    preferences.dictationLimitMinutes ?? DEFAULT_DICTATION_LIMIT_MINUTES,
  ),
  dictationPillVisibility: getEffectivePillVisibility(
    preferences.dictationPillVisibility,
  ),
  realtimeOutputEnabled: preferences.realtimeOutputEnabled ?? false,
  remoteOutputEnabled: preferences.remoteOutputEnabled ?? false,
  remoteTargetDeviceId: withDefault(preferences.remoteTargetDeviceId, null),
  remoteReceiverPort: withDefault(preferences.remoteReceiverPort, null),
  remoteReceiverAutoStart: preferences.remoteReceiverAutoStart ?? false,
  dictationAudioDim: preferences.dictationAudioDim ?? 1.0,
  pasteKeybind: withDefault(preferences.pasteKeybind, null),
  useNewBackend: true,
  menuBarIconHidden: preferences.menuBarIconHidden ?? false,
  insertionMethod: withDefault(preferences.insertionMethod, null),
  typingSpeedMs: withDefault(preferences.typingSpeedMs, null),
  pillResetMonitorStrategy: normalizePillResetMonitorStrategy(
    preferences.pillResetMonitorStrategy,
  ),
  pillPlacement: normalizePillPlacement(preferences.pillPlacement ?? null),
  alwaysRequestAdminOnStartup: withDefault(
    preferences.alwaysRequestAdminOnStartup,
    false,
  ),
  handsFreeDelayMs:
    preferences.handsFreeDelayMs === null
      ? null
      : normalizeHandsFreeDelayMs(preferences.handsFreeDelayMs),
  autoLearnDictionaryEnabled: preferences.autoLearnDictionaryEnabled ?? true,
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
