import { useHotkeyCapture } from "../../hooks/hotkey-capture.hooks";
import { advanceHotkeyCapture } from "../../utils/hotkey-capture.utils";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { hotkeyRecorderStyles } from "./hotkey-recorder.styles";
import { useEffect, useMemo, useRef, useState } from "react";
import { useIntl, type IntlShape } from "react-intl";
import { produceAppState, useAppStore } from "../../store";
import { setSnackbar } from "../../utils/app.utils";
import {
  getPrettyKeyName,
  isModifierOnlyCombo,
} from "../../utils/keyboard.utils";

const reportBridgeShortcut = (
  released: string[],
  requireNonModifier: boolean,
  intl: IntlShape,
): boolean => {
  if (!requireNonModifier) return false;
  const invalid = isModifierOnlyCombo(released);
  const message = invalid
    ? intl.formatMessage({
        defaultMessage:
          "Hotkey must include a non-modifier key (e.g. a letter or number)",
      })
    : intl.formatMessage({
        defaultMessage:
          "You may need to reload your compositor for changes to take effect.",
      });
  produceAppState((draft) => {
    setSnackbar(draft, message, invalid ? { mode: "error" } : undefined);
  });
  return invalid;
};

export const HotKey = ({
  value,
  onChange,
}: {
  value?: string[];
  onChange?: (value: string[]) => void;
}) => {
  const intl = useIntl();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const keysHeld = useAppStore((s) => s.keysHeld);
  const hotkeyStrategy = useAppStore((s) => s.hotkeyStrategy);
  const requireNonModifier = hotkeyStrategy === "bridge";

  const lastEmittedRef = useRef<string[]>(value);
  const valueBeforeRecordingRef = useRef<string[] | undefined>(value);
  useEffect(() => {
    lastEmittedRef.current = value;
  }, [value]);

  useHotkeyCapture(focused);

  const previousKeysHeldRef = useRef<string[]>([]);

  useEffect(() => {
    const update = advanceHotkeyCapture({
      focused,
      interacted: hasInteracted,
      keysHeld,
      previousHeld: previousKeysHeldRef.current,
      lastEmitted: lastEmittedRef.current,
    });
    previousKeysHeldRef.current = update.previousHeld;
    lastEmittedRef.current = update.lastEmitted;

    if (update.action === "release") {
      if (reportBridgeShortcut(update.released, requireNonModifier, intl)) {
        onChange?.(valueBeforeRecordingRef.current ?? []);
        lastEmittedRef.current = valueBeforeRecordingRef.current;
      }
      boxRef.current?.blur();
    } else if (update.action === "cancel") {
      boxRef.current?.blur();
    } else if (update.action === "record") {
      setHasInteracted(true);
      if (update.emitted) onChange?.(update.emitted);
    }
  }, [keysHeld, focused, onChange, hasInteracted, requireNonModifier, intl]);

  const [empty, label] = useMemo(() => {
    if (focused && !hasInteracted) {
      return [
        true,
        intl.formatMessage({ defaultMessage: "Recording keys..." }),
      ];
    }
    const v = value ?? [];
    return v.length > 0
      ? [false, v.map((k) => getPrettyKeyName(k)).join(" + ")]
      : [true, intl.formatMessage({ defaultMessage: "Set hotkey" })];
  }, [value, focused, hasInteracted, intl]);

  return (
    <Box
      ref={boxRef}
      tabIndex={0}
      onClick={() => boxRef.current?.focus()}
      onFocus={() => {
        valueBeforeRecordingRef.current = value;
        setFocused(true);
      }}
      onBlur={() => {
        setFocused(false);
        setHasInteracted(false);
      }}
      sx={hotkeyRecorderStyles(focused)}
    >
      <Typography
        variant="body2"
        color={empty ? "text.secondary" : "text.primary"}
      >
        {label}
      </Typography>
    </Box>
  );
};
