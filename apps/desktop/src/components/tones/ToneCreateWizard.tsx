import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Step,
  StepButton,
  StepLabel,
  Stepper,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { Tone } from "@maus-inc/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { setAppTargetTone } from "../../actions/app-target.actions";
import { PREVIEW_SAMPLE_TEXT } from "../../actions/tone-preview.actions";
import { upsertTone } from "../../actions/tone.actions";
import { useAppStore } from "../../store";
import { createId } from "../../utils/id.utils";
import { useTonePreview } from "./useTonePreview";

const MAX_NAME_LEN = 120;
const MAX_CATEGORY_LEN = 80;
const MAX_OUTPUT_LEN = 120;
const MAX_EXAMPLE_LEN = 1200;
const MAX_PROMPT_LEN = 8000;

const countLabel = (value: string, max: number) => `${value.length}/${max}`;

export const ToneCreateWizard = ({ onClose }: { onClose: () => void }) => {
  const intl = useIntl();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const toneById = useAppStore((state) => state.toneById);
  const targetId = useAppStore((state) => state.toneEditor.targetId);

  const [step, setStep] = useState(0);
  const [maxReached, setMaxReached] = useState(0);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [outputLength, setOutputLength] = useState("");
  const [exampleInputOutput, setExampleInputOutput] = useState("");
  const [promptTemplate, setPromptTemplate] = useState("");
  const [sampleText, setSampleText] = useState(PREVIEW_SAMPLE_TEXT);
  const [isSaving, setIsSaving] = useState(false);

  const preview = useTonePreview();

  const tones = useMemo(
    () =>
      Object.values(toneById).sort(
        (left, right) => left.sortOrder - right.sortOrder,
      ),
    [toneById],
  );

  const trimmedName = name.trim();
  const trimmedPrompt = promptTemplate.trim();
  const canLeaveDefine = trimmedName.length > 0;
  const canLeaveTune = canLeaveDefine && trimmedPrompt.length > 0;

  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next > 2 || next > maxReached) {
        return;
      }
      if (next === 1 && !canLeaveDefine) {
        return;
      }
      if (next === 2 && !canLeaveTune) {
        return;
      }
      setStep(next);
    },
    [maxReached, canLeaveDefine, canLeaveTune],
  );

  const goNext = useCallback(() => {
    const next = Math.min(step + 1, 2);
    setMaxReached((reached) => Math.max(reached, next));
    setStep(next);
  }, [step]);

  const fields = useMemo(
    () => ({
      promptTemplate: trimmedPrompt,
      category: category.trim() || undefined,
      outputLength: outputLength.trim() || undefined,
      exampleInputOutput: exampleInputOutput.trim() || undefined,
    }),
    [trimmedPrompt, category, outputLength, exampleInputOutput],
  );

  const latest = useRef({ fields, sampleText });
  latest.current = { fields, sampleText };

  useEffect(() => {
    if (step !== 2) {
      preview.cancel();
      return;
    }
    const { fields: currentFields, sampleText: currentSample } = latest.current;
    if (currentFields.promptTemplate.trim().length > 0) {
      void preview.run(currentFields, currentSample);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const handleCreate = useCallback(async () => {
    if (!canLeaveTune || isSaving) {
      return;
    }
    setIsSaving(true);
    try {
      const nextSortOrder =
        tones.length > 0 ? tones[tones.length - 1].sortOrder + 1 : 0;
      const newTone: Tone = {
        id: createId(),
        name: trimmedName,
        promptTemplate: trimmedPrompt,
        isSystem: false,
        createdAt: Date.now(),
        sortOrder: nextSortOrder,
        category: category.trim() || undefined,
        outputLength: outputLength.trim() || undefined,
        exampleInputOutput: exampleInputOutput.trim() || undefined,
      };
      await upsertTone(newTone);
      if (targetId) {
        await setAppTargetTone(targetId, newTone.id);
      }
      onClose();
    } finally {
      setIsSaving(false);
    }
  }, [
    canLeaveTune,
    isSaving,
    tones,
    trimmedName,
    trimmedPrompt,
    category,
    outputLength,
    exampleInputOutput,
    targetId,
    onClose,
  ]);

  return (
    <Dialog
      open
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      fullScreen={fullScreen}
    >
      <DialogTitle>
        <FormattedMessage defaultMessage="Create style" />
      </DialogTitle>
      <DialogContent dividers sx={{ minHeight: 380 }}>
        <Stepper activeStep={step} sx={{ mb: 3 }}>
          {[
            intl.formatMessage({ defaultMessage: "Define" }),
            intl.formatMessage({ defaultMessage: "Tune" }),
            intl.formatMessage({ defaultMessage: "Test and review" }),
          ].map((label, index) =>
            index <= maxReached ? (
              <Step key={label} completed={index < step}>
                <StepButton onClick={() => goTo(index)}>{label}</StepButton>
              </Step>
            ) : (
              <Step key={label} completed={false}>
                <StepLabel>{label}</StepLabel>
              </Step>
            ),
          )}
        </Stepper>

        {step === 0 && (
          <Stack spacing={3} sx={{ pt: 1 }}>
            <TextField
              autoFocus
              label={<FormattedMessage defaultMessage="Name" />}
              value={name}
              onChange={(event) => setName(event.target.value)}
              fullWidth
              required
              error={name.length > 0 && !trimmedName}
              helperText={
                name.length > 0 && !trimmedName ? (
                  <FormattedMessage defaultMessage="Give the style a name." />
                ) : (
                  countLabel(name, MAX_NAME_LEN)
                )
              }
              placeholder={intl.formatMessage({
                defaultMessage: "Casual, Formal, Business...",
              })}
              slotProps={{ htmlInput: { maxLength: MAX_NAME_LEN } }}
            />
            <TextField
              label={<FormattedMessage defaultMessage="Category" />}
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              fullWidth
              helperText={countLabel(category, MAX_CATEGORY_LEN)}
              placeholder={intl.formatMessage({
                defaultMessage: "Writing, notes, developer...",
              })}
              slotProps={{ htmlInput: { maxLength: MAX_CATEGORY_LEN } }}
            />
          </Stack>
        )}

        {step === 1 && (
          <Stack spacing={3} sx={{ pt: 1 }}>
            <TextField
              autoFocus
              label={<FormattedMessage defaultMessage="Prompt" />}
              value={promptTemplate}
              onChange={(event) => setPromptTemplate(event.target.value)}
              multiline
              rows={5}
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
              placeholder={intl.formatMessage({
                defaultMessage:
                  "Make it sound like a professional but friendly email. Use jargon and fun words.",
              })}
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
            <Accordion disableGutters>
              <AccordionSummary>
                <Typography variant="subtitle2">
                  <FormattedMessage defaultMessage="Writing tips" />
                </Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Typography variant="body2" color="text.secondary">
                  <FormattedMessage defaultMessage="Name the voice first, then the rules. One sentence of example output beats a paragraph of adjectives. Mention what to avoid only when the model keeps doing it." />
                </Typography>
              </AccordionDetails>
            </Accordion>
            <Accordion disableGutters>
              <AccordionSummary>
                <Typography variant="subtitle2">
                  <FormattedMessage defaultMessage="Advanced" />
                </Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Typography variant="body2" color="text.secondary">
                  <FormattedMessage defaultMessage="The prompt runs as the style instruction on every post-processing pass, with your category, length, and example appended as guidance. Keep it under a paragraph so it stays cheap and predictable." />
                </Typography>
              </AccordionDetails>
            </Accordion>
          </Stack>
        )}

        {step === 2 && (
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                <FormattedMessage defaultMessage="Try it" />
              </Typography>
              <TextField
                autoFocus
                value={sampleText}
                onChange={(event) => setSampleText(event.target.value)}
                multiline
                rows={3}
                fullWidth
                placeholder={intl.formatMessage({
                  defaultMessage: "Sample dictation to restyle...",
                })}
              />
              <Box sx={{ display: "flex", gap: 1, mt: 1 }}>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => preview.run(fields, sampleText)}
                  disabled={preview.status === "running"}
                >
                  <FormattedMessage defaultMessage="Run preview" />
                </Button>
                {preview.status === "running" && (
                  <Button variant="text" size="small" onClick={preview.cancel}>
                    <FormattedMessage defaultMessage="Cancel" />
                  </Button>
                )}
              </Box>
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
                <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                  {preview.output}
                </Typography>
              </Alert>
            )}
            {preview.status === "error" && (
              <Alert severity="error">{preview.error}</Alert>
            )}
            {preview.status === "unavailable" && (
              <Alert severity="info">
                <FormattedMessage defaultMessage="No text-generation provider is configured, so the preview cannot run. You can still create this style now; the preview unlocks after provider setup." />
              </Alert>
            )}

            <Box>
              <Typography variant="subtitle2" gutterBottom>
                <FormattedMessage defaultMessage="Review" />
              </Typography>
              <Typography variant="body2">
                <strong>{trimmedName}</strong>
                {category.trim() && ` · ${category.trim()}`}
                {outputLength.trim() && ` · ${outputLength.trim()}`}
              </Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{
                  mt: 0.5,
                  display: "-webkit-box",
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {trimmedPrompt}
              </Typography>
            </Box>
          </Stack>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="text" onClick={onClose}>
          <FormattedMessage defaultMessage="Cancel" />
        </Button>
        {step > 0 && (
          <Button variant="text" onClick={() => goTo(step - 1)}>
            <FormattedMessage defaultMessage="Back" />
          </Button>
        )}
        {step < 2 ? (
          <Button
            variant="contained"
            onClick={goNext}
            disabled={step === 0 ? !canLeaveDefine : !canLeaveTune}
          >
            <FormattedMessage defaultMessage="Next" />
          </Button>
        ) : (
          <Button
            variant="contained"
            onClick={handleCreate}
            disabled={isSaving || !canLeaveTune}
          >
            <FormattedMessage defaultMessage="Create" />
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};
