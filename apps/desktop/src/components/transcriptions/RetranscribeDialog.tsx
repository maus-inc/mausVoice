import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
} from "@mui/material";
import { useCallback, useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";
import {
  closeRetranscribeDialog,
  retranscribeTranscription,
} from "../../actions/transcriptions.actions";
import { useAppStore } from "../../store";
import {
  type DictationLanguageCode,
  toSelectableDictationLanguage,
} from "../../utils/language.utils";
import { isStyleSelectionAvailable } from "../../utils/post-processing.utils";
import { getSortedExistingTones } from "../../utils/tone.utils";
import { getMyDictationLanguage } from "../../utils/user.utils";
import { chromeDialogPaperSx } from "../common/chromeMenu";
import { TranscriptionOptions } from "./TranscriptionOptions";

export const RetranscribeDialog = () => {
  const open = useAppStore(
    (state) => state.transcriptions.retranscribeDialogOpen,
  );
  const transcriptionId = useAppStore(
    (state) => state.transcriptions.retranscribeDialogTranscriptionId,
  );
  const isRetranscribing = useAppStore((state) =>
    transcriptionId
      ? state.transcriptions.retranscribingIds.includes(transcriptionId)
      : false,
  );

  const tones = useAppStore(getSortedExistingTones);

  const defaultLanguage = useAppStore((state) => getMyDictationLanguage(state));
  const styleSelectionAvailable = useAppStore(isStyleSelectionAvailable);

  const [selectedToneId, setSelectedToneId] = useState<string | null>(null);
  const [selectedLanguage, setSelectedLanguage] =
    useState<DictationLanguageCode>(
      toSelectableDictationLanguage(defaultLanguage),
    );

  useEffect(() => {
    if (open) {
      setSelectedToneId(tones[0]?.id ?? null);
      setSelectedLanguage(toSelectableDictationLanguage(defaultLanguage));
    }
  }, [open, defaultLanguage, tones]);

  const handleClose = useCallback(() => {
    closeRetranscribeDialog();
  }, []);

  const handleSubmit = useCallback(() => {
    if (!transcriptionId || isRetranscribing) return;

    closeRetranscribeDialog();
    void retranscribeTranscription({
      transcriptionId,
      toneId: styleSelectionAvailable ? selectedToneId : null,
      languageCode: selectedLanguage,
    });
  }, [
    transcriptionId,
    selectedToneId,
    selectedLanguage,
    isRetranscribing,
    styleSelectionAvailable,
  ]);

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="xs"
      fullWidth
      slotProps={{ paper: { sx: chromeDialogPaperSx } }}
    >
      <DialogTitle>
        <FormattedMessage defaultMessage="Retranscribe" />
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TranscriptionOptions
            tones={tones}
            styleSelectionAvailable={styleSelectionAvailable}
            selectedToneId={selectedToneId}
            onToneChange={setSelectedToneId}
            selectedLanguage={selectedLanguage}
            onLanguageChange={setSelectedLanguage}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>
          <FormattedMessage defaultMessage="Cancel" />
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={!transcriptionId || isRetranscribing}
        >
          <FormattedMessage defaultMessage="Transcribe" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};
