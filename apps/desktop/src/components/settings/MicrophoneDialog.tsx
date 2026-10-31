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
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { FormattedMessage } from "react-intl";
import { setPreferredMicrophone } from "../../actions/user.actions";
import { useMyPreferredMicrophone } from "../../hooks/user.hooks";
import { produceAppState, useAppStore } from "../../store";
import { SettingSection } from "../common/SettingSection";
import { BusyButtonLabel } from "../common/BusyButtonLabel";
import { MicrophoneSelector } from "../microphone/MicrophoneSelector";
import { MicrophoneTester } from "../microphone/MicrophoneTester";

export const MicrophoneDialog = () => {
  const open = useAppStore((state) => state.settings.microphoneDialogOpen);
  const savedPreference = useMyPreferredMicrophone();

  const [selected, setSelected] = useState<Nullable<string>>(savedPreference);
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  const [saveError, setSaveError] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const content = contentRef.current;
    const feedback = feedbackRef.current;
    if ((!saveError && !saveSuccess) || !content || !feedback) return;
    // Do not move the viewport away from a tester the user has started using
    // while this save was pending. The alert still announces itself.
    if (content.contains(document.activeElement)) return;
    const containerRect = content.getBoundingClientRect();
    const errorRect = feedback.getBoundingClientRect();
    if (
      errorRect.top < containerRect.top ||
      errorRect.height > containerRect.height
    ) {
      content.scrollTop += errorRect.top - containerRect.top;
    } else if (errorRect.bottom > containerRect.bottom) {
      content.scrollTop += errorRect.bottom - containerRect.bottom + 8;
    }
  }, [saveError, saveSuccess]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setSelected(savedPreference);
    setHasChanges(false);
    setSaveError(false);
    setSaveSuccess(false);
  }, [open, savedPreference]);

  const handleSelectionChange = useCallback(
    (next: Nullable<string>) => {
      setSelected(next ?? null);
      setHasChanges((next ?? null) !== (savedPreference ?? null));
      setSaveError(false);
      setSaveSuccess(false);
    },
    [savedPreference],
  );

  const handleSave = useCallback(async () => {
    if (!hasChanges || saving || saveInFlight.current) {
      return;
    }

    saveInFlight.current = true;
    setSaving(true);
    setSaveError(false);
    setSaveSuccess(false);

    try {
      await setPreferredMicrophone(selected ?? null);
      setHasChanges(false);
      setSaveSuccess(true);
    } catch {
      setSaveError(true);
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }, [hasChanges, saving, selected]);

  const handleClose = useCallback(() => {
    if (saveInFlight.current) return;
    produceAppState((draft) => {
      draft.settings.microphoneDialogOpen = false;
    });
  }, []);

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
      <DialogTitle>
        <FormattedMessage defaultMessage="Microphone settings" />
      </DialogTitle>
      <DialogContent dividers ref={contentRef}>
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
            {saveError && (
              <Alert ref={feedbackRef} severity="error">
                <FormattedMessage defaultMessage="Failed to save microphone preference. Please try again." />
              </Alert>
            )}
            {saveSuccess && (
              <Alert ref={feedbackRef} severity="success">
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
            <MicrophoneTester preferredMicrophone={selected ?? null} />
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={saving}>
          <FormattedMessage defaultMessage="Close" />
        </Button>
        <Button
          onClick={handleSave}
          disabled={!hasChanges || saving}
          aria-busy={saving || undefined}
          variant="contained"
        >
          {saving ? (
            <BusyButtonLabel>
              <FormattedMessage defaultMessage="Save changes" />
            </BusyButtonLabel>
          ) : (
            <FormattedMessage defaultMessage="Save changes" />
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
