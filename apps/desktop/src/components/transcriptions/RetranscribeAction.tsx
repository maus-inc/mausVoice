import { CheckCircle, Hourglass, RotateCcw } from "lucide-react";
import { CircularProgress, IconButton, Tooltip } from "@mui/material";
import { useIntl } from "react-intl";
import { openRetranscribeDialog } from "../../actions/transcriptions.actions";

/** The state, accessible label and motion-aware indicator for retranscription. */
export const RetranscribeAction = ({
  id,
  isRetranscribing,
  didRetranscribe,
  prefersReducedMotion,
}: {
  id: string;
  isRetranscribing: boolean;
  didRetranscribe: boolean;
  prefersReducedMotion: boolean;
}) => {
  const intl = useIntl();
  const retranscribeTooltip = (() => {
    if (isRetranscribing) {
      return intl.formatMessage({
        defaultMessage: "Retranscribing audio clip",
      });
    }
    if (didRetranscribe) {
      return intl.formatMessage({ defaultMessage: "Retranscribed audio clip" });
    }
    return intl.formatMessage({ defaultMessage: "Retranscribe audio clip" });
  })();

  const retranscribeIcon = (() => {
    if (isRetranscribing && prefersReducedMotion) {
      return (
        <span data-testid="retranscribe-hourglass">
          <Hourglass size={16} strokeWidth={1.9} aria-hidden />
        </span>
      );
    }
    if (isRetranscribing) {
      return <CircularProgress size={18} color="inherit" aria-hidden />;
    }
    if (didRetranscribe) {
      return (
        <span data-testid="retranscribe-check">
          <CheckCircle size={16} strokeWidth={1.9} aria-hidden />
        </span>
      );
    }
    return (
      <span data-testid="retranscribe-replay">
        <RotateCcw size={16} strokeWidth={1.9} aria-hidden />
      </span>
    );
  })();

  return (
    <Tooltip title={retranscribeTooltip} placement="top">
      <span>
        <IconButton
          aria-label={retranscribeTooltip}
          aria-busy={isRetranscribing}
          size="small"
          onClick={() => openRetranscribeDialog(id)}
          disabled={isRetranscribing}
          sx={{ p: 0.5 }}
        >
          {retranscribeIcon}
        </IconButton>
      </span>
    </Tooltip>
  );
};
