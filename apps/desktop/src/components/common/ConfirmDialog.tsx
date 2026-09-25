import {
  Button,
  ButtonProps,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from "@mui/material";
import { ReactNode, useId } from "react";
import { FormattedMessage } from "react-intl";

export type ConfirmDialogProps = {
  isOpen: boolean;
  title: ReactNode;
  content: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  confirmButtonProps?: ButtonProps;
  cancelButtonProps?: ButtonProps;
  destructive?: boolean;
  busy?: boolean;
};

export const ConfirmDialog = ({
  isOpen,
  title,
  content,
  onCancel,
  onConfirm,
  confirmLabel,
  cancelLabel,
  confirmButtonProps,
  cancelButtonProps,
  destructive,
  busy,
}: ConfirmDialogProps) => {
  const confirmContent = confirmLabel ?? (
    <FormattedMessage defaultMessage="Confirm" />
  );
  const cancelContent = cancelLabel ?? (
    <FormattedMessage defaultMessage="Cancel" />
  );

  const titleId = useId();
  const contentId = useId();

  return (
    <Dialog
      open={isOpen}
      onClose={busy ? undefined : onCancel}
      maxWidth="xs"
      fullWidth
      aria-labelledby={titleId}
      aria-describedby={contentId}
    >
      <DialogTitle id={titleId}>{title}</DialogTitle>
      <DialogContent dividers>
        <DialogContentText id={contentId}>{content}</DialogContentText>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button
          variant="text"
          onClick={onCancel}
          {...cancelButtonProps}
          disabled={busy || cancelButtonProps?.disabled}
        >
          {cancelContent}
        </Button>
        <Button
          variant="contained"
          color={destructive ? "error" : "primary"}
          onClick={onConfirm}
          {...confirmButtonProps}
          disabled={busy || confirmButtonProps?.disabled}
        >
          {busy ? (
            <CircularProgress size={16} color="inherit" />
          ) : (
            confirmContent
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
