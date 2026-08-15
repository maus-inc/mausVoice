import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from "@mui/material";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FormattedMessage } from "react-intl";
import { produceAppState, useAppStore } from "../../store";

/**
 * Shown when the Windows UAC elevation prompt for admin-on-startup is
 * declined: the app continues running normally, and the user chooses between
 * staying in the unelevated session or closing the app.
 */
export const ElevationDeclinedDialog = () => {
  const open = useAppStore(
    (state) => state.settings.elevationDeclinedDialogOpen,
  );

  const handleLaunchNormally = () => {
    produceAppState((draft) => {
      draft.settings.elevationDeclinedDialogOpen = false;
    });
  };

  const handleCloseApp = () => {
    void getCurrentWindow().close();
  };

  return (
    <Dialog open={open} onClose={handleLaunchNormally} maxWidth="xs" fullWidth>
      <DialogTitle>
        <FormattedMessage defaultMessage="Administrator permission declined" />
      </DialogTitle>
      <DialogContent>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          <FormattedMessage defaultMessage="Windows declined the administrator prompt. mausVoice will keep running without administrator privileges — input capture may not work in apps that run as administrator." />
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button variant="outlined" onClick={handleCloseApp}>
          <FormattedMessage defaultMessage="Close mausVoice" />
        </Button>
        <Button variant="contained" onClick={handleLaunchNormally} autoFocus>
          <FormattedMessage defaultMessage="Launch normally" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};
