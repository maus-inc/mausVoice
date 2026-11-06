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
import { useCallback, useEffect, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import { setPreferredMicrophone } from "../../actions/user.actions";
import { useMyPreferredMicrophone } from "../../hooks/user.hooks";
import { produceAppState, useAppStore } from "../../store";
import { SettingSection } from "../common/SettingSection";
import { MicrophoneSelector } from "../microphone/MicrophoneSelector";
import { MicrophoneTester } from "../microphone/MicrophoneTester";

/** Manage a dialog draft and serialize writes to the saved microphone. */
const useMicrophonePreference = (
  open: boolean,
  savedPreference: Nullable<string>,
) => {
  const [selected, setSelected] = useState<Nullable<string>>(savedPreference);
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const dialogSessionRef = useRef(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    if (!open) {
      dialogSessionRef.current += 1;
      return;
    }
    setSelected(savedPreference);
    setHasChanges(false);
    setSaveError(null);
    setSaveSuccess(false);
  }, [open, savedPreference]);

  const handleSelectionChange = useCallback(
    (next: Nullable<string>) => {
      setSelected(next ?? null);
      setHasChanges((next ?? null) !== (savedPreference ?? null));
      setSaveError(null);
      setSaveSuccess(false);
    },
    [savedPreference],
  );

  const handleSave = useCallback(async () => {
    if (!hasChanges || savingRef.current) {
      return;
    }

    savingRef.current = true;
    const session = dialogSessionRef.current;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    try {
      await setPreferredMicrophone(selected ?? null);
      if (dialogSessionRef.current === session) {
        setHasChanges(false);
        setSaveSuccess(true);
      }
    } catch {
      if (dialogSessionRef.current === session) {
        setSaveError("Failed to save microphone preference. Please try again.");
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [hasChanges, selected]);

  return {
    selected,
    hasChanges,
    saving,
    saveError,
    saveSuccess,
    handleSelectionChange,
    handleSave,
  };
};

export const MicrophoneDialog = () => {
  const open = useAppStore((state) => state.settings.microphoneDialogOpen);
  const savedPreference = useMyPreferredMicrophone();

  const {
    selected,
    hasChanges,
    saving,
    saveError,
    saveSuccess,
    handleSelectionChange,
    handleSave,
  } = useMicrophonePreference(open, savedPreference);

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
            {saveSuccess && (
              <Alert severity="success">
                <FormattedMessage defaultMessage="Preference saved." />
              </Alert>
            )}
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
