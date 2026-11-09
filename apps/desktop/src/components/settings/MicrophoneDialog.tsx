import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { Nullable } from "@maus-inc/types";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { toast } from "sonner";
import {
  setKeepMicrophoneReady,
  setMicrophoneLingerMs,
  setMicrophonePrerollSeconds,
  setPreferredMicrophone,
} from "../../actions/user.actions";
import { useMyPreferredMicrophone } from "../../hooks/user.hooks";
import { produceAppState, useAppStore } from "../../store";
import { SettingSection } from "../common/SettingSection";
import { BusyButtonLabel } from "../common/BusyButtonLabel";
import { MicrophoneSelector } from "../microphone/MicrophoneSelector";
import { MicrophoneTester } from "../microphone/MicrophoneTester";
import { ElasticSlider } from "../common/ElasticSlider";
import {
  DEFAULT_MICROPHONE_LINGER_MS,
  MAX_MICROPHONE_PREROLL_SECONDS,
  describeHeldState,
} from "../../utils/microphone-readiness.utils";

export const MicrophoneDialog = () => {
  const open = useAppStore((state) => state.settings.microphoneDialogOpen);
  const savedPreference = useMyPreferredMicrophone();
  const intl = useIntl();
  const keepReady = useAppStore(
    (state) => state.userPrefs?.keepMicrophoneReady === true,
  );
  const prerollSeconds = useAppStore(
    (state) => state.userPrefs?.microphonePrerollSeconds ?? 0.5,
  );
  const microphoneHeld = useAppStore((state) => state.settings.microphoneHeld);
  const heldState = describeHeldState(microphoneHeld);
  const lingerMs = useAppStore(
    (state) => state.userPrefs?.microphoneLingerMs ?? 0,
  );
  const lingerOn = lingerMs > 0;
  // A zero pre-roll is a deliberate choice: the user asked for a recording that
  // starts exactly at the press. The slider therefore stays rendered at zero --
  // it is the only control that sets this value, so hiding it at the one value a
  // drag can reach would strand the user with pre-roll off and no way back.
  // `prerollOn` only chooses the caption, which must not describe a window that
  // does not exist.
  const prerollOn = prerollSeconds > 0;

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
      toast.success(
        intl.formatMessage({ defaultMessage: "Preference saved." }),
        { duration: 5000 },
      );
    } catch {
      setSaveError(true);
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }, [hasChanges, intl, saving, selected]);

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
            <span
              role="status"
              aria-live="polite"
              aria-atomic="true"
              style={{
                position: "absolute",
                width: 1,
                height: 1,
                padding: 0,
                margin: -1,
                overflow: "hidden",
                clip: "rect(0, 0, 0, 0)",
                whiteSpace: "nowrap",
                border: 0,
              }}
            >
              {saveSuccess && (
                <FormattedMessage defaultMessage="Preference saved." />
              )}
            </span>
          </Stack>

          <Divider />

          <Stack spacing={1.5}>
            <FormControlLabel
              control={
                <Switch
                  checked={keepReady}
                  onChange={(event) =>
                    void setKeepMicrophoneReady(event.target.checked)
                  }
                />
              }
              label={
                <FormattedMessage defaultMessage="Keep the microphone ready" />
              }
            />
            <Typography variant="body2" color="text.secondary">
              <FormattedMessage defaultMessage="Start dictating instantly by opening the microphone ahead of time. Your system shows its microphone-in-use indicator the whole time this is on." />
            </Typography>
            {keepReady && heldState === "held" && (
              <Typography variant="body2" color="text.secondary">
                <FormattedMessage defaultMessage="Held open now." />
              </Typography>
            )}
            {keepReady && heldState === "not_held" && (
              <Typography variant="body2" color="text.secondary">
                <FormattedMessage defaultMessage="Not holding the microphone yet, so a press still has to open it. The setting applies as soon as the device opens." />
              </Typography>
            )}
            {keepReady && heldState === "unknown" && (
              <Typography variant="body2" color="text.secondary">
                <FormattedMessage defaultMessage="Checking the microphone..." />
              </Typography>
            )}
            {/* Offered outside the keep-ready branch because it is not a
                keep-ready setting. The pre-roll is what the next press keeps
                from before it, which matters most when the device is opened at
                that press: hiding it here left the control unreachable for
                exactly the case where it does the most work. */}
            <Stack spacing={0.5}>
              <Typography variant="body2">
                <FormattedMessage defaultMessage="Audio kept before the press" />
              </Typography>
              <ElasticSlider
                value={prerollSeconds}
                min={0}
                max={MAX_MICROPHONE_PREROLL_SECONDS}
                step={0.1}
                valueLabelDisplay="auto"
                valueLabelFormat={(value) => `${value.toFixed(1)} s`}
                ariaLabel={intl.formatMessage({
                  defaultMessage: "Audio kept before the press",
                })}
                onCommit={(value) => setMicrophonePrerollSeconds(value)}
              />
              <Typography variant="caption" color="text.secondary">
                {prerollOn ? (
                  <FormattedMessage defaultMessage="How much speech to keep from just before you press, so a word you start early is not cut off." />
                ) : (
                  <FormattedMessage defaultMessage="Nothing is kept from before the press: the recording starts exactly on the press." />
                )}
              </Typography>
            </Stack>
          </Stack>

          <Divider />

          <Stack spacing={1.5}>
            <FormControlLabel
              control={
                <Switch
                  // The effective state, not the stored one. Keep-ready holds the
                  // device forever, so the linger window is on whatever its own
                  // preference says; showing the stored value left a disabled
                  // switch reading "off" directly above a caption that said it was
                  // already on.
                  checked={keepReady || lingerOn}
                  disabled={keepReady}
                  onChange={(event) =>
                    void setMicrophoneLingerMs(
                      event.target.checked ? DEFAULT_MICROPHONE_LINGER_MS : 0,
                    )
                  }
                />
              }
              label={
                <FormattedMessage defaultMessage="Stay ready after a dictation" />
              }
            />
            <Typography variant="body2" color="text.secondary">
              {keepReady ? (
                <FormattedMessage defaultMessage="Already on, because the microphone is kept ready." />
              ) : (
                <FormattedMessage defaultMessage="Keeps the microphone open for a few seconds after each recording, so a second dictation starts instantly. Your system shows its microphone-in-use indicator for that time." />
              )}
            </Typography>
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
