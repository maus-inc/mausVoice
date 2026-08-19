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
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { Tone } from "@maus-inc/types";
import { getRec } from "@maus-inc/utilities";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { importAudioFile } from "../../actions/transcriptions.actions";
import { useAppStore } from "../../store";
import { TranscriptionsSideEffects } from "./TranscriptionsSideEffects";
import { TranscriptionRow } from "./TranscriptRow";
import { ScrollListPage } from "../common/ScrollListPage";
import {
  AUTO_LANGUAGE,
  DICTATION_LANGUAGES,
  type DictationLanguageCode,
  ORDERED_DICTATION_LANGUAGES,
} from "../../utils/language.utils";
import { isPostProcessingEnabled } from "../../utils/post-processing.utils";
import { getSortedToneIds } from "../../utils/tone.utils";
import { getMyDictationLanguage } from "../../utils/user.utils";

const languageOptions = (
  [
    AUTO_LANGUAGE,
    ...ORDERED_DICTATION_LANGUAGES,
  ] satisfies DictationLanguageCode[]
).map((code) => ({ code, label: DICTATION_LANGUAGES[code] }));

export default function TranscriptionsPage() {
  const intl = useIntl();
  const transcriptionIds = useAppStore(
    (state) => state.transcriptions.transcriptionIds,
  );
  const defaultLanguage = useAppStore((state) => getMyDictationLanguage(state));
  const postProcessingEnabled = useAppStore(isPostProcessingEnabled);
  const tones = useAppStore((state) =>
    getSortedToneIds(state)
      .map((id) => getRec(state.toneById, id))
      .filter((tone): tone is Tone => Boolean(tone)),
  );
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [selectedToneId, setSelectedToneId] = useState<string | null>(null);
  const resolveImportLanguage = (language: string): DictationLanguageCode =>
    language === "keyboard-layout"
      ? AUTO_LANGUAGE
      : (language as DictationLanguageCode);

  const [selectedLanguage, setSelectedLanguage] =
    useState<DictationLanguageCode>(resolveImportLanguage(defaultLanguage));
  const [isImporting, setIsImporting] = useState(false);

  const prevImportDialogOpen = useRef(false);
  useEffect(() => {
    if (importDialogOpen && !prevImportDialogOpen.current) {
      const state = useAppStore.getState();
      const firstTone = getSortedToneIds(state)
        .map((id) => getRec(state.toneById, id))
        .find((tone): tone is Tone => Boolean(tone));
      setSelectedToneId(firstTone?.id ?? null);
      setSelectedLanguage(resolveImportLanguage(getMyDictationLanguage(state)));
    }
    prevImportDialogOpen.current = importDialogOpen;
  }, [importDialogOpen]);

  const handleImport = async () => {
    const selected = await openFileDialog({
      multiple: false,
      directory: false,
      title: intl.formatMessage({ defaultMessage: "Choose audio file" }),
      filters: [
        {
          name: intl.formatMessage({ defaultMessage: "Audio" }),
          extensions: ["wav", "mp3", "flac", "ogg"],
        },
      ],
    });
    if (typeof selected !== "string" || selected.length === 0) return;

    setImportDialogOpen(false);
    setIsImporting(true);
    try {
      await importAudioFile({
        path: selected,
        toneId: postProcessingEnabled ? selectedToneId : null,
        languageCode: selectedLanguage,
      });
    } catch (error) {
      showErrorSnackbar(
        error instanceof Error
          ? error.message
          : intl.formatMessage({
              defaultMessage: "Unable to import audio file.",
            }),
      );
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <>
      <TranscriptionsSideEffects />
      <ScrollListPage
        title={<FormattedMessage defaultMessage="History" />}
        subtitle={
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
            <span>
              <FormattedMessage
                defaultMessage="{count} {count, plural, one {transcription} other {transcriptions}}"
                values={{ count: transcriptionIds.length }}
              />
            </span>
            <Button
              size="small"
              variant="outlined"
              onClick={() => setImportDialogOpen(true)}
              disabled={isImporting}
            >
              <FormattedMessage defaultMessage="Import audio" />
            </Button>
          </Stack>
        }
        items={transcriptionIds}
        computeItemKey={(id) => id}
        renderItem={(id) => <TranscriptionRow key={id} id={id} />}
      />

      <Dialog
        open={importDialogOpen}
        onClose={() => setImportDialogOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>
          <FormattedMessage defaultMessage="Import audio" />
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            {postProcessingEnabled && (
              <FormControl fullWidth size="small">
                <InputLabel>
                  <FormattedMessage defaultMessage="Style" />
                </InputLabel>
                <Select
                  label={intl.formatMessage({ defaultMessage: "Style" })}
                  value={selectedToneId ?? ""}
                  onChange={(event) =>
                    setSelectedToneId(event.target.value || null)
                  }
                >
                  {tones.map((tone) => (
                    <MenuItem key={tone.id} value={tone.id}>
                      {tone.name}
                    </MenuItem>
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
                onChange={(event) =>
                  setSelectedLanguage(
                    event.target.value as DictationLanguageCode,
                  )
                }
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
          <Button onClick={() => setImportDialogOpen(false)}>
            <FormattedMessage defaultMessage="Cancel" />
          </Button>
          <Button variant="contained" onClick={() => void handleImport()}>
            <FormattedMessage defaultMessage="Choose file" />
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
