import { useEffect } from "react";
import { toast } from "sonner";
import { useAppStore } from "../../store";
import { SonnerToaster } from "./SonnerToaster";

/**
 * Keeps the zustand `showSnackbar()` API and routes each increment to sonner.
 */
export const SnackbarEmitter = () => {
  const snackbarCounter = useAppStore((state) => state.snackbarCounter);
  const snackbarMessage = useAppStore((state) => state.snackbarMessage);
  const snackbarDuration = useAppStore((state) => state.snackbarDuration);
  const snackbarMode = useAppStore((state) => state.snackbarMode);
  const snackbarAction = useAppStore((state) => state.snackbarAction);

  useEffect(() => {
    if (snackbarCounter <= 0 || !snackbarMessage) {
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
  }, [
    snackbarCounter,
    snackbarMessage,
    snackbarDuration,
    snackbarMode,
    snackbarAction,
  ]);

  return <SonnerToaster />;
};
