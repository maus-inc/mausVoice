import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
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
import { useToneDraftPreview } from "./useToneDraftPreview";

import { ToneBasicsFields } from "./ToneBasicsFields";
import {
  ToneExampleField,
  ToneOutputLengthField,
  TonePreviewSampleField,
} from "./ToneGuidanceFields";
import { TonePreviewFeedback } from "./TonePreviewFeedback";
import { countLabel, MAX_PROMPT_LEN } from "./tone-form.utils";

const buildNewTone = ({
  identity,
  name,
  promptTemplate,
  category,
  outputLength,
  exampleInputOutput,
  tones,
  toneById,
}: {
  identity: { id: string; createdAt: number };
  name: string;
  promptTemplate: string;
  category: string;
  outputLength: string;
  exampleInputOutput: string;
  tones: Tone[];
  toneById: Record<string, Tone>;
}): Tone => {
  const lastSortOrder = tones.at(-1)?.sortOrder;
  const nextSortOrder = lastSortOrder === undefined ? 0 : lastSortOrder + 1;
  return {
    id: identity.id,
    name,
    promptTemplate,
    isSystem: false,
    createdAt: identity.createdAt,
    sortOrder: toneById[identity.id]?.sortOrder ?? nextSortOrder,
    category: category.trim() || undefined,
    outputLength: outputLength.trim() || undefined,
    exampleInputOutput: exampleInputOutput.trim() || undefined,
  };
};

// The draft keeps its identity across retries and owns all editable fields.
const useToneCreateDraft = () => {
  const [draftIdentity] = useState(() => ({
    id: createId(),
    createdAt: Date.now(),
  }));
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [outputLength, setOutputLength] = useState("");
  const [exampleInputOutput, setExampleInputOutput] = useState("");
  const [promptTemplate, setPromptTemplate] = useState("");
  const trimmedName = name.trim();
  const trimmedPrompt = promptTemplate.trim();
  const canLeaveDefine = trimmedName.length > 0;
  const canLeaveTune = canLeaveDefine && trimmedPrompt.length > 0;

  return {
    draftIdentity,
    name,
    setName,
    category,
    setCategory,
    outputLength,
    setOutputLength,
    exampleInputOutput,
    setExampleInputOutput,
    promptTemplate,
    setPromptTemplate,
    trimmedName,
    trimmedPrompt,
    canLeaveDefine,
    canLeaveTune,
  };
};

// Preview requests are owned by the current wizard step and field snapshot.
const useCreateTonePreview = ({
  step,
  promptTemplate,
  category,
  outputLength,
  exampleInputOutput,
}: {
  step: number;
  promptTemplate: string;
  category: string;
  outputLength: string;
  exampleInputOutput: string;
}) => {
  const { sampleText, setSampleText, preview, fields } = useToneDraftPreview({
    promptTemplate,
    category,
    outputLength,
    exampleInputOutput,
  });

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

  return { sampleText, setSampleText, preview, fields };
};

const ToneWizardStepper = ({
  step,
  maxReached,
  goTo,
}: {
  step: number;
  maxReached: number;
  goTo: (step: number) => void;
}) => {
  const intl = useIntl();
  return (
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
  );
};

const ToneWizardActions = ({
  step,
  onClose,
  goTo,
  goNext,
  canLeaveDefine,
  canLeaveTune,
  isSaving,
  handleCreate,
}: {
  step: number;
  onClose: () => void;
  goTo: (step: number) => void;
  goNext: () => void;
  canLeaveDefine: boolean;
  canLeaveTune: boolean;
  isSaving: boolean;
  handleCreate: () => void;
}) => (
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
);

const useToneWizardNavigation = (
  canLeaveDefine: boolean,
  canLeaveTune: boolean,
) => {
  const [step, setStep] = useState(0);
  const [maxReached, setMaxReached] = useState(0);
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

  return { step, maxReached, goTo, goNext };
};

const ToneTuneStep = ({
  promptRef,
  promptTemplate,
  setPromptTemplate,
  outputLength,
  setOutputLength,
  exampleInputOutput,
  setExampleInputOutput,
}: {
  promptRef: React.Ref<HTMLTextAreaElement>;
  promptTemplate: string;
  setPromptTemplate: (value: string) => void;
  outputLength: string;
  setOutputLength: (value: string) => void;
  exampleInputOutput: string;
  setExampleInputOutput: (value: string) => void;
}) => {
  const intl = useIntl();
  const trimmedPrompt = promptTemplate.trim();
  return (
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
      <ToneOutputLengthField value={outputLength} onChange={setOutputLength} />
      <ToneExampleField
        value={exampleInputOutput}
        onChange={setExampleInputOutput}
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
  );
};

const ToneReviewStep = ({
  sampleRef,
  sampleText,
  setSampleText,
  preview,
  fields,
  trimmedName,
  category,
  outputLength,
  trimmedPrompt,
}: {
  sampleRef: React.Ref<HTMLTextAreaElement>;
  sampleText: string;
  setSampleText: (value: string) => void;
  preview: ReturnType<typeof useToneDraftPreview>["preview"];
  fields: ReturnType<typeof useToneDraftPreview>["fields"];
  trimmedName: string;
  category: string;
  outputLength: string;
  trimmedPrompt: string;
}) => (
  <Stack spacing={2} sx={{ pt: 1 }}>
    <Box>
      <Typography variant="subtitle2" gutterBottom>
        <FormattedMessage defaultMessage="Try it" />
      </Typography>
      <TonePreviewSampleField
        value={sampleText}
        onChange={setSampleText}
        inputRef={sampleRef}
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

    <TonePreviewFeedback
      status={preview.status}
      output={preview.output}
      error={preview.error}
      canCreateWithoutPreview
    />

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
);

// A create attempt owns its in-flight write and cannot close a replacement editor.
const useToneCreateSave = ({
  canLeaveTune,
  draftIdentity,
  trimmedName,
  trimmedPrompt,
  category,
  outputLength,
  exampleInputOutput,
  onClose,
}: {
  canLeaveTune: boolean;
  draftIdentity: { id: string; createdAt: number };
  trimmedName: string;
  trimmedPrompt: string;
  category: string;
  outputLength: string;
  exampleInputOutput: string;
  onClose: () => void;
}) => {
  const toneById = useAppStore((state) => state.toneById);
  const targetId = useAppStore((state) => state.toneEditor.targetId);

  const [isSaving, setIsSaving] = useState(false);
  const writingRef = useRef(false);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const tones = useMemo(
    () =>
      Object.values(toneById).sort(
        (left, right) => left.sortOrder - right.sortOrder,
      ),
    [toneById],
  );

  const handleCreate = useCallback(async () => {
    if (!canLeaveTune || isSaving || writingRef.current) {
      return;
    }
    writingRef.current = true;
    setIsSaving(true);
    try {
      const newTone = buildNewTone({
        identity: draftIdentity,
        name: trimmedName,
        promptTemplate: trimmedPrompt,
        category,
        outputLength,
        exampleInputOutput,
        tones,
        toneById,
      });
      await upsertTone(newTone, { activate: !targetId });
      if (targetId) {
        if (!(await setAppTargetTone(targetId, newTone.id))) return;
      }
      if (mountedRef.current) onClose();
    } catch {
      // upsertTone already displays the failure. Keep this draft and identity
      // for retry, including when storage succeeded but activation failed.
    } finally {
      writingRef.current = false;
      if (mountedRef.current) setIsSaving(false);
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

  return { isSaving, handleCreate };
};

export const ToneCreateWizard = ({ onClose }: { onClose: () => void }) => {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const {
    draftIdentity,
    name,
    setName,
    category,
    setCategory,
    outputLength,
    setOutputLength,
    exampleInputOutput,
    setExampleInputOutput,
    promptTemplate,
    setPromptTemplate,
    trimmedName,
    trimmedPrompt,
    canLeaveDefine,
    canLeaveTune,
  } = useToneCreateDraft();
  const { step, maxReached, goTo, goNext } = useToneWizardNavigation(
    canLeaveDefine,
    canLeaveTune,
  );
  // Focus each step's field explicitly once it has mounted rather than with DOM
  // `autoFocus` props: `autoFocus` fires as an attribute and cannot be deferred,
  // so it races anything that moves focus in the same commit. This mirrors
  // ContextMenu's own "focus after commit, not via autoFocus" rule.
  //
  // These two fields render only for their own step, so the effect is keyed on
  // `step` rather than `[]`: on mount `step` is 0 and neither field is in the
  // tree, so a mount-only effect would never fire and the field would not be
  // focused on arrival. `TextField` forwards `inputRef` to the real element.
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const sampleRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    promptRef.current?.focus();
    sampleRef.current?.focus();
  }, [step]);

  const { sampleText, setSampleText, preview, fields } = useCreateTonePreview({
    step,
    promptTemplate,
    category,
    outputLength,
    exampleInputOutput,
  });

  const { isSaving, handleCreate } = useToneCreateSave({
    canLeaveTune,
    draftIdentity,
    trimmedName,
    trimmedPrompt,
    category,
    outputLength,
    exampleInputOutput,
    onClose,
  });

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
        <ToneWizardStepper step={step} maxReached={maxReached} goTo={goTo} />

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
          <ToneTuneStep
            promptRef={promptRef}
            promptTemplate={promptTemplate}
            setPromptTemplate={setPromptTemplate}
            outputLength={outputLength}
            setOutputLength={setOutputLength}
            exampleInputOutput={exampleInputOutput}
            setExampleInputOutput={setExampleInputOutput}
          />
        )}

        {step === 2 && (
          <ToneReviewStep
            sampleRef={sampleRef}
            sampleText={sampleText}
            setSampleText={setSampleText}
            preview={preview}
            fields={fields}
            trimmedName={trimmedName}
            category={category}
            outputLength={outputLength}
            trimmedPrompt={trimmedPrompt}
          />
        )}
      </DialogContent>

      <ToneWizardActions
        step={step}
        onClose={onClose}
        goTo={goTo}
        goNext={goNext}
        canLeaveDefine={canLeaveDefine}
        canLeaveTune={canLeaveTune}
        isSaving={isSaving}
        handleCreate={handleCreate}
      />
    </Dialog>
  );
};
