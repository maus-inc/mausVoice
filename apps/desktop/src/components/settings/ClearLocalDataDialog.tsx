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
import { useState } from "react";
import { FormattedMessage } from "react-intl";
import { produceAppState, useAppStore } from "../../store";

const CONFIRMATION_PHRASE = "clear";

export const ClearLocalDataDialog = () => {
  const open = useAppStore((state) => state.settings.clearLocalDataDialogOpen);
  const [confirmationValue, setConfirmationValue] = useState("");
  const [isClearing, setIsClearing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleClose = () => {
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
    setErrorMessage(null);

    try {
      // Tear down long-running native subsystems BEFORE wiping the DB and
      // reloading. If a recorder or global key listener is left running
      // past `clear_local_data`, its in-flight callbacks will race the
      // page reload against a now-empty / VACUUM'd database and emit
      // errors into the fresh session. Best-effort: ignore per-command
      // failures (there may not be an active recording/listener to stop).
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
      handleClose();
      // A hard reload is the simplest way to flush every in-memory store
      // (Zustand, React state, transcription sessions, subscription
      // handles) that may still hold references to wiped data.
      window.location.reload();
    } catch (error) {
      console.error("Failed to clear local data", error);
      const message =
        error instanceof Error ? error.message : "Failed to clear local data.";
      setErrorMessage(message);
      setIsClearing(false);
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
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
                    fontWeight="bold"
                    sx={{ fontFamily: "inherit" }}
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
          {errorMessage && (
            <Alert severity="error" variant="outlined">
              {errorMessage}
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={isClearing}>
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
