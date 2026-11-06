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
import { useMemo } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useAppStore } from "../../store";
import { isStyleSelectionAvailable } from "../../utils/post-processing.utils";
import { getPrettyKeyName } from "../../utils/keyboard.utils";
import { HotKey } from "../common/HotKey";
import { PostProcessingDisabledTooltip } from "../styling/PostProcessingDisabledTooltip";
import { useStyleHotkeyDraft } from "./useStyleHotkeyDraft";

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
  const styleSelectionAvailable = useAppStore(isStyleSelectionAvailable);
  const intl = useIntl();
  const { rows, setRows, ready, failed, retry, isSaving, close, save } =
    useStyleHotkeyDraft(open, tones, styleSelectionAvailable);

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

  return (
    <Dialog
      open={open}
      onClose={isSaving ? undefined : close}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>
        <Box sx={{ display: "flex", alignItems: "flex-start" }}>
          <Box sx={{ flex: 1 }}>
            <FormattedMessage defaultMessage="Style hotkeys" />
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
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
        <Stack spacing={1.25} inert={isSaving}>
          {!ready &&
            (failed ? (
              <Button onClick={retry}>
                <FormattedMessage defaultMessage="Retry" />
              </Button>
            ) : (
              <Typography>
                <FormattedMessage defaultMessage="Loading" />
              </Typography>
            ))}
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
          disabled={!ready || isSaving || !styleSelectionAvailable}
        >
          <FormattedMessage defaultMessage="Save" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};
