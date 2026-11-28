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
import {
  DIALOG_SHORTCUTS,
  SHORTCUT_COPY,
  shortcutDescription,
} from "./shortcut-copy";

export const ShortcutsDialog = () => {
  const titleId = useId();
  const descriptionId = useId();
  const assistantModeEnabled = useAppStore(getIsAssistantModeEnabled);
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

    // Every key stays listed. An assistant key pressed while the feature is
    // off opens the setting that turns it on, so hiding the row would hide the
    // one place that says so, and someone who already bound the key would have
    // no way back to it.
    return (
      <Stack spacing={3}>
        {DIALOG_SHORTCUTS.map((row) => (
          <HotkeySetting
            key={row.action}
            title={row.title}
            description={shortcutDescription(row, { assistantModeEnabled })}
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
