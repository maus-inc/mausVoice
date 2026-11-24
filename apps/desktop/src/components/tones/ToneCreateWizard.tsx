import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
} from "@mui/material";
import { FormattedMessage } from "react-intl";
import { useTonePreview } from "./useTonePreview";
import { useToneWizard } from "./useToneCreateWizard";

import { BusyButtonLabel } from "../common/BusyButtonLabel";
import { ToneCreateDiscard } from "./ToneCreateDiscard";
import { ToneBasicsFields } from "./ToneBasicsFields";
import { ToneCreateReview } from "./ToneCreateReview";
import { ToneTuneFields } from "./ToneTuneFields";
import { ToneWizardStepper } from "./ToneWizardStepper";

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
