import {
  Alert,
  Dialog,
  DialogContent,
  DialogTitle,
  Stack,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { Tone } from "@maus-inc/types";
import { useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useTonePreview } from "./useTonePreview";
import { useToneEditDraft } from "./use-tone-edit-draft";
import { useToneEditWrite } from "./use-tone-edit-write";

import { ToneEditActions } from "./ToneEditActions";
import { ToneEditConfirmations } from "./ToneEditConfirmations";
import { ToneEditFields } from "./ToneEditFields";
import { TonePreviewPanel } from "./TonePreviewPanel";
import { PREVIEW_SAMPLE_MESSAGE } from "./tone-form.utils";

export const ToneEditDialog = ({
  tone,
  onClose,
}: {
  tone: Tone;
  onClose: () => void;
}) => {
  const intl = useIntl();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const defaultSampleText = intl.formatMessage(PREVIEW_SAMPLE_MESSAGE);
  const [sampleText, setSampleText] = useState(() => defaultSampleText);
  const preview = useTonePreview(defaultSampleText);
  const editor = useToneEditDraft(tone);
  const {
    draft,
    baseline,
    setName,
    setCategory,
    setOutputLength,
    setExampleInputOutput,
    setPromptTemplate,
    resetTo,
    trimmedName,
    trimmedPrompt,
    isValid,
    hasChanges,
    sourceChanged,
  } = editor;
  const {
    isBusy,
    isConfirmOpen,
    setIsConfirmOpen,
    isDiscardOpen,
    handleSave,
    handleDeleteTone,
    handleRequestClose,
    handleDiscard,
    handleCancelDiscard,
  } = useToneEditWrite({
    tone,
    onClose,
    draft,
    baseline,
    trimmedName,
    trimmedPrompt,
    isValid,
    hasChanges,
  });

  // A preview belongs to the exact sample and style fields that produced it.
  // Invalidate both completed results and in-flight requests; never auto-run
  // on every keystroke.
  useEffect(preview.cancel, [
    preview.cancel,
    sampleText,
    draft.promptTemplate,
    draft.category,
    draft.outputLength,
    draft.exampleInputOutput,
  ]);

  useEffect(() => {
    if (hasChanges || isBusy || !sourceChanged) return;
    // Refresh only a pristine draft. A dirty draft remains available to copy
    // or discard, but it cannot silently overwrite an external revision.
    resetTo(tone);
  }, [tone, hasChanges, isBusy, sourceChanged, resetTo]);

  const fields = {
    promptTemplate: trimmedPrompt,
    category: draft.category.trim() || undefined,
    outputLength: draft.outputLength.trim() || undefined,
    exampleInputOutput: draft.exampleInputOutput.trim() || undefined,
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

        <DialogContent
          dividers
          sx={{ minHeight: "min(320px, max(0px, calc(100dvh - 220px)))" }}
        >
          {sourceChanged && hasChanges && !isBusy && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              <FormattedMessage defaultMessage="This style changed elsewhere. Close and reopen the editor before saving." />
            </Alert>
          )}
          <Stack spacing={3} sx={{ pt: 1 }}>
            <ToneEditFields
              name={draft.name}
              category={draft.category}
              promptTemplate={draft.promptTemplate}
              outputLength={draft.outputLength}
              exampleInputOutput={draft.exampleInputOutput}
              trimmedPrompt={trimmedPrompt}
              onNameChange={setName}
              onCategoryChange={setCategory}
              onPromptChange={setPromptTemplate}
              onOutputLengthChange={setOutputLength}
              onExampleChange={setExampleInputOutput}
            />

            <TonePreviewPanel
              preview={preview}
              sampleText={sampleText}
              onSampleTextChange={setSampleText}
              fields={fields}
              canRun={trimmedPrompt.length > 0}
            />
          </Stack>
        </DialogContent>

        <ToneEditActions
          isSystem={tone.isSystem}
          isBusy={isBusy}
          canSave={!sourceChanged && isValid && hasChanges}
          onDelete={() => setIsConfirmOpen(true)}
          onClose={handleRequestClose}
          onSave={handleSave}
        />
      </Dialog>

      <ToneEditConfirmations
        deleteOpen={isConfirmOpen}
        discardOpen={isDiscardOpen}
        isBusy={isBusy}
        onCancelDelete={() => setIsConfirmOpen(false)}
        onDelete={handleDeleteTone}
        onCancelDiscard={handleCancelDiscard}
        onDiscard={handleDiscard}
      />
    </>
  );
};
