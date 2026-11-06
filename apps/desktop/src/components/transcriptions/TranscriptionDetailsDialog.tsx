import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
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
import { getRec } from "@maus-inc/utilities";
import { useMemo } from "react";
import { FormattedMessage } from "react-intl";
import {
  closeTranscriptionDetailsDialog,
  openRetranscribeDialog,
} from "../../actions/transcriptions.actions";
import { useAppStore } from "../../store";
import { TranscriptionMetadataDetails } from "./TranscriptionMetadataDetails";
import { TranscriptionOutputs } from "./TranscriptionOutputs";

export const TranscriptionDetailsDialog = () => {
  const open = useAppStore((state) => state.transcriptions.detailsDialogOpen);
  const transcription = useAppStore((state) => {
    const transcriptionId = state.transcriptions.detailsDialogTranscriptionId;
    if (!transcriptionId) {
      return null;
    }
    return getRec(state.transcriptionById, transcriptionId);
  });
  const apiKeysById = useAppStore((state) => state.apiKeyById);

  const isRetranscribing = useAppStore((state) =>
    transcription?.id
      ? state.transcriptions.retranscribingIds.includes(transcription.id)
      : false,
  );
  const didRetranscribe = useAppStore((state) =>
    transcription?.id
      ? state.transcriptions.retranscriptionSuccessIds.includes(
          transcription.id,
        )
      : false,
  );

  const retranscribeResultIcon = didRetranscribe ? (
    <CheckCircleRoundedIcon color="success" />
  ) : (
    <ReplayRoundedIcon />
  );

  const rawTranscriptText = useMemo(
    () => transcription?.rawTranscript ?? transcription?.transcript ?? "",
    [transcription?.rawTranscript, transcription?.transcript],
  );

  return (
    <Dialog
      open={open}
      onClose={closeTranscriptionDetailsDialog}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>
        <FormattedMessage defaultMessage="Transcription Details" />
      </DialogTitle>
      <DialogContent dividers>
        {transcription ? (
          <Stack spacing={3}>
            <TranscriptionOutputs
              open={open}
              transcription={transcription}
              rawTranscriptText={rawTranscriptText}
            />

            <TranscriptionMetadataDetails
              transcription={transcription}
              apiKeysById={apiKeysById}
              rawTranscriptText={rawTranscriptText}
            />
          </Stack>
        ) : (
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            <FormattedMessage defaultMessage="Metadata unavailable for this transcription." />
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button
          startIcon={
            isRetranscribing ? (
              <CircularProgress size={16} color="inherit" />
            ) : (
              retranscribeResultIcon
            )
          }
          onClick={() => {
            if (transcription?.id) {
              closeTranscriptionDetailsDialog();
              openRetranscribeDialog(transcription.id);
            }
          }}
          disabled={isRetranscribing || !transcription}
        >
          <FormattedMessage defaultMessage="Retranscribe" />
        </Button>
        <Button onClick={closeTranscriptionDetailsDialog}>
          <FormattedMessage defaultMessage="Close" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};
