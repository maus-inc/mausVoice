import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Button,
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
import {
  useCallback,
  useEffect,
  useMemo,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { setAppTargetTone } from "../../actions/app-target.actions";
import { upsertTone } from "../../actions/tone.actions";
import { useAppStore } from "../../store";
import { createId } from "../../utils/id.utils";
import { useTonePreview } from "./useTonePreview";

import { BusyButtonLabel } from "../common/BusyButtonLabel";
import { ToneCreateDiscard } from "./ToneCreateDiscard";
import { ToneBasicsFields } from "./ToneBasicsFields";
import { ToneCreateReview } from "./ToneCreateReview";
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
  const [discardOpen, setDiscardOpen] = useState(false);
  const savePending = useRef(false);
  const mounted = useRef(false);
  const initialSampleText = useRef(defaultSampleText);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const hasDraft =
    Boolean(
      name || category || outputLength || exampleInputOutput || promptTemplate,
    ) || sampleText !== initialSampleText.current;
  const requestClose = () => {
    if (savePending.current) return;
    if (hasDraft) setDiscardOpen(true);
    else onClose();
  };
  // Focus the field once its wizard step has mounted.
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const sampleRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    promptRef.current?.focus();
    sampleRef.current?.focus();
  }, [step]);
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
      if (savePending.current || next < 0 || next > 2 || next > maxReached) {
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
    if (savePending.current) return;
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
    if (!canLeaveTune || isSaving || savePending.current) {
      return;
    }
    savePending.current = true;
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
      if (mounted.current) onClose();
    } catch {
      // upsertTone already displays the failure. Keep this draft and identity
      // for retry, including when storage succeeded but activation failed.
    } finally {
      savePending.current = false;
      if (mounted.current) setIsSaving(false);
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
    <>
      <Dialog
        open
        onClose={requestClose}
        maxWidth="sm"
        fullWidth
        fullScreen={fullScreen}
      >
        <DialogTitle>
          <FormattedMessage defaultMessage="Create style" />
        </DialogTitle>
        <DialogContent
          dividers
          sx={{ minHeight: "min(380px, max(0px, calc(100dvh - 220px)))" }}
        >
          <Stepper activeStep={step} sx={{ mb: 3 }}>
            {[
              intl.formatMessage({ defaultMessage: "Define" }),
              intl.formatMessage({ defaultMessage: "Tune" }),
              intl.formatMessage({ defaultMessage: "Test and review" }),
            ].map((label, index) =>
              index <= maxReached ? (
                <Step key={label} completed={index < step}>
                  <StepButton disabled={isSaving} onClick={() => goTo(index)}>
                    {label}
                  </StepButton>
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
                inputRef={promptRef}
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
            <ToneCreateReview
              sampleRef={sampleRef}
              sampleText={sampleText}
              setSampleText={setSampleText}
              preview={preview}
              fields={fields}
              trimmedName={trimmedName}
              trimmedPrompt={trimmedPrompt}
              category={category}
              outputLength={outputLength}
              isSaving={isSaving}
            />
          )}
        </DialogContent>

        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button variant="text" onClick={requestClose} disabled={isSaving}>
            <FormattedMessage defaultMessage="Cancel" />
          </Button>
          {step > 0 && (
            <Button
              variant="text"
              onClick={() => goTo(step - 1)}
              disabled={isSaving}
            >
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
              aria-busy={isSaving || undefined}
            >
              {isSaving ? (
                <BusyButtonLabel>
                  <FormattedMessage defaultMessage="Create" />
                </BusyButtonLabel>
              ) : (
                <FormattedMessage defaultMessage="Create" />
              )}
            </Button>
          )}
        </DialogActions>
      </Dialog>
      <ToneCreateDiscard
        open={discardOpen}
        onCancel={() => setDiscardOpen(false)}
        onDiscard={onClose}
      />
    </>
  );
};
