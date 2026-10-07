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
 * Whether the account rows can act. The local build has no session, so those
 * rows stay out of the page, out of search and out of deep links.
 */
const getAccountAvailability = (
  state: Parameters<typeof getIsLoggedIn>[0],
) => ({
  signed_in_as: getIsLoggedIn(state),
  change_password: getIsLoggedIn(state) && getHasEmailProvider(state),
  sign_out: getIsLoggedIn(state),
  delete_account: getIsLoggedIn(state),
});

/**
 * One snapshot of which rows the current platform, provider and preferences
 * make renderable.
 *
 * Rendering, search and deep links all read this, so a control the page does
 * not show cannot be found by search or reached by a `?setting=` link. It lives
 * here rather than inside a page because the pages are separate routes now and
 * there is no single component left that owns the whole surface.
 */
export const useSettingsAvailability = (): SettingAvailability => {
  const platform = getPlatform();
  const snapshot = useAppStore((state) => {
    const preferences = getMyUserPreferences(state);
    const transcriptionPrefs = getTranscriptionPrefs(state);
    return [
      shouldEnableDictationLimit(transcriptionPrefs.mode),
      getEffectiveStylingMode(state),
      preferences?.incognitoModeEnabled ?? false,
      transcriptionPrefs.mode === "api" ? transcriptionPrefs.provider : null,
      disclosureIsVisible(getTranscriptionAudioDisclosure(state)),
      platform === "macos" || platform === "windows",
      platform === "windows",
      isPillPlacementAvailable(),
      getAccountAvailability(state),
    ] as const;
  });

  const [
    dictationLimitEnabled,
    stylingMode,
    incognitoModeEnabled,
    transcriptionProvider,
    audioDisclosureVisible,
    supportsCorrectionWatch,
    isWindows,
    pillPlacementAvailable,
    account,
  ] = snapshot;

  return useMemo(
    () => ({
      dictation_limit: dictationLimitEnabled,
      automatic_style_loading: stylingMode === "manual",
      include_incognito_in_stats: incognitoModeEnabled,
      learn_from_corrections: supportsCorrectionWatch,
      always_run_as_administrator: isWindows,
      pill_placement: pillPlacementAvailable,
      elevenlabs_keyterms: transcriptionProvider === "elevenlabs",
      where_your_dictation_audio_goes: audioDisclosureVisible,
      ...account,
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
      account,
    ],
  );
};
