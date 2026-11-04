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
  if (lastEmittedSnackbarCounter === snackbarCounter) {
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
