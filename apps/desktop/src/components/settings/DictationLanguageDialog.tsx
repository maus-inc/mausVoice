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
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { produceAppState, useAppStore } from "../../store";
import { createId } from "../../utils/id.utils";
import {
  DICTATE_HOTKEY,
  getAdditionalLanguageEntries,
  getHotkeyCombosForAction,
} from "../../utils/keyboard.utils";
import {
  DICTATION_LANGUAGE_OPTIONS,
  KEYBOARD_LAYOUT_LANGUAGE,
} from "../../utils/language.utils";
import { getDetectedSystemLocale, getMyUser } from "../../utils/user.utils";
import { HotKey } from "../common/HotKey";
import { BusyButtonLabel } from "../common/BusyButtonLabel";
import { saveDictationLanguageSettings } from "./save-dictation-language-settings";

type DictationLanguageRowProps = {
  language: string;
  hotkeyKeys: string[];
  onLanguageChange: (language: string) => void;
  onHotkeyChange: (keys: string[]) => void;
  onDelete?: () => void;
  canDelete: boolean;
  index: number;
  disabled: boolean;
};

const DictationLanguageRow = ({
  language,
  hotkeyKeys,
  onLanguageChange,
  onHotkeyChange,
  onDelete,
  canDelete,
  index,
  disabled,
}: DictationLanguageRowProps) => {
  const intl = useIntl();
  const handleLanguageChange = (event: SelectChangeEvent<string>) => {
    onLanguageChange(event.target.value);
  };

  return (
    <Stack
      direction="row"
      spacing={1}
      useFlexGap
      sx={{
        alignItems: "center",
        flexWrap: "wrap",
        width: "100%",
      }}
    >
      <HotKey
        value={hotkeyKeys}
        disabled={disabled}
        onChange={onHotkeyChange}
        ariaLabel={intl.formatMessage(
          { defaultMessage: "Hotkey for language {number}" },
          { number: index + 1 },
        )}
      />
      <Box sx={{ flex: 1, minWidth: 120 }}>
        <Select
          value={language}
          disabled={disabled}
          onChange={handleLanguageChange}
          inputProps={{
            "aria-label": intl.formatMessage(
              { defaultMessage: "Language {number}" },
              { number: index + 1 },
            ),
          }}
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
        <IconButton
          size="small"
          disabled={disabled}
          onClick={onDelete}
          aria-label={intl.formatMessage(
            { defaultMessage: "Remove language {number}" },
            { number: index + 1 },
          )}
        >
          <X size={16} strokeWidth={1.9} />
        </IconButton>
      )}
    </Stack>
  );
};

type LanguageRow = {
  rowId: string;
  language: string;
  hotkeyKeys: string[];
};

export const DictationLanguageDialog = () => {
  const titleId = useId();
  const descriptionId = useId();
  const open = useAppStore(
    (state) => state.settings.dictationLanguageDialogOpen,
  );

  const storePrimaryLanguage = useAppStore((state) => {
    const user = getMyUser(state);
    return user?.preferredLanguage ?? getDetectedSystemLocale();
  });

  const storePrimaryHotkeyKeys = useAppStore((state) => {
    const combos = getHotkeyCombosForAction(state, DICTATE_HOTKEY);
    return combos[0] ?? [];
  });

  const storeAdditionalEntries = useAppStore(getAdditionalLanguageEntries);

  const [rows, setRows] = useState<LanguageRow[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const saveInFlight = useRef(false);
  const initialLanguage = useRef(storePrimaryLanguage);

  useEffect(() => {
    if (!open) return;
    setSaveFailed(false);
    initialLanguage.current = storePrimaryLanguage;
    setRows([
      {
        rowId: createId(),
        language: storePrimaryLanguage,
        hotkeyKeys: storePrimaryHotkeyKeys,
      },
      ...storeAdditionalEntries.map((entry) => ({
        rowId: createId(),
        language: entry.language,
        hotkeyKeys: entry.hotkeyCombos[0] ?? [],
      })),
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleClose = () => {
    if (saveInFlight.current) return;
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

  const handleSave = async () => {
    if (saveInFlight.current || rows.length === 0) return;
    saveInFlight.current = true;
    setIsSaving(true);
    try {
      await saveDictationLanguageSettings(
        rows,
        storePrimaryLanguage,
        initialLanguage.current,
      );
      produceAppState((draft) => {
        draft.settings.dictationLanguageDialogOpen = false;
      });
    } catch (error) {
      setSaveFailed(true);
      if (contentRef.current) contentRef.current.scrollTop = 0;
      showErrorSnackbar(error);
    } finally {
      saveInFlight.current = false;
      setIsSaving(false);
    }
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
    <Dialog
      open={open}
      onClose={handleClose}
      slotProps={{ paper: { sx: { width: 480 } } }}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <DialogTitle id={`${titleId}-wrapper`}>
        <span id={titleId}>
          <FormattedMessage defaultMessage="Dictation language" />
        </span>
        <Typography
          id={descriptionId}
          variant="body2"
          sx={{
            color: "text.secondary",
            "@media (max-height: 400px)": { display: "none" },
          }}
        >
          <FormattedMessage defaultMessage="Configure multiple dictation languages with hotkeys." />
        </Typography>
      </DialogTitle>
      <DialogContent
        ref={contentRef}
        dividers
        sx={
          saveFailed ? { "@media (max-height: 400px)": { pt: 1 } } : undefined
        }
      >
        <Stack spacing={1}>
          {saveFailed && (
            <Alert
              severity="error"
              variant="outlined"
              icon={false}
              sx={{ "@media (max-height: 400px)": { py: 0.5 } }}
            >
              <FormattedMessage defaultMessage="Save incomplete. Some changes may be saved. Retry or check settings after closing." />
            </Alert>
          )}
          <Typography
            aria-hidden
            variant="body2"
            color="text.secondary"
            sx={{
              display: "none",
              "@media (max-height: 400px)": { display: "block" },
            }}
          >
            <FormattedMessage defaultMessage="Configure multiple dictation languages with hotkeys." />
          </Typography>
          {hasHotkeyConflict && (
            <Alert severity="warning" variant="outlined">
              <FormattedMessage defaultMessage="Some hotkeys share overlapping keys, which may cause conflicts." />
            </Alert>
          )}
          {rows.map((row, index) => (
            <DictationLanguageRow
              key={row.rowId}
              disabled={isSaving}
              index={index}
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
            disabled={isSaving}
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
          disabled={isSaving}
          aria-busy={isSaving}
        >
          {isSaving ? (
            <BusyButtonLabel>
              <FormattedMessage defaultMessage="Save" />
            </BusyButtonLabel>
          ) : (
            <FormattedMessage defaultMessage="Save" />
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
