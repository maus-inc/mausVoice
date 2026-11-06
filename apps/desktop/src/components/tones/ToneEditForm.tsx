import { DeleteForeverOutlined } from "@mui/icons-material";
import SaveIcon from "@mui/icons-material/Save";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
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
import { useCallback, useEffect, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import { deleteTone, upsertTone } from "../../actions/tone.actions";
import { getAppState } from "../../store";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { useToneDraftPreview } from "./useToneDraftPreview";

import { ToneBasicsFields } from "./ToneBasicsFields";
import {
  ToneExampleField,
  ToneOutputLengthField,
  TonePreviewSampleField,
} from "./ToneGuidanceFields";
import { TonePreviewFeedback } from "./TonePreviewFeedback";
import { countLabel, sameToneDraft, MAX_PROMPT_LEN } from "./tone-form.utils";

const trimOrUndefined = (value: string): string | undefined =>
  value.trim() || undefined;

// Keep draft hydration and conflict detection together: a dirty or busy draft
// must never be overwritten by a newer source record.
const useToneEditDraft = (tone: Tone, isBusy: boolean) => {
  const [baseline, setBaseline] = useState(tone);
  const [name, setName] = useState(tone.name);
  const [category, setCategory] = useState(tone.category ?? "");
  const [outputLength, setOutputLength] = useState(tone.outputLength ?? "");
  const [exampleInputOutput, setExampleInputOutput] = useState(
    tone.exampleInputOutput ?? "",
  );
  const [promptTemplate, setPromptTemplate] = useState(tone.promptTemplate);
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
  return {
    baseline,
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
    hasChanges,
    sourceChanged,
    isValid,
  };
};

// The sample and preview result are owned by the editable fields that produce them.
const ToneEditPreview = ({
  promptTemplate,
  category,
  outputLength,
  exampleInputOutput,
}: {
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
  const [showTester, setShowTester] = useState(false);
  const trimmedPrompt = promptTemplate.trim();

  return (
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
          <TonePreviewSampleField value={sampleText} onChange={setSampleText} />
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
              <Button variant="text" size="small" onClick={preview.cancel}>
                <FormattedMessage defaultMessage="Cancel" />
              </Button>
            )}
          </Box>
          <TonePreviewFeedback
            status={preview.status}
            output={preview.output}
            error={preview.error}
          />
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
};

const ToneEditPrompt = ({
  promptTemplate,
  setPromptTemplate,
}: {
  promptTemplate: string;
  setPromptTemplate: (value: string) => void;
}) => {
  const trimmedPrompt = promptTemplate.trim();
  return (
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
  );
};

const ToneEditActions = ({
  isSystem,
  isBusy,
  sourceChanged,
  isValid,
  hasChanges,
  onRequestDelete,
  onRequestClose,
  onSave,
}: {
  isSystem: boolean;
  isBusy: boolean;
  sourceChanged: boolean;
  isValid: boolean;
  hasChanges: boolean;
  onRequestDelete: () => void;
  onRequestClose: () => void;
  onSave: () => void;
}) => (
  <DialogActions sx={{ px: 3, pb: 2 }}>
    {!isSystem && (
      <Button
        variant="text"
        onClick={onRequestDelete}
        disabled={isBusy}
        color="warning"
        sx={{ mr: "auto" }}
        startIcon={<DeleteForeverOutlined />}
      >
        <FormattedMessage defaultMessage="Delete" />
      </Button>
    )}
    <Button variant="text" onClick={onRequestClose} disabled={isBusy}>
      <FormattedMessage defaultMessage="Cancel" />
    </Button>
    <Button
      variant="contained"
      startIcon={<SaveIcon />}
      onClick={onSave}
      disabled={isBusy || sourceChanged || !isValid || !hasChanges}
    >
      <FormattedMessage defaultMessage="Save changes" />
    </Button>
  </DialogActions>
);

export const ToneEditDialog = ({
  tone,
  onClose,
}: {
  tone: Tone;
  onClose: () => void;
}) => {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));

  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  // One shared busy latch: Save and Delete must never interleave, or the
  // slower command can resurrect a deleted style or overwrite a deletion.
  const isBusy = isSaving || isDeleting;
  const {
    baseline,
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
    hasChanges,
    sourceChanged,
    isValid,
  } = useToneEditDraft(tone, isBusy);
  // State drives the buttons; the ref takes ownership before React commits
  // that state, so two handlers in the same event batch cannot both write.
  const writePending = useRef(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isDiscardOpen, setIsDiscardOpen] = useState(false);

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
                <ToneEditPrompt
                  promptTemplate={promptTemplate}
                  setPromptTemplate={setPromptTemplate}
                />
                <ToneOutputLengthField
                  value={outputLength}
                  onChange={setOutputLength}
                />
              </Stack>
            </Box>

            <Box>
              <Typography variant="subtitle2" gutterBottom>
                <FormattedMessage defaultMessage="Examples" />
              </Typography>
              <ToneExampleField
                value={exampleInputOutput}
                onChange={setExampleInputOutput}
              />
            </Box>

            <ToneEditPreview
              promptTemplate={promptTemplate}
              category={category}
              outputLength={outputLength}
              exampleInputOutput={exampleInputOutput}
            />
          </Stack>
        </DialogContent>

        <ToneEditActions
          isSystem={Boolean(tone.isSystem)}
          isBusy={isBusy}
          sourceChanged={sourceChanged}
          isValid={isValid}
          hasChanges={hasChanges}
          onRequestDelete={() => setIsConfirmOpen(true)}
          onRequestClose={handleRequestClose}
          onSave={handleSave}
        />
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
