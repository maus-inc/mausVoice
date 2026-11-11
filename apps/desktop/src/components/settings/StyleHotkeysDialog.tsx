import { X } from "lucide-react";
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
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { loadHotkeys } from "../../actions/hotkey.actions";
import { getHotkeyRepo } from "../../repos";
import { produceAppState, useAppStore } from "../../store";
import { applyReplacedStyleHotkeys } from "../../utils/style-hotkey";
import { createId } from "../../utils/id.utils";
import { isStyleSelectionAvailable } from "../../utils/post-processing.utils";
import {
  getHotkeyCombosForAction,
  getPrettyKeyName,
  getSwitchToStyleActionName,
  SWITCH_TO_STYLE_HOTKEY_PREFIX,
  syncHotkeyCombosToNative,
} from "../../utils/keyboard.utils";
import { HotKey } from "../common/HotKey";
import { BusyButtonLabel } from "../common/BusyButtonLabel";
import { PostProcessingDisabledTooltip } from "../styling/PostProcessingDisabledTooltip";

type StyleHotkeyRow = {
  toneId: string;
  toneName: string;
  actionName: string;
  keys: string[];
};

const snapshotStyleHotkeys = (): Hotkey[] =>
  Object.values(useAppStore.getState().hotkeyById)
    .filter((hotkey) =>
      hotkey.actionName.startsWith(SWITCH_TO_STYLE_HOTKEY_PREFIX),
    )
    .map((hotkey) => ({ ...hotkey, keys: [...hotkey.keys] }));

/** Assign one optional global shortcut to each writing style. */
export const StyleHotkeysDialog = () => {
  const titleId = useId();
  const descriptionId = useId();
  const open = useAppStore((state) => state.settings.styleHotkeysDialogOpen);
  const toneById = useAppStore((state) => state.toneById);
  const tones = useMemo(
    () =>
      Object.values(toneById)
        .filter((tone) => !tone.isDeprecated)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [toneById],
  );
  const styleSelectionAvailable = useAppStore(isStyleSelectionAvailable);
  const intl = useIntl();
  const [rows, setRows] = useState<StyleHotkeyRow[]>([]);
  // The style group as it was read when the dialog opened. Native compares it
  // against the group it is about to replace, so a shortcut another dialog
  // saved meanwhile is reported instead of being deleted here.
  const [snapshot, setSnapshot] = useState<Hotkey[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const saveInFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    setSnapshot(snapshotStyleHotkeys());
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
    // Snapshot persisted shortcuts when the dialog opens or the tone list
    // changes. Do not depend on `hotkeyById`: unrelated store writes would
    // wipe in-progress edits.
  }, [open, tones]);

  useEffect(() => {
    if (open && !styleSelectionAvailable) {
      produceAppState((draft) => {
        draft.isRecordingHotkey = false;
      });
    }
  }, [open, styleSelectionAvailable]);

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

  const dismiss = () => {
    produceAppState((draft) => {
      draft.settings.styleHotkeysDialogOpen = false;
    });
  };

  const close = () => {
    if (!saveInFlight.current) dismiss();
  };

  const save = async () => {
    if (isSaving || saveInFlight.current || !styleSelectionAvailable) return;
    saveInFlight.current = true;
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
      const saved = await repo.replaceStyleHotkeys(
        prefix,
        next,
        undefined,
        snapshot,
      );

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
      dismiss();
    } catch (error) {
      if (String(error).includes("STYLE_HOTKEYS_CHANGED")) {
        // Another window saved the group first. Reload what it wrote and
        // re-snapshot, so the user edits the shortcuts that actually exist
        // instead of silently overwriting them on the next save.
        await loadHotkeys();
        setSnapshot(snapshotStyleHotkeys());
        setRows((current) =>
          current.map((row) => ({
            ...row,
            keys:
              getHotkeyCombosForAction(
                useAppStore.getState(),
                row.actionName,
              )[0] ?? [],
          })),
        );
        showErrorSnackbar(
          intl.formatMessage({
            defaultMessage:
              "Your style shortcuts changed in another window. Review them and save again.",
          }),
        );
        return;
      }
      showErrorSnackbar(error);
    } finally {
      saveInFlight.current = false;
      setIsSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={isSaving ? undefined : close}
      maxWidth="sm"
      fullWidth
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <DialogTitle id={`${titleId}-wrapper`}>
        <Box sx={{ display: "flex", alignItems: "flex-start" }}>
          <Box sx={{ flex: 1 }}>
            <span id={titleId}>
              <FormattedMessage defaultMessage="Style hotkeys" />
            </span>
            <Typography
              id={descriptionId}
              variant="body2"
              color="text.secondary"
              sx={{
                mt: 0.5,
                "@media (max-height: 400px)": { display: "none" },
              }}
            >
              <FormattedMessage defaultMessage="Assign a shortcut to select a style directly. Leave a row empty to disable its shortcut." />
            </Typography>
          </Box>
          <IconButton
            size="small"
            aria-label={intl.formatMessage({ defaultMessage: "Close" })}
            onClick={close}
            disabled={isSaving}
            sx={{ ml: 1, mt: -0.5 }}
          >
            <X size={16} strokeWidth={1.9} />
          </IconButton>
        </Box>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.25}>
          <Typography
            aria-hidden
            variant="body2"
            color="text.secondary"
            sx={{
              display: "none",
              "@media (max-height: 400px)": { display: "block" },
            }}
          >
            <FormattedMessage defaultMessage="Assign a shortcut to select a style directly. Leave a row empty to disable its shortcut." />
          </Typography>
          {styleSelectionAvailable && hasConflict && (
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
              {styleSelectionAvailable ? (
                <HotKey
                  ariaLabel={intl.formatMessage(
                    { defaultMessage: "Shortcut for {style}" },
                    { style: row.toneName },
                  )}
                  value={row.keys}
                  disabled={isSaving}
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
              ) : (
                <PostProcessingDisabledTooltip disabled>
                  <Button
                    variant="outlined"
                    disabled
                    sx={{ width: 200, height: 40, textTransform: "none" }}
                  >
                    {row.keys.length > 0 ? (
                      row.keys.map(getPrettyKeyName).join(" + ")
                    ) : (
                      <FormattedMessage defaultMessage="Set hotkey" />
                    )}
                  </Button>
                </PostProcessingDisabledTooltip>
              )}
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2">{row.toneName}</Typography>
              </Box>
              {styleSelectionAvailable && row.keys.length > 0 && (
                <IconButton
                  size="small"
                  disabled={isSaving}
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
                  <X size={16} strokeWidth={1.9} />
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
          disabled={isSaving || !styleSelectionAvailable}
          aria-busy={isSaving || undefined}
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
