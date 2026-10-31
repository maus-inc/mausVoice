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
import { FormattedMessage, useIntl } from "react-intl";
import { showSnackbar } from "../../actions/app.actions";
import { getAuthRepo } from "../../repos";
import { produceAppState, useAppStore } from "../../store";
import { clearLocalData } from "../../utils/local-data.utils";
import { logOnRejection } from "../../utils/promise.utils";
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
  const intl = useIntl();
  const open = useAppStore((state) => state.settings.deleteAccountDialog);
  const [confirmationValue, setConfirmationValue] = useState("");
  const [busy, setBusy] = useState(false);
  const deleteInFlight = useRef(false);

  const isDeleteEnabled =
    confirmationValue.trim().toLowerCase() === CONFIRMATION_PHRASE;

  const handleClose = () => {
    if (deleteInFlight.current) return;
    produceAppState((state) => {
      state.settings.deleteAccountDialog = false;
    });
    setConfirmationValue("");
  };

  const handleSubmit = async () => {
    if (!isDeleteEnabled || deleteInFlight.current) {
      return;
    }

    deleteInFlight.current = true;
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
      deleteInFlight.current = false;
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

    setConfirmationValue("");
    // What was deleted is described as what it is: everything this device was
    // holding. "Your account has been deleted" was a promise about a server
    // account that no longer exists in this build, and the app is still on
    // screen afterwards, so it read as a claim that did not come true.
    showSnackbar(
      leftoverData
        ? intl.formatMessage({
            defaultMessage:
              "Your data was deleted from this device, but some of it could not be removed. Quit and reopen mausVoice.",
          })
        : intl.formatMessage({
            defaultMessage: "Your data has been deleted from this device",
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
    deleteInFlight.current = false;
    setBusy(false);
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
