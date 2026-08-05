import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
} from "@mui/material";
import type { Tone } from "@maus-inc/types";
import { getRec } from "@maus-inc/utilities";
import { useCallback, useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import {
  closeRetranscribeDialog,
  retranscribeTranscription,
} from "../../actions/transcriptions.actions";
import { produceAppState, useAppStore } from "../../store";
import {
  AUTO_LANGUAGE,
  DICTATION_LANGUAGES,
  type DictationLanguageCode,
  ORDERED_DICTATION_LANGUAGES,
} from "../../utils/language.utils";
import { getSortedToneIds } from "../../utils/tone.utils";
import { getMyDictationLanguage } from "../../utils/user.utils";

const languageOptions = (
  [
    AUTO_LANGUAGE,
    ...ORDERED_DICTATION_LANGUAGES,
  ] satisfies DictationLanguageCode[]
).map((code) => ({
  code,
  label: DICTATION_LANGUAGES[code],
}));

const SUCCESS_VISIBLE_DELAY_MS = 900;

export const RetranscribeDialog = () => {
  const intl = useIntl();

  const open = useAppStore(
    (state) => state.transcriptions.retranscribeDialogOpen,
  );
  const transcriptionId = useAppStore(
    (state) => state.transcriptions.retranscribeDialogTranscriptionId,
  );

  const tones = useAppStore((state) => {
    const toneIds = getSortedToneIds(state);
    return toneIds
      .map((toneId) => getRec(state.toneById, toneId))
      .filter((tone): tone is Tone => tone !== null);
  });

  const defaultLanguage = useAppStore((state) => getMyDictationLanguage(state));

  const [selectedToneId, setSelectedToneId] = useState<string | null>(null);
  const [selectedLanguage, setSelectedLanguage] =
    useState<string>(defaultLanguage);

  useEffect(() => {
    if (open) {
      setSelectedToneId(tones[0]?.id ?? null);
      setSelectedLanguage(defaultLanguage);
    }
  }, [open, defaultLanguage, tones]);

  const handleClose = useCallback(() => {
    closeRetranscribeDialog();
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!transcriptionId) return;

    closeRetranscribeDialog();
    produceAppState((draft) => {
      if (!draft.transcriptions.retranscribingIds.includes(transcriptionId)) {
        draft.transcriptions.retranscribingIds.push(transcriptionId);
      }
      draft.transcriptions.retranscriptionSuccessIds =
        draft.transcriptions.retranscriptionSuccessIds.filter(
          (id) => id !== transcriptionId,
        );
    });

    let didSucceed = false;
    try {
      await retranscribeTranscription({
        transcriptionId,
        toneId: selectedToneId,
        languageCode: selectedLanguage,
      });
      didSucceed = true;
    } catch (error) {
      console.error("Failed to retranscribe audio", error);
      const fallbackMessage = intl.formatMessage({
        defaultMessage: "Unable to retranscribe audio snippet.",
      });
      const message = error instanceof Error ? error.message : fallbackMessage;
      showErrorSnackbar(message || fallbackMessage);
    } finally {
      produceAppState((draft) => {
        draft.transcriptions.retranscribingIds =
          draft.transcriptions.retranscribingIds.filter(
            (id) => id !== transcriptionId,
          );
        if (
          didSucceed &&
          !draft.transcriptions.retranscriptionSuccessIds.includes(
            transcriptionId,
          )
        ) {
          draft.transcriptions.retranscriptionSuccessIds.push(transcriptionId);
        }
      });
      if (didSucceed) {
        window.setTimeout(() => {
          produceAppState((draft) => {
            draft.transcriptions.retranscriptionSuccessIds =
              draft.transcriptions.retranscriptionSuccessIds.filter(
                (id) => id !== transcriptionId,
              );
          });
        }, SUCCESS_VISIBLE_DELAY_MS);
      }
    }
  }, [transcriptionId, selectedToneId, selectedLanguage, intl]);

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        <FormattedMessage defaultMessage="Retranscribe" />
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <FormControl fullWidth size="small">
            <InputLabel>
              <FormattedMessage defaultMessage="Style" />
            </InputLabel>
            <Select
              label={intl.formatMessage({ defaultMessage: "Style" })}
              value={selectedToneId ?? ""}
              onChange={(e) => {
                const value = e.target.value;
                setSelectedToneId(value || null);
              }}
            >
              {tones.map((tone) => (
                <MenuItem key={tone.id} value={tone.id}>
                  {tone.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl fullWidth size="small">
            <InputLabel>
              <FormattedMessage defaultMessage="Language" />
            </InputLabel>
            <Select
              label={intl.formatMessage({ defaultMessage: "Language" })}
              value={selectedLanguage}
              onChange={(e) =>
                setSelectedLanguage(e.target.value as DictationLanguageCode)
              }
              MenuProps={{ PaperProps: { sx: { maxHeight: 300 } } }}
            >
              {languageOptions.map(({ code, label }) => (
                <MenuItem key={code} value={code}>
                  {label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>
          <FormattedMessage defaultMessage="Cancel" />
        </Button>
        <Button variant="contained" onClick={handleSubmit}>
          <FormattedMessage defaultMessage="Transcribe" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};
