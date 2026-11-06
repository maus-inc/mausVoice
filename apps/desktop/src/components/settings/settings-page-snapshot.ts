import type { UserPreferences } from "@maus-inc/types";
import type { AppState } from "../../state/app.state";
import {
  getEffectiveDictationLimitMinutes,
  shouldEnableDictationLimit,
} from "../../utils/dictation-limit.utils";
import { getEffectiveHandsFreeDelayMs } from "../../utils/hands-free-delay.utils";
import { getEffectiveStylingMode } from "../../utils/feature.utils";
import {
  disclosureIsVisible,
  getTranscriptionAudioDisclosure,
} from "../../utils/transcription-privacy.utils";
import {
  getEffectivePillVisibility,
  getMyUserPreferences,
  getTranscriptionPrefs,
} from "../../utils/user.utils";
import { orFalse, orTrue } from "../../utils/nullable.utils";

/** One coherent settings snapshot for the controls and their availability. */
export const selectSettingsPageSnapshot = (state: AppState) => {
  const storedPrefs = getMyUserPreferences(state);
  // Legacy records may lack newer values. A partial view plus the shared
  // nullable helpers gives this settings snapshot the same defaults as the
  // individual controls without manufacturing a persisted preferences row.
  const prefs: Partial<UserPreferences> = storedPrefs ?? {};
  const transcriptionPrefs = getTranscriptionPrefs(state);
  return [
    orFalse(prefs.ignoreUpdateDialog),
    orFalse(prefs.incognitoModeEnabled),
    orFalse(prefs.incognitoModeIncludeInStats),
    orTrue(prefs.preserveAudioOnFailure),
    getEffectivePillVisibility(prefs.dictationPillVisibility),
    prefs.pillResetMonitorStrategy ?? "current",
    orFalse(prefs.realtimeOutputEnabled),
    getEffectiveStylingMode(state),
    true,
    shouldEnableDictationLimit(transcriptionPrefs.mode),
    getEffectiveDictationLimitMinutes(storedPrefs),
    state.local.disablePillRewards,
    orFalse(state.local.disableAutoStyleLoading),
    orFalse(prefs.menuBarIconHidden),
    getEffectiveHandsFreeDelayMs(storedPrefs),
    orTrue(prefs.autoLearnDictionaryEnabled),
    orFalse(prefs.autoLearnFromEditsEnabled),
    orFalse(prefs.elevenLabsKeytermsEnabled),
    orTrue(prefs.spokenCommandsEnabled),
    orFalse(prefs.reviewBeforeInsert),
    orTrue(prefs.hallucinationFilterEnabled),
    orFalse(prefs.inDictationStyleSwitchingEnabled),
    transcriptionPrefs.mode === "api" ? transcriptionPrefs.provider : null,
    disclosureIsVisible(getTranscriptionAudioDisclosure(state)),
  ] as const;
};
