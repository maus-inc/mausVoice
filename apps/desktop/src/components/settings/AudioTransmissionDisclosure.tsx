import { Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";
import { useAppStore } from "../../store";
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
  const message =
    disclosure.kind === "live-streaming" ? (
      <FormattedMessage
        defaultMessage="Audio is sent to {provider} as you speak, so text can come back immediately. Audio already sent cannot be recalled."
        values={{ provider }}
      />
    ) : (
      <FormattedMessage
        defaultMessage="Your recording is uploaded to {provider} only after you stop, so cancelling before you stop sends nothing."
        values={{ provider }}
      />
    );

  if (variant === "sentence") {
    return (
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {message}
      </Typography>
    );
  }

  return <>{message}</>;
};
