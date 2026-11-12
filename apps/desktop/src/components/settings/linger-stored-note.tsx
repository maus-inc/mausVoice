import { Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";

/**
 * Says so when the segmented control cannot show the stored window exactly.
 *
 * The control offers three windows and the preference can hold any duration --
 * from an older build, a hand-edited profile, or a future release's choices. The
 * control shows the nearest one, which is fine as a starting point but wrong as
 * a report: a stored 30 s window displayed as "15 s" told the user their
 * microphone closed twice as fast as it did. Rather than writing the nearest
 * value back on read (opening a settings dialog must not change a preference),
 * the true value is shown next to the control, in the same units, so the
 * approximation is visible before anything is picked.
 *
 * Nothing renders for an exact match, and nothing renders for an unusable value
 * -- there the control's own default is the honest answer.
 */
export const LingerStoredNote = ({
  stored,
  format,
}: {
  readonly stored: number | null;
  readonly format: (milliseconds: number) => string;
}) => {
  if (stored === null) {
    return null;
  }
  return (
    <Typography variant="caption" color="text.secondary">
      <FormattedMessage
        defaultMessage="Currently set to {duration}, which is not one of these; the closest is selected. Choosing one replaces it."
        values={{ duration: format(stored) }}
      />
    </Typography>
  );
};
