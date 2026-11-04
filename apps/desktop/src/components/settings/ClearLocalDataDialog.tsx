import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import { produceAppState, useAppStore } from "../../store";
import { StorageUnavailableError } from "../../utils/local-storage.utils";
import { ConfirmationField } from "./ConfirmationField";
import { ConsequenceList } from "./ConsequenceList";
import { BusyButtonLabel } from "../common/BusyButtonLabel";
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
import { stopLocalDataSubsystems } from "../../utils/stop-local-data-subsystems";

const CONFIRMATION_PHRASE = "clear";

/**
 * What to tell someone whose clear failed.
 *
 * A blocked origin is the one failure whose own message means nothing to the
 * person reading it, so it gets the sentence naming what to do instead.
 * Everything else keeps its own message: those come from the native command and
 * from this code, and paraphrasing them would drop whatever the person would
 * have to act on.
 */
const describeClearFailure = (error: unknown, intl: IntlShape): string => {
  if (error instanceof StorageUnavailableError) {
    // Specific about which half happened: the native wipe has already removed
    // the database and the audio by the time this throws, so saying nothing was
    // removed would send someone looking for data that is already gone.
    return intl.formatMessage({
      defaultMessage:
        "Your saved recordings and history were removed, but mausVoice could not reach this computer\u2019s storage, so some preferences may remain. Check that the app is allowed to store data, then try again.",
    });
  }
  if (error instanceof Error) {
    return error.message;
  }
  return intl.formatMessage({
    defaultMessage: "Failed to clear local data.",
  });
};

export const ClearLocalDataDialog = () => {
  const intl = useIntl();
  const open = useAppStore((state) => state.settings.clearLocalDataDialogOpen);
  const [confirmationValue, setConfirmationValue] = useState("");
  const [isClearing, setIsClearing] = useState(false);
  const clearInFlight = useRef(false);
  const confirmationRef = useRef<HTMLInputElement | null>(null);

  // The field someone has to type into gets the focus, spelled out here rather
  // than as an `autoFocus` attribute: the attribute fires as markup and cannot
  // be deferred, so it races anything else that moves focus in the same commit.
  // This mirrors ContextMenu's "focus after commit, not via autoFocus" rule.
  useEffect(() => {
    if (open) {
      confirmationRef.current?.focus();
    }
  }, [open]);

  const [clearStarted, setClearStarted] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);
  const clearStartedRef = useRef(false);
  const releaseClearRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (errorMessage) errorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [errorMessage]);

  useEffect(() => {
    if (!hasPendingLocalDataClear()) return;

    clearStartedRef.current = true;
    setClearStarted(true);
    setRecoveryRequired(true);
    produceAppState((draft) => {
      draft.settings.clearLocalDataDialogOpen = true;
    });
  }, []);

  const close = () => {
    if (clearInFlight.current || clearStartedRef.current) return;
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
    if (!isClearing && !clearInFlight.current) {
      close();
    }
  };

  const confirmationMatches =
    confirmationValue.trim().toLowerCase() === CONFIRMATION_PHRASE;

  const handleClear = async () => {
    if (!confirmationMatches || isClearing || clearInFlight.current) {
      return;
    }

    clearInFlight.current = true;
    setIsClearing(true);
    setRecoveryRequired(false);
    setErrorMessage(null);
    let stoppingSubsystems = false;
    try {
      if (!releaseClearRef.current) {
        releaseClearRef.current = await beginLocalDataClear();
        disableAnalyticsPersistenceForLocalDataClear();
        clearStartedRef.current = true;
        setClearStarted(true);
      }

      stoppingSubsystems = true;
      await stopLocalDataSubsystems();
      stoppingSubsystems = false;

      await invoke("clear_local_data");
      resetPendingTranscriptionDeletes();
      resetAutoLearnSessionState();
      clearAppLocalStorage();
      await invoke("complete_local_data_clear");
      removeLocalDataClearPendingMarker();
      // Keep the browser-side gate closed until this reload resets the stores.
      window.location.reload();
    } catch (error) {
      getLogger().error(
        "Failed to clear local data",
        typeof error === "string" ? new Error(error) : error,
      );
      const message =
        error instanceof Error ? error.message : "Failed to clear local data.";
      setErrorMessage(
        stoppingSubsystems
          ? intl.formatMessage({
              defaultMessage:
                "mausVoice could not stop recording or keyboard monitoring. Local data was not cleared in this attempt. Try again.",
            })
          : describeClearFailure(error, intl) || message,
      );
      clearInFlight.current = false;
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
              // The name and the photo are two stores — the name is a column
              // on `user_profiles`, which the native wipe deletes, and the
              // photo is this device's own file — but they are one thing to
              // the person reading this list.
              <FormattedMessage
                key="profile"
                defaultMessage="Your profile name and photo"
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
          <ConfirmationField
            phrase={CONFIRMATION_PHRASE}
            value={confirmationValue}
            onChange={setConfirmationValue}
            disabled={isClearing}
            inputRef={confirmationRef}
          />
          {recoveryRequired && !errorMessage && (
            <Alert severity="warning" variant="outlined">
              <FormattedMessage defaultMessage="A previous clear was interrupted. Retry to finish deleting local data." />
            </Alert>
          )}
          {errorMessage && (
            <Alert ref={errorRef} severity="error" variant="outlined">
              {errorMessage}
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={isClearing || clearStarted}>
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
            <BusyButtonLabel>
              <FormattedMessage defaultMessage="Clear local data" />
            </BusyButtonLabel>
          ) : (
            <FormattedMessage defaultMessage="Clear local data" />
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
