import {
  Alert,
  FormControlLabel,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { FormattedMessage } from "react-intl";

import { Reveal } from "../common/Reveal";
import { HeldStateLine } from "./held-state-line";
import { PrerollCaption } from "./preroll-caption";
import { ElasticSlider } from "../common/ElasticSlider";
import {
  MAX_MICROPHONE_PREROLL_SECONDS,
  describeHeldState,
} from "../../utils/microphone-readiness.utils";

/**
 * Keep-ready, its cost warnings, and the pre-roll slider.
 *
 * The pre-roll lives here rather than in the linger section because it is what
 * the *next press* keeps, which matters most when nothing is held -- the case
 * that has no other control. It is offered whatever the switch says for that
 * reason.
 */
export const KeepReadySection = ({
  keepReady,
  heldState,
  bluetoothWarning,
  prerollSeconds,
  prerollOn,
  prerollLabel,
  onKeepReadyChange,
  onPrerollCommit,
}: {
  readonly keepReady: boolean;
  readonly heldState: ReturnType<typeof describeHeldState>;
  readonly bluetoothWarning: boolean;
  readonly prerollSeconds: number;
  readonly prerollOn: boolean;
  readonly prerollLabel: string;
  readonly onKeepReadyChange: (checked: boolean) => void;
  readonly onPrerollCommit: (seconds: number) => void;
}) => (
  <Stack spacing={1.5}>
    <FormControlLabel
      control={
        <Switch
          checked={keepReady}
          onChange={(event) => onKeepReadyChange(event.target.checked)}
        />
      }
      label={<FormattedMessage defaultMessage="Keep the microphone ready" />}
    />
    <Typography variant="body2" color="text.secondary">
      <FormattedMessage defaultMessage="Start dictating instantly by opening the microphone ahead of time. Your system shows its microphone-in-use indicator the whole time this is on." />
    </Typography>
    <Reveal show={keepReady}>
      <HeldStateLine state={heldState} />
    </Reveal>
    {/*
      The switch's own copy promises the microphone indicator. On a Bluetooth
      headset the real cost is larger and invisible: the link drops to the
      hands-free profile, so playback becomes call quality and the headset's
      battery drains for as long as the hold lasts. Said here, under the switch,
      rather than in a toast, because it is a standing property of the setting
      and not an event. `Reveal` rather than a conditional so the appearance is
      a fade instead of a layout jump under the cursor.
    */}
    <Reveal show={bluetoothWarning}>
      <Alert
        severity="warning"
        icon={false}
        sx={{ alignItems: "center", py: 0.5 }}
      >
        <Typography variant="body2">
          <FormattedMessage defaultMessage="This is a Bluetooth microphone. While it is held, your headset switches to its call profile, so audio you play will sound like a phone call and its battery will drain faster." />
        </Typography>
      </Alert>
    </Reveal>
    <Stack spacing={0.5}>
      <Typography variant="body2">
        <FormattedMessage defaultMessage="Audio kept before the press" />
      </Typography>
      <ElasticSlider
        value={prerollSeconds}
        min={0}
        max={MAX_MICROPHONE_PREROLL_SECONDS}
        step={0.1}
        valueLabelDisplay="auto"
        valueLabelFormat={(value) => `${value.toFixed(1)} s`}
        ariaLabel={prerollLabel}
        onCommit={onPrerollCommit}
      />
      <PrerollCaption on={prerollOn} />
    </Stack>
  </Stack>
);
