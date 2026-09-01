import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  Stack,
  Typography,
} from "@mui/material";
import { FormattedMessage } from "react-intl";
import { produceAppState, useAppStore } from "../../store";
import { DialogTitleWithClose } from "../common/DialogTitleWithClose";
import { AIPostProcessingConfiguration } from "./AIPostProcessingConfiguration";

export const AIPostProcessingDialog = () => {
  const open = useAppStore(
    (state) => state.settings.aiPostProcessingDialogOpen,
  );

  const handleClose = () => {
    produceAppState((draft) => {
      draft.settings.aiPostProcessingDialogOpen = false;
    });
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitleWithClose onClose={handleClose}>
        <FormattedMessage defaultMessage="AI post processing" />
      </DialogTitleWithClose>
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
            <FormattedMessage defaultMessage="Tell mausVoice how to enhance your transcripts after they are created." />
          </Typography>

          <AIPostProcessingConfiguration />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>
          <FormattedMessage defaultMessage="Done" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};
