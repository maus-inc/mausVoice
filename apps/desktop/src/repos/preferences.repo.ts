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

export const normalizeAgentMaxIterations = (
  value: number | null | undefined,
): number => {
  const normalized =
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : 20;
  return Math.min(100, Math.max(1, normalized));
};

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
    const parsed = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return parsed.length > 0 ? parsed : null;
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

const nullableValue = <T>(value: T | null | undefined): T | null =>
  value ?? null;

const booleanValue = (value: boolean | null | undefined): boolean =>
  value ?? false;

const valueOr = <T>(value: T | null | undefined, fallback: T): T =>
  value ?? fallback;

const jsonValue = (value: string[] | null | undefined): string | null =>
  value ? JSON.stringify(value) : null;

export const fromLocalPreferences = (
  preferences: LocalUserPreferences,
): UserPreferences => ({
  userId: preferences.userId,
  transcriptionMode: normalizeTranscriptionMode(preferences.transcriptionMode),
  transcriptionApiKeyId: nullableValue(preferences.transcriptionApiKeyId),
  transcriptionDevice: nullableValue(preferences.transcriptionDevice),
  transcriptionModelSize: nullableValue(preferences.transcriptionModelSize),
  postProcessingMode: normalizePostProcessingMode(
    preferences.postProcessingMode,
  ),
  postProcessingApiKeyId: nullableValue(preferences.postProcessingApiKeyId),
  postProcessingOllamaUrl: nullableValue(preferences.postProcessingOllamaUrl),
  postProcessingOllamaModel: nullableValue(
    preferences.postProcessingOllamaModel,
  ),
  activeToneId: nullableValue(preferences.activeToneId),
  gotStartedAt: nullableValue(preferences.gotStartedAt),
  gpuEnumerationEnabled: booleanValue(preferences.gpuEnumerationEnabled),
  agentMode: normalizeAgentMode(preferences.agentMode),
  agentModeApiKeyId: nullableValue(preferences.agentModeApiKeyId),
  openclawGatewayUrl: nullableValue(preferences.openclawGatewayUrl),
  openclawToken: nullableValue(preferences.openclawToken),
  lastSeenFeature: nullableValue(preferences.lastSeenFeature),
  activeDictationLanguage: nullableValue(preferences.activeDictationLanguage),
  preferredMicrophone: nullableValue(preferences.preferredMicrophone),
  ignoreUpdateDialog: booleanValue(preferences.ignoreUpdateDialog),
  incognitoModeEnabled: booleanValue(preferences.incognitoModeEnabled),
  incognitoModeIncludeInStats: booleanValue(
    preferences.incognitoModeIncludeInStats,
  ),
  dictationLimitMinutes: normalizeDictationLimitMinutes(
    preferences.dictationLimitMinutes,
  ),
  dictationPillVisibility: getEffectivePillVisibility(
    preferences.dictationPillVisibility,
  ),
  realtimeOutputEnabled: booleanValue(preferences.realtimeOutputEnabled),
  remoteOutputEnabled: booleanValue(preferences.remoteOutputEnabled),
  remoteTargetDeviceId: nullableValue(preferences.remoteTargetDeviceId),
  remoteReceiverPort: nullableValue(preferences.remoteReceiverPort),
  remoteReceiverAutoStart: booleanValue(preferences.remoteReceiverAutoStart),
  dictationAudioDim: valueOr(preferences.dictationAudioDim, 1.0),
  pasteKeybind: nullableValue(preferences.pasteKeybind),
  menuBarIconHidden: booleanValue(preferences.menuBarIconHidden),
  insertionMethod: nullableValue(preferences.insertionMethod),
  typingSpeedMs: nullableValue(preferences.typingSpeedMs),
  pillResetMonitorStrategy: normalizePillResetMonitorStrategy(
    preferences.pillResetMonitorStrategy,
  ),
  alwaysRequestAdminOnStartup: booleanValue(
    preferences.alwaysRequestAdminOnStartup,
  ),
  inDictationStyleSwitchingEnabled: booleanValue(
    preferences.inDictationStyleSwitchingEnabled,
  ),
  hallucinationFilterEnabled: valueOr(
    preferences.hallucinationFilterEnabled,
    true,
  ),
  reviewBeforeInsert: nullableValue(preferences.reviewBeforeInsert),
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
  transcriptionMode: nullableValue(preferences.transcriptionMode),
  transcriptionApiKeyId: nullableValue(preferences.transcriptionApiKeyId),
  transcriptionDevice: nullableValue(preferences.transcriptionDevice),
  transcriptionModelSize: nullableValue(preferences.transcriptionModelSize),
  postProcessingMode: nullableValue(preferences.postProcessingMode),
  postProcessingApiKeyId: nullableValue(preferences.postProcessingApiKeyId),
  postProcessingOllamaUrl: nullableValue(preferences.postProcessingOllamaUrl),
  postProcessingOllamaModel: nullableValue(
    preferences.postProcessingOllamaModel,
  ),
  activeToneId: nullableValue(preferences.activeToneId),
  gotStartedAt: nullableValue(preferences.gotStartedAt),
  gpuEnumerationEnabled: preferences.gpuEnumerationEnabled,
  agentMode: nullableValue(preferences.agentMode),
  agentModeApiKeyId: nullableValue(preferences.agentModeApiKeyId),
  openclawGatewayUrl: nullableValue(preferences.openclawGatewayUrl),
  openclawToken: nullableValue(preferences.openclawToken),
  lastSeenFeature: nullableValue(preferences.lastSeenFeature),
  languageSwitchEnabled: false,
  secondaryDictationLanguage: null,
  activeDictationLanguage: valueOr(
    preferences.activeDictationLanguage,
    PRIMARY_LANGUAGE_SENTINEL,
  ),
  preferredMicrophone: nullableValue(preferences.preferredMicrophone),
  ignoreUpdateDialog: preferences.ignoreUpdateDialog,
  incognitoModeEnabled: preferences.incognitoModeEnabled,
  incognitoModeIncludeInStats: preferences.incognitoModeIncludeInStats,
  dictationLimitMinutes: normalizeDictationLimitMinutes(
    valueOr(preferences.dictationLimitMinutes, DEFAULT_DICTATION_LIMIT_MINUTES),
  ),
  dictationPillVisibility: getEffectivePillVisibility(
    preferences.dictationPillVisibility,
  ),
  realtimeOutputEnabled: preferences.realtimeOutputEnabled,
  remoteOutputEnabled: preferences.remoteOutputEnabled,
  remoteTargetDeviceId: nullableValue(preferences.remoteTargetDeviceId),
  remoteReceiverPort: nullableValue(preferences.remoteReceiverPort),
  remoteReceiverAutoStart: preferences.remoteReceiverAutoStart,
  dictationAudioDim: preferences.dictationAudioDim,
  pasteKeybind: nullableValue(preferences.pasteKeybind),
  useNewBackend: true,
  menuBarIconHidden: preferences.menuBarIconHidden,
  insertionMethod: nullableValue(preferences.insertionMethod),
  typingSpeedMs: nullableValue(preferences.typingSpeedMs),
  pillResetMonitorStrategy: normalizePillResetMonitorStrategy(
    preferences.pillResetMonitorStrategy,
  ),
  alwaysRequestAdminOnStartup: preferences.alwaysRequestAdminOnStartup,
  inDictationStyleSwitchingEnabled:
    preferences.inDictationStyleSwitchingEnabled,
  hallucinationFilterEnabled: preferences.hallucinationFilterEnabled,
  reviewBeforeInsert: nullableValue(preferences.reviewBeforeInsert),
  agentEnabledTools: jsonValue(preferences.agentEnabledTools),
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
