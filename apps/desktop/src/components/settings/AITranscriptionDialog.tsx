import CloseIcon from "@mui/icons-material/Close";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Typography,
} from "@mui/material";
import { FormattedMessage } from "react-intl";
import { produceAppState, useAppStore } from "../../store";
import { getTranscriptionProviderName } from "../../utils/transcription-privacy.utils";
import { AITranscriptionConfiguration } from "./AITranscriptionConfiguration";

export const AITranscriptionDialog = () => {
  const open = useAppStore((state) => state.settings.aiTranscriptionDialogOpen);
  const transcriptionProviderName = useAppStore(getTranscriptionProviderName);

  const closeDialog = () => {
    produceAppState((draft) => {
      draft.settings.aiTranscriptionDialogOpen = false;
    });
  };

  return (
    <Dialog open={open} onClose={closeDialog} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: "flex", alignItems: "center" }}>
        <FormattedMessage defaultMessage="AI transcription" />
        <IconButton
          aria-label="Close"
          onClick={closeDialog}
          size="small"
          sx={{ ml: "auto" }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack
          spacing={3}
          sx={{
            alignItems: "flex-start",
          }}
        >
          <Typography
            variant="body1"
            sx={{
              color: "text.secondary",
            }}
          >
            <FormattedMessage defaultMessage="Decide how mausVoice should transcribe your recordings, locally on your machine or through a connected provider." />
          </Typography>
          <AITranscriptionConfiguration />
          {transcriptionProviderName && (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              <FormattedMessage
                defaultMessage="Audio is sent to {provider} while you dictate, so text can come back immediately."
                values={{ provider: transcriptionProviderName }}
              />
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={closeDialog}>
          <FormattedMessage defaultMessage="Done" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};
