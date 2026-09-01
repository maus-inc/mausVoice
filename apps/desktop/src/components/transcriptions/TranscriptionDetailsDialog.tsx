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
import { useEffect, useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { saveCorrectedTranscript } from "../../actions/auto-learn.actions";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import {
  closeTranscriptionDetailsDialog,
  openRetranscribeDialog,
} from "../../actions/transcriptions.actions";
import { AppState } from "../../state/app.state";
import { useAppStore } from "../../store";
import { TranscriptionTextBlock } from "./TranscriptionTextBlock";

const formatModelSizeLabel = (
  modelSize?: string | null,
  unknownLabel: React.ReactNode = "Unknown",
): React.ReactNode => {
  const value = modelSize?.trim();
  if (!value) {
    return unknownLabel;
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
};

const resolveApiKeyLabel = (
  records: AppState["apiKeyById"],
  apiKeyId: string | null | undefined,
  noneLabel: string,
  unknownLabel: string,
): string => {
  if (!apiKeyId) {
    return noneLabel;
  }

  const record = records[apiKeyId];
  if (!record) {
    return unknownLabel;
  }

  const suffix = record.keySuffix?.trim();
  if (suffix && suffix.length > 0) {
    return `${record.name} (••••${suffix})`;
  }

  return record.name;
};

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

  const [isEditingFinal, setIsEditingFinal] = useState(false);
  const [finalDraft, setFinalDraft] = useState("");
  const [isSavingFinal, setIsSavingFinal] = useState(false);

  useEffect(() => {
    setIsEditingFinal(false);
    setFinalDraft("");
  }, [open, transcription?.id]);

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

  const transcriptionModeLabel = useMemo(() => {
    if (transcription?.transcriptionMode === "api") {
      return <FormattedMessage defaultMessage="API" />;
    }
    if (transcription?.transcriptionMode === "local") {
      return <FormattedMessage defaultMessage="Local" />;
    }
    return <FormattedMessage defaultMessage="Unknown" />;
  }, [transcription?.transcriptionMode]);

  const transcriptionApiKeyLabel = useMemo(
    () =>
      resolveApiKeyLabel(
        apiKeysById,
        transcription?.transcriptionApiKeyId,
        "None",
        "Unknown",
      ),
    [apiKeysById, transcription?.transcriptionApiKeyId],
  );

  const postProcessModeLabel = useMemo(() => {
    if (transcription?.postProcessMode === "api") {
      return <FormattedMessage defaultMessage="API" />;
    }
    return <FormattedMessage defaultMessage="Disabled" />;
  }, [transcription?.postProcessDevice, transcription?.postProcessMode]);

  const postProcessApiKeyLabel = useMemo(
    () =>
      resolveApiKeyLabel(
        apiKeysById,
        transcription?.postProcessApiKeyId,
        "None",
        "Unknown",
      ),
    [apiKeysById, transcription?.postProcessApiKeyId],
  );

  const modelSizeLabel = useMemo(
    () => formatModelSizeLabel(transcription?.modelSize ?? null, "Unknown"),
    [transcription?.modelSize],
  );

  const deviceLabel = useMemo(() => {
    const value = transcription?.inferenceDevice?.trim();
    return value && value.length > 0 ? (
      value
    ) : (
      <FormattedMessage defaultMessage="Unknown" />
    );
  }, [transcription?.inferenceDevice]);

  const postProcessDeviceLabel = useMemo(() => {
    const value = transcription?.postProcessDevice?.trim();
    return value && value.length > 0 ? (
      value
    ) : (
      <FormattedMessage defaultMessage="Unknown" />
    );
  }, [transcription?.postProcessDevice]);

  const transcriptionPrompt = useMemo(() => {
    const prompt = transcription?.transcriptionPrompt?.trim();
    return prompt && prompt.length > 0 ? prompt : null;
  }, [transcription?.transcriptionPrompt]);

  const rawTranscriptText = useMemo(
    () => transcription?.rawTranscript ?? transcription?.transcript ?? "",
    [transcription?.rawTranscript, transcription?.transcript],
  );

  const sanitizedTranscriptText = useMemo(
    () => transcription?.sanitizedTranscript ?? null,
    [transcription?.sanitizedTranscript],
  );

  const postProcessPrompt = useMemo(() => {
    let prompt = transcription?.postProcessPrompt?.trim() ?? "";
    if (rawTranscriptText) {
      prompt = prompt.replace(rawTranscriptText.trim(), "<transcript>");
    }

    return prompt && prompt.length > 0 ? prompt : null;
  }, [transcription?.postProcessPrompt, rawTranscriptText]);

  const finalTranscriptText = transcription?.transcript ?? "";

  const transcriptionDurationLabel = useMemo(() => {
    const ms = transcription?.transcriptionDurationMs;
    if (ms == null) return null;
    if (ms >= 1000) {
      return `${(ms / 1000).toFixed(2)}s`;
    }
    return `${ms}ms`;
  }, [transcription?.transcriptionDurationMs]);

  const postprocessDurationLabel = useMemo(() => {
    const ms = transcription?.postprocessDurationMs;
    if (ms == null) return null;
    if (ms >= 1000) {
      return `${(ms / 1000).toFixed(2)}s`;
    }
    return `${ms}ms`;
  }, [transcription?.postprocessDurationMs]);

  const warnings = useMemo(() => {
    if (!transcription?.warnings) {
      return [];
    }
    return transcription.warnings
      .map((warning) => warning.trim())
      .filter((warning) => warning.length > 0);
  }, [transcription?.warnings]);

  const startEditingFinal = () => {
    setFinalDraft(finalTranscriptText);
    setIsEditingFinal(true);
  };

  const cancelEditingFinal = () => {
    setIsEditingFinal(false);
    setFinalDraft("");
  };

  const handleSaveFinal = async () => {
    if (!transcription?.id) {
      return;
    }

    // Saving unchanged text would perform a needless DB write and run the
    // full glossary extraction pipeline for nothing.
    if (finalDraft.trim() === finalTranscriptText.trim()) {
      setIsEditingFinal(false);
      setFinalDraft("");
      return;
    }

    setIsSavingFinal(true);
    try {
      const { learnedTerms, failedTerms } = await saveCorrectedTranscript({
        transcriptionId: transcription.id,
        correctedText: finalDraft,
      });

      setIsEditingFinal(false);
      setFinalDraft("");

      if (learnedTerms.length === 1 && failedTerms === 0) {
        showSnackbar(
          intl.formatMessage(
            { defaultMessage: 'Added "{term}" to your dictionary' },
            { term: learnedTerms[0] },
          ),
          { mode: "success" },
        );
      } else if (learnedTerms.length > 0 && failedTerms === 0) {
        showSnackbar(
          intl.formatMessage(
            { defaultMessage: "Added {count} words to your dictionary" },
            { count: learnedTerms.length },
          ),
          { mode: "success" },
        );
      } else if (learnedTerms.length > 0 && failedTerms > 0) {
        showSnackbar(
          intl.formatMessage({
            defaultMessage:
              "Some corrected words were added to your dictionary, but others failed.",
          }),
          { mode: "warning" },
        );
      } else if (failedTerms > 0) {
        showSnackbar(
          intl.formatMessage({
            defaultMessage:
              "Transcript updated, but the corrected words could not be added to your dictionary.",
          }),
          { mode: "error" },
        );
      } else {
        showSnackbar(
          intl.formatMessage({ defaultMessage: "Transcript updated" }),
          { mode: "success" },
        );
      }
    } catch (error) {
      showErrorSnackbar(error);
    } finally {
      setIsSavingFinal(false);
    }
  };

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
                      autoFocus
                      fullWidth
                      multiline
                      minRows={3}
                      value={finalDraft}
                      onChange={(event) => setFinalDraft(event.target.value)}
                      disabled={isSavingFinal}
                      sx={{ mt: 0.5 }}
                      aria-label={intl.formatMessage({
                        defaultMessage: "Final transcription",
                      })}
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
                      <Box>
                        <Typography
                          variant="caption"
                          sx={{
                            color: "text.secondary",
                          }}
                        >
                          <FormattedMessage defaultMessage="Transcription Duration" />
                        </Typography>
                        <Typography
                          variant="body2"
                          sx={{
                            fontWeight: 600,
                          }}
                        >
                          {transcriptionDurationLabel}
                        </Typography>
                      </Box>
                    )}
                    {postprocessDurationLabel && (
                      <Box>
                        <Typography
                          variant="caption"
                          sx={{
                            color: "text.secondary",
                          }}
                        >
                          <FormattedMessage defaultMessage="Post-processing Duration" />
                        </Typography>
                        <Typography
                          variant="body2"
                          sx={{
                            fontWeight: 600,
                          }}
                        >
                          {postprocessDurationLabel}
                        </Typography>
                      </Box>
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
                <Box>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    <FormattedMessage defaultMessage="Mode" />
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: 600,
                    }}
                  >
                    {transcriptionModeLabel}
                  </Typography>
                </Box>
                <Box>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    <FormattedMessage defaultMessage="Device" />
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: 600,
                    }}
                  >
                    {deviceLabel}
                  </Typography>
                </Box>
                <Box>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    <FormattedMessage defaultMessage="Model Size" />
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: 600,
                    }}
                  >
                    {modelSizeLabel}
                  </Typography>
                </Box>
                <Box>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    <FormattedMessage defaultMessage="API Key" />
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: 600,
                    }}
                  >
                    {transcriptionApiKeyLabel}
                  </Typography>
                </Box>
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
                <Box>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    <FormattedMessage defaultMessage="Mode" />
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: 600,
                    }}
                  >
                    {postProcessModeLabel}
                  </Typography>
                </Box>
                <Box>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    <FormattedMessage defaultMessage="Processor" />
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: 600,
                    }}
                  >
                    {postProcessDeviceLabel}
                  </Typography>
                </Box>
                <Box>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    <FormattedMessage defaultMessage="API Key" />
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: 600,
                    }}
                  >
                    {postProcessApiKeyLabel}
                  </Typography>
                </Box>
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
            ) : didRetranscribe ? (
              <CheckCircleRoundedIcon color="success" />
            ) : (
              <ReplayRoundedIcon />
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
