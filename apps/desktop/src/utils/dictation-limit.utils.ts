import type { UserPreferences } from "@maus-inc/types";
import type { TranscriptionMode } from "../types/ai.types";
import { minutesToMilliseconds } from "./time.utils";

export const DEFAULT_DICTATION_LIMIT_MINUTES = 5;
const MAX_TIMEOUT_MS = 2_147_483_647;
export const MAX_DICTATION_LIMIT_MINUTES = Math.floor(MAX_TIMEOUT_MS / 60_000);

export const shouldEnableDictationLimit = (
  mode: TranscriptionMode | null | undefined,
): boolean => mode === "api" || mode === "local";

export const normalizeDictationLimitMinutes = (
  value: number | null | undefined,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_DICTATION_LIMIT_MINUTES;
  }

  return Math.min(MAX_DICTATION_LIMIT_MINUTES, Math.max(0, Math.floor(value)));
};

export const getEffectiveDictationLimitMinutes = (
  preferences:
    Pick<UserPreferences, "dictationLimitMinutes"> | null | undefined,
): number => {
  return normalizeDictationLimitMinutes(preferences?.dictationLimitMinutes);
};

export type DictationRecordingTimerDurations = {
  warningDurationMs: number | null;
  autoStopDurationMs: number | null;
};

export const getProviderRecordingTimerDurations = (
  maximumDurationMs: number | null | undefined,
): DictationRecordingTimerDurations => {
  if (
    typeof maximumDurationMs !== "number" ||
    !Number.isFinite(maximumDurationMs) ||
    maximumDurationMs <= 0 ||
    maximumDurationMs > MAX_TIMEOUT_MS
  ) {
    return { warningDurationMs: null, autoStopDurationMs: null };
  }
  return {
    warningDurationMs:
      maximumDurationMs > 60_000 ? maximumDurationMs - 60_000 : null,
    autoStopDurationMs: maximumDurationMs,
  };
};

export const getDictationRecordingTimerDurations = (
  limitMinutes: number,
): DictationRecordingTimerDurations => {
  const normalizedLimitMinutes = normalizeDictationLimitMinutes(limitMinutes);

  if (normalizedLimitMinutes === 0) {
    return {
      warningDurationMs: null,
      autoStopDurationMs: null,
    };
  }

  return {
    warningDurationMs:
      normalizedLimitMinutes > 1
        ? minutesToMilliseconds(normalizedLimitMinutes - 1)
        : null,
    autoStopDurationMs: minutesToMilliseconds(normalizedLimitMinutes),
  };
};
