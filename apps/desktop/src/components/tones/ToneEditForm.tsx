import { DeleteForeverOutlined } from "@mui/icons-material";
import SaveIcon from "@mui/icons-material/Save";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { Tone } from "@maus-inc/types";
import { MAX_PREVIEW_SAMPLE_LEN } from "../../actions/tone-preview.actions";
import { useCallback, useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { deleteTone, upsertTone } from "../../actions/tone.actions";
import { getAppState } from "../../store";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { useTonePreview } from "./useTonePreview";

import { ToneBasicsFields } from "./ToneBasicsFields";
import {
  PREVIEW_SAMPLE_MESSAGE,
  countLabel,
  sameToneDraft,
  MAX_OUTPUT_LEN,
  MAX_EXAMPLE_LEN,
  MAX_PROMPT_LEN,
} from "./tone-form.utils";

const trimOrUndefined = (value: string): string | undefined =>
  value.trim() || undefined;

export const ToneEditDialog = ({
  tone,
  onClose,
}: {
  tone: Tone;
  onClose: () => void;
}) => {
  const intl = useIntl();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));

  const [baseline, setBaseline] = useState(tone);
  const [name, setName] = useState(tone.name);
  const [category, setCategory] = useState(tone.category ?? "");
  const [outputLength, setOutputLength] = useState(tone.outputLength ?? "");
  const [exampleInputOutput, setExampleInputOutput] = useState(
    tone.exampleInputOutput ?? "",
  );
  const [promptTemplate, setPromptTemplate] = useState(tone.promptTemplate);
  const defaultSampleText = intl.formatMessage(PREVIEW_SAMPLE_MESSAGE);
  const [sampleText, setSampleText] = useState(() => defaultSampleText);
  const [showTester, setShowTester] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  // One shared busy latch: Save and Delete must never interleave, or the
  // slower command can resurrect a deleted style or overwrite a deletion.
  const isBusy = isSaving || isDeleting;
  // State drives the buttons; the ref takes ownership before React commits
  // that state, so two handlers in the same event batch cannot both write.
  const writePending = useRef(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isDiscardOpen, setIsDiscardOpen] = useState(false);

  const preview = useTonePreview(defaultSampleText);

  // A preview belongs to the exact sample and style fields that produced it.
  // Invalidate both completed results and in-flight requests; never auto-run
  // on every keystroke.
  useEffect(preview.cancel, [
    preview.cancel,
    sampleText,
    promptTemplate,
    category,
    outputLength,
    exampleInputOutput,
  ]);

  const trimmedName = name.trim();
  const trimmedPrompt = promptTemplate.trim();
  const hasChanges = !sameToneDraft(
    { name, promptTemplate, category, outputLength, exampleInputOutput },
    baseline,
  );
  const sourceChanged = !sameToneDraft(tone, baseline);

  useEffect(() => {
    if (hasChanges || isBusy || !sourceChanged) return;
    // Refresh only a pristine draft. A dirty draft remains available to copy
    // or discard, but it cannot silently overwrite an external revision.
    setBaseline(tone);
    setName(tone.name);
    setPromptTemplate(tone.promptTemplate);
    setCategory(tone.category ?? "");
    setOutputLength(tone.outputLength ?? "");
    setExampleInputOutput(tone.exampleInputOutput ?? "");
  }, [tone, hasChanges, isBusy, sourceChanged]);

  const isValid = trimmedName.length > 0 && trimmedPrompt.length > 0;

  const handleSave = useCallback(async () => {
    if (!isValid || isBusy || writePending.current) {
      return;
    }
    // Read synchronously as well: an external store update and this click
    // can share a React batch before the new props/disabled state commit.
    const liveTone = getAppState().toneById[tone.id];
    if (!liveTone || !sameToneDraft(liveTone, baseline)) return;
    writePending.current = true;
    setIsSaving(true);
    try {
      await upsertTone({
        ...liveTone,
        name: trimmedName,
        promptTemplate: trimmedPrompt,
        category: trimOrUndefined(category),
        outputLength: trimOrUndefined(outputLength),
        exampleInputOutput: trimOrUndefined(exampleInputOutput),
      });
      if (mounted.current) onClose();
    } catch {
      // upsertTone already surfaced an error snackbar; swallow the rethrow
      // so the UI callback does not create an unhandled rejection.
    } finally {
      writePending.current = false;
      setIsSaving(false);
    }
  }, [
    isValid,
    isBusy,
    baseline,
    tone,
    trimmedName,
    trimmedPrompt,
    category,
    outputLength,
    exampleInputOutput,
    onClose,
  ]);

  const handleDeleteTone = useCallback(async () => {
    if (isBusy || writePending.current) {
      return;
    }
    writePending.current = true;
    setIsDeleting(true);
    try {
      await deleteTone(tone.id);
      if (mounted.current) {
        setIsConfirmOpen(false);
        onClose();
      }
    } catch {
      // deleteTone already surfaced an error snackbar; swallow the rethrow
      // so the confirm-dialog callback does not create an unhandled rejection.
    } finally {
      writePending.current = false;
      setIsDeleting(false);
    }
  }, [tone.id, onClose, isBusy]);

  const handleRequestClose = useCallback(() => {
    if (isBusy || writePending.current) {
      return;
    }
    if (hasChanges) {
      setIsDiscardOpen(true);
      return;
    }
    onClose();
  }, [hasChanges, onClose, isBusy]);

  const fields = {
    promptTemplate: trimmedPrompt,
    category: trimOrUndefined(category),
    outputLength: trimOrUndefined(outputLength),
    exampleInputOutput: trimOrUndefined(exampleInputOutput),
  };

  return (
    <>
      <Dialog
        open
        onClose={handleRequestClose}
        maxWidth="sm"
        fullWidth
        fullScreen={fullScreen}
      >
        <DialogTitle>
          <FormattedMessage defaultMessage="Edit style" />
        </DialogTitle>

        <DialogContent dividers sx={{ minHeight: 320 }}>
          {sourceChanged && hasChanges && !isBusy && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              <FormattedMessage defaultMessage="This style changed elsewhere. Close and reopen the editor before saving." />
            </Alert>
          )}
          <Stack spacing={3} sx={{ pt: 1 }}>
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                <FormattedMessage defaultMessage="Basics" />
              </Typography>
              <Stack spacing={2}>
                <ToneBasicsFields
                  name={name}
                  category={category}
                  onNameChange={setName}
                  onCategoryChange={setCategory}
                />
              </Stack>
            </Box>

            <Box>
              <Typography variant="subtitle2" gutterBottom>
                <FormattedMessage defaultMessage="Behavior" />
              </Typography>
              <Stack spacing={2}>
                <TextField
                  label={<FormattedMessage defaultMessage="Prompt" />}
                  value={promptTemplate}
                  onChange={(event) => setPromptTemplate(event.target.value)}
                  multiline
                  rows={6}
                  fullWidth
                  required
                  error={promptTemplate.length > 0 && !trimmedPrompt}
                  helperText={
                    promptTemplate.length > 0 && !trimmedPrompt ? (
                      <FormattedMessage defaultMessage="Describe how the style should sound." />
                    ) : (
                      countLabel(promptTemplate, MAX_PROMPT_LEN)
                    )
                  }
                  slotProps={{ htmlInput: { maxLength: MAX_PROMPT_LEN } }}
                />
                <TextField
                  label={<FormattedMessage defaultMessage="Output length" />}
                  value={outputLength}
                  onChange={(event) => setOutputLength(event.target.value)}
                  fullWidth
                  helperText={countLabel(outputLength, MAX_OUTPUT_LEN)}
                  placeholder={intl.formatMessage({
                    defaultMessage: "1–3 sentences",
                  })}
                  slotProps={{ htmlInput: { maxLength: MAX_OUTPUT_LEN } }}
                />
              </Stack>
            </Box>

            <Box>
              <Typography variant="subtitle2" gutterBottom>
                <FormattedMessage defaultMessage="Examples" />
              </Typography>
              <TextField
                label={
                  <FormattedMessage defaultMessage="Example input and output" />
                }
                value={exampleInputOutput}
                onChange={(event) => setExampleInputOutput(event.target.value)}
                multiline
                rows={3}
                fullWidth
                helperText={countLabel(exampleInputOutput, MAX_EXAMPLE_LEN)}
                placeholder={intl.formatMessage({
                  defaultMessage: "Input: ... Output: ...",
                })}
                slotProps={{ htmlInput: { maxLength: MAX_EXAMPLE_LEN } }}
              />
            </Box>

            <Accordion
              disableGutters
              expanded={showTester}
              onChange={(_, expanded) => setShowTester(expanded)}
            >
              <AccordionSummary>
                <Typography variant="subtitle2">
                  <FormattedMessage defaultMessage="Test style" />
                </Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Stack spacing={2}>
                  <TextField
                    value={sampleText}
                    label={
                      <FormattedMessage defaultMessage="Sample dictation to restyle..." />
                    }
                    slotProps={{
                      htmlInput: { maxLength: MAX_PREVIEW_SAMPLE_LEN },
                    }}
                    helperText={countLabel(sampleText, MAX_PREVIEW_SAMPLE_LEN)}
                    onChange={(event) => setSampleText(event.target.value)}
                    multiline
                    rows={3}
                    fullWidth
                    placeholder={intl.formatMessage({
                      defaultMessage: "Sample dictation to restyle...",
                    })}
                  />
                  <Box sx={{ display: "flex", gap: 1 }}>
                    <Button
                      variant="outlined"
                      size="small"
                      onClick={() => preview.run(fields, sampleText)}
                      disabled={preview.status === "running" || !trimmedPrompt}
                    >
                      <FormattedMessage defaultMessage="Run preview" />
                    </Button>
                    {preview.status === "running" && (
                      <Button
                        variant="text"
                        size="small"
                        onClick={preview.cancel}
                      >
                        <FormattedMessage defaultMessage="Cancel" />
                      </Button>
                    )}
                  </Box>
                  {preview.status === "running" && (
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                      <CircularProgress size={18} />
                      <Typography variant="body2" color="text.secondary">
                        <FormattedMessage defaultMessage="Styling the sample..." />
                      </Typography>
                    </Box>
                  )}
                  {preview.status === "done" && (
                    <Alert severity="success">
                      <Typography
                        variant="body2"
                        sx={{ whiteSpace: "pre-wrap" }}
                      >
                        {preview.output}
                      </Typography>
                    </Alert>
                  )}
                  {preview.status === "error" && (
                    <Alert severity="error">
                      <AlertTitle>
                        <FormattedMessage defaultMessage="Preview failed." />
                      </AlertTitle>
                      {preview.error}
                    </Alert>
                  )}
                  {preview.status === "unavailable" && (
                    <Alert severity="info">
                      <FormattedMessage defaultMessage="No text-generation provider is configured, so the preview cannot run." />
                    </Alert>
                  )}
                </Stack>
              </AccordionDetails>
            </Accordion>
          </Stack>
        </DialogContent>

        <DialogActions sx={{ px: 3, pb: 2 }}>
          {!tone.isSystem && (
            <Button
              variant="text"
              onClick={() => setIsConfirmOpen(true)}
              disabled={isBusy}
              color="warning"
              sx={{ mr: "auto" }}
              startIcon={<DeleteForeverOutlined />}
            >
              <FormattedMessage defaultMessage="Delete" />
            </Button>
          )}
          <Button variant="text" onClick={handleRequestClose} disabled={isBusy}>
            <FormattedMessage defaultMessage="Cancel" />
          </Button>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={handleSave}
            disabled={isBusy || sourceChanged || !isValid || !hasChanges}
          >
            <FormattedMessage defaultMessage="Save changes" />
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        isOpen={isConfirmOpen}
        title={<FormattedMessage defaultMessage="Delete style" />}
        content={
          <FormattedMessage defaultMessage="Are you sure you want to delete this style?" />
        }
        onCancel={() => setIsConfirmOpen(false)}
        onConfirm={handleDeleteTone}
        busy={isBusy}
        confirmLabel={<FormattedMessage defaultMessage="Delete" />}
        confirmButtonProps={{ color: "error", disabled: isBusy }}
      />

      <ConfirmDialog
        isOpen={isDiscardOpen}
        title={<FormattedMessage defaultMessage="Discard changes?" />}
        content={
          <FormattedMessage defaultMessage="You have unsaved changes. Closing now loses them." />
        }
        busy={isBusy}
        onCancel={() => {
          if (!writePending.current) setIsDiscardOpen(false);
        }}
        onConfirm={() => {
          if (isBusy || writePending.current) return;
          setIsDiscardOpen(false);
          onClose();
        }}
        confirmLabel={<FormattedMessage defaultMessage="Discard" />}
        confirmButtonProps={{ color: "warning", disabled: isBusy }}
      />
    </>
  );
};
