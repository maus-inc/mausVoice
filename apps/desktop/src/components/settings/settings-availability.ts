import { useMemo } from "react";
import { useAppStore } from "../../store";
import { shouldEnableDictationLimit } from "../../utils/dictation-limit.utils";
import { getEffectiveStylingMode } from "../../utils/feature.utils";
import {
  disclosureIsVisible,
  getTranscriptionAudioDisclosure,
} from "../../utils/transcription-privacy.utils";
import {
  getHasEmailProvider,
  getIsLoggedIn,
  getMyUserPreferences,
  getTranscriptionPrefs,
} from "../../utils/user.utils";
import { getPlatform } from "../../utils/platform.utils";
import { isPillPlacementAvailable } from "./PillPlacementSetting";
import type { SettingAvailability } from "../../utils/settings-registry";

/**
 * One snapshot of which rows the current platform, provider and preferences
 * make renderable.
 *
 * Rendering and search exclude unknown rows. Deep links retain an unknown
 * target while its provider data loads, then focus it if it becomes available.
 * This snapshot is shared across the separate settings routes.
 */
export const useSettingsAvailability = (): SettingAvailability => {
  const platform = getPlatform();
  const snapshot = useAppStore((state) => {
    const preferences = getMyUserPreferences(state);
    const transcriptionPrefs = getTranscriptionPrefs(state);
    const loggedIn = getIsLoggedIn(state);
    return {
      dictationLimitEnabled: shouldEnableDictationLimit(
        transcriptionPrefs.mode,
      ),
      stylingMode: getEffectiveStylingMode(state),
      incognitoModeEnabled: preferences?.incognitoModeEnabled ?? false,
      transcriptionProvider:
        transcriptionPrefs.mode === "api" ? transcriptionPrefs.provider : null,
      audioDisclosureVisible: disclosureIsVisible(
        getTranscriptionAudioDisclosure(state),
      ),
      supportsCorrectionWatch: platform === "macos" || platform === "windows",
      isWindows: platform === "windows",
      pillPlacementAvailable: isPillPlacementAvailable(),
      changePassword: loggedIn && getHasEmailProvider(state),
      signOut: loggedIn,
      deleteAccount: loggedIn,
      // Provider-dependent availability remains unknown until the list loads.
      apiKeysKnown: state.settings.apiKeysStatus === "success",
    };
  });

  const {
    dictationLimitEnabled,
    stylingMode,
    incognitoModeEnabled,
    transcriptionProvider,
    audioDisclosureVisible,
    supportsCorrectionWatch,
    isWindows,
    pillPlacementAvailable,
    changePassword,
    signOut,
    deleteAccount,
    apiKeysKnown,
  } = snapshot;

  return useMemo(
    () => ({
      // The two flags that read the key list stay absent until it loads. An
      // absent key means "unknown", which `isSettingAvailable` reads as
      // available, so a `?setting=` deep link that arrives before the list does
      // still resolves: reading a not-yet-loaded source as `false` threw the
      // link away and landed the person on another page. The flags that read
      // the platform, the user record or the preferences are settled by the
      // time any surface renders — including this one, which reads the
      // transcription mode and nothing the key list has to say. Waiting for the
      // list here would hide the limit whenever that request failed, which is a
      // permanent hiding of a control that never depended on it.
      dictation_limit: dictationLimitEnabled,
      automatic_style_loading: stylingMode === "manual",
      include_incognito_in_stats: incognitoModeEnabled,
      learn_from_corrections: supportsCorrectionWatch,
      always_run_as_administrator: isWindows,
      pill_placement: pillPlacementAvailable,
      elevenlabs_keyterms: apiKeysKnown
        ? transcriptionProvider === "elevenlabs"
        : undefined,
      where_your_dictation_audio_goes: apiKeysKnown
        ? audioDisclosureVisible
        : undefined,
      change_password: changePassword,
      sign_out: signOut,
      delete_account: deleteAccount,
    }),
    [
      dictationLimitEnabled,
      stylingMode,
      incognitoModeEnabled,
      supportsCorrectionWatch,
      isWindows,
      pillPlacementAvailable,
      transcriptionProvider,
      audioDisclosureVisible,
      changePassword,
      signOut,
      deleteAccount,
      apiKeysKnown,
    ],
  );
};
