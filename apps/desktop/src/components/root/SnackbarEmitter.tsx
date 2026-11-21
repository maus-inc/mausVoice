import { useEffect } from "react";
import { useAppStore } from "../../store";
import { emitSnackbarIfNew } from "./snackbar-emit";
import { SonnerToaster } from "./SonnerToaster";

/**
 * Route each queued snackbar to sonner, in the order it was raised.
 *
 * Depend only on the counter, so a re-render does not re-run the effect; dedup
 * lives in module scope so a StrictMode remount cannot replay a counter.
 *
 * Every request above the last emitted one is drained, not just the newest.
 * Two messages raised in the same tick leave two entries in the queue and one
 * counter increase, so reading only the newest silently dropped the other --
 * and reading them one at a time would have been no better, because React
 * batches the two state updates into a single effect run.
 */
export const SnackbarEmitter = () => {
  const snackbarCounter = useAppStore((state) => state.snackbarCounter);

  useEffect(() => {
    const { snackbarRequests } = useAppStore.getState();
    for (const request of snackbarRequests) {
      emitSnackbarIfNew({
        snackbarCounter: request.counter,
        snackbarMessage: request.message,
        snackbarDuration: request.duration,
        snackbarMode: request.mode,
        snackbarAction: request.action,
      });
    }
  }, [snackbarCounter]);

  return <SonnerToaster />;
};
