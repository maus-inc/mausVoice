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
import { MAX_PREVIEW_SAMPLE_LEN } from "../../actions/tone-preview.actions";
import {
  useCallback,
  useEffect,
  useMemo,
  useEffectEvent,
  useState,
} from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { setAppTargetTone } from "../../actions/app-target.actions";
import { upsertTone } from "../../actions/tone.actions";
import { useAppStore } from "../../store";
import { createId } from "../../utils/id.utils";
import { useTonePreview } from "./useTonePreview";

import { ToneBasicsFields } from "./ToneBasicsFields";
import {
  PREVIEW_SAMPLE_MESSAGE,
  countLabel,
  MAX_OUTPUT_LEN,
  MAX_EXAMPLE_LEN,
  MAX_PROMPT_LEN,
} from "./tone-form.utils";

export const ToneCreateWizard = ({ onClose }: { onClose: () => void }) => {
  const intl = useIntl();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const toneById = useAppStore((state) => state.toneById);
  const targetId = useAppStore((state) => state.toneEditor.targetId);

  const [draftIdentity] = useState(() => ({
    id: createId(),
    createdAt: Date.now(),
  }));
  const [step, setStep] = useState(0);
  const [maxReached, setMaxReached] = useState(0);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [outputLength, setOutputLength] = useState("");
  const [exampleInputOutput, setExampleInputOutput] = useState("");
  const [promptTemplate, setPromptTemplate] = useState("");
  const defaultSampleText = intl.formatMessage(PREVIEW_SAMPLE_MESSAGE);
  const [sampleText, setSampleText] = useState(() => defaultSampleText);
  const [isSaving, setIsSaving] = useState(false);

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

  const runInitialPreview = useEffectEvent(() => {
    if (fields.promptTemplate.trim().length > 0) {
      void preview.run(fields, sampleText);
    }
  });
  const cancelPreview = preview.cancel;
  useEffect(() => {
    if (step === 2) runInitialPreview();
    else cancelPreview();
  }, [step, cancelPreview]);

  const handleCreate = useCallback(async () => {
    if (!canLeaveTune || isSaving) {
      return;
    }
    setIsSaving(true);
    try {
      const nextSortOrder =
        tones.length > 0 ? tones[tones.length - 1].sortOrder + 1 : 0;
      const newTone: Tone = {
        id: draftIdentity.id,
        name: trimmedName,
        promptTemplate: trimmedPrompt,
        isSystem: false,
        createdAt: draftIdentity.createdAt,
        sortOrder: toneById[draftIdentity.id]?.sortOrder ?? nextSortOrder,
        category: category.trim() || undefined,
        outputLength: outputLength.trim() || undefined,
        exampleInputOutput: exampleInputOutput.trim() || undefined,
      };
      await upsertTone(newTone, { activate: !targetId });
      if (targetId) {
        if (!(await setAppTargetTone(targetId, newTone.id))) return;
      }
      onClose();
    } catch {
      // upsertTone already displays the failure. Keep this draft and identity
      // for retry, including when storage succeeded but activation failed.
    } finally {
      setIsSaving(false);
    }
  }, [
    canLeaveTune,
    isSaving,
    draftIdentity,
    toneById,
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
            <ToneBasicsFields
              name={name}
              category={category}
              onNameChange={setName}
              onCategoryChange={setCategory}
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
                label={
                  <FormattedMessage defaultMessage="Sample dictation to restyle..." />
                }
                slotProps={{ htmlInput: { maxLength: MAX_PREVIEW_SAMPLE_LEN } }}
                helperText={countLabel(sampleText, MAX_PREVIEW_SAMPLE_LEN)}
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
              <Alert severity="error">
                <AlertTitle>
                  <FormattedMessage defaultMessage="Preview failed." />
                </AlertTitle>
                {preview.error}
              </Alert>
            )}
            {preview.status === "unavailable" && (
              <Alert severity="info">
                <FormattedMessage defaultMessage="No text-generation provider is configured, so the preview cannot run." />{" "}
                <FormattedMessage defaultMessage="You can create this style without a preview. Configure a text-generation provider to try it." />
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
