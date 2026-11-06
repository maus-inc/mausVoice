import {
  Alert,
  AlertTitle,
  Box,
  CircularProgress,
  Typography,
} from "@mui/material";
import { FormattedMessage } from "react-intl";
import type { TonePreviewStatus } from "./useTonePreview";

export const TonePreviewFeedback = ({
  status,
  output,
  error,
  canCreateWithoutPreview = false,
}: {
  status: TonePreviewStatus;
  output: string;
  error: string;
  canCreateWithoutPreview?: boolean;
}) => (
  <>
    {status === "running" && (
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <CircularProgress size={18} />
        <Typography variant="body2" color="text.secondary">
          <FormattedMessage defaultMessage="Styling the sample..." />
        </Typography>
      </Box>
    )}
    {status === "done" && (
      <Alert severity="success">
        <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
          {output}
        </Typography>
      </Alert>
    )}
    {status === "error" && (
      <Alert severity="error">
        <AlertTitle>
          <FormattedMessage defaultMessage="Preview failed." />
        </AlertTitle>
        {error}
      </Alert>
    )}
    {status === "unavailable" && (
      <Alert severity="info">
        <FormattedMessage defaultMessage="No text-generation provider is configured, so the preview cannot run." />
        {canCreateWithoutPreview && (
          <>
            {" "}
            <FormattedMessage defaultMessage="You can create this style without a preview. Configure a text-generation provider to try it." />
          </>
        )}
      </Alert>
    )}
  </>
);
