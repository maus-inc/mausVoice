import type { Transcription } from "@maus-inc/types";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import {
  Box,
  Button,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { FormattedMessage } from "react-intl";
import { TranscriptionTextBlock } from "./TranscriptionTextBlock";
import { useFinalTranscriptEditor } from "./useFinalTranscriptEditor";

/** Transcript output and its correction workflow. */
export const TranscriptionOutputs = ({
  open,
  transcription,
  rawTranscriptText,
}: {
  open: boolean;
  transcription: Transcription;
  rawTranscriptText: string;
}) => {
  const finalTranscriptText = transcription.transcript ?? "";
  const sanitizedTranscriptText = transcription.sanitizedTranscript ?? null;
  const {
    isEditingFinal,
    finalDraft,
    setFinalDraft,
    isSavingFinal,
    finalDraftRef,
    startEditingFinal,
    cancelEditingFinal,
    handleSaveFinal,
  } = useFinalTranscriptEditor(open, transcription.id, finalTranscriptText);
  return (
    <Box>
      <Typography
        variant="overline"
        sx={{
          color: "text.secondary",
        }}
      >
        <FormattedMessage defaultMessage="Outputs" />
      </Typography>
      <Stack spacing={1.25} sx={{ mt: 1 }}>
        <TranscriptionTextBlock
          label={<FormattedMessage defaultMessage="Raw transcription" />}
          value={rawTranscriptText}
          placeholder={
            <FormattedMessage defaultMessage="Raw transcript unavailable." />
          }
          monospace
        />
        {sanitizedTranscriptText && (
          <TranscriptionTextBlock
            label={<FormattedMessage defaultMessage="After replacements" />}
            value={sanitizedTranscriptText}
            monospace
          />
        )}
        {isEditingFinal ? (
          <Box>
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
              }}
            >
              <FormattedMessage defaultMessage="Final transcription" />
            </Typography>
            <TextField
              inputRef={finalDraftRef}
              fullWidth
              multiline
              minRows={3}
              value={finalDraft}
              onChange={(event) => setFinalDraft(event.target.value)}
              disabled={isSavingFinal}
              sx={{ mt: 0.5 }}
            />
            <Stack
              direction="row"
              spacing={1}
              sx={{ justifyContent: "flex-end", mt: 1 }}
            >
              <Button
                size="small"
                variant="text"
                startIcon={<CloseRoundedIcon />}
                onClick={cancelEditingFinal}
                disabled={isSavingFinal}
              >
                <FormattedMessage defaultMessage="Cancel" />
              </Button>
              <Button
                size="small"
                variant="contained"
                startIcon={
                  isSavingFinal ? (
                    <CircularProgress size={16} color="inherit" />
                  ) : (
                    <CheckRoundedIcon />
                  )
                }
                onClick={handleSaveFinal}
                disabled={isSavingFinal || finalDraft.trim().length === 0}
              >
                <FormattedMessage defaultMessage="Save" />
              </Button>
            </Stack>
          </Box>
        ) : (
          <Box>
            <TranscriptionTextBlock
              label={<FormattedMessage defaultMessage="Final transcription" />}
              value={finalTranscriptText}
              placeholder={
                <FormattedMessage defaultMessage="Final transcript unavailable." />
              }
              monospace
            />
            {finalTranscriptText.trim().length > 0 && (
              <Button
                size="small"
                startIcon={<EditRoundedIcon />}
                onClick={startEditingFinal}
                sx={{ mt: 0.5 }}
              >
                <FormattedMessage defaultMessage="Edit" />
              </Button>
            )}
          </Box>
        )}
      </Stack>
    </Box>
  );
};
