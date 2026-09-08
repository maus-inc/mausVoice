import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import type { Tone } from "@maus-inc/types";
import { getRec } from "@maus-inc/utilities";
import { Check, FileUp } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { importAudioFile } from "../../actions/transcriptions.actions";
import { useAppStore } from "../../store";
import { threadDayGroup, type ThreadDayGroup } from "../../utils/date.utils";
import {
  AUTO_LANGUAGE,
  DICTATION_LANGUAGES,
  type DictationLanguageCode,
  ORDERED_DICTATION_LANGUAGES,
} from "../../utils/language.utils";
import { isPostProcessingEnabled } from "../../utils/post-processing.utils";
import { getSortedToneIds } from "../../utils/tone.utils";
import { getMyDictationLanguage } from "../../utils/user.utils";
import {
  chromeDialogPaperSx,
  chromeMenuItemSx,
  chromeSelectMenuProps,
} from "../common/chromeMenu";
import { DialogTitleWithClose } from "../common/DialogTitleWithClose";
import { ScrollListPage } from "../common/ScrollListPage";
import { TranscriptionRow } from "./TranscriptRow";
import { TranscriptionsSideEffects } from "./TranscriptionsSideEffects";

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
  const transcriptionById = useAppStore((state) => state.transcriptionById);
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

  const dayLabelById = useMemo(() => {
    const labels = new Map<string, ThreadDayGroup | null>();
    const occupied = new Set<ThreadDayGroup>();
    let previous: ThreadDayGroup | null = null;
    for (const id of transcriptionIds) {
      const row = transcriptionById[id];
      if (!row) continue;
      const group = threadDayGroup(row.createdAt);
      occupied.add(group);
      labels.set(id, group !== previous ? group : null);
      previous = group;
    }
    if (occupied.size < 2) {
      return new Map<string, ThreadDayGroup | null>();
    }
    return labels;
  }, [transcriptionIds, transcriptionById]);

  const groupLabel = (group: ThreadDayGroup) => {
    switch (group) {
      case "today":
        return intl.formatMessage({ defaultMessage: "Today" });
      case "yesterday":
        return intl.formatMessage({ defaultMessage: "Yesterday" });
      case "earlier":
        return intl.formatMessage({ defaultMessage: "Earlier" });
    }
  };

  const handleImport = async () => {
    setIsImporting(true);
    try {
      const imported = await importAudioFile({
        toneId: postProcessingEnabled ? selectedToneId : null,
        languageCode: selectedLanguage,
      });
      // Keep the in-app dialog (and its Style/Language choices) open when the
      // user cancels the Rust-owned OS picker. Close only after a file was
      // actually selected and imported.
      if (imported) setImportDialogOpen(false);
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

  const closeImport = () => {
    if (!isImporting) setImportDialogOpen(false);
  };

  return (
    <>
      <TranscriptionsSideEffects />
      <ScrollListPage
        title={<FormattedMessage defaultMessage="History" />}
        subtitle={
          <FormattedMessage
            defaultMessage="{count} {count, plural, one {transcription} other {transcriptions}}"
            values={{ count: transcriptionIds.length }}
          />
        }
        action={
          <Button
            size="small"
            variant="outlined"
            startIcon={<FileUp size={14} strokeWidth={2} />}
            onClick={() => setImportDialogOpen(true)}
            disabled={isImporting}
            sx={{ textTransform: "none", borderRadius: 999 }}
          >
            <FormattedMessage defaultMessage="Import audio" />
          </Button>
        }
        emptyState={
          <Stack spacing={1} sx={{ alignItems: "center", px: 2 }}>
            <Typography variant="h6" sx={{ textAlign: "center" }}>
              <FormattedMessage defaultMessage="No transcriptions yet." />
            </Typography>
            <Typography
              variant="body2"
              sx={{ color: "text.secondary", textAlign: "center" }}
            >
              <FormattedMessage defaultMessage="Dictate something, or import an audio file to get started." />
            </Typography>
          </Stack>
        }
        items={transcriptionIds}
        computeItemKey={(id) => id}
        renderItem={(id) => {
          const group = dayLabelById.get(id);
          return (
            <>
              {group ? (
                <Typography
                  variant="caption"
                  sx={{
                    display: "block",
                    pt: 1.5,
                    pb: 0.25,
                    color: "text.secondary",
                    fontWeight: 600,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                  }}
                >
                  {groupLabel(group)}
                </Typography>
              ) : null}
              <TranscriptionRow key={id} id={id} />
            </>
          );
        }}
      />

      <Dialog
        open={importDialogOpen}
        onClose={closeImport}
        maxWidth="xs"
        fullWidth
        slotProps={{ paper: { sx: chromeDialogPaperSx } }}
      >
        <DialogTitleWithClose onClose={closeImport}>
          <FormattedMessage defaultMessage="Import audio" />
        </DialogTitleWithClose>
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
                  MenuProps={chromeSelectMenuProps}
                >
                  {tones.map((tone) => (
                    <MenuItem
                      key={tone.id}
                      value={tone.id}
                      sx={chromeMenuItemSx}
                    >
                      {tone.name}
                      {tone.id === selectedToneId ? (
                        <Check size={16} strokeWidth={2} />
                      ) : null}
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
                MenuProps={chromeSelectMenuProps}
              >
                {languageOptions.map(({ code, label }) => (
                  <MenuItem key={code} value={code} sx={chromeMenuItemSx}>
                    {label}
                    {code === selectedLanguage ? (
                      <Check size={16} strokeWidth={2} />
                    ) : null}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={closeImport} disabled={isImporting}>
            <FormattedMessage defaultMessage="Cancel" />
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleImport()}
            disabled={isImporting}
          >
            <FormattedMessage defaultMessage="Choose file" />
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
