import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { MAX_PREVIEW_SAMPLE_LEN } from "../../actions/tone-preview.actions";
import type { TonePreviewFields } from "../../actions/tone-preview.actions";
import type { useTonePreview } from "./useTonePreview";
import { countLabel } from "./tone-form.utils";

type TonePreviewPanelProps = {
  preview: ReturnType<typeof useTonePreview>;
  sampleText: string;
  onSampleTextChange: (value: string) => void;
  fields: TonePreviewFields;
  canRun: boolean;
};

export const TonePreviewPanel = ({
  preview,
  sampleText,
  onSampleTextChange,
  fields,
  canRun,
}: TonePreviewPanelProps) => {
  const intl = useIntl();
  const [showTester, setShowTester] = useState(false);

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
          <TextField
            value={sampleText}
            label={
              <FormattedMessage defaultMessage="Sample dictation to restyle..." />
            }
            slotProps={{
              htmlInput: { maxLength: MAX_PREVIEW_SAMPLE_LEN },
            }}
            helperText={countLabel(sampleText, MAX_PREVIEW_SAMPLE_LEN)}
            onChange={(event) => onSampleTextChange(event.target.value)}
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
              disabled={preview.status === "running" || !canRun}
            >
              <FormattedMessage defaultMessage="Run preview" />
            </Button>
            {preview.status === "running" && (
              <Button variant="text" size="small" onClick={preview.cancel}>
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
              <FormattedMessage defaultMessage="No text-generation provider is configured, so the preview cannot run." />
            </Alert>
          )}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
};
