import { Close } from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Typography,
} from "@mui/material";
import type { Hotkey } from "@maus-inc/types";
import { useEffect, useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { getHotkeyRepo } from "../../repos";
import { produceAppState, useAppStore } from "../../store";
import { applyReplacedStyleHotkeys } from "../../utils/style-hotkey";
import { createId } from "../../utils/id.utils";
import {
  getHotkeyCombosForAction,
  getSwitchToStyleActionName,
  SWITCH_TO_STYLE_HOTKEY_PREFIX,
  syncHotkeyCombosToNative,
} from "../../utils/keyboard.utils";
import { HotKey } from "../common/HotKey";

type StyleHotkeyRow = {
  toneId: string;
  toneName: string;
  actionName: string;
  keys: string[];
};

/** Assign one optional global shortcut to each writing style. */
export const StyleHotkeysDialog = () => {
  const open = useAppStore((state) => state.settings.styleHotkeysDialogOpen);
  const toneById = useAppStore((state) => state.toneById);
  const tones = useMemo(
    () =>
      Object.values(toneById)
        .filter((tone) => !tone.isDeprecated)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [toneById],
  );
  const hotkeyById = useAppStore((state) => state.hotkeyById);
  const intl = useIntl();
  const [rows, setRows] = useState<StyleHotkeyRow[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRows(
      tones.map((tone) => {
        const actionName = getSwitchToStyleActionName(tone.id);
        return {
          toneId: tone.id,
          toneName: tone.name,
          actionName,
          keys:
            getHotkeyCombosForAction(useAppStore.getState(), actionName)[0] ??
            [],
        };
      }),
    );
    // Rebuild rows when the dialog opens, persisted shortcuts change, or the
    // available tone list changes while the dialog is open.
  }, [open, hotkeyById, tones]);

  const hasConflict = useMemo(() => {
    const filled = rows.filter((row) => row.keys.length > 0);
    for (let i = 0; i < filled.length; i += 1) {
      for (let j = i + 1; j < filled.length; j += 1) {
        const left = new Set(filled[i].keys.map((key) => key.toLowerCase()));
        const right = new Set(filled[j].keys.map((key) => key.toLowerCase()));
        if (
          left.size === right.size &&
          [...left].every((key) => right.has(key))
        ) {
          return true;
        }
      }
    }
    return false;
  }, [rows]);

  const close = () => {
    produceAppState((draft) => {
      draft.settings.styleHotkeysDialogOpen = false;
    });
  };

  const save = async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const state = useAppStore.getState();
      const prefix = SWITCH_TO_STYLE_HOTKEY_PREFIX;
      const existingIdByActionName = new Map(
        Object.values(state.hotkeyById)
          .filter((hotkey) => hotkey.actionName.startsWith(prefix))
          .map((hotkey) => [hotkey.actionName, hotkey.id]),
      );
      const next = rows
        .filter((row) => row.keys.length > 0)
        .map((row): Hotkey => ({
          id: existingIdByActionName.get(row.actionName) ?? createId(),
          actionName: row.actionName,
          keys: row.keys,
        }));

      const repo = getHotkeyRepo();
      const saved = await repo.replaceStyleHotkeys(prefix, next);

      produceAppState((draft) => {
        applyReplacedStyleHotkeys(draft, prefix, saved);
      });

      try {
        await syncHotkeyCombosToNative();
      } catch (error) {
        // The database replacement already committed in a single transaction,
        // so only the in-memory native sync failed. Surface the error and let
        // the user retry instead of silently reverting SQLite to a stale state.
        showErrorSnackbar(error);
        return;
      }
      close();
    } catch (error) {
      showErrorSnackbar(error);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={isSaving ? undefined : close}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>
        <FormattedMessage defaultMessage="Style hotkeys" />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          <FormattedMessage defaultMessage="Assign a shortcut to select a style directly. Leave a row empty to disable its shortcut." />
        </Typography>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.25}>
          {hasConflict && (
            <Alert severity="warning" variant="outlined">
              <FormattedMessage defaultMessage="Some style shortcuts overlap and may be difficult to trigger." />
            </Alert>
          )}
          {rows.map((row) => (
            <Stack
              key={row.toneId}
              direction="row"
              spacing={1.5}
              sx={{ alignItems: "center" }}
            >
              <HotKey
                value={row.keys}
                onChange={(keys) =>
                  setRows((current) =>
                    current.map((candidate) =>
                      candidate.toneId === row.toneId
                        ? { ...candidate, keys }
                        : candidate,
                    ),
                  )
                }
              />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2">{row.toneName}</Typography>
              </Box>
              {row.keys.length > 0 && (
                <IconButton
                  size="small"
                  aria-label={intl.formatMessage({
                    defaultMessage: "Clear style hotkey",
                  })}
                  onClick={() =>
                    setRows((current) =>
                      current.map((candidate) =>
                        candidate.toneId === row.toneId
                          ? { ...candidate, keys: [] }
                          : candidate,
                      ),
                    )
                  }
                >
                  <Close fontSize="small" color="disabled" />
                </IconButton>
              )}
            </Stack>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={isSaving}>
          <FormattedMessage defaultMessage="Cancel" />
        </Button>
        <Button
          variant="contained"
          onClick={() => void save()}
          disabled={isSaving}
        >
          <FormattedMessage defaultMessage="Save" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};
