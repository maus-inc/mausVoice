import { Plus, X } from "lucide-react";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Select,
  SelectChangeEvent,
  Stack,
  Typography,
} from "@mui/material";
import { useMemo } from "react";
import { FormattedMessage } from "react-intl";
import { produceAppState, useAppStore } from "../../store";
import { createId } from "../../utils/id.utils";
import {
  DICTATION_LANGUAGE_OPTIONS,
  KEYBOARD_LAYOUT_LANGUAGE,
} from "../../utils/language.utils";
import { HotKey } from "../common/HotKey";
import { useDictationLanguageDraft } from "./useDictationLanguageDraft";

type DictationLanguageRowProps = {
  language: string;
  hotkeyKeys: string[];
  onLanguageChange: (language: string) => void;
  onHotkeyChange: (keys: string[]) => void;
  onDelete?: () => void;
  canDelete: boolean;
};

const DictationLanguageRow = ({
  language,
  hotkeyKeys,
  onLanguageChange,
  onHotkeyChange,
  onDelete,
  canDelete,
}: DictationLanguageRowProps) => {
  const handleLanguageChange = (event: SelectChangeEvent<string>) => {
    onLanguageChange(event.target.value);
  };

  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        alignItems: "center",
        width: "100%",
      }}
    >
      <HotKey value={hotkeyKeys} onChange={onHotkeyChange} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Select
          value={language}
          onChange={handleLanguageChange}
          size="small"
          variant="outlined"
          fullWidth
          MenuProps={{
            slotProps: {
              paper: {
                style: { maxHeight: 300 },
              },
            },
          }}
        >
          {DICTATION_LANGUAGE_OPTIONS.map(([value, label]) => (
            <MenuItem key={value} value={value}>
              {label}
            </MenuItem>
          ))}
        </Select>
      </Box>
      {canDelete && (
        <IconButton size="small" onClick={onDelete}>
          <X size={16} strokeWidth={1.9} />
        </IconButton>
      )}
    </Stack>
  );
};

export const DictationLanguageDialog = () => {
  const open = useAppStore(
    (state) => state.settings.dictationLanguageDialogOpen,
  );

  const {
    rows,
    setRows,
    ready,
    loadFailed,
    setAttempt,
    isSaving,
    saving,
    handleSave,
  } = useDictationLanguageDraft(open);

  const handleClose = () => {
    if (saving.current) return;
    produceAppState((draft) => {
      draft.settings.dictationLanguageDialogOpen = false;
    });
  };

  const handleLanguageChange = (rowId: string, language: string) => {
    setRows((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, language } : r)),
    );
  };

  const handleHotkeyChange = (rowId: string, keys: string[]) => {
    setRows((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, hotkeyKeys: keys } : r)),
    );
  };

  const handleDelete = (rowId: string) => {
    setRows((prev) => prev.filter((r) => r.rowId !== rowId));
  };

  const handleAddLanguage = () => {
    const usedLanguages = new Set(rows.map((r) => r.language));
    const available = DICTATION_LANGUAGE_OPTIONS.find(
      ([value]) =>
        value !== KEYBOARD_LAYOUT_LANGUAGE && !usedLanguages.has(value),
    );
    const language = available
      ? available[0]
      : DICTATION_LANGUAGE_OPTIONS[1][0];
    setRows((prev) => [
      ...prev,
      { rowId: createId(), language, hotkeyKeys: [] },
    ]);
  };

  const hasHotkeyConflict = useMemo(() => {
    const filled = rows.filter((r) => r.hotkeyKeys.length > 0);
    for (let i = 0; i < filled.length; i++) {
      for (let j = i + 1; j < filled.length; j++) {
        const a = new Set(filled[i].hotkeyKeys);
        const b = new Set(filled[j].hotkeyKeys);
        const aSubsetOfB = [...a].every((k) => b.has(k));
        const bSubsetOfA = [...b].every((k) => a.has(k));
        if (aSubsetOfB || bSubsetOfA) {
          return true;
        }
      }
    }
    return false;
  }, [rows]);

  const canDelete = rows.length > 1;

  return (
    <Dialog open={open} onClose={handleClose}>
      <DialogTitle>
        <FormattedMessage defaultMessage="Dictation language" />
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          <FormattedMessage defaultMessage="Configure multiple dictation languages with hotkeys." />
        </Typography>
      </DialogTitle>
      <DialogContent dividers sx={{ width: 480 }}>
        <Stack spacing={1} inert={isSaving}>
          {!ready &&
            (loadFailed ? (
              <Button onClick={() => setAttempt((value) => value + 1)}>
                <FormattedMessage defaultMessage="Retry" />
              </Button>
            ) : (
              <Typography>
                <FormattedMessage defaultMessage="Loading" />
              </Typography>
            ))}
          {hasHotkeyConflict && (
            <Alert severity="warning" variant="outlined">
              <FormattedMessage defaultMessage="Some hotkeys share overlapping keys, which may cause conflicts." />
            </Alert>
          )}
          {rows.map((row) => (
            <DictationLanguageRow
              key={row.rowId}
              language={row.language}
              hotkeyKeys={row.hotkeyKeys}
              onLanguageChange={(lang) => handleLanguageChange(row.rowId, lang)}
              onHotkeyChange={(keys) => handleHotkeyChange(row.rowId, keys)}
              onDelete={() => handleDelete(row.rowId)}
              canDelete={canDelete}
            />
          ))}
          <Button
            variant="text"
            startIcon={<Plus size={16} strokeWidth={1.9} />}
            size="small"
            onClick={handleAddLanguage}
            disabled={!ready || isSaving}
            sx={{ alignSelf: "flex-end", py: 0.5 }}
          >
            <Typography
              variant="body2"
              sx={{
                fontWeight: 500,
              }}
            >
              <FormattedMessage defaultMessage="Add language" />
            </Typography>
          </Button>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={isSaving}>
          <FormattedMessage defaultMessage="Cancel" />
        </Button>
        <Button
          variant="contained"
          onClick={() => void handleSave()}
          disabled={!ready || isSaving}
        >
          <FormattedMessage defaultMessage="Save" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};
