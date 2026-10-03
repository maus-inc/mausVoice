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
import { useCallback, useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  closeRetranscribeDialog,
  retranscribeTranscription,
} from "../../actions/transcriptions.actions";
import { useAppStore } from "../../store";
import {
  AUTO_LANGUAGE,
  DICTATION_LANGUAGES,
  type DictationLanguageCode,
  ORDERED_DICTATION_LANGUAGES,
  toSelectableDictationLanguage,
} from "../../utils/language.utils";
import { isStyleSelectionAvailable } from "../../utils/post-processing.utils";
import { getSortedToneIds } from "../../utils/tone.utils";
import { getMyDictationLanguage } from "../../utils/user.utils";
import {
  chromeDialogPaperSx,
  chromeMenuItemSx,
  chromeSelectMenuProps,
  selectedOptionLabel,
} from "../common/chromeMenu";

const languageOptions = (
  [
    AUTO_LANGUAGE,
    ...ORDERED_DICTATION_LANGUAGES,
  ] satisfies DictationLanguageCode[]
).map((code) => ({
  code,
  label: DICTATION_LANGUAGES[code],
}));

/**
 * A select option that shows a check beside the currently chosen value.
 *
 * Extracted so the style and language pickers read as one element per option
 * instead of a MenuItem wrapping the label and a conditional Check five JSX
 * levels deep inside Dialog>DialogContent>Stack>FormControl>Select. The `key`
 * stays at each `.map` call site; only the row shape moved.
 */
const CheckableMenuItem = ({
  value,
  label,
  selected,
}: {
  value: string;
  label: React.ReactNode;
  selected: boolean;
}) => (
  <MenuItem value={value} sx={chromeMenuItemSx}>
    {label}
    {selected ? <Check size={16} strokeWidth={2} /> : null}
  </MenuItem>
);

export const RetranscribeDialog = () => {
  const intl = useIntl();

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

  const tones = useAppStore((state) => {
    const toneIds = getSortedToneIds(state);
    return toneIds
      .map((toneId) => getRec(state.toneById, toneId))
      .filter((tone): tone is Tone => tone !== null);
  });

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
          {styleSelectionAvailable && (
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
                MenuProps={chromeSelectMenuProps}
                renderValue={(value) =>
                  selectedOptionLabel(
                    value,
                    tones,
                    (tone) => tone.id,
                    (tone) => tone.name,
                  )
                }
              >
                {tones.map((tone) => (
                  <CheckableMenuItem
                    key={tone.id}
                    value={tone.id}
                    label={tone.name}
                    selected={tone.id === selectedToneId}
                  />
                ))}
              </Select>
            </FormControl>
          )}
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
              {languageOptions.map(({ code, label }) => (
                <CheckableMenuItem
                  key={code}
                  value={code}
                  label={label}
                  selected={code === selectedLanguage}
                />
              ))}
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
