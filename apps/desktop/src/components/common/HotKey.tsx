import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { hotkeyRecorderStyles } from "./hotkey-recorder.styles";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { produceAppState, useAppStore } from "../../store";
import { setSnackbar } from "../../utils/app.utils";
import {
  getPrettyKeyName,
  isModifierOnlyCombo,
} from "../../utils/keyboard.utils";

// Only the recorder that owns focus may release the global shortcut guard.
let activeRecorder: symbol | null = null;

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

  const lastEmittedRef = useRef<string[]>(value);
  const valueBeforeRecordingRef = useRef<string[] | undefined>(value);
  useEffect(() => {
    lastEmittedRef.current = value;
  }, [value]);

  useEffect(() => {
    const owner = recorderId.current;
    return () => {
      if (activeRecorder !== owner) return;
      activeRecorder = null;
      produceAppState((draft) => {
        draft.isRecordingHotkey = false;
      });
    };
  }, []);

  useEffect(() => {
    if (disabled) boxRef.current?.blur();
  }, [disabled]);

  const previousKeysHeldRef = useRef<string[]>([]);

  useEffect(() => {
    if (!focused) {
      previousKeysHeldRef.current = [];
      return;
    }

    if (!hasInteracted) {
      lastEmittedRef.current = [];
    }

    const seen = new Set<string>();
    const held = keysHeld.filter((k: string) => {
      if (seen.has(k)) {
        return false;
      }
      seen.add(k);
      return true;
    });

    const last = lastEmittedRef.current ?? [];

    const previousHeld = previousKeysHeldRef.current;
    if (
      hasInteracted &&
      previousHeld.length > 0 &&
      held.length < previousHeld.length
    ) {
      if (requireNonModifier && isModifierOnlyCombo(previousHeld)) {
        produceAppState((draft) => {
          setSnackbar(
            draft,
            intl.formatMessage({
              defaultMessage:
                "Hotkey must include a non-modifier key (e.g. a letter or number)",
            }),
            { mode: "error" },
          );
        });
        onChange?.(valueBeforeRecordingRef.current ?? []);
        lastEmittedRef.current = valueBeforeRecordingRef.current;
      } else if (requireNonModifier) {
        produceAppState((draft) => {
          setSnackbar(
            draft,
            intl.formatMessage({
              defaultMessage:
                "You may need to reload your compositor for changes to take effect.",
            }),
          );
        });
      }
      boxRef.current?.blur();
      previousKeysHeldRef.current = [];
      return;
    }

    previousKeysHeldRef.current = held;

    if (held.length === 0) {
      return;
    }

    if (held.length === 1 && held[0] === "Escape") {
      boxRef.current?.blur();
      return;
    }

    setHasInteracted(true);

    const lastSet = new Set(last);
    const anyNewKey = held.some((k) => !lastSet.has(k));
    if (held.length > last.length || anyNewKey) {
      lastEmittedRef.current = held;
      onChange?.(held);
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
      tabIndex={disabled ? -1 : 0}
      role={ariaLabel || ariaLabelledBy ? "textbox" : undefined}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaLabel || ariaLabelledBy ? valueId : undefined}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) boxRef.current?.focus();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        boxRef.current?.blur();
      }}
      onFocus={() => {
        if (disabled) return;
        activeRecorder = recorderId.current;
        produceAppState((draft) => {
          draft.isRecordingHotkey = true;
        });
        valueBeforeRecordingRef.current = value;
        setFocused(true);
      }}
      onBlur={() => {
        if (activeRecorder === recorderId.current) {
          activeRecorder = null;
          produceAppState((draft) => {
            draft.isRecordingHotkey = false;
          });
        }
        setFocused(false);
        setHasInteracted(false);
      }}
      sx={hotkeyRecorderStyles(focused, 200, disabled)}
    >
      <Typography
        id={ariaLabel || ariaLabelledBy ? valueId : undefined}
        variant="body2"
        color={empty ? "text.secondary" : "text.primary"}
      >
        {label}
      </Typography>
    </Box>
  );
};
