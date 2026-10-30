import { LoadingButton } from "@mui/lab";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
} from "@mui/material";
import { Nullable } from "@maus-inc/types";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { FormattedMessage, useIntl } from "react-intl";
import { setPreferredMicrophone } from "../../actions/user.actions";
import { useMyPreferredMicrophone } from "../../hooks/user.hooks";
import { produceAppState, useAppStore } from "../../store";
import { SettingSection } from "../common/SettingSection";
import { MicrophoneSelector } from "../microphone/MicrophoneSelector";
import { MicrophoneTester } from "../microphone/MicrophoneTester";

export const MicrophoneDialog = () => {
  const open = useAppStore((state) => state.settings.microphoneDialogOpen);
  const savedPreference = useMyPreferredMicrophone();
  const intl = useIntl();

  const [selected, setSelected] = useState<Nullable<string>>(savedPreference);
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveAnnouncement, setSaveAnnouncement] = useState("");

  useEffect(() => {
    if (!open) {
      return;
    }
    setSelected(savedPreference);
    setHasChanges(false);
    setSaveError(null);
    setSaveAnnouncement("");
  }, [open, savedPreference]);

  const handleSelectionChange = useCallback(
    (next: Nullable<string>) => {
      setSelected(next ?? null);
      setHasChanges((next ?? null) !== (savedPreference ?? null));
      setSaveError(null);
      setSaveAnnouncement("");
    },
    [savedPreference],
  );

  const handleSave = useCallback(async () => {
    if (!hasChanges || saving) {
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSaveAnnouncement("");

    try {
      await setPreferredMicrophone(selected ?? null);
    } catch {
      setSaveError("Failed to save microphone preference. Please try again.");
      return;
    } finally {
      setSaving(false);
    }

    const successMessage = intl.formatMessage({
      defaultMessage: "Preference saved.",
    });
    setHasChanges(false);
    setSaveAnnouncement(successMessage);
    // Avoid the state-backed snackbar bridge coalescing this confirmation.
    toast.success(successMessage, { duration: 5000 });
  }, [hasChanges, intl, saving, selected]);

  const handleClose = useCallback(() => {
    produceAppState((draft) => {
      draft.settings.microphoneDialogOpen = false;
    });
  }, []);

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
      <DialogTitle>
        <FormattedMessage defaultMessage="Microphone settings" />
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={3} sx={{ paddingTop: 0.5 }}>
          <Stack spacing={1.5}>
            <SettingSection
              title={<FormattedMessage defaultMessage="Preferred microphone" />}
              description={
                <FormattedMessage defaultMessage="Choose which microphone mausVoice should use when recording. Automatic picks the best available device each time." />
              }
              sx={{ pb: 0.5 }}
            />
            <MicrophoneSelector
              value={selected ?? null}
              onChange={handleSelectionChange}
              disabled={saving}
            />
            {saveError && <Alert severity="error">{saveError}</Alert>}
            {/* MUI hides the app root from assistive tech while this dialog is open,
                so announce success here without a second visible alert. */}
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              style={{
                border: 0,
                clip: "rect(0 0 0 0)",
                height: 1,
                margin: -1,
                overflow: "hidden",
                padding: 0,
                position: "absolute",
                whiteSpace: "nowrap",
                width: 1,
              }}
            >
              {saveAnnouncement}
            </div>
          </Stack>

          <Divider />

          <Stack spacing={1.5}>
            <SettingSection
              title={<FormattedMessage defaultMessage="Test your microphone" />}
              description={
                <FormattedMessage defaultMessage="Start a short test to see live audio levels and play back what was recorded." />
              }
            />
            <MicrophoneTester
              preferredMicrophone={selected ?? null}
              disabled={saving}
            />
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>
          <FormattedMessage defaultMessage="Close" />
        </Button>
        <LoadingButton
          onClick={handleSave}
          loading={saving}
          disabled={!hasChanges || saving}
          variant="contained"
        >
          <FormattedMessage defaultMessage="Save changes" />
        </LoadingButton>
      </DialogActions>
    </Dialog>
  );
};
