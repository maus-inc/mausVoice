import type { AppState } from "../../state/app.state";
import type {
  ApiTranscriptionPrefs,
  TranscriptionPrefs,
} from "../../types/transcription-prefs.types";
import { getMyPrimaryDictationLanguage } from "../../utils/user.utils";
import {
  getLocalDataClearGeneration,
  isLocalDataClearRequested,
} from "../../utils/local-data-write-gate";

export const resolveDictationLanguage = (
  requested: string | null | undefined,
  state: AppState,
): string => requested || getMyPrimaryDictationLanguage(state);

export const getSessionProvider = (
  prefs: TranscriptionPrefs,
): ApiTranscriptionPrefs["provider"] | null =>
  prefs.mode === "api" ? prefs.provider : null;

/**
 * Style loading and provider warmup are async, so a start can be replaced,
 * wiped or superseded while it runs. The caller stops when this is false.
 */
export const isStartStillValidAfterStyleLoad = (
  styleReady: boolean,
  attempt: number,
  currentAttempt: number,
  clearGeneration: number,
): boolean =>
  styleReady &&
  currentAttempt === attempt &&
  !isLocalDataClearRequested() &&
  clearGeneration === getLocalDataClearGeneration();
