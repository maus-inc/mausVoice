import type { IntlShape } from "react-intl";
import { getProviderFormConfig } from "../components/settings/api-key-provider-config";
import type { AppState } from "../state/app.state";
import {
  getEffectiveTranscriptionMode,
  getTranscriptionPrefs,
} from "./user.utils";

/**
 * True when the user has selected a cloud transcription provider, so dictation
 * audio leaves the machine while they are still talking. Local mode transcribes
 * on the loopback sidecar and is a different privacy case: disclosures about
 * transmission must stay hidden there.
 */
export const getIsCloudTranscriptionSelected = (state: AppState): boolean =>
  getEffectiveTranscriptionMode(state) === "api";

/**
 * Bare provider name (for example "AssemblyAI") for interpolation into a
 * translated sentence. Never the `"API • AssemblyAI"` session label, which would
 * drop an untranslated fragment into translated copy.
 *
 * Null when nothing is actually dispatched to a cloud provider: local mode, or
 * a selection that cannot transcribe (no key, no key value, a provider this
 * build does not know). Copy that has to name a provider stays hidden rather
 * than rendering an empty or unresolvable name.
 */
export const getTranscriptionProviderName = (
  state: AppState,
): string | null => {
  const prefs = getTranscriptionPrefs(state);
  if (prefs.mode !== "api") {
    return null;
  }
  try {
    return getProviderFormConfig(prefs.provider, "transcription").displayName;
  } catch {
    // Every transcription-capable provider has a form config, so this only
    // covers a key row written by a newer build. A disclosure that cannot name
    // its provider stays hidden rather than crashing the surface that shows it.
    return null;
  }
};

/**
 * Body of the "press cancel again" toast. A cloud provider already holds the
 * audio by the time the prompt appears, so the discard is not local and the
 * message says so. Local mode keeps the original wording: nothing leaves the
 * machine, and naming a provider there would be false.
 */
export const getCancelTranscriptPromptMessage = (
  state: AppState,
  intl: IntlShape,
): string => {
  const provider = getTranscriptionProviderName(state);
  return provider
    ? intl.formatMessage(
        {
          defaultMessage:
            "Press cancel again to discard. Audio already sent to {provider} can't be recalled.",
        },
        { provider },
      )
    : intl.formatMessage({
        defaultMessage: "Press cancel again to discard transcript",
      });
};
