import { useMediaQuery, useTheme } from "@mui/material";
import { Tone } from "@maus-inc/types";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { useIntl } from "react-intl";
import { setAppTargetTone } from "../../actions/app-target.actions";
import { upsertTone } from "../../actions/tone.actions";
import { useAppStore } from "../../store";
import { createId } from "../../utils/id.utils";
import { useTonePreview } from "./useTonePreview";
import { hasWizardDraft } from "./tone-wizard-draft";
import { PREVIEW_SAMPLE_MESSAGE } from "./tone-form.utils";

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
  const nextSortOrder = (tones.at(-1)?.sortOrder ?? -1) + 1;
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

export const useToneWizard = ({ onClose }: { onClose: () => void }) => {
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
