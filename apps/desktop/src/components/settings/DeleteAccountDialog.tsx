import {
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
import { showSnackbar } from "../../actions/app.actions";
import { getAuthRepo } from "../../repos";
import { produceAppState, useAppStore } from "../../store";
import { clearLocalData } from "../../utils/local-data.utils";
import { logOnRejection } from "../../utils/promise.utils";
import { ConfirmationPhrase } from "./ConfirmationPhrase";
import { ConsequenceList } from "./ConsequenceList";

export const DeleteAccountDialog = () => {
  const intl = useIntl();
  const open = useAppStore((state) => state.settings.deleteAccountDialog);
  const userEmail = useAppStore((state) => state.auth?.email);
  const [confirmationEmail, setConfirmationEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const isDeleteEnabled = confirmationEmail === userEmail && userEmail;

  const handleClose = () => {
    produceAppState((state) => {
      state.settings.deleteAccountDialog = false;
    });
    setConfirmationEmail("");
  };

  const handleSubmit = async () => {
    if (!isDeleteEnabled) {
      return;
    }

    setBusy(true);
    try {
      await getAuthRepo().deleteMyAccount();
    } catch {
      // Only this call failing means the deletion failed. Everything below runs
      // after the account is gone, which is why it is outside this `try`: the
      // wipe used to sit inside it, so a wipe that could not finish was
      // reported as "your account could not be deleted" for an account that no
      // longer existed.
      showSnackbar(
        "An error occurred while attempting to delete your account. Please try again later.",
      );
      setBusy(false);
      return;
    }

    // Everything this device was keeping for the account goes too, through the
    // same seam "Clear local data" uses: wiping only the native half here is
    // what left the profile photo — a picture of the person's face — in
    // localStorage after a deletion that promised to remove it.
    let leftoverData = false;
    try {
      const { storageFailedKeys } = await clearLocalData();
      leftoverData = storageFailedKeys.length > 0;
    } catch {
      // The wipe throws when this app cannot reach storage at all, which is the
      // strongest version of "some of it may still be here" rather than a
      // reason to say nothing.
      leftoverData = true;
    }

    setConfirmationEmail("");
    showSnackbar(
      leftoverData
        ? intl.formatMessage({
            defaultMessage:
              "Your account has been deleted, but some stored data could not be removed. Quit and reopen mausVoice.",
          })
        : intl.formatMessage({
            defaultMessage: "Your account has been deleted",
          }),
      { duration: 15000 },
    );
    produceAppState((state) => {
      state.settings.deleteAccountDialog = false;
    });
    // Fire-and-forget, matching the sign-out row on the account page: the toast
    // above has already told the person what happened, and a failing sign-out
    // cannot make a deleted account undeleted.
    logOnRejection(getAuthRepo().signOut(), "account deletion: signOut");
    setBusy(false);
  };

  const handleEmailChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setConfirmationEmail(event.target.value);
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : handleClose}
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
              reason. */}
          <ConsequenceList
            label={<FormattedMessage defaultMessage="This removes" />}
            items={[
              <FormattedMessage
                key="data"
                defaultMessage="Permanently delete all your data"
              />,
              <FormattedMessage
                key="subscriptions"
                defaultMessage="Cancel any active subscriptions"
              />,
              <FormattedMessage
                key="premium"
                defaultMessage="Remove access to all premium features"
              />,
              <FormattedMessage
                key="signout"
                defaultMessage="Sign you out immediately"
              />,
            ]}
          />
          <Stack spacing={1.5}>
            <Typography variant="body2">
              <FormattedMessage
                defaultMessage="Type {phrase} to confirm."
                values={{
                  phrase: (
                    <ConfirmationPhrase>{userEmail ?? ""}</ConfirmationPhrase>
                  ),
                }}
              />
            </Typography>
            <TextField
              fullWidth
              variant="outlined"
              slotProps={{
                htmlInput: {
                  "aria-label": intl.formatMessage({
                    defaultMessage: "Your email address",
                  }),
                },
              }}
              placeholder={userEmail || ""}
              value={confirmationEmail}
              onChange={handleEmailChange}
              size="small"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} variant="text" disabled={busy}>
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
