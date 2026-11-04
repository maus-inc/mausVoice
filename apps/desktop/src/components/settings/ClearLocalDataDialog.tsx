import { invoke } from "@tauri-apps/api/core";
import {
  Alert,
  AlertTitle,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import { produceAppState, useAppStore } from "../../store";
import { resetAutoLearnSessionState } from "../../actions/edit-watch.actions";
import {
  clearAppLocalStorage,
  removeLocalDataClearPendingMarker,
} from "../../utils/local-data-storage.utils";
import {
  beginLocalDataClear,
  hasPendingLocalDataClear,
} from "../../utils/local-data-write-gate";
import { getLogger } from "../../utils/log.utils";
import { disableAnalyticsPersistenceForLocalDataClear } from "../../utils/analytics-persistence.utils";
import { resetPendingTranscriptionDeletes } from "../../utils/pending-transcription-delete";

const CONFIRMATION_PHRASE = "clear";

export const ClearLocalDataDialog = () => {
  const open = useAppStore((state) => state.settings.clearLocalDataDialogOpen);
  const [confirmationValue, setConfirmationValue] = useState("");
  const [isClearing, setIsClearing] = useState(false);
  const [clearStarted, setClearStarted] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const clearStartedRef = useRef(false);
  const releaseClearRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!hasPendingLocalDataClear()) return;

    clearStartedRef.current = true;
    setClearStarted(true);
    setRecoveryRequired(true);
    produceAppState((draft) => {
      draft.settings.clearLocalDataDialogOpen = true;
    });
  }, []);

  const handleClose = () => {
    if (clearStartedRef.current) return;
    produceAppState((draft) => {
      draft.settings.clearLocalDataDialogOpen = false;
    });
    setConfirmationValue("");
    setIsClearing(false);
    setErrorMessage(null);
  };

  const confirmationMatches =
    confirmationValue.trim().toLowerCase() === CONFIRMATION_PHRASE;

  const handleClear = async () => {
    if (!confirmationMatches || isClearing) {
      return;
    }

    setIsClearing(true);
    setRecoveryRequired(false);
    setErrorMessage(null);
    try {
      if (!releaseClearRef.current) {
        releaseClearRef.current = await beginLocalDataClear();
        disableAnalyticsPersistenceForLocalDataClear();
        clearStartedRef.current = true;
        setClearStarted(true);
      }

      // Tear down long-running native subsystems before wiping the DB. Native
      // clear also stops remote pairing and drains its in-flight writes.
      // Best-effort: these commands fail when nothing is active.
      try {
        await invoke("stop_key_listener");
      } catch {
        /* no listener active */
      }
      try {
        await invoke("stop_recording");
      } catch {
        /* no active recording */
      }

      await invoke("clear_local_data");
      resetPendingTranscriptionDeletes();
      resetAutoLearnSessionState();
      clearAppLocalStorage();
      await invoke("complete_local_data_clear");
      removeLocalDataClearPendingMarker();
      // Keep the browser-side gate closed until this reload resets the stores.
      window.location.reload();
    } catch (error) {
      getLogger().error("Failed to clear local data", error);
      const message =
        error instanceof Error ? error.message : "Failed to clear local data.";
      setErrorMessage(message);
      setIsClearing(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={isClearing || clearStarted ? undefined : handleClose}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>
        <FormattedMessage defaultMessage="Clear local data" />
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Alert severity="warning" variant="outlined">
            <AlertTitle>
              <FormattedMessage defaultMessage="This action permanently removes local data" />
            </AlertTitle>
            <Typography variant="body2">
              <FormattedMessage defaultMessage="This will delete all preferences, dictionary entries, and saved transcriptions from this device. The action cannot be undone." />
            </Typography>
          </Alert>
          <Typography variant="body2">
            <FormattedMessage
              defaultMessage="To confirm, type {phrase} below and click Clear local data."
              values={{
                phrase: (
                  <Typography
                    component="span"
                    variant="body2"
                    sx={{
                      fontWeight: "bold",
                      fontFamily: "inherit",
                    }}
                  >
                    {CONFIRMATION_PHRASE}
                  </Typography>
                ),
              }}
            />
          </Typography>
          <TextField
            autoFocus
            fullWidth
            label={<FormattedMessage defaultMessage="Confirmation phrase" />}
            value={confirmationValue}
            onChange={(event) => setConfirmationValue(event.target.value)}
            disabled={isClearing}
            placeholder={CONFIRMATION_PHRASE}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {recoveryRequired && !errorMessage && (
            <Alert severity="warning" variant="outlined">
              <FormattedMessage defaultMessage="A previous clear was interrupted. Retry to finish deleting local data." />
            </Alert>
          )}
          {errorMessage && (
            <Alert severity="error" variant="outlined">
              {errorMessage}
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={isClearing || clearStarted}>
          <FormattedMessage defaultMessage="Cancel" />
        </Button>
        <Button
          color="error"
          variant="contained"
          onClick={handleClear}
          disabled={!confirmationMatches || isClearing}
        >
          {isClearing ? (
            <FormattedMessage defaultMessage="Clearing..." />
          ) : (
            <FormattedMessage defaultMessage="Clear local data" />
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
