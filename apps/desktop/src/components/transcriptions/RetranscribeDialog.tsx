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
import { Check } from "lucide-react";
import type { Tone } from "@maus-inc/types";
import { getRec } from "@maus-inc/utilities";
import { useCallback, useEffect, useId } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  closeRetranscribeDialog,
  retranscribeTranscriptionWithRecovery,
  setRetranscribeDialogLanguage,
  setRetranscribeDialogToneId,
} from "../../actions/transcriptions.actions";
import { useAppStore } from "../../store";
import {
  AUTO_LANGUAGE,
  type DictationLanguageCode,
  getRenderSafeLanguageLabel,
  ORDERED_DICTATION_LANGUAGES,
  toSelectableDictationLanguage,
} from "../../utils/language.utils";
import { isStyleSelectionAvailable } from "../../utils/post-processing.utils";
import { getSortedToneIds } from "../../utils/tone.utils";
import { getMyDictationLanguage } from "../../utils/user.utils";
import {
  chromeDialogPaperSx,
  chromeSelectMenuItemSx,
  chromeSelectMenuProps,
  chromeStyleSelectMenuProps,
  selectedOptionLabel,
} from "../common/chromeMenu";

const languageOptions = (
  [
    AUTO_LANGUAGE,
    ...ORDERED_DICTATION_LANGUAGES,
  ] satisfies DictationLanguageCode[]
).map((code) => ({
  code,
  label: getRenderSafeLanguageLabel(code),
}));

const renderCheckableMenuItem = (
  value: string,
  label: React.ReactNode,
  selected: boolean,
) => (
  <MenuItem key={value} value={value} sx={chromeSelectMenuItemSx}>
    {label}
    {selected ? <Check size={16} strokeWidth={2} /> : null}
  </MenuItem>
);

const resolveToneId = (
  tones: Tone[],
  selectedToneId: string | null,
  defaultToneId: string | null,
): string | null =>
  tones.find((tone) => tone.id === selectedToneId)?.id ??
  tones.find((tone) => tone.id === defaultToneId)?.id ??
  tones[0]?.id ??
  null;

const useRetranscribeSelection = (
  open: boolean,
  transcriptionId: string | null,
) => {
  const defaultLanguage = useAppStore((state) => getMyDictationLanguage(state));
  const tones = useAppStore((state) => {
    const toneIds = getSortedToneIds(state);
    return toneIds
      .map((toneId) => getRec(state.toneById, toneId))
      .filter((tone): tone is Tone => tone !== null);
  });
  const selection = useAppStore(
    (state) => state.transcriptions.retranscribeDialogSelection,
  );

  const isCurrentSession =
    open &&
    transcriptionId !== null &&
    selection?.transcriptionId === transcriptionId;
  const selectedLanguage =
    isCurrentSession && selection
      ? selection.selectedLanguage
      : toSelectableDictationLanguage(defaultLanguage);
  const resolvedToneId =
    isCurrentSession && selection
      ? resolveToneId(tones, selection.selectedToneId, selection.defaultToneId)
      : (tones[0]?.id ?? null);

  useEffect(() => {
    if (!isCurrentSession || !selection) return;

    const availableToneId = resolveToneId(
      tones,
      selection.selectedToneId,
      selection.defaultToneId,
    );
    if (availableToneId !== selection.selectedToneId) {
      setRetranscribeDialogToneId(availableToneId);
    }
  }, [isCurrentSession, selection, tones]);

  return {
    tones,
    resolvedToneId,
    setSelectedToneId: setRetranscribeDialogToneId,
    selectedLanguage,
    setSelectedLanguage: setRetranscribeDialogLanguage,
  };
};

export const RetranscribeDialog = () => {
  const intl = useIntl();
  const styleLabelId = useId();
  const languageLabelId = useId();

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
  const styleSelectionAvailable = useAppStore(isStyleSelectionAvailable);
  const {
    tones,
    resolvedToneId,
    setSelectedToneId,
    selectedLanguage,
    setSelectedLanguage,
  } = useRetranscribeSelection(open, transcriptionId);

  const handleClose = useCallback(() => {
    closeRetranscribeDialog();
  }, []);

  const handleSubmit = useCallback(() => {
    if (!transcriptionId || isRetranscribing) return;

    closeRetranscribeDialog();
    void retranscribeTranscriptionWithRecovery({
      transcriptionId,
      toneId: styleSelectionAvailable ? resolvedToneId : null,
      languageCode: selectedLanguage,
    });
  }, [
    transcriptionId,
    resolvedToneId,
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
          {styleSelectionAvailable && (
            <FormControl fullWidth size="small">
              <InputLabel id={styleLabelId}>
                <FormattedMessage defaultMessage="Style" />
              </InputLabel>
              <Select
                labelId={styleLabelId}
                label={intl.formatMessage({ defaultMessage: "Style" })}
                value={resolvedToneId ?? ""}
                onChange={(e) => {
                  const value = e.target.value;
                  setSelectedToneId(value || null);
                }}
                MenuProps={chromeStyleSelectMenuProps}
                renderValue={(value) =>
                  selectedOptionLabel(
                    value,
                    tones,
                    (tone) => tone.id,
                    (tone) => tone.name,
                  )
                }
              >
                {tones.map((tone) =>
                  renderCheckableMenuItem(
                    tone.id,
                    tone.name,
                    tone.id === resolvedToneId,
                  ),
                )}
              </Select>
            </FormControl>
          )}
          <FormControl fullWidth size="small">
            <InputLabel id={languageLabelId}>
              <FormattedMessage defaultMessage="Language" />
            </InputLabel>
            <Select
              labelId={languageLabelId}
              label={intl.formatMessage({ defaultMessage: "Language" })}
              value={selectedLanguage}
              onChange={(e) =>
                setSelectedLanguage(e.target.value as DictationLanguageCode)
              }
              MenuProps={chromeSelectMenuProps}
              renderValue={(value) =>
                selectedOptionLabel(
                  value,
                  languageOptions,
                  (option) => option.code,
                  (option) => option.label,
                )
              }
            >
              {languageOptions.map(({ code, label }) =>
                renderCheckableMenuItem(code, label, code === selectedLanguage),
              )}
            </Select>
          </FormControl>
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
