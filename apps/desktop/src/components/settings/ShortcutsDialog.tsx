import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material";
import { useId } from "react";
import { FormattedMessage } from "react-intl";
import { produceAppState, useAppStore } from "../../store";
import { getIsAssistantModeEnabled } from "../../utils/assistant-mode.utils";
import { getEffectiveStylingMode } from "../../utils/feature.utils";
import { HotkeySetting } from "./HotkeySetting";
import { DIALOG_SHORTCUTS, SHORTCUT_COPY } from "./shortcut-copy";

export const ShortcutsDialog = () => {
  const titleId = useId();
  const descriptionId = useId();
  const isAssistantModeEnabled = useAppStore(getIsAssistantModeEnabled);
  const { open, hotkeysStatus, isManualStyling } = useAppStore((state) => ({
    open: state.settings.shortcutsDialogOpen,
    hotkeysStatus: state.settings.hotkeysStatus,
    isManualStyling: getEffectiveStylingMode(state) === "manual",
  }));

  const handleClose = () => {
    produceAppState((draft) => {
      draft.settings.shortcutsDialogOpen = false;
    });
  };

  const renderContent = () => {
    if (hotkeysStatus === "loading") {
      return (
        <Stack
          direction="row"
          sx={{
            justifyContent: "center",
            alignItems: "center",
            py: 4,
          }}
        >
          <CircularProgress size={24} />
        </Stack>
      );
    }

    // The one key here that is conditional on a mode rather than always
    // present: with assistant mode off there is no agent session to dictate
    // into, so the row would offer a key that does nothing.
    const rows = DIALOG_SHORTCUTS.filter(
      (row) =>
        isAssistantModeEnabled ||
        row.action !== SHORTCUT_COPY.assistantDictate.action,
    );

    return (
      <Stack spacing={3}>
        {rows.map((row) => (
          <HotkeySetting
            key={row.action}
            title={row.title}
            description={row.description}
            actionName={row.action}
          />
        ))}
        {isManualStyling && (
          <>
            <HotkeySetting
              title={SHORTCUT_COPY.nextStyle.title}
              description={SHORTCUT_COPY.nextStyle.description}
              actionName={SHORTCUT_COPY.nextStyle.action}
            />
            <HotkeySetting
              title={SHORTCUT_COPY.previousStyle.title}
              description={SHORTCUT_COPY.previousStyle.description}
              actionName={SHORTCUT_COPY.previousStyle.action}
            />
          </>
        )}
      </Stack>
    );
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <DialogTitle id={`${titleId}-wrapper`}>
        <Stack spacing={1}>
          <Typography id={titleId} variant="h6">
            <FormattedMessage defaultMessage="Keyboard shortcuts" />
          </Typography>
          <Typography id={descriptionId} variant="body2" color="textSecondary">
            <FormattedMessage defaultMessage="Customize your keyboard shortcuts. Keyboard shortcuts can be triggered from within any app." />
          </Typography>
        </Stack>
      </DialogTitle>
      <DialogContent dividers>{renderContent()}</DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>
          <FormattedMessage defaultMessage="Close" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};
