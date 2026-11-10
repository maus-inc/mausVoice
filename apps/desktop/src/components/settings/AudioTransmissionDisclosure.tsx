import { Typography } from "@mui/material";
import { Fragment } from "react";
import { FormattedMessage } from "react-intl";
import { useAppStore } from "../../store";
import { ProviderLogo } from "../common/provider-logos/ProviderLogo";
import {
  disclosureIsVisible,
  getTranscriptionAudioDisclosure,
} from "../../utils/transcription-privacy.utils";

/**
 * The one sentence that tells the user where their dictation audio goes.
 *
 * Every surface that makes a transmission claim renders this, so the wording
 * cannot drift away from the session the app builds. The sentence is chosen by
 * the session kind: a live-streaming provider receives audio while the user is
 * still talking, and a batch provider receives it only after recording stops.
 * Local mode renders nothing, because nothing leaves the machine.
 */
export const AudioTransmissionDisclosure = ({
  variant = "sentence",
}: {
  variant?: "sentence" | "setting";
}) => {
  const disclosure = useAppStore(getTranscriptionAudioDisclosure);

  if (!disclosureIsVisible(disclosure)) {
    return null;
  }

  const provider = disclosure.providerName as string;
  // The provider's own mark, inline with the name it belongs to. `values`
  // accepts a node, so the mark sits inside the sentence instead of beside it
  // as a stray graphic — and it is decorative, because the sentence says the
  // name itself.
  // Keyed children: `FormattedMessage` renders its `values` inside a list, so an
  // unkeyed fragment is a React warning in development and a reconciliation
  // guess in production.
  const providerNode = disclosure.provider ? (
    <Fragment key="provider">
      <ProviderLogo
        provider={disclosure.provider}
        size={14}
        sx={{ display: "inline-flex", verticalAlign: "-2px", mr: 0.5 }}
      />
      <span>{provider}</span>
    </Fragment>
  ) : (
    provider
  );
  const message =
    disclosure.kind === "live-streaming" ? (
      <FormattedMessage
        defaultMessage="Audio is sent to {provider} as you speak, so text can come back immediately. Audio already sent cannot be recalled."
        values={{ provider: providerNode }}
      />
    ) : (
      // Not "only after you stop": `BatchTranscriptionSession` pretranscribes
      // at natural pauses, so a completed chunk is already on the provider while
      // the user is still talking. Only what has not been cut into a chunk yet
      // is held back, and cancelling does not recall what was sent.
      <FormattedMessage
        defaultMessage="Your recording is sent to {provider} in pieces as you pause, and the rest once you stop. Audio already sent cannot be recalled."
        values={{ provider: providerNode }}
      />
    );

  if (variant === "sentence") {
    return (
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {message}
      </Typography>
    );
  }

  return message;
};
