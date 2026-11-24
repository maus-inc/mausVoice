import type { KeyboardEvent, RefObject } from "react";
import { useEffect, useRef } from "react";
import type { useIntl } from "react-intl";
import { produceAppState } from "../../store";
import { setSnackbar } from "../../utils/app.utils";
import {
  getPrettyKeyName,
  isModifierOnlyCombo,
} from "../../utils/keyboard.utils";

/** Only the recorder that owns focus may release the global shortcut guard. */
let activeRecorder: symbol | null = null;

/** Snackbar the recorder shows when it ends a session without a usable combo. */
export type ComboNotice = "modifier-only" | "compositor";

/**
 * What one tick of the keys-held stream does to the recorder. Every field is
 * optional so a tick can change only what it needs to.
 */
export type ComboResolution = {
  /** New value for the previous-keys ref. */
  previousKeysHeld?: string[];
  /** The recorder has captured at least one real key this session. */
  markInteracted?: boolean;
  /** Keys to publish through onChange, including a restored combo. */
  emit?: string[];
  notice?: ComboNotice;
  /** End the session by blurring the recorder. */
  blur?: boolean;
};

export type ComboUpdateInput = {
  focused: boolean;
  hasInteracted: boolean;
  requireNonModifier: boolean;
  keysHeld: string[];
  previousKeysHeld: string[];
  lastEmitted: string[];
  /** The combo the field held when the session started. */
  valueBeforeRecording: string[] | undefined;
};

export const dedupeKeys = (keys: string[]): string[] => [...new Set(keys)];

/**
 * Turns the global keys-held list into the recorder's next move.
 *
 * A session ends when the user releases a key after the first capture, or
 * presses Escape. On a bridge hotkey strategy a modifier-only release is
 * rejected and the previous combo restored, because a modifier alone cannot
 * trigger dictation. Keys are published when the combo grows or gains a key,
 * which keeps a chord from firing on every tick it is held.
 */
export const resolveComboUpdate = (
  input: ComboUpdateInput,
): ComboResolution => {
  if (!input.focused) return { previousKeysHeld: [] };

  const held = dedupeKeys(input.keysHeld);
  const released =
    input.hasInteracted &&
    input.previousKeysHeld.length > 0 &&
    held.length < input.previousKeysHeld.length;
  if (released) {
    if (
      input.requireNonModifier &&
      isModifierOnlyCombo(input.previousKeysHeld)
    ) {
      return {
        previousKeysHeld: [],
        notice: "modifier-only",
        emit: input.valueBeforeRecording ?? [],
        blur: true,
      };
    }
    return {
      previousKeysHeld: [],
      notice: input.requireNonModifier ? "compositor" : undefined,
      blur: true,
    };
  }

  if (held.length === 0) return { previousKeysHeld: held };

  if (held.length === 1 && held[0] === "Escape") {
    return { previousKeysHeld: held, blur: true };
  }

  const lastSet = new Set(input.lastEmitted);
  const grew = held.length > input.lastEmitted.length;
  const anyNewKey = held.some((key) => !lastSet.has(key));
  if (grew || anyNewKey) {
    return { previousKeysHeld: held, markInteracted: true, emit: held };
  }

  return { previousKeysHeld: held, markInteracted: true };
};

/** `muted` is the placeholder and recording copy; `strong` is a real combo. */
export type RecorderTone = "muted" | "strong";

export type RecorderLabel = { label: string; tone: RecorderTone };

/** The text a recorder shows at rest, mid-session, or after a capture. */
export const describeRecorderLabel = (
  intl: ReturnType<typeof useIntl>,
  value: string[] | undefined,
  focused: boolean,
  hasInteracted: boolean,
): RecorderLabel => {
  if (focused && !hasInteracted) {
    return {
      tone: "muted",
      label: intl.formatMessage({ defaultMessage: "Recording keys..." }),
    };
  }
  const combo = value ?? [];
  return combo.length > 0
    ? { tone: "strong", label: combo.map(getPrettyKeyName).join(" + ") }
    : {
        tone: "muted",
        label: intl.formatMessage({ defaultMessage: "Set hotkey" }),
      };
};

export type RecorderA11yInput = {
  ariaLabel: string | undefined;
  ariaLabelledBy: string | undefined;
  disabled: boolean;
  valueId: string;
};

export type RecorderA11y = {
  role: "textbox" | undefined;
  tabIndex: number;
  describedBy: string | undefined;
  ariaDisabled: true | undefined;
  labelledBy: string | undefined;
};

/**
 * A recorder is a textbox only when it carries a name, and its current value
 * is described through the same element that renders it. An unnamed recorder
 * stays a plain focusable box so it never announces an empty text field.
 */
export const describeRecorderA11y = ({
  ariaLabel,
  ariaLabelledBy,
  disabled,
  valueId,
}: RecorderA11yInput): RecorderA11y => {
  const labelled = Boolean(ariaLabel || ariaLabelledBy);
  return {
    role: labelled ? "textbox" : undefined,
    tabIndex: disabled ? -1 : 0,
    describedBy: labelled ? valueId : undefined,
    ariaDisabled: disabled || undefined,
    labelledBy: ariaLabelledBy,
  };
};

const notifyComboNotice = (
  intl: ReturnType<typeof useIntl>,
  notice: ComboNotice,
): void => {
  const message =
    notice === "modifier-only"
      ? intl.formatMessage({
          defaultMessage:
            "Hotkey must include a non-modifier key (e.g. a letter or number)",
        })
      : intl.formatMessage({
          defaultMessage:
            "You may need to reload your compositor for changes to take effect.",
        });
  produceAppState((draft) => {
    setSnackbar(draft, message, { mode: "error" });
  });
};

export type RecorderHandlers = {
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onFocus: () => void;
  onBlur: () => void;
};

export type RecorderHandlerDeps = {
  boxRef: RefObject<HTMLDivElement | null>;
  recorderId: RefObject<symbol>;
  value: string[] | undefined;
  disabled: boolean;
  valueBeforeRecordingRef: RefObject<string[] | undefined>;
  setFocused: (focused: boolean) => void;
  setHasInteracted: (value: boolean) => void;
};

/**
 * Pointer, keyboard and focus handlers for a recorder field. Focus claims the
 * global shortcut guard, and blur or Escape releases it so dictation works
 * again while the field is not being edited.
 */
export const createRecorderHandlers = (
  deps: RecorderHandlerDeps,
): RecorderHandlers => ({
  onClick: () => {
    if (!deps.disabled) deps.boxRef.current?.focus();
  },
  onKeyDown: (event) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    deps.boxRef.current?.blur();
  },
  onFocus: () => {
    if (deps.disabled) return;
    activeRecorder = deps.recorderId.current;
    produceAppState((draft) => {
      draft.isRecordingHotkey = true;
    });
    deps.valueBeforeRecordingRef.current = deps.value;
    deps.setFocused(true);
  },
  onBlur: () => {
    if (activeRecorder === deps.recorderId.current) {
      activeRecorder = null;
      produceAppState((draft) => {
        draft.isRecordingHotkey = false;
      });
    }
    deps.setFocused(false);
    deps.setHasInteracted(false);
  },
});

/** Releases the shortcut guard if this recorder still owns it on unmount. */
export const useRecorderOwnership = (recorderId: RefObject<symbol>): void => {
  useEffect(() => {
    const owner = recorderId.current;
    return () => {
      if (activeRecorder !== owner) return;
      activeRecorder = null;
      produceAppState((draft) => {
        draft.isRecordingHotkey = false;
      });
    };
  }, [recorderId]);
};

/** A disabled field cannot keep focus, so it drops out of the session. */
export const useBlurWhenDisabled = (
  disabled: boolean,
  boxRef: RefObject<HTMLDivElement | null>,
): void => {
  useEffect(() => {
    if (disabled) boxRef.current?.blur();
  }, [disabled, boxRef]);
};

export type RecordedComboInput = {
  value: string[] | undefined;
  focused: boolean;
  hasInteracted: boolean;
  setHasInteracted: (value: boolean) => void;
  requireNonModifier: boolean;
  keysHeld: string[];
  onChange?: (value: string[]) => void;
  valueBeforeRecordingRef: RefObject<string[] | undefined>;
  boxRef: RefObject<HTMLDivElement | null>;
  intl: ReturnType<typeof useIntl>;
};

/** Keeps the recorded combo in step with the global keys-held stream. */
export const useRecordedCombo = ({
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
}: RecordedComboInput): void => {
  const lastEmittedRef = useRef<string[]>(value ?? []);
  const previousKeysHeldRef = useRef<string[]>([]);

  useEffect(() => {
    lastEmittedRef.current = value ?? [];
  }, [value]);

  useEffect(() => {
    if (!hasInteracted) {
      lastEmittedRef.current = [];
    }

    const resolution = resolveComboUpdate({
      focused,
      hasInteracted,
      requireNonModifier,
      keysHeld,
      previousKeysHeld: previousKeysHeldRef.current,
      lastEmitted: lastEmittedRef.current,
      valueBeforeRecording: valueBeforeRecordingRef.current,
    });

    if (resolution.previousKeysHeld !== undefined) {
      previousKeysHeldRef.current = resolution.previousKeysHeld;
    }
    if (resolution.markInteracted) setHasInteracted(true);
    if (resolution.emit) {
      lastEmittedRef.current = resolution.emit;
      onChange?.(resolution.emit);
    }
    if (resolution.notice) {
      notifyComboNotice(intl, resolution.notice);
    }
    if (resolution.blur) {
      boxRef.current?.blur();
    }
  }, [
    keysHeld,
    focused,
    onChange,
    hasInteracted,
    requireNonModifier,
    intl,
    setHasInteracted,
    valueBeforeRecordingRef,
    boxRef,
  ]);
};
