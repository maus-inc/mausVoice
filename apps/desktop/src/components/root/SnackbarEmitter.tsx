import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useAppStore } from "../../store";
import { SonnerToaster } from "./SonnerToaster";

/**
 * Route each snackbarCounter increment to sonner. Depend only on the counter
 * so message/mode/action identity changes cannot double-fire (StrictMode +
 * function-valued actions). lastEmittedCounterRef skips the StrictMode remount
 * replay of the same counter.
 */
export const SnackbarEmitter = () => {
  const snackbarCounter = useAppStore((state) => state.snackbarCounter);
  const lastEmittedCounterRef = useRef(0);

  useEffect(() => {
    if (snackbarCounter <= 0) {
      return;
    }
    if (lastEmittedCounterRef.current === snackbarCounter) {
      return;
    }
    lastEmittedCounterRef.current = snackbarCounter;

    const { snackbarMessage, snackbarDuration, snackbarMode, snackbarAction } =
      useAppStore.getState();

    if (!snackbarMessage) {
      return;
    }

    const opts = {
      duration: snackbarDuration,
      action: snackbarAction
        ? {
            label: snackbarAction.label,
            onClick: snackbarAction.onClick,
          }
        : undefined,
    };

    if (snackbarMode === "error") {
      toast.error(snackbarMessage, opts);
    } else if (snackbarMode === "success") {
      toast.success(snackbarMessage, opts);
    } else {
      toast(snackbarMessage, opts);
    }
  }, [snackbarCounter]);

  return <SonnerToaster />;
};
