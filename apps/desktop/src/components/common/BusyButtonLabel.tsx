import { CircularProgress, Stack } from "@mui/material";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";

export type BusyButtonLabelProps = {
  /**
   * Names the progress indicator for assistive technology. A string because it
   * lands in `aria-label`; a `FormattedMessage` would render a node there.
   */
  label?: string;
  children: ReactNode;
};

/**
 * A confirm button's own label, with a spinner beside it while the action runs.
 *
 * The label stays in the DOM rather than being replaced by a bare spinner.
 * Swapping it out left the button with no accessible name during the one action
 * that destroys something, so a screen reader announced an unlabelled disabled
 * control with no indication that anything was in progress; `aria-busy` on the
 * button and a name on this progressbar carry the in-flight state instead.
 *
 * Three surfaces had grown their own copy of this markup — the shared
 * `ConfirmDialog` and both destructive settings dialogs — so the treatment
 * lives here and a change to it lands in all of them.
 */
export const BusyButtonLabel = ({ label, children }: BusyButtonLabelProps) => {
  const intl = useIntl();

  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{ alignItems: "center", justifyContent: "center" }}
    >
      <CircularProgress
        size={16}
        color="inherit"
        role="progressbar"
        aria-label={label ?? intl.formatMessage({ defaultMessage: "Working" })}
      />
      <span>{children}</span>
    </Stack>
  );
};
