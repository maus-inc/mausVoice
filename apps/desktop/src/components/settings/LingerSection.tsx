import { FormControlLabel, Stack, Switch, Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";

import { Reveal } from "../common/Reveal";
import { SegmentedControl } from "../common/SegmentedControl";
import { LingerCaption } from "./linger-caption";
import {
  lingerChoices,
  nearestLingerChoice,
} from "../../utils/microphone-readiness.utils";

/**
 * The post-dictation window: its switch, and the duration control.
 *
 * The subtlety this owns is that the switch's *position* and its *stored
 * preference* are different things. Keep-ready holds the device forever, so the
 * linger window is on whatever its own preference says; showing the stored value
 * left a disabled switch reading "off" directly above a caption saying it was
 * already on. The duration control is hidden in that state rather than disabled,
 * because offering a choice the app is not listening to is worse than not
 * offering it.
 */
export const LingerSection = ({
  keepReady,
  lingerOn,
  lingerMs,
  lingerLabel,
  secondsFormat,
  onLingerChange,
  onDurationChange,
}: {
  readonly keepReady: boolean;
  readonly lingerOn: boolean;
  readonly lingerMs: number;
  readonly lingerLabel: string;
  readonly secondsFormat: (choice: number) => string;
  readonly onLingerChange: (checked: boolean) => void;
  readonly onDurationChange: (milliseconds: number) => void;
}) => (
  <Stack spacing={1.5}>
    <FormControlLabel
      control={
        <Switch
          // The effective state, not the stored one: see the module comment.
          checked={keepReady || lingerOn}
          // `aria-disabled`, not `disabled`. A disabled control leaves the tab
          // order entirely, and the one thing a keyboard user needs here is to
          // reach this switch and hear the caption below that says why it is on.
          // The handler below is what makes it inert.
          //
          // On the inner `input`, not the wrapper: a bare `aria-disabled` on the
          // component lands on the `<span>` wrapper, which is not the node a
          // screen reader reaches when the switch is focused, so the state would
          // be announced for nobody. `slotProps.input` is the MUI v7 spelling;
          // the deprecated `inputProps` is silently dropped in v9 (it renders a
          // literal `inputprops="[object Object]"` attribute on the wrapper),
          // which is how the first attempt failed without an error.
          //
          // Both slots, and the second is not redundant. `input` is the node a
          // screen reader reaches; `switchBase` is the span the theme can style
          // and the only one an adjacent-sibling rule can dim the track from. A
          // CSS child selector cannot reach up from the input to its wrapper, so
          // a style keyed on the input alone silently did nothing.
          slotProps={{
            input: { "aria-disabled": keepReady || undefined },
            switchBase: { "aria-disabled": keepReady || undefined },
          }}
          onChange={(event) => {
            // The switch is inert while keep-ready owns the device. Guarding in
            // the handler rather than relying on `aria-disabled` is the other
            // half of the pair: `aria-disabled` describes, this enforces.
            if (keepReady) {
              return;
            }
            onLingerChange(event.target.checked);
          }}
        />
      }
      label={<FormattedMessage defaultMessage="Stay ready after a dictation" />}
    />
    <LingerCaption keepReady={keepReady} />
    {/* Only while the switch is the one in charge. */}
    <Reveal show={!keepReady && lingerOn}>
      <Stack spacing={0.5}>
        <Typography variant="caption" color="text.secondary">
          <FormattedMessage defaultMessage="How long to stay open after each dictation" />
        </Typography>
        <SegmentedControl
          value={String(nearestLingerChoice(lingerMs))}
          options={lingerChoices().map((choice) => ({
            value: String(choice),
            label: secondsFormat(choice),
          }))}
          onChange={(next) => onDurationChange(Number(next))}
          ariaLabel={lingerLabel}
        />
      </Stack>
    </Reveal>
  </Stack>
);
