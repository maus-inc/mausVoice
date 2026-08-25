import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Switch,
  Typography,
} from "@mui/material";
import { ChangeEvent, useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  setDictationAudioDim,
  setInteractionChimeEnabled,
  setInteractionFeedbackVolume,
} from "../../actions/user.actions";
import { produceAppState, useAppStore } from "../../store";
import { getMyUser } from "../../utils/user.utils";
import { ElasticSlider } from "../common/ElasticSlider";
import { SettingSection } from "../common/SettingSection";

export const AudioDialog = () => {
  const intl = useIntl();
  const [
    open,
    playInteractionChime,
    interactionFeedbackVolume,
    dictationAudioDim,
  ] = useAppStore((state) => {
    const user = getMyUser(state);
    return [
      state.settings.audioDialogOpen,
      user?.playInteractionChime ?? true,
      user?.interactionFeedbackVolume ?? 0.35,
      state.userPrefs?.dictationAudioDim ?? 1.0,
    ] as const;
  });

  const handleClose = () => {
    produceAppState((draft) => {
      draft.settings.audioDialogOpen = false;
    });
  };

  const handleToggle = (event: ChangeEvent<HTMLInputElement>) => {
    const enabled = event.target.checked;
    void setInteractionChimeEnabled(enabled);
  };

  // Live display value while dragging; the persisted value updates on commit.
  const [displayDim, setDisplayDim] = useState(dictationAudioDim);
  const [displayThock, setDisplayThock] = useState(interactionFeedbackVolume);

  useEffect(() => {
    setDisplayDim(dictationAudioDim);
  }, [dictationAudioDim]);
  useEffect(() => {
    setDisplayThock(interactionFeedbackVolume);
  }, [interactionFeedbackVolume]);

  return (
    <Dialog open={open} onClose={handleClose}>
      <DialogTitle>
        <FormattedMessage defaultMessage="Audio" />
      </DialogTitle>
      <DialogContent sx={{ minWidth: 360 }}>
        <SettingSection
          title={<FormattedMessage defaultMessage="Interaction feedback" />}
          description={
            <FormattedMessage defaultMessage="Play a short haptic-style click when you press the pill or start and stop recording. No sound plays while a recording is processing." />
          }
          action={
            <Switch
              edge="end"
              checked={playInteractionChime}
              onChange={handleToggle}
            />
          }
        />
        <Box sx={{ mt: 2, pl: 1, opacity: playInteractionChime ? 1 : 0.4 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            <FormattedMessage defaultMessage="Interaction feedback volume" />
          </Typography>
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", display: "block", mb: 1 }}
          >
            <FormattedMessage defaultMessage="Lower the click volume or turn the click off entirely." />
          </Typography>
          <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
            <ElasticSlider
              value={interactionFeedbackVolume}
              onChangeDisplay={setDisplayThock}
              onCommit={(v) => {
                void setInteractionFeedbackVolume(v);
              }}
              min={0}
              max={1}
              step={0.05}
              disabled={!playInteractionChime}
              ariaLabel={intl.formatMessage({
                defaultMessage: "Interaction feedback volume",
              })}
            />
            <Typography
              variant="body2"
              sx={{ minWidth: 40, textAlign: "right" }}
            >
              {Math.round(displayThock * 100)}%
            </Typography>
          </Box>
        </Box>
        <Box sx={{ mt: 3 }}>
          <Typography variant="body1" sx={{ fontWeight: 600 }}>
            <FormattedMessage defaultMessage="Dim audio while dictating" />
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              mb: 1,
            }}
          >
            <FormattedMessage defaultMessage="Lower system volume while recording, then restore it when done." />
          </Typography>
          <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
            <ElasticSlider
              value={dictationAudioDim}
              onCommit={(v) => {
                void setDictationAudioDim(v);
              }}
              onChangeDisplay={setDisplayDim}
              min={0}
              max={1}
              step={0.05}
              ariaLabel={intl.formatMessage({
                defaultMessage: "Dictation audio dim level",
              })}
            />
            <Typography
              variant="body2"
              sx={{ minWidth: 40, textAlign: "right" }}
            >
              {Math.round(displayDim * 100)}%
            </Typography>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>
          <FormattedMessage defaultMessage="Close" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};
