import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useMemo, useRef, useState } from "react";
import { useId } from "react";
import { useIntl } from "react-intl";
import { useAppStore } from "../../store";
import { hotkeyRecorderStyles } from "./hotkey-recorder.styles";
import {
  createRecorderHandlers,
  describeRecorderA11y,
  describeRecorderLabel,
  useBlurWhenDisabled,
  useRecordedCombo,
  useRecorderOwnership,
} from "./hotkey-recorder.utils";

/** Muted is the placeholder and recording copy; strong is a real combo. */
const TONE_COLOR = {
  muted: "text.secondary",
  strong: "text.primary",
} as const;

type HotKeyProps = {
  value?: string[];
  onChange?: (value: string[]) => void;
  disabled?: boolean;
  ariaLabel?: string;
  ariaLabelledBy?: string;
};

export const HotKey = ({
  value,
  onChange,
  disabled = false,
  ariaLabel,
  ariaLabelledBy,
}: HotKeyProps) => {
  const intl = useIntl();
  const valueId = useId();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const recorderId = useRef(Symbol("hotkey recorder"));
  const [focused, setFocused] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const keysHeld = useAppStore((s) => s.keysHeld);
  const hotkeyStrategy = useAppStore((s) => s.hotkeyStrategy);
  const requireNonModifier = hotkeyStrategy === "bridge";
  const valueBeforeRecordingRef = useRef<string[] | undefined>(value);

  useRecorderOwnership(recorderId);
  useBlurWhenDisabled(disabled, boxRef);
  useRecordedCombo({
    value,
    focused,
    hasInteracted,
    setHasInteracted,
    requireNonModifier,
    keysHeld,
    onChange,
    valueBeforeRecordingRef,
    boxRef,
    intl,
  });

  const { label, tone } = useMemo(
    () => describeRecorderLabel(intl, value, focused, hasInteracted),
    [intl, value, focused, hasInteracted],
  );
  const a11y = describeRecorderA11y({
    ariaLabel,
    ariaLabelledBy,
    disabled,
    valueId,
  });
  const handlers = createRecorderHandlers({
    boxRef,
    recorderId,
    value,
    disabled,
    valueBeforeRecordingRef,
    setFocused,
    setHasInteracted,
  });

  return (
    <Box
      ref={boxRef}
      tabIndex={a11y.tabIndex}
      role={a11y.role}
      aria-label={ariaLabel}
      aria-labelledby={a11y.labelledBy}
      aria-describedby={a11y.describedBy}
      aria-disabled={a11y.ariaDisabled}
      {...handlers}
      sx={hotkeyRecorderStyles(focused, 200, disabled)}
    >
      <Typography
        id={a11y.describedBy}
        variant="body2"
        color={TONE_COLOR[tone]}
      >
        {label}
      </Typography>
    </Box>
  );
};
