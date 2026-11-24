import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { getRec } from "@maus-inc/utilities";
import { FormattedMessage, useIntl } from "react-intl";
import {
  closeTranscriptionDetailsDialog,
  openRetranscribeDialog,
} from "../../actions/transcriptions.actions";
import { useAppStore } from "../../store";
import {
  useTranscriptionModelLabels,
  useTranscriptionTextLabels,
} from "./use-transcription-details-labels";
import { TranscriptionTextBlock } from "./TranscriptionTextBlock";
import { useFinalTranscriptEditor } from "./use-final-transcript-editor";

const DetailField = ({
  label,
  value,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
}) => (
  <Box>
    <Typography variant="caption" sx={{ color: "text.secondary" }}>
      {label}
    </Typography>
    <Typography variant="body2" sx={{ fontWeight: 600 }}>
      {value}
    </Typography>
  </Box>
);

export const TranscriptionDetailsDialog = () => {
  const intl = useIntl();
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

  const modelLabels = useTranscriptionModelLabels({
    transcription,
    apiKeysById,
  });
  const {
    transcriptionModeLabel,
    postProcessModeLabel,
    transcriptionApiKeyLabel,
    postProcessApiKeyLabel,
    modelSizeLabel,
    deviceLabel,
    postProcessDeviceLabel,
    postProcessModelLabel,
  } = modelLabels;

  const finalTranscriptText = transcription?.transcript ?? "";

  const textLabels = useTranscriptionTextLabels({ transcription, intl });
  const {
    transcriptionPrompt,
    rawTranscriptText,
    sanitizedTranscriptText,
    postProcessPrompt,
    transcriptionDurationLabel,
    postprocessDurationLabel,
    warnings,
  } = textLabels;

  const editor = useFinalTranscriptEditor({
    transcriptionId: transcription?.id,
    open,
    finalTranscriptText,
    intl,
  });
  const {
    isEditingFinal,
    finalDraft,
    setFinalDraft,
    isSavingFinal,
    finalDraftRef,
    startEditingFinal,
    cancelEditingFinal,
    handleSaveFinal,
  } = editor;

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
                  label={
                    <FormattedMessage defaultMessage="Raw transcription" />
                  }
                  value={rawTranscriptText}
                  placeholder={
                    <FormattedMessage defaultMessage="Raw transcript unavailable." />
                  }
                  monospace
                />
                {sanitizedTranscriptText && (
                  <TranscriptionTextBlock
                    label={
                      <FormattedMessage defaultMessage="After replacements" />
                    }
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
                        disabled={
                          isSavingFinal || finalDraft.trim().length === 0
                        }
                      >
                        <FormattedMessage defaultMessage="Save" />
                      </Button>
                    </Stack>
                  </Box>
                ) : (
                  <Box>
                    <TranscriptionTextBlock
                      label={
                        <FormattedMessage defaultMessage="Final transcription" />
                      }
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

            {warnings.length > 0 && (
              <>
                <Divider />

                <Box>
                  <Typography
                    variant="overline"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    <FormattedMessage defaultMessage="Warnings" />
                  </Typography>
                  <Stack spacing={1} sx={{ mt: 1 }}>
                    {warnings.map((warning, index) => (
                      <Box
                        key={`warning-${index}`}
                        sx={(theme) => ({
                          p: 1,
                          borderRadius: 1,
                          bgcolor:
                            theme.vars?.palette.level1 ??
                            theme.palette.background.default,
                        })}
                      >
                        <Typography
                          variant="body2"
                          sx={(theme) => ({
                            color:
                              theme.vars?.palette.warning?.main ??
                              theme.palette.warning.main,
                          })}
                        >
                          {warning}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                </Box>
              </>
            )}

            {(transcriptionDurationLabel || postprocessDurationLabel) && (
              <>
                <Divider />

                <Box>
                  <Typography
                    variant="overline"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    <FormattedMessage defaultMessage="Performance" />
                  </Typography>
                  <Stack spacing={1.25} sx={{ mt: 1 }}>
                    {transcriptionDurationLabel && (
                      <DetailField
                        label={
                          <FormattedMessage defaultMessage="Transcription Duration" />
                        }
                        value={transcriptionDurationLabel}
                      />
                    )}
                    {postprocessDurationLabel && (
                      <DetailField
                        label={
                          <FormattedMessage defaultMessage="Post-processing Duration" />
                        }
                        value={postprocessDurationLabel}
                      />
                    )}
                  </Stack>
                </Box>
              </>
            )}

            <Divider />

            <Box>
              <Typography
                variant="overline"
                sx={{
                  color: "text.secondary",
                }}
              >
                <FormattedMessage defaultMessage="Transcription Step" />
              </Typography>
              <Stack spacing={1.25} sx={{ mt: 1 }}>
                <DetailField
                  label={<FormattedMessage defaultMessage="Mode" />}
                  value={transcriptionModeLabel}
                />
                <DetailField
                  label={<FormattedMessage defaultMessage="Device" />}
                  value={deviceLabel}
                />
                <DetailField
                  label={<FormattedMessage defaultMessage="Model Size" />}
                  value={modelSizeLabel}
                />
                <DetailField
                  label={<FormattedMessage defaultMessage="API key" />}
                  value={transcriptionApiKeyLabel}
                />
                <TranscriptionTextBlock
                  label={<FormattedMessage defaultMessage="Prompt" />}
                  value={transcriptionPrompt}
                  placeholder={
                    <FormattedMessage defaultMessage="No custom prompt applied." />
                  }
                  monospace
                />
              </Stack>
            </Box>

            <Divider />

            <Box>
              <Typography
                variant="overline"
                sx={{
                  color: "text.secondary",
                }}
              >
                <FormattedMessage defaultMessage="Post-processing Step" />
              </Typography>
              <Stack spacing={1.25} sx={{ mt: 1 }}>
                <DetailField
                  label={<FormattedMessage defaultMessage="Mode" />}
                  value={postProcessModeLabel}
                />
                <DetailField
                  label={<FormattedMessage defaultMessage="Processor" />}
                  value={postProcessDeviceLabel}
                />
                <DetailField
                  label={<FormattedMessage defaultMessage="Model" />}
                  value={postProcessModelLabel}
                />
                <DetailField
                  label={<FormattedMessage defaultMessage="API key" />}
                  value={postProcessApiKeyLabel}
                />
                <TranscriptionTextBlock
                  label={<FormattedMessage defaultMessage="Prompt" />}
                  value={postProcessPrompt}
                  placeholder={
                    <FormattedMessage defaultMessage="No LLM post-processing was applied." />
                  }
                  monospace
                />
              </Stack>
            </Box>
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
