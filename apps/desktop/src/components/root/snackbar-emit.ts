import { toast } from "sonner";
import { createElement } from "react";
import type { SnackbarAction, SnackbarMode } from "../../state/app.state";
import { TimedSnackbarAction } from "./TimedSnackbarAction";

/** Survives StrictMode remount; instance refs reset to 0 and would re-fire. */
let lastEmittedSnackbarCounter = 0;

export const resetSnackbarEmitForTests = (): void => {
  lastEmittedSnackbarCounter = 0;
};

export type SnackbarEmitPayload = {
  snackbarCounter: number;
  snackbarMessage?: string;
  snackbarDuration?: number;
  snackbarMode?: SnackbarMode;
  snackbarAction?: SnackbarAction;
};

export const emitSnackbarIfNew = (payload: SnackbarEmitPayload): boolean => {
  const { snackbarCounter, snackbarMessage } = payload;
  if (snackbarCounter <= 0) {
    return false;
  }
  // `<=`, not `===`. The caller walks the entire queue on every counter
  // change, so it asks about counters that have already been shown: the queue
  // still holds 1 and 2 when 3 arrives. Equality only rejected the one that
  // matched exactly, so every older entry looked new and was toasted again --
  // a dismissed message came back on the next snackbar, and a burst of N
  // messages produced roughly N² of them.
  //
  // The name is a high-water mark, and this is what makes it one. A counter
  // below it has been shown; at or below it must not be shown again.
  if (snackbarCounter <= lastEmittedSnackbarCounter) {
    return false;
  }

  if (!snackbarMessage) {
    return false;
  }

  lastEmittedSnackbarCounter = snackbarCounter;

  const action = payload.snackbarAction;
  const toastId = `snackbar-${snackbarCounter}`;
  let actionElement: HTMLButtonElement | null = null;
  let focusReturned = false;
  const returnFocus = (undone: boolean) => {
    if (focusReturned) return;
    focusReturned = true;
    action?.onFocusReturn?.(undone);
  };
  let actionContent:
    | ReturnType<typeof createElement>
    | { label: string; onClick: () => void }
    | undefined;
  if (action?.expiresAt) {
    actionContent = createElement(TimedSnackbarAction, {
      action: { ...action, onFocusReturn: returnFocus },
      toastId,
      onMount: (element: HTMLButtonElement | null) => {
        actionElement = element;
      },
    });
  } else if (action) {
    actionContent = { label: action.label, onClick: action.onClick };
  }
  const opts = {
    id: toastId,
    duration: payload.snackbarDuration,
    onDismiss: () => {
      const toastElement = actionElement?.closest("[data-sonner-toast]");
      if (toastElement?.contains(document.activeElement)) returnFocus(false);
    },
    action: actionContent,
  };

  if (payload.snackbarMode === "error") {
    toast.error(snackbarMessage, opts);
  } else if (payload.snackbarMode === "success") {
    toast.success(snackbarMessage, opts);
  } else {
    toast(snackbarMessage, opts);
  }
  return true;
};
