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
import { FormattedMessage } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { getHotkeyRepo } from "../../repos";
import { produceAppState, useAppStore } from "../../store";
import { registerHotkeys } from "../../utils/app.utils";
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
  const tones = useAppStore((state) =>
    Object.values(state.toneById)
      .filter((tone) => !tone.isDeprecated)
      .sort((a, b) => a.sortOrder - b.sortOrder),
  );
  const hotkeyById = useAppStore((state) => state.hotkeyById);
  const [rows, setRows] = useState<StyleHotkeyRow[]>([]);

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
    // Rebuild rows when the dialog opens or persisted shortcuts change. The tone
    // list itself is derived from store state and is intentionally not a
    // dependency because the selector returns a fresh sorted array.
  }, [open, hotkeyById]);

  const hasConflict = useMemo(() => {
    const filled = rows.filter((row) => row.keys.length > 0);
    for (let i = 0; i < filled.length; i += 1) {
      for (let j = i + 1; j < filled.length; j += 1) {
        const left = new Set(filled[i].keys.map((key) => key.toLowerCase()));
        const right = new Set(filled[j].keys.map((key) => key.toLowerCase()));
        if (
          [...left].every((key) => right.has(key)) ||
          [...right].every((key) => left.has(key))
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
    try {
      const state = useAppStore.getState();
      const oldIds = Object.values(state.hotkeyById)
        .filter((hotkey) =>
          hotkey.actionName.startsWith(SWITCH_TO_STYLE_HOTKEY_PREFIX),
        )
        .map((hotkey) => hotkey.id);
      const next = rows
        .filter((row) => row.keys.length > 0)
        .map((row): Hotkey => ({
          id:
            Object.values(state.hotkeyById).find(
              (hotkey) => hotkey.actionName === row.actionName,
            )?.id ?? createId(),
          actionName: row.actionName,
          keys: row.keys,
        }));

      produceAppState((draft) => {
        for (const id of oldIds) {
          delete draft.hotkeyById[id];
          draft.settings.hotkeyIds = draft.settings.hotkeyIds.filter(
            (hotkeyId) => hotkeyId !== id,
          );
        }
        registerHotkeys(draft, next);
        for (const hotkey of next) {
          if (!draft.settings.hotkeyIds.includes(hotkey.id)) {
            draft.settings.hotkeyIds.push(hotkey.id);
          }
        }
      });

      const repo = getHotkeyRepo();
      await Promise.all(oldIds.map((id) => repo.deleteHotkey(id)));
      await Promise.all(next.map((hotkey) => repo.saveHotkey(hotkey)));
      await syncHotkeyCombosToNative();
      close();
    } catch (error) {
      showErrorSnackbar(error);
    }
  };

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth>
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
                  aria-label="Clear style hotkey"
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
        <Button onClick={close}>
          <FormattedMessage defaultMessage="Cancel" />
        </Button>
        <Button variant="contained" onClick={() => void save()}>
          <FormattedMessage defaultMessage="Save" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};
