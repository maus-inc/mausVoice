import { useEffect } from "react";
import { useAppStore } from "../../store";
import { emitSnackbarIfNew } from "./snackbar-emit";
import { SonnerToaster } from "./SonnerToaster";

/**
 * Route each snackbarCounter increment to sonner. Depend only on the counter.
 * Dedup lives in module scope so StrictMode remount cannot replay the same
 * counter.
 */
export const SnackbarEmitter = () => {
  const snackbarCounter = useAppStore((state) => state.snackbarCounter);

  useEffect(() => {
    const {
      snackbarMessage,
      snackbarDuration,
      snackbarMode,
      snackbarAction,
    } = useAppStore.getState();
    emitSnackbarIfNew({
      snackbarCounter,
      snackbarMessage,
      snackbarDuration,
      snackbarMode,
      snackbarAction,
    });
  }, [snackbarCounter]);

  return <SonnerToaster />;
};
