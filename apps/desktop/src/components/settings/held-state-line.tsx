import { Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";
import type { describeHeldState } from "../../utils/microphone-readiness.utils";

/**
 * What the backend says the device is doing, in words.
 *
 * `null` is not "not held": it means the first read has not come back yet, and
 * saying "not holding" during that window would be a claim the dialog cannot
 * make. Hence a third message rather than a two-way branch.
 *
 * Each carries its own `defaultMessage` at its own call so the i18n extractor
 * still sees three distinct messages; a lookup table would collapse them into
 * keys it cannot read and they would drop out of every catalogue.
 */
export const HeldStateLine = ({
  state,
}: {
  readonly state: ReturnType<typeof describeHeldState>;
}) => {
  if (state === "held") {
    return (
      <Typography variant="body2" color="text.secondary">
        <FormattedMessage defaultMessage="Held open now." />
      </Typography>
    );
  }
  if (state === "not_held") {
    return (
      <Typography variant="body2" color="text.secondary">
        <FormattedMessage defaultMessage="Not holding the microphone yet, so a press still has to open it. The setting applies as soon as the device opens." />
      </Typography>
    );
  }
  return (
    <Typography variant="body2" color="text.secondary">
      <FormattedMessage defaultMessage="Checking the microphone..." />
    </Typography>
  );
};
