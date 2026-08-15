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
  inDictationStyleSwitchingEnabled?: boolean;
  hallucinationFilterEnabled?: boolean;
  reviewBeforeInsert?: Nullable<boolean>;
  agentEnabledTools?: Nullable<string>;
  agentMaxIterations?: number;
  agentPermissionTimeoutMs?: number;
};

const normalizePillResetMonitorStrategy = (
  strategy: Nullable<string> | undefined,
): PillResetMonitorStrategy => (strategy === "cursor" ? "cursor" : "current");

const normalizeAgentMaxIterations = (
  value: number | null | undefined,
): number => Math.min(100, Math.max(1, Math.trunc(value ?? 20)));

const normalizeAgentPermissionTimeout = (
  value: number | null | undefined,
): number =>
  Math.min(10 * 60_000, Math.max(5_000, Math.trunc(value ?? 60_000)));

const parseAgentEnabledTools = (
  value: Nullable<string[]> | string | undefined,
): Nullable<string[]> => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
      ? parsed
      : null;
  } catch {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
};

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
  openclawGatewayUrl: preferences.openclawGatewayUrl ?? null,
  openclawToken: preferences.openclawToken ?? null,
  lastSeenFeature: preferences.lastSeenFeature,
  activeDictationLanguage: preferences.activeDictationLanguage ?? null,
  preferredMicrophone: preferences.preferredMicrophone ?? null,
  ignoreUpdateDialog: preferences.ignoreUpdateDialog ?? false,
  incognitoModeEnabled: preferences.incognitoModeEnabled ?? false,
  incognitoModeIncludeInStats: preferences.incognitoModeIncludeInStats ?? false,
  dictationLimitMinutes: normalizeDictationLimitMinutes(
    preferences.dictationLimitMinutes,
  ),
  dictationPillVisibility: getEffectivePillVisibility(
    preferences.dictationPillVisibility,
  ),
  realtimeOutputEnabled: preferences.realtimeOutputEnabled ?? false,
  remoteOutputEnabled: preferences.remoteOutputEnabled ?? false,
  remoteTargetDeviceId: preferences.remoteTargetDeviceId ?? null,
  remoteReceiverPort: preferences.remoteReceiverPort ?? null,
  remoteReceiverAutoStart: preferences.remoteReceiverAutoStart ?? false,
  dictationAudioDim: preferences.dictationAudioDim ?? 1.0,
  pasteKeybind: preferences.pasteKeybind ?? null,
  menuBarIconHidden: preferences.menuBarIconHidden ?? false,
  insertionMethod: preferences.insertionMethod ?? null,
  typingSpeedMs: preferences.typingSpeedMs ?? null,
  pillResetMonitorStrategy: normalizePillResetMonitorStrategy(
    preferences.pillResetMonitorStrategy,
  ),
  alwaysRequestAdminOnStartup: preferences.alwaysRequestAdminOnStartup ?? false,
  inDictationStyleSwitchingEnabled:
    preferences.inDictationStyleSwitchingEnabled ?? false,
  hallucinationFilterEnabled: preferences.hallucinationFilterEnabled ?? true,
  reviewBeforeInsert: preferences.reviewBeforeInsert ?? null,
  agentEnabledTools: parseAgentEnabledTools(preferences.agentEnabledTools),
  agentMaxIterations: normalizeAgentMaxIterations(
    preferences.agentMaxIterations,
  ),
  agentPermissionTimeoutMs: normalizeAgentPermissionTimeout(
    preferences.agentPermissionTimeoutMs,
  ),
});

export const toLocalPreferences = (
  preferences: UserPreferences,
): LocalUserPreferences => ({
  userId: LOCAL_USER_ID,
  transcriptionMode: preferences.transcriptionMode ?? null,
  transcriptionApiKeyId: preferences.transcriptionApiKeyId ?? null,
  transcriptionDevice: preferences.transcriptionDevice ?? null,
  transcriptionModelSize: preferences.transcriptionModelSize ?? null,
  postProcessingMode: preferences.postProcessingMode ?? null,
  postProcessingApiKeyId: preferences.postProcessingApiKeyId ?? null,
  postProcessingOllamaUrl: preferences.postProcessingOllamaUrl ?? null,
  postProcessingOllamaModel: preferences.postProcessingOllamaModel ?? null,
  activeToneId: preferences.activeToneId ?? null,
  gotStartedAt: preferences.gotStartedAt ?? null,
  gpuEnumerationEnabled: preferences.gpuEnumerationEnabled,
  agentMode: preferences.agentMode ?? null,
  agentModeApiKeyId: preferences.agentModeApiKeyId ?? null,
  openclawGatewayUrl: preferences.openclawGatewayUrl ?? null,
  openclawToken: preferences.openclawToken ?? null,
  lastSeenFeature: preferences.lastSeenFeature ?? null,
  languageSwitchEnabled: false,
  secondaryDictationLanguage: null,
  activeDictationLanguage:
    preferences.activeDictationLanguage ?? PRIMARY_LANGUAGE_SENTINEL,
  preferredMicrophone: preferences.preferredMicrophone ?? null,
  ignoreUpdateDialog: preferences.ignoreUpdateDialog ?? false,
  incognitoModeEnabled: preferences.incognitoModeEnabled ?? false,
  incognitoModeIncludeInStats: preferences.incognitoModeIncludeInStats ?? false,
  dictationLimitMinutes: normalizeDictationLimitMinutes(
    preferences.dictationLimitMinutes ?? DEFAULT_DICTATION_LIMIT_MINUTES,
  ),
  dictationPillVisibility: getEffectivePillVisibility(
    preferences.dictationPillVisibility,
  ),
  realtimeOutputEnabled: preferences.realtimeOutputEnabled ?? false,
  remoteOutputEnabled: preferences.remoteOutputEnabled ?? false,
  remoteTargetDeviceId: preferences.remoteTargetDeviceId ?? null,
  remoteReceiverPort: preferences.remoteReceiverPort ?? null,
  remoteReceiverAutoStart: preferences.remoteReceiverAutoStart ?? false,
  dictationAudioDim: preferences.dictationAudioDim ?? 1.0,
  pasteKeybind: preferences.pasteKeybind ?? null,
  useNewBackend: true,
  menuBarIconHidden: preferences.menuBarIconHidden ?? false,
  insertionMethod: preferences.insertionMethod ?? null,
  typingSpeedMs: preferences.typingSpeedMs ?? null,
  pillResetMonitorStrategy: normalizePillResetMonitorStrategy(
    preferences.pillResetMonitorStrategy,
  ),
  alwaysRequestAdminOnStartup: preferences.alwaysRequestAdminOnStartup ?? false,
  inDictationStyleSwitchingEnabled:
    preferences.inDictationStyleSwitchingEnabled ?? false,
  hallucinationFilterEnabled: preferences.hallucinationFilterEnabled ?? true,
  reviewBeforeInsert: preferences.reviewBeforeInsert ?? null,
  agentEnabledTools: preferences.agentEnabledTools
    ? JSON.stringify(preferences.agentEnabledTools)
    : null,
  agentMaxIterations: normalizeAgentMaxIterations(
    preferences.agentMaxIterations,
  ),
  agentPermissionTimeoutMs: normalizeAgentPermissionTimeout(
    preferences.agentPermissionTimeoutMs,
  ),
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
