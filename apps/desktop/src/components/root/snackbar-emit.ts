import { toast } from "sonner";
import type { SnackbarMode } from "../../state/app.state";

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
  snackbarAction?: { label: string; onClick: () => void };
};

export const emitSnackbarIfNew = (payload: SnackbarEmitPayload): boolean => {
  const { snackbarCounter, snackbarMessage } = payload;
  if (snackbarCounter <= 0) {
    return false;
  }
  if (lastEmittedSnackbarCounter === snackbarCounter) {
    return false;
  }
  lastEmittedSnackbarCounter = snackbarCounter;

  if (!snackbarMessage) {
    return false;
  }

  const opts = {
    duration: payload.snackbarDuration,
    action: payload.snackbarAction
      ? {
          label: payload.snackbarAction.label,
          onClick: payload.snackbarAction.onClick,
        }
      : undefined,
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
