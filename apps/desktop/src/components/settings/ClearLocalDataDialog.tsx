import { invoke } from "@tauri-apps/api/core";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { produceAppState, useAppStore } from "../../store";
import { clearAppDataStorage } from "../../utils/local-storage.utils";
import { ConsequenceList } from "./ConsequenceList";

const CONFIRMATION_PHRASE = "clear";

export const ClearLocalDataDialog = () => {
  const intl = useIntl();
  const open = useAppStore((state) => state.settings.clearLocalDataDialogOpen);
  const [confirmationValue, setConfirmationValue] = useState("");
  const [isClearing, setIsClearing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  /** Put the dialog away and forget everything typed into it. */
  const close = () => {
    produceAppState((draft) => {
      draft.settings.clearLocalDataDialogOpen = false;
    });
    setConfirmationValue("");
    setIsClearing(false);
    setErrorMessage(null);
  };

  // Escape and a click on the backdrop both arrive here, so the dialog cannot
  // be dismissed out from under a wipe that is already running: the button is
  // disabled for the same reason, and a half-finished wipe with the dialog gone
  // would leave nothing to report on.
  const handleDismiss = () => {
    if (!isClearing) {
      close();
    }
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

      // The Rust side wipes the database and the managed audio directory;
      // everything this app keeps in localStorage lives outside both, so the
      // photo, dismissed tips and account anchors would otherwise survive a
      // wipe that promises to remove them. The session keys are not in that
      // list: clearing local data is not a sign-out.
      //
      // The dialog is deliberately left open across this and the reload. Closing
      // it updates the store, and the persist middleware rewrites its own key on
      // every state change, so a close before the wipe would put a freshly
      // serialized key back; and a wipe the browser refuses has to be able to
      // say so to someone who is still looking at the dialog. The reload takes
      // the dialog down with everything else.
      const failedKeys = clearAppDataStorage();
      if (failedKeys.length > 0) {
        // Reloading anyway would restore exactly the state the dialog just
        // promised to remove, so the honest answer is to name the problem and
        // keep the confirmation field on screen for a retry.
        setErrorMessage(
          intl.formatMessage({
            defaultMessage:
              "Some stored data could not be removed. Quit and reopen mausVoice, then try again.",
          }),
        );
        setIsClearing(false);
        return;
      }
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
    <Dialog open={open} onClose={handleDismiss} fullWidth maxWidth="sm">
      <DialogTitle>
        <FormattedMessage defaultMessage="Clear local data" />
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <ConsequenceList
            label={<FormattedMessage defaultMessage="This removes" />}
            items={[
              <FormattedMessage
                key="preferences"
                defaultMessage="Preferences and settings"
              />,
              <FormattedMessage
                key="photo"
                defaultMessage="Your profile photo"
              />,
              <FormattedMessage
                key="dictionary"
                defaultMessage="Dictionary entries"
              />,
              <FormattedMessage
                key="transcriptions"
                defaultMessage="Saved transcriptions and audio"
              />,
            ]}
          />
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            <FormattedMessage defaultMessage="This cannot be undone. Your account and sign-in stay as they are." />
          </Typography>
          <Stack spacing={1.5}>
            <Typography variant="body2">
              <FormattedMessage
                defaultMessage="Type {phrase} to confirm."
                values={{
                  phrase: (
                    // The literal someone has to reproduce is set apart from
                    // the instruction around it: as running text it read like
                    // part of the sentence and was easy to mistype.
                    <Box
                      component="code"
                      sx={{
                        fontFamily: "ui-monospace, SFMono-Regular, monospace",
                        fontSize: "0.875em",
                        px: 0.75,
                        py: 0.25,
                        borderRadius: 0.5,
                        border: 1,
                        borderColor: "divider",
                        bgcolor: "level2",
                      }}
                    >
                      {CONFIRMATION_PHRASE}
                    </Box>
                  ),
                }}
              />
            </Typography>
            <TextField
              autoFocus
              fullWidth
              // No visible label: the line above it already names the word to
              // type, and repeating it in a floating label is one more element
              // competing with the instruction. The accessible name stays.
              slotProps={{
                htmlInput: {
                  "aria-label": intl.formatMessage({
                    defaultMessage: "Confirmation phrase",
                  }),
                },
              }}
              value={confirmationValue}
              onChange={(event) => setConfirmationValue(event.target.value)}
              disabled={isClearing}
              placeholder={CONFIRMATION_PHRASE}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </Stack>
          {errorMessage && (
            <Alert severity="error" variant="outlined">
              {errorMessage}
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={isClearing}>
          <FormattedMessage defaultMessage="Cancel" />
        </Button>
        <Button
          color="error"
          variant="contained"
          onClick={() => void handleClear()}
          disabled={!confirmationMatches || isClearing}
          // The label stays while the button is busy, so the control never
          // loses its name during the one action that empties the device.
          aria-busy={isClearing || undefined}
        >
          {isClearing ? (
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: "center", justifyContent: "center" }}
            >
              <CircularProgress
                size={16}
                color="inherit"
                role="progressbar"
                aria-label={intl.formatMessage({ defaultMessage: "Working" })}
              />
              <span>
                <FormattedMessage defaultMessage="Clear local data" />
              </span>
            </Stack>
          ) : (
            <FormattedMessage defaultMessage="Clear local data" />
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
