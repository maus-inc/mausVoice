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
import { PRIMARY_LANGUAGE_SENTINEL } from "../utils/language.utils";
import { orFalse, orNull, orTrue, orValue } from "../utils/nullable.utils";
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
  pillPlacement?: Nullable<string>;
  alwaysRequestAdminOnStartup?: boolean;
  preserveAudioOnFailure?: boolean;
  handsFreeDelayMs?: Nullable<number>;
  autoLearnDictionaryEnabled?: boolean;
  autoLearnFromEditsEnabled?: boolean;
  inDictationStyleSwitchingEnabled?: boolean;
  hallucinationFilterEnabled?: boolean;
  reviewBeforeInsert?: Nullable<boolean>;
  // Contract: `null` (the persisted default) means "follow the tool registry's
  // per-tool enablement"; an empty list `[]` is an *explicit* deny-all the user
  // chose and must never be coerced into enabling tools; a non-empty list is the
  // explicit allow-set. Do not migrate `null` to an allow-list of every tool id,
  // or a user's explicit `[]` would be silently overwritten. Persisted as a
  // JSON-encoded string (see `parseAgentEnabledTools` / `jsonValue`).
  agentEnabledTools?: Nullable<string>;
  agentMaxIterations?: number;
  agentPermissionTimeoutMs?: number;
  spokenCommandsEnabled?: boolean;
};

const normalizePillResetMonitorStrategy = (
  strategy: Nullable<string> | undefined,
): PillResetMonitorStrategy => (strategy === "cursor" ? "cursor" : "current");

const normalizePillPlacement = (
  value: Nullable<string> | undefined,
): PillPlacement => (value === "top" || value === "bottom" ? value : "bottom");

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

const jsonValue = (value: string[] | null | undefined): string | null =>
  value ? JSON.stringify(value) : null;

const fromLocalAiPreferences = (preferences: LocalUserPreferences) => ({
  transcriptionMode: normalizeTranscriptionMode(preferences.transcriptionMode),
  transcriptionApiKeyId: orNull(preferences.transcriptionApiKeyId),
  transcriptionDevice: orNull(preferences.transcriptionDevice),
  transcriptionModelSize: orNull(preferences.transcriptionModelSize),
  postProcessingMode: normalizePostProcessingMode(
    preferences.postProcessingMode,
  ),
  postProcessingApiKeyId: orNull(preferences.postProcessingApiKeyId),
  postProcessingOllamaUrl: orNull(preferences.postProcessingOllamaUrl),
  postProcessingOllamaModel: orNull(preferences.postProcessingOllamaModel),
  activeToneId: orNull(preferences.activeToneId),
  gpuEnumerationEnabled: orFalse(preferences.gpuEnumerationEnabled),
  agentMode: normalizeAgentMode(preferences.agentMode),
  agentModeApiKeyId: preferences.agentModeApiKeyId,
  openclawGatewayUrl: orNull(preferences.openclawGatewayUrl),
  openclawToken: orNull(preferences.openclawToken),
});

const fromLocalOutputPreferences = (preferences: LocalUserPreferences) => ({
  gotStartedAt: orNull(preferences.gotStartedAt),
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
  pillPlacement: normalizePillPlacement(preferences.pillPlacement),
  alwaysRequestAdminOnStartup: orFalse(preferences.alwaysRequestAdminOnStartup),
  preserveAudioOnFailure: preferences.preserveAudioOnFailure ?? true,
  handsFreeDelayMs: preferences.handsFreeDelayMs ?? null,
});

const fromLocalFeaturePreferences = (preferences: LocalUserPreferences) => ({
  autoLearnDictionaryEnabled: preferences.autoLearnDictionaryEnabled ?? true,
  autoLearnFromEditsEnabled: preferences.autoLearnFromEditsEnabled ?? false,
  inDictationStyleSwitchingEnabled: orFalse(
    preferences.inDictationStyleSwitchingEnabled,
  ),
  hallucinationFilterEnabled: orTrue(preferences.hallucinationFilterEnabled),
  reviewBeforeInsert: orNull(preferences.reviewBeforeInsert),
  agentEnabledTools: parseAgentEnabledTools(preferences.agentEnabledTools),
  agentMaxIterations: normalizeAgentMaxIterations(
    preferences.agentMaxIterations,
  ),
  agentPermissionTimeoutMs: normalizeAgentPermissionTimeout(
    preferences.agentPermissionTimeoutMs,
  ),
  spokenCommandsEnabled: orTrue(preferences.spokenCommandsEnabled),
});

export const fromLocalPreferences = (
  preferences: LocalUserPreferences,
): UserPreferences => ({
  userId: preferences.userId,
  ...fromLocalAiPreferences(preferences),
  ...fromLocalOutputPreferences(preferences),
  ...fromLocalFeaturePreferences(preferences),
});

const toLocalAiPreferences = (preferences: UserPreferences) => ({
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
});

const toLocalOutputPreferences = (preferences: UserPreferences) => ({
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
  pillPlacement: orValue(preferences.pillPlacement, "bottom"),
  alwaysRequestAdminOnStartup: orFalse(preferences.alwaysRequestAdminOnStartup),
  preserveAudioOnFailure: preferences.preserveAudioOnFailure ?? true,
  handsFreeDelayMs: orNull(preferences.handsFreeDelayMs),
});

const toLocalFeaturePreferences = (preferences: UserPreferences) => ({
  autoLearnDictionaryEnabled: preferences.autoLearnDictionaryEnabled,
  autoLearnFromEditsEnabled: preferences.autoLearnFromEditsEnabled,
  inDictationStyleSwitchingEnabled:
    preferences.inDictationStyleSwitchingEnabled,
  hallucinationFilterEnabled: preferences.hallucinationFilterEnabled,
  reviewBeforeInsert: orNull(preferences.reviewBeforeInsert),
  agentEnabledTools: jsonValue(preferences.agentEnabledTools),
  agentMaxIterations: normalizeAgentMaxIterations(
    preferences.agentMaxIterations,
  ),
  agentPermissionTimeoutMs: normalizeAgentPermissionTimeout(
    preferences.agentPermissionTimeoutMs,
  ),
  spokenCommandsEnabled: orTrue(preferences.spokenCommandsEnabled),
});

export const toLocalPreferences = (
  preferences: UserPreferences,
): LocalUserPreferences => ({
  userId: LOCAL_USER_ID,
  ...toLocalAiPreferences(preferences),
  ...toLocalOutputPreferences(preferences),
  ...toLocalFeaturePreferences(preferences),
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
