import { Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";

/**
 * Why the linger switch reads the way it does.
 *
 * When keep-ready is on the switch is on and aria-disabled, so the caption has
 * to say why rather than describe a window the hold has already superseded.
 */
export const LingerCaption = ({
  keepReady,
}: {
  readonly keepReady: boolean;
}) => (
  <Typography variant="body2" color="text.secondary">
    {keepReady ? (
      <FormattedMessage defaultMessage="Already on, because the microphone is kept ready." />
    ) : (
      <FormattedMessage defaultMessage="Keeps the microphone open for a few seconds after each recording, so a second dictation starts instantly. Your system shows its microphone-in-use indicator for that time." />
    )}
  </Typography>
);
