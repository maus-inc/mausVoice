import { invoke } from "@tauri-apps/api/core";
import {
  ApiKeyProvider,
  DictationPillVisibility,
  Nullable,
  User,
  UserPreferences,
} from "@maus-inc/types";
import { countWords, getRec } from "@maus-inc/utilities";
import type {
  AgentMode,
  PostProcessingMode,
  TranscriptionMode,
} from "../types/ai.types";
import dayjs from "dayjs";
import { detectLocale, matchSupportedLocale } from "../i18n";
import { DEFAULT_LOCALE, type Locale } from "../i18n/config";
import { createTranscriptionSession } from "../sessions";
import type { AppState } from "../state/app.state";
import { applyAiPreferences } from "./ai.utils";
import { registerUsers } from "./app.utils";
import { getAdditionalLanguageEntries } from "./keyboard.utils";
import {
  AUTO_LANGUAGE,
  coerceToDictationLanguage,
  DictationLanguageCode,
  KEYBOARD_LAYOUT_LANGUAGE,
  PRIMARY_LANGUAGE_SENTINEL,
} from "./language.utils";

export const LOCAL_USER_ID = "local-user-id";

export const getIsLoggedIn = (state: AppState): boolean => {
  return !!state.auth;
};

export const getHasEmailProvider = (state: AppState): boolean => {
  const auth = state.auth;
  const providers = auth?.providers ?? [];
  return providers.includes("password");
};

export const getIsOnboarded = (state: AppState): boolean => {
  return Boolean(getMyUser(state)?.onboarded);
};

export const getIsDictationUnlocked = (state: AppState): boolean => {
  return getIsOnboarded(state) || state.onboarding.dictationOverrideEnabled;
};

const resolveMode = <T extends string>(mode: T | null, fallback: T): T => {
  return mode ?? fallback;
};

export const getEffectiveTranscriptionMode = (
  state: AppState,
): TranscriptionMode => {
  return resolveMode(state.settings.aiTranscription.mode, "local");
};

export const getEffectivePostProcessingMode = (
  state: AppState,
): PostProcessingMode => {
  return resolveMode(state.settings.aiPostProcessing.mode, "none");
};

export const getEffectiveAgentMode = (state: AppState): AgentMode => {
  return resolveMode(state.settings.agentMode.mode, "none");
};

export const getMyEffectiveUserId = (state: AppState): string => {
  return state.auth?.uid ?? LOCAL_USER_ID;
};

export const getMyUser = (state: AppState): Nullable<User> => {
  return getRec(state.userById, getMyEffectiveUserId(state)) ?? null;
};

export const getMyPreferredLocale = (state: AppState): Locale => {
  const user = getMyUser(state);
  return (
    matchSupportedLocale(user?.preferredLanguage) ??
    detectLocale() ??
    DEFAULT_LOCALE
  );
};

export const getDetectedSystemLocale = (): string => {
  return detectLocale() ?? DEFAULT_LOCALE;
};

export const getMyPrimaryDictationLanguage = (state: AppState): string => {
  const user = getMyUser(state);
  if (user?.preferredLanguage) {
    return user.preferredLanguage;
  }
  return getDetectedSystemLocale();
};

/**
 * The set of concrete dictation language codes the user has configured and may
 * therefore select as their Active Dictation Language. Auto is always available;
 * the rest come from the additional-language hotkeys. The Primary is represented
 * by the `primary` sentinel, not a concrete code, so it is not included here.
 */
export const getConfiguredDictationLanguageCodes = (
  state: AppState,
): Set<string> => {
  const codes = new Set<string>([AUTO_LANGUAGE]);
  for (const entry of getAdditionalLanguageEntries(state)) {
    codes.add(entry.language);
  }
  return codes;
};

/**
 * The Active Dictation Language as a sentinel-or-code, with the stale-value
 * guard applied: the persisted value is honored only when it is the `primary`
 * sentinel or a member of the current configured set; otherwise it falls
 * through to the sentinel (follow Primary). Guards against stale values written
 * by the since-removed language-switch feature and against a previously-active
 * language later removed from the configured set.
 */
export const getActiveDictationLanguage = (state: AppState): string => {
  const stored = state.userPrefs?.activeDictationLanguage;
  if (!stored || stored === PRIMARY_LANGUAGE_SENTINEL) {
    return PRIMARY_LANGUAGE_SENTINEL;
  }
  if (getConfiguredDictationLanguageCodes(state).has(stored)) {
    return stored;
  }
  return PRIMARY_LANGUAGE_SENTINEL;
};

export const getMyDictationLanguage = (state: AppState): string => {
  const override = state.dictationLanguageOverride;
  if (override) {
    return override;
  }

  const active = getActiveDictationLanguage(state);
  if (active !== PRIMARY_LANGUAGE_SENTINEL) {
    return active;
  }

  return getMyPrimaryDictationLanguage(state);
};

export const loadMyEffectiveDictationLanguage = async (
  state: AppState,
): Promise<DictationLanguageCode> => {
  let lang = getMyDictationLanguage(state);
  if (lang === AUTO_LANGUAGE) {
    return AUTO_LANGUAGE;
  }
  if (lang === KEYBOARD_LAYOUT_LANGUAGE) {
    lang = await invoke<string>("get_keyboard_language").catch((e) => {
      console.error("Failed to get keyboard language:", e);
      return "en";
    });
  }

  return coerceToDictationLanguage(lang);
};

export const formatDictationLanguageCode = (language: string): string => {
  if (language === AUTO_LANGUAGE) {
    return "AUTO";
  }
  const baseCode = language.split("-")[0];
  return baseCode.toUpperCase().slice(0, 2);
};

export const getMyUserPreferences = (
  state: AppState,
): Nullable<UserPreferences> => {
  return state.userPrefs;
};

export const getMyPreferredMicrophone = (state: AppState): Nullable<string> => {
  return state.userPrefs?.preferredMicrophone ?? null;
};

export const getShouldGoToOnboarding = (state: AppState): boolean => {
  const prefs = getMyUserPreferences(state);
  const gotStartedAt = prefs?.gotStartedAt;
  if (!gotStartedAt) {
    return false;
  }

  const now = Date.now();
  const elapsed = now - gotStartedAt;
  const twoMinutes = 2 * 60 * 1000;
  if (elapsed < twoMinutes) {
    return true;
  }

  return false;
};

export const getMyUserName = (state: AppState): string => {
  const user = getMyUser(state);
  return user?.name || "Guest";
};

export const getIsSignedIn = (state: AppState): boolean => {
  return !!state.auth;
};

export const setCurrentUser = (draft: AppState, user: User): void => {
  registerUsers(draft, [user]);
};

export const setUserPreferences = (
  draft: AppState,
  value: UserPreferences,
): void => {
  // Invariant enforcement, one write-site wide: realtime output and
  // review-before-insert cannot both be on (interim streaming always runs
  // with skipReview, so dual-true would silently skip review). Setters keep
  // the pair exclusive on write; this normalize also repairs legacy rows
  // that predate that rule. Realtime wins to match the runtime preference.
  const normalized =
    value.realtimeOutputEnabled === true && value.reviewBeforeInsert === true
      ? { ...value, reviewBeforeInsert: false }
      : value;
  draft.userPrefs = normalized;
  applyAiPreferences(draft, normalized);
};

type BaseTranscriptionPrefs = {
  warnings: string[];
};

export type LocalTranscriptionPrefs = BaseTranscriptionPrefs & {
  mode: "local";
  gpuEnumerationEnabled: boolean;
  transcriptionDevice: string | null;
  transcriptionModelSize: string | null;
};

export type ApiTranscriptionPrefs = BaseTranscriptionPrefs & {
  mode: "api";
  provider: ApiKeyProvider;
  apiKeyId: string;
  apiKeyValue: string;
  transcriptionModel: string | null;
};

export type TranscriptionPrefs =
  LocalTranscriptionPrefs | ApiTranscriptionPrefs;

/**
 * Providers with an implemented batch transcription route — i.e. parity with
 * the `getTranscribeAudioRepo()` switch branches in `repos/index.ts` (mirrored
 * here to avoid a circular import). This is NOT the same as the
 * `supportsTranscriptionModels()` capability flags: Azure is always available
 * in the transcription UI (special-cased by region in `ApiKeyList`), so
 * `AzureModelProviderRepo.supportsTranscriptionModels()` returns `false` while
 * `azure` still has a real dispatch branch and must stay in this set. A
 * selected key whose provider is not in this set cannot be transcribed and is
 * treated as stale.
 */
const TRANSCRIPTION_CAPABLE_PROVIDERS: Set<ApiKeyProvider> = new Set([
  "groq",
  "openai",
  "aldea",
  "assemblyai",
  "elevenlabs",
  "deepgram",
  "gladia",
  "openai-compatible",
  "azure",
  "gemini",
  "speaches",
  "xai",
  "openrouter",
]);

export const getTranscriptionPrefs = (state: AppState): TranscriptionPrefs => {
  const config = state.settings.aiTranscription;
  const mode = getEffectiveTranscriptionMode(state);
  const warnings: string[] = [];

  if (mode === "api") {
    const selectedApiKey = getRec(state.apiKeyById, config.selectedApiKeyId);
    const provider = selectedApiKey?.provider as ApiKeyProvider | undefined;
    // A stale selection (e.g. an Ollama key saved before Ollama lost
    // transcription capability) must not reach the dispatch path. Treat it as
    // if nothing were selected: fall back to local mode and warn, mirroring
    // the no-API-key path.
    const keylessTranscriptionProvider =
      provider === "speaches" || provider === "openai-compatible";
    if (
      !selectedApiKey ||
      !provider ||
      !TRANSCRIPTION_CAPABLE_PROVIDERS.has(provider)
    ) {
      warnings.push("No transcription-capable API key selected.");
    } else if (selectedApiKey.keyFull || keylessTranscriptionProvider) {
      return {
        mode: "api",
        provider,
        apiKeyId: config.selectedApiKeyId!,
        apiKeyValue: selectedApiKey.keyFull ?? "",
        transcriptionModel: selectedApiKey.transcriptionModel ?? null,
        warnings,
      };
    } else {
      warnings.push("No API key configured for API transcription.");
    }
  }

  return {
    mode: "local",
    warnings,
    gpuEnumerationEnabled: config.gpuEnumerationEnabled,
    transcriptionDevice: config.device ?? null,
    transcriptionModelSize: config.modelSize ?? null,
  };
};

export const getTranscriptionSupportsStreaming = (state: AppState): boolean => {
  const prefs = getTranscriptionPrefs(state);
  const session = createTranscriptionSession(prefs);
  return session.supportsStreaming();
};

type BaseGenerativePrefs = {
  warnings: string[];
};

export type ApiGenerativePrefs = BaseGenerativePrefs & {
  mode: "api";
  provider: ApiKeyProvider;
  apiKeyId: string;
  apiKeyValue: string;
  postProcessingModel: string | null;
};

export type NoneGenerativePrefs = BaseGenerativePrefs & {
  mode: "none";
};

export type GenerativePrefs = ApiGenerativePrefs | NoneGenerativePrefs;

type GenerativeConfigInput = {
  mode: "none" | "api" | null;
  selectedApiKeyId: string | null;
};

const getGenPrefsInternal = ({
  state,
  config,
  context,
}: {
  state: AppState;
  config: GenerativeConfigInput;
  context: string;
}): GenerativePrefs => {
  const mode = resolveMode(config.mode, "none");
  const apiKey = getRec(state.apiKeyById, config.selectedApiKeyId)?.keyFull;
  const warnings: string[] = [];

  if (mode === "api") {
    const selectedApiKey = getRec(state.apiKeyById, config.selectedApiKeyId);
    const provider = selectedApiKey?.provider;
    const noKeyRequired =
      provider === "ollama" || provider === "openai-compatible";
    if (apiKey || noKeyRequired) {
      return {
        mode: "api",
        provider: provider ?? "groq",
        apiKeyId: config.selectedApiKeyId!,
        apiKeyValue: apiKey ?? "",
        postProcessingModel: selectedApiKey?.postProcessingModel ?? null,
        warnings,
      };
    } else {
      warnings.push(`No API key configured for API ${context}.`);
    }
  }

  return { mode: "none", warnings };
};

export const getGenerativePrefs = (state: AppState): GenerativePrefs => {
  return getGenPrefsInternal({
    state,
    config: state.settings.aiPostProcessing,
    context: "post-processing",
  });
};

export type OpenClawGenerativePrefs = {
  mode: "openclaw";
  gatewayUrl: string;
  token: string;
  warnings: string[];
};

export type AgentModePrefs = GenerativePrefs | OpenClawGenerativePrefs;

export const getAgentModePrefs = (state: AppState): AgentModePrefs => {
  const agentMode = state.settings.agentMode;

  return getGenPrefsInternal({
    state,
    config: agentMode as GenerativeConfigInput,
    context: "agent mode",
  });
};

export const getEffectiveStreak = (state: AppState): number => {
  const user = getMyUser(state);
  const streak = user?.streak;
  const recordedAt = user?.streakRecordedAt;
  if (!streak || !recordedAt) {
    return 0;
  }

  const today = dayjs().format("YYYY-MM-DD");
  if (recordedAt === today) {
    return streak;
  }

  const yesterday = dayjs().subtract(1, "day").format("YYYY-MM-DD");
  if (recordedAt === yesterday) {
    return streak;
  }

  return 0;
};

export const getEffectivePillVisibility = (
  visibility?: Nullable<string>,
): DictationPillVisibility => {
  if (
    visibility === "hidden" ||
    visibility === "while_active" ||
    visibility === "persistent"
  ) {
    return visibility;
  }

  return "persistent";
};

const SILENCE_PADDING_MS = 1500;
const MIN_DURATION_FOR_PADDING_MS = 4000;

export type DictationSpeed = {
  wpm: number;
  sampleCount: number;
};

export const getDictationSpeed = (state: AppState): DictationSpeed | null => {
  const ids = state.transcriptions.transcriptionIds;
  let totalWpm = 0;
  let count = 0;

  for (const id of ids) {
    const t = getRec(state.transcriptionById, id);
    if (
      !t ||
      !t.audio?.durationMs ||
      t.audio.durationMs <= 0 ||
      !t.transcript
    ) {
      continue;
    }
    const words = countWords(t.transcript);
    if (words <= 0) continue;
    let durationMs = t.audio.durationMs;
    if (durationMs >= MIN_DURATION_FOR_PADDING_MS) {
      durationMs -= SILENCE_PADDING_MS;
    }
    totalWpm += words / (durationMs / 60000);
    count++;
  }

  if (count === 0) return null;
  return { wpm: Math.round(totalWpm / count), sampleCount: count };
};
