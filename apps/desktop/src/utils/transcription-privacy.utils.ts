import type { ApiKeyProvider } from "@maus-inc/types";
import type { IntlShape } from "react-intl";
import { getProviderFormConfig } from "../components/settings/api-key-provider-config";
import {
  resolveTranscriptionSessionKind,
  type TranscriptionSessionKind,
} from "../sessions";
import type { AppState } from "../state/app.state";
import {
  getEffectiveTranscriptionMode,
  getSelectedTranscriptionProvider,
} from "./user.utils";

/**
 * What the user needs to be told about where their dictation audio goes, for the
 * configuration they have selected.
 *
 * `kind` is read from the same table that builds the session class, so the copy
 * cannot describe a session the app never creates. `providerName` is the bare
 * display name (for example "AssemblyAI"), never the `"API • AssemblyAI"`
 * session label, which would drop an untranslated fragment into translated copy.
 */
export type TranscriptionAudioDisclosure = {
  kind: TranscriptionSessionKind;
  providerName: string | null;
};

const readProviderName = (provider: ApiKeyProvider | null): string | null => {
  if (!provider) {
    return null;
  }
  try {
    return getProviderFormConfig(provider, "transcription").displayName;
  } catch {
    // Every transcription-capable provider has a form config, so this only
    // covers a key row written by a newer build. A disclosure that cannot name
    // its provider stays hidden rather than crashing the surface that shows it.
    return null;
  }
};

/**
 * The one gate every audio-transmission disclosure reads.
 *
 * The settings page, the dialog, the onboarding form and the cancel prompt used
 * to decide separately, and two of them disagreed: the page asked only whether
 * API mode was selected, while the prompt asked whether a provider could
 * actually be dispatched to. This answers from the selected provider and the
 * effective mode, which is what both surfaces mean to describe.
 *
 * The mode and provider are read without resolving the key, because onboarding
 * shows this before a key is saved, and a key that has not been typed yet does
 * not make the disclosure untrue.
 */
export const getTranscriptionAudioDisclosure = (
  state: AppState,
): TranscriptionAudioDisclosure => {
  const mode = getEffectiveTranscriptionMode(state);
  const provider = getSelectedTranscriptionProvider(state);
  return {
    kind: resolveTranscriptionSessionKind({ mode, provider }),
    providerName: readProviderName(provider),
  };
};

/**
 * True when the copy should be shown at all. Local mode needs no disclosure:
 * nothing leaves the machine, so a warning there would describe a non-event.
 */
export const disclosureIsVisible = (
  disclosure: TranscriptionAudioDisclosure,
): boolean => disclosure.kind !== "local" && disclosure.providerName !== null;

/**
 * Body of the "press cancel again" toast.
 *
 * Only a live-streaming provider already holds the audio at this point, so only
 * that case changes the wording. A batch provider uploads after recording stops,
 * so cancelling here has sent nothing and keeps the original prompt. Local mode
 * keeps it too.
 */
export const getCancelTranscriptPromptMessage = (
  disclosure: TranscriptionAudioDisclosure,
  intl: IntlShape,
): string => {
  if (disclosure.kind === "live-streaming" && disclosure.providerName) {
    return intl.formatMessage(
      {
        defaultMessage:
          "Press cancel again to discard. Audio already sent to {provider} can't be recalled.",
      },
      { provider: disclosure.providerName },
    );
  }
  return intl.formatMessage({
    defaultMessage: "Press cancel again to discard transcript",
  });
};
