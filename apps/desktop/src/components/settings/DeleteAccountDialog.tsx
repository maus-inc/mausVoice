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
import { invoke } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
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
import { disableAnalyticsPersistenceForLocalDataClear } from "../../utils/analytics-persistence.utils";

export const DeleteAccountDialog = () => {
  const intl = useIntl();
  const open = useAppStore((state) => state.settings.deleteAccountDialog);
  const userEmail = useAppStore((state) => state.auth?.email);
  const [confirmationEmail, setConfirmationEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const releaseClearRef = useRef<(() => void) | null>(null);
  const clearMarkerWasPreexistingRef = useRef(false);
  const accountDeletedRef = useRef(false);

  const isDeleteEnabled = confirmationEmail === userEmail && userEmail;
  const clearInProgress = releaseClearRef.current !== null;

  const handleClose = () => {
    if (busy || releaseClearRef.current || accountDeletedRef.current) return;
    produceAppState((state) => {
      state.settings.deleteAccountDialog = false;
    });
    setConfirmationEmail("");
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

  const stopNativeSubsystems = async () => {
    // Stop callbacks before wiping data so they cannot race with the cleared DB.
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
    if (!isDeleteEnabled || busy) return;

    setBusy(true);
    try {
      await ensureClearLease();
      await deleteAccountOnce();
      await stopNativeSubsystems();
      await clearDeletedAccountData();
      setConfirmationEmail("");
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
      setBusy(false);
    }
  };

  const handleEmailChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setConfirmationEmail(event.target.value);
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
        <Alert severity="warning" sx={{ mb: 2 }}>
          <FormattedMessage defaultMessage="This action cannot be undone. All your data will be permanently deleted." />
        </Alert>
        <Typography variant="body1" component="div" sx={{ mb: 2 }}>
          <FormattedMessage defaultMessage="Are you sure you want to delete your account? This will:" />
        </Typography>
        <Box component="ul" sx={{ pl: 2, mb: 2 }}>
          <Typography component="li" variant="body2">
            <FormattedMessage defaultMessage="Permanently delete all your data" />
          </Typography>
          <Typography component="li" variant="body2">
            <FormattedMessage defaultMessage="Cancel any active subscriptions" />
          </Typography>
          <Typography component="li" variant="body2">
            <FormattedMessage defaultMessage="Remove access to all premium features" />
          </Typography>
          <Typography component="li" variant="body2">
            <FormattedMessage defaultMessage="Sign you out immediately" />
          </Typography>
        </Box>
        {userEmail && (
          <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
            <FormattedMessage
              defaultMessage="Account to be deleted: {email}"
              values={{ email: <strong>{userEmail}</strong> }}
            />
          </Typography>
        )}

        <Typography variant="body2" sx={{ mb: 1 }}>
          <FormattedMessage defaultMessage="To confirm, type your email address below:" />
        </Typography>
        <TextField
          fullWidth
          variant="outlined"
          placeholder={userEmail || ""}
          value={confirmationEmail}
          onChange={handleEmailChange}
          size="small"
          sx={{ mb: 2 }}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
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
                <FormattedMessage defaultMessage="Delete account" />
              </span>
            </Stack>
          ) : (
            <FormattedMessage defaultMessage="Delete account" />
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
