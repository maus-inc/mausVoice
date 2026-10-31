import {
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { RefObject } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  MAX_PREVIEW_SAMPLE_LEN,
  type TonePreviewFields,
} from "../../actions/tone-preview.actions";
import { countLabel } from "./tone-form.utils";
import type { useTonePreview } from "./useTonePreview";

type Props = {
  sampleRef: RefObject<HTMLTextAreaElement | null>;
  sampleText: string;
  setSampleText: (value: string) => void;
  preview: ReturnType<typeof useTonePreview>;
  fields: TonePreviewFields;
  trimmedName: string;
  trimmedPrompt: string;
  category: string;
  outputLength: string;
  isSaving: boolean;
};

export const ToneCreateReview = ({
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
}: Props) => {
  const intl = useIntl();
  return (
    <Stack spacing={2} sx={{ pt: 1 }}>
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          <FormattedMessage defaultMessage="Try it" />
        </Typography>
        <TextField
          inputRef={sampleRef}
          value={sampleText}
          disabled={isSaving}
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
            disabled={isSaving || preview.status === "running"}
          >
            <FormattedMessage defaultMessage="Run preview" />
          </Button>
          {preview.status === "running" && (
            <Button
              variant="text"
              size="small"
              onClick={preview.cancel}
              disabled={isSaving}
            >
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
  );
};
