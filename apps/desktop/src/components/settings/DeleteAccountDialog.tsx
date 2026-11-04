import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material";
import { useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import { showSnackbar } from "../../actions/app.actions";
import { resetAutoLearnSessionState } from "../../actions/edit-watch.actions";
import { getAuthRepo } from "../../repos";
import { produceAppState, useAppStore } from "../../store";
import {
  clearAppLocalStorage,
  removeLocalDataClearPendingMarker,
} from "../../utils/local-data-storage.utils";
import {
  beginLocalDataClear,
  hasPendingLocalDataClear,
} from "../../utils/local-data-write-gate";
import { resetPendingTranscriptionDeletes } from "../../utils/pending-transcription-delete";
import { stopLocalDataSubsystems } from "../../utils/stop-local-data-subsystems";
import { disableAnalyticsPersistenceForLocalDataClear } from "../../utils/analytics-persistence.utils";

import { invoke } from "@tauri-apps/api/core";
import { ConfirmationField } from "./ConfirmationField";
import { ConsequenceList } from "./ConsequenceList";
import { BusyButtonLabel } from "../common/BusyButtonLabel";

/**
 * The literal that has to be typed before the deletion runs, matching the
 * sibling dialog that clears local data.
 *
 * It used to be the account's email address, which made sense while the account
 * lived on a server and the address identified it. In this build the profile is
 * the account and it is local — the address on it is a placeholder the app
 * itself made up — so asking someone to retype it was a ritual with nothing
 * behind it. The phrase is the destructive action's own name instead.
 */
const CONFIRMATION_PHRASE = "delete";

export const DeleteAccountDialog = () => {
  const open = useAppStore((state) => state.settings.deleteAccountDialog);
  const [confirmationValue, setConfirmationValue] = useState("");
  const [busy, setBusy] = useState(false);
  const deleteInFlight = useRef(false);
  const releaseClearRef = useRef<(() => void) | null>(null);
  const clearMarkerWasPreexistingRef = useRef(false);
  const accountDeletedRef = useRef(false);
  const clearInProgress = releaseClearRef.current !== null;

  const isDeleteEnabled =
    confirmationValue.trim().toLowerCase() === CONFIRMATION_PHRASE;

  const handleClose = () => {
    if (
      deleteInFlight.current ||
      releaseClearRef.current ||
      accountDeletedRef.current
    )
      return;
    produceAppState((state) => {
      state.settings.deleteAccountDialog = false;
    });
    setConfirmationValue("");
  };

  const ensureClearLease = async () => {
    if (releaseClearRef.current) return;
    // Keep writes closed across retries if account deletion succeeds but local
    // cleanup later fails.
    clearMarkerWasPreexistingRef.current = hasPendingLocalDataClear();
    releaseClearRef.current = await beginLocalDataClear();
  };

  const deleteAccountOnce = async () => {
    if (accountDeletedRef.current) return;
    await getAuthRepo().deleteMyAccount();
    accountDeletedRef.current = true;
    disableAnalyticsPersistenceForLocalDataClear();
  };

  const signOutAfterAccountDeletion = async () => {
    try {
      await getAuthRepo().signOut();
    } catch (error) {
      console.error("Failed to sign out after account deletion", error);
    }
  };

  const clearDeletedAccountData = async () => {
    await invoke("clear_local_data");
    resetPendingTranscriptionDeletes();
    resetAutoLearnSessionState();
    clearAppLocalStorage();
    await signOutAfterAccountDeletion();
    await invoke("complete_local_data_clear");
    removeLocalDataClearPendingMarker();
  };

  const releaseClearAfterDeletionFailure = () => {
    if (accountDeletedRef.current) return;
    // If deletion failed, reopen only a clear marker created by this attempt.
    try {
      if (!clearMarkerWasPreexistingRef.current) {
        removeLocalDataClearPendingMarker();
      }
      releaseClearRef.current?.();
      releaseClearRef.current = null;
      clearMarkerWasPreexistingRef.current = false;
    } catch (cleanupError) {
      // Keep writes blocked if the durable marker cannot be removed.
      console.error(
        "Failed to release local-data clear after account deletion failed",
        cleanupError,
      );
    }
  };

  const handleSubmit = async () => {
    if (!isDeleteEnabled || busy || deleteInFlight.current) return;
    deleteInFlight.current = true;

    setBusy(true);
    try {
      await ensureClearLease();
      await deleteAccountOnce();
      await stopLocalDataSubsystems();
      await clearDeletedAccountData();
      setConfirmationValue("");
      produceAppState((state) => {
        state.settings.deleteAccountDialog = false;
      });
      // Keep the clear gate closed until reload so startup tasks cannot recreate
      // local data after the reset.
      window.location.reload();
    } catch (error) {
      console.error("Failed to finish account deletion cleanup", error);
      showSnackbar(
        accountDeletedRef.current
          ? "Your account was deleted, but local cleanup is incomplete. Retry to finish clearing this device."
          : "An error occurred while attempting to delete your account. Please try again later.",
      );
      releaseClearAfterDeletionFailure();
    } finally {
      deleteInFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy || clearInProgress ? undefined : handleClose}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>
        <Typography
          variant="h6"
          component="div"
          color="error"
          sx={{
            fontWeight: 600,
          }}
        >
          <FormattedMessage defaultMessage="Delete account" />
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.5}>
          {/* The consequences are the dialog, so they are a list rather than a
              sentence: the same one the local-data wipe uses, for the same
              reason. Every line is something this build actually does — the
              subscriptions, premium access and sign-out that used to be listed
              here belonged to a cloud account that 0.1.6 removed, and a dialog
              that promises them is describing a different app. */}
          <ConsequenceList
            label={<FormattedMessage defaultMessage="This removes" />}
            items={[
              <FormattedMessage
                key="data"
                defaultMessage="All your data on this device, including history and audio"
              />,
              <FormattedMessage
                key="profile"
                defaultMessage="Your profile name and photo"
              />,
              <FormattedMessage
                key="preferences"
                defaultMessage="Your preferences and settings"
              />,
            ]}
          />
          <ConfirmationField
            phrase={CONFIRMATION_PHRASE}
            value={confirmationValue}
            onChange={setConfirmationValue}
            disabled={busy}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button
          onClick={handleClose}
          variant="text"
          disabled={busy || clearInProgress}
        >
          <FormattedMessage defaultMessage="Cancel" />
        </Button>
        <Button
          onClick={() => void handleSubmit()}
          variant="contained"
          color="error"
          disabled={!isDeleteEnabled || busy}
          // The label stays in the DOM while the button is busy. Swapping it for
          // a bare spinner left the button with no accessible name during the
          // one flow that destroys the user's account, so a screen reader
          // announced an unlabelled disabled control with no indication that
          // anything was in progress.
          aria-busy={busy || undefined}
        >
          {busy ? (
            <BusyButtonLabel>
              <FormattedMessage defaultMessage="Delete account" />
            </BusyButtonLabel>
          ) : (
            <FormattedMessage defaultMessage="Delete account" />
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
