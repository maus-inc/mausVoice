import { Chip, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import { Copy, Info, Send, Trash2 } from "lucide-react";
import type { MouseEventHandler, ReactNode } from "react";
import { useIntl } from "react-intl";

const RowAction = ({
  label,
  onClick,
  icon,
  color,
}: {
  label: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  icon: ReactNode;
  color?: "primary" | "default";
}) => (
  <Tooltip title={label} placement="top">
    <IconButton aria-label={label} onClick={onClick} size="small" color={color}>
      {icon}
    </IconButton>
  </Tooltip>
);

type Props = {
  createdAt?: string;
  isRemote: boolean;
  isSent: boolean;
  receiverName?: string;
  hasMetadata: boolean;
  onDetails: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onSend: () => void;
};

export const HistoryRowHeader = ({
  createdAt,
  isRemote,
  isSent,
  receiverName,
  hasMetadata,
  onDetails,
  onCopy,
  onDelete,
  onSend,
}: Props) => {
  const intl = useIntl();
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{ justifyContent: "space-between", alignItems: "center" }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "center", flexWrap: "wrap" }}
      >
        <Typography
          variant="subtitle2"
          component="span"
          sx={{ color: "text.secondary" }}
        >
          {createdAt
            ? new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(createdAt))
            : ""}
        </Typography>
        {isRemote && (
          <Chip
            size="small"
            variant="outlined"
            label={intl.formatMessage({ defaultMessage: "Remote" })}
          />
        )}
        {isSent && (
          <Chip
            size="small"
            variant="outlined"
            label={intl.formatMessage({ defaultMessage: "Sent" })}
          />
        )}
      </Stack>
      <Stack direction="row" spacing={1}>
        <RowAction
          label={intl.formatMessage({
            defaultMessage: "View transcription details",
          })}
          onClick={onDetails}
          icon={<Info size={16} strokeWidth={1.9} />}
          color={hasMetadata ? "primary" : "default"}
        />
        <RowAction
          label={intl.formatMessage({ defaultMessage: "Copy transcript" })}
          onClick={onCopy}
          icon={<Copy size={16} strokeWidth={1.9} />}
        />
        <RowAction
          label={intl.formatMessage({ defaultMessage: "Delete transcript" })}
          onClick={(event) => {
            if (event.detail <= 1) onDelete();
          }}
          icon={<Trash2 size={16} strokeWidth={1.9} />}
        />
        {!isRemote && receiverName !== undefined && (
          <RowAction
            label={intl.formatMessage(
              { defaultMessage: "Send to {name}" },
              { name: receiverName },
            )}
            onClick={onSend}
            icon={<Send size={16} strokeWidth={1.9} />}
          />
        )}
      </Stack>
    </Stack>
  );
};
