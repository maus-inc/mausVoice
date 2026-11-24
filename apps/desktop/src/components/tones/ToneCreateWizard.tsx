import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
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
import { ToneTuneFields } from "./ToneTuneFields";
import { ToneWizardStepper } from "./ToneWizardStepper";
import { hasWizardDraft } from "./tone-wizard-draft";
import { PREVIEW_SAMPLE_MESSAGE } from "./tone-form.utils";

const ToneWizardBody = ({
  step,
  maxReached,
  isSaving,
  onGoTo,
  fields,
  tune,
  review,
}: {
  step: number;
  maxReached: number;
  isSaving: boolean;
  onGoTo: (next: number) => void;
  fields: {
    name: string;
    setName: (value: string) => void;
    category: string;
    setCategory: (value: string) => void;
  };
  tune: {
    promptRef: React.RefObject<HTMLTextAreaElement | null>;
    promptTemplate: string;
    trimmedPrompt: string;
    outputLength: string;
    exampleInputOutput: string;
    setPromptTemplate: (value: string) => void;
    setOutputLength: (value: string) => void;
    setExampleInputOutput: (value: string) => void;
  };
  review: {
    sampleRef: React.RefObject<HTMLTextAreaElement | null>;
    sampleText: string;
    setSampleText: (value: string) => void;
    preview: ReturnType<typeof useTonePreview>;
    fields: {
      promptTemplate: string;
      category: string | undefined;
      outputLength: string | undefined;
      exampleInputOutput: string | undefined;
    };
    trimmedName: string;
    trimmedPrompt: string;
    category: string;
    outputLength: string;
    isSaving: boolean;
  };
}) => (
  <>
    <ToneWizardStepper
      step={step}
      maxReached={maxReached}
      disabled={isSaving}
      onGoTo={onGoTo}
    />

    {step === 0 && (
      <Stack spacing={3} sx={{ pt: 1 }}>
        <ToneBasicsFields
          name={fields.name}
          category={fields.category}
          onNameChange={fields.setName}
          onCategoryChange={fields.setCategory}
        />
      </Stack>
    )}

    {step === 1 && (
      <ToneTuneFields
        promptRef={tune.promptRef}
        promptTemplate={tune.promptTemplate}
        trimmedPrompt={tune.trimmedPrompt}
        outputLength={tune.outputLength}
        exampleInputOutput={tune.exampleInputOutput}
        onPromptChange={tune.setPromptTemplate}
        onOutputLengthChange={tune.setOutputLength}
        onExampleChange={tune.setExampleInputOutput}
      />
    )}

    {step === 2 && (
      <ToneCreateReview
        sampleRef={review.sampleRef}
        sampleText={review.sampleText}
        setSampleText={review.setSampleText}
        preview={review.preview}
        fields={review.fields}
        trimmedName={review.trimmedName}
        trimmedPrompt={review.trimmedPrompt}
        category={review.category}
        outputLength={review.outputLength}
        isSaving={review.isSaving}
      />
    )}
  </>
);

const ToneWizardActions = ({
  step,
  isSaving,
  canLeaveDefine,
  canLeaveTune,
  onClose,
  onBack,
  onNext,
  onCreate,
}: {
  step: number;
  isSaving: boolean;
  canLeaveDefine: boolean;
  canLeaveTune: boolean;
  onClose: () => void;
  onBack: () => void;
  onNext: () => void;
  onCreate: () => void;
}) => (
  <DialogActions sx={{ px: 3, pb: 2 }}>
    <Button variant="text" onClick={onClose} disabled={isSaving}>
      <FormattedMessage defaultMessage="Cancel" />
    </Button>
    {step > 0 && (
      <Button variant="text" onClick={onBack} disabled={isSaving}>
        <FormattedMessage defaultMessage="Back" />
      </Button>
    )}
    {step < 2 ? (
      <Button
        variant="contained"
        onClick={onNext}
        disabled={step === 0 ? !canLeaveDefine : !canLeaveTune}
      >
        <FormattedMessage defaultMessage="Next" />
      </Button>
    ) : (
      <Button
        variant="contained"
        onClick={onCreate}
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
);

const buildWizardTone = ({
  draftIdentity,
  trimmedName,
  trimmedPrompt,
  category,
  outputLength,
  exampleInputOutput,
  tones,
  toneById,
}: {
  draftIdentity: { id: string; createdAt: number };
  trimmedName: string;
  trimmedPrompt: string;
  category: string;
  outputLength: string;
  exampleInputOutput: string;
  tones: Tone[];
  toneById: Record<string, Tone | undefined>;
}): Tone => {
  const nextSortOrder =
    tones.length > 0 ? tones[tones.length - 1].sortOrder + 1 : 0;
  return {
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
};

const useToneWizardDraft = (intl: ReturnType<typeof useIntl>) => {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [outputLength, setOutputLength] = useState("");
  const [exampleInputOutput, setExampleInputOutput] = useState("");
  const [promptTemplate, setPromptTemplate] = useState("");
  const defaultSampleText = intl.formatMessage(PREVIEW_SAMPLE_MESSAGE);
  const [sampleText, setSampleText] = useState(() => defaultSampleText);
  const initialSampleText = useRef(defaultSampleText);
  const hasDraft = hasWizardDraft(
    { name, category, outputLength, exampleInputOutput, promptTemplate },
    sampleText,
    initialSampleText.current,
  );

  const trimmedName = name.trim();
  const trimmedPrompt = promptTemplate.trim();
  const canLeaveDefine = trimmedName.length > 0;
  const canLeaveTune = canLeaveDefine && trimmedPrompt.length > 0;

  const fields = useMemo(
    () => ({
      promptTemplate: trimmedPrompt,
      category: category.trim() || undefined,
      outputLength: outputLength.trim() || undefined,
      exampleInputOutput: exampleInputOutput.trim() || undefined,
    }),
    [trimmedPrompt, category, outputLength, exampleInputOutput],
  );

  return {
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
    sampleText,
    setSampleText,
    hasDraft,
    trimmedName,
    trimmedPrompt,
    canLeaveDefine,
    canLeaveTune,
    fields,
  };
};

const useToneWizardSteps = ({
  canLeaveDefine,
  canLeaveTune,
  savePending,
}: {
  canLeaveDefine: boolean;
  canLeaveTune: boolean;
  savePending: React.RefObject<boolean>;
}) => {
  const [step, setStep] = useState(0);
  const [maxReached, setMaxReached] = useState(0);
  // Focus the field once its wizard step has mounted.
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const sampleRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    promptRef.current?.focus();
    sampleRef.current?.focus();
  }, [step]);

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
    [maxReached, canLeaveDefine, canLeaveTune, savePending],
  );

  const goNext = useCallback(() => {
    if (savePending.current) return;
    const next = Math.min(step + 1, 2);
    setMaxReached((reached) => Math.max(reached, next));
    setStep(next);
  }, [step, savePending]);

  return { step, maxReached, promptRef, sampleRef, goTo, goNext };
};

const useToneWizardPreview = ({
  fields,
  sampleText,
  promptTemplate,
  category,
  outputLength,
  exampleInputOutput,
  step,
}: {
  fields: ReturnType<typeof useToneWizardDraft>["fields"];
  sampleText: string;
  promptTemplate: string;
  category: string;
  outputLength: string;
  exampleInputOutput: string;
  step: number;
}) => {
  const intl = useIntl();
  const preview = useTonePreview(intl.formatMessage(PREVIEW_SAMPLE_MESSAGE));
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

  return preview;
};

const useToneWizardSave = ({
  draftIdentity,
  draft,
  tones,
  toneById,
  targetId,
  onClose,
}: {
  draftIdentity: { id: string; createdAt: number };
  draft: ReturnType<typeof useToneWizardDraft>;
  tones: Tone[];
  toneById: Record<string, Tone | undefined>;
  targetId: string | null;
  onClose: () => void;
}) => {
  const [isSaving, setIsSaving] = useState(false);
  const savePending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const { trimmedName, trimmedPrompt, category, outputLength } = draft;
  const exampleInputOutput = draft.exampleInputOutput;
  const canLeaveTune = draft.canLeaveTune;

  const handleCreate = useCallback(async () => {
    if (!canLeaveTune || isSaving || savePending.current) {
      return;
    }
    savePending.current = true;
    setIsSaving(true);
    try {
      const newTone = buildWizardTone({
        draftIdentity,
        trimmedName,
        trimmedPrompt,
        category,
        outputLength,
        exampleInputOutput,
        tones,
        toneById,
      });
      await upsertTone(newTone, { activate: !targetId });
      if (targetId && !(await setAppTargetTone(targetId, newTone.id))) return;
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

  return { isSaving, savePending, handleCreate };
};

const useToneWizard = ({ onClose }: { onClose: () => void }) => {
  const intl = useIntl();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const toneById = useAppStore((state) => state.toneById);
  const targetId = useAppStore((state) => state.toneEditor.targetId);
  const draft = useToneWizardDraft(intl);
  const [draftIdentity] = useState(() => ({
    id: createId(),
    createdAt: Date.now(),
  }));
  const tones = useMemo(
    () =>
      Object.values(toneById).sort(
        (left, right) => left.sortOrder - right.sortOrder,
      ),
    [toneById],
  );
  const { isSaving, savePending, handleCreate } = useToneWizardSave({
    draftIdentity,
    draft,
    tones,
    toneById,
    targetId,
    onClose,
  });
  const { step, maxReached, promptRef, sampleRef, goTo, goNext } =
    useToneWizardSteps({
      canLeaveDefine: draft.canLeaveDefine,
      canLeaveTune: draft.canLeaveTune,
      savePending,
    });
  const preview = useToneWizardPreview({
    fields: draft.fields,
    sampleText: draft.sampleText,
    promptTemplate: draft.promptTemplate,
    category: draft.category,
    outputLength: draft.outputLength,
    exampleInputOutput: draft.exampleInputOutput,
    step,
  });
  const [discardOpen, setDiscardOpen] = useState(false);
  const requestClose = () => {
    if (savePending.current) return;
    if (draft.hasDraft) setDiscardOpen(true);
    else onClose();
  };

  return {
    fullScreen,
    step,
    maxReached,
    isSaving,
    discardOpen,
    setDiscardOpen,
    ...draft,
    preview,
    promptRef,
    sampleRef,
    requestClose,
    goTo,
    goNext,
    handleCreate,
  };
};

export const ToneCreateWizard = ({ onClose }: { onClose: () => void }) => {
  const {
    fullScreen,
    step,
    maxReached,
    isSaving,
    discardOpen,
    setDiscardOpen,
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
    sampleText,
    setSampleText,
    trimmedName,
    trimmedPrompt,
    canLeaveDefine,
    canLeaveTune,
    fields,
    preview,
    promptRef,
    sampleRef,
    requestClose,
    goTo,
    goNext,
    handleCreate,
  } = useToneWizard({ onClose });

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
          <ToneWizardBody
            step={step}
            maxReached={maxReached}
            isSaving={isSaving}
            onGoTo={goTo}
            fields={{ name, setName, category, setCategory }}
            tune={{
              promptRef,
              promptTemplate,
              trimmedPrompt,
              outputLength,
              exampleInputOutput,
              setPromptTemplate,
              setOutputLength,
              setExampleInputOutput,
            }}
            review={{
              sampleRef,
              sampleText,
              setSampleText,
              preview,
              fields,
              trimmedName,
              trimmedPrompt,
              category,
              outputLength,
              isSaving,
            }}
          />
        </DialogContent>

        <ToneWizardActions
          step={step}
          isSaving={isSaving}
          canLeaveDefine={canLeaveDefine}
          canLeaveTune={canLeaveTune}
          onClose={requestClose}
          onBack={() => goTo(step - 1)}
          onNext={goNext}
          onCreate={handleCreate}
        />
      </Dialog>
      <ToneCreateDiscard
        open={discardOpen}
        onCancel={() => setDiscardOpen(false)}
        onDiscard={onClose}
      />
    </>
  );
};
