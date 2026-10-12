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
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import { produceAppState, useAppStore } from "../../store";
import { clearLocalData } from "../../utils/local-data.utils";
import { StorageUnavailableError } from "../../utils/local-storage.utils";
import { ConfirmationField } from "./ConfirmationField";
import { ConsequenceList } from "./ConsequenceList";
import { BusyButtonLabel } from "../common/BusyButtonLabel";

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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
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
      // The wipe lives in one place because deleting the account has to remove
      // the same things; see `clearLocalData` for what those are and why each
      // step is there.
      //
      // The dialog is deliberately left open across this and the reload. Closing
      // it updates the store, and the persist middleware rewrites its own key on
      // every state change, so a close before the wipe would put a freshly
      // serialized key back; and a wipe the browser refuses has to be able to
      // say so to someone who is still looking at the dialog. The reload takes
      // the dialog down with everything else.
      const { storageFailedKeys: failedKeys } = await clearLocalData();
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
      setErrorMessage(describeClearFailure(error, intl));
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
