import { DeleteForeverOutlined } from "@mui/icons-material";
import SaveIcon from "@mui/icons-material/Save";
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
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { Tone } from "@maus-inc/types";
import { useCallback, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { PREVIEW_SAMPLE_TEXT } from "../../actions/tone-preview.actions";
import { deleteTone, upsertTone } from "../../actions/tone.actions";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { useTonePreview } from "./useTonePreview";

const MAX_NAME_LEN = 120;
const MAX_CATEGORY_LEN = 80;
const MAX_OUTPUT_LEN = 120;
const MAX_EXAMPLE_LEN = 1200;
const MAX_PROMPT_LEN = 8000;

const countLabel = (value: string, max: number) => `${value.length}/${max}`;

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
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));

  const [name, setName] = useState(tone.name);
  const [category, setCategory] = useState(tone.category ?? "");
  const [outputLength, setOutputLength] = useState(tone.outputLength ?? "");
  const [exampleInputOutput, setExampleInputOutput] = useState(
    tone.exampleInputOutput ?? "",
  );
  const [promptTemplate, setPromptTemplate] = useState(tone.promptTemplate);
  const [sampleText, setSampleText] = useState(PREVIEW_SAMPLE_TEXT);
  const [showTester, setShowTester] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isDiscardOpen, setIsDiscardOpen] = useState(false);

  const preview = useTonePreview();

  const trimmedName = name.trim();
  const trimmedPrompt = promptTemplate.trim();
  const hasChanges =
    name !== tone.name ||
    promptTemplate !== tone.promptTemplate ||
    category !== (tone.category ?? "") ||
    outputLength !== (tone.outputLength ?? "") ||
    exampleInputOutput !== (tone.exampleInputOutput ?? "");
  const isValid = trimmedName.length > 0 && trimmedPrompt.length > 0;

  const handleSave = useCallback(async () => {
    if (!isValid || isSaving) {
      return;
    }
    setIsSaving(true);
    try {
      await upsertTone({
        ...tone,
        name: trimmedName,
        promptTemplate: trimmedPrompt,
        category: trimOrUndefined(category),
        outputLength: trimOrUndefined(outputLength),
        exampleInputOutput: trimOrUndefined(exampleInputOutput),
      });
      onClose();
    } finally {
      setIsSaving(false);
    }
  }, [
    isValid,
    isSaving,
    tone,
    trimmedName,
    trimmedPrompt,
    category,
    outputLength,
    exampleInputOutput,
    onClose,
  ]);

  const handleDeleteTone = useCallback(async () => {
    setIsConfirmOpen(false);
    setIsDeleting(true);
    try {
      await deleteTone(tone.id);
      onClose();
    } finally {
      setIsDeleting(false);
    }
  }, [tone.id, onClose]);

  const handleRequestClose = useCallback(() => {
    if (hasChanges) {
      setIsDiscardOpen(true);
      return;
    }
    onClose();
  }, [hasChanges, onClose]);

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
          <Stack spacing={3} sx={{ pt: 1 }}>
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                <FormattedMessage defaultMessage="Basics" />
              </Typography>
              <Stack spacing={2}>
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
                    <Alert severity="error">{preview.error}</Alert>
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
              disabled={isDeleting}
              color="warning"
              sx={{ mr: "auto" }}
              startIcon={<DeleteForeverOutlined />}
            >
              <FormattedMessage defaultMessage="Delete" />
            </Button>
          )}
          <Button variant="text" onClick={handleRequestClose}>
            <FormattedMessage defaultMessage="Cancel" />
          </Button>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={handleSave}
            disabled={isSaving || !isValid || !hasChanges}
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
        confirmLabel={<FormattedMessage defaultMessage="Delete" />}
        confirmButtonProps={{ color: "error", disabled: isDeleting }}
      />

      <ConfirmDialog
        isOpen={isDiscardOpen}
        title={<FormattedMessage defaultMessage="Discard changes?" />}
        content={
          <FormattedMessage defaultMessage="You have unsaved changes. Closing now loses them." />
        }
        onCancel={() => setIsDiscardOpen(false)}
        onConfirm={() => {
          setIsDiscardOpen(false);
          onClose();
        }}
        confirmLabel={<FormattedMessage defaultMessage="Discard" />}
        confirmButtonProps={{ color: "warning" }}
      />
    </>
  );
};
