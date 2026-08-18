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
import { ReactNode } from "react";
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
  return (
    <Dialog
      open={isOpen}
      onClose={busy ? undefined : onCancel}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers>
        <DialogContentText>{content}</DialogContentText>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button
          variant="text"
          onClick={onCancel}
          disabled={busy}
          {...cancelButtonProps}
        >
          {cancelLabel ?? <FormattedMessage defaultMessage="Cancel" />}
        </Button>
        <Button
          variant="contained"
          color={destructive ? "error" : "primary"}
          onClick={onConfirm}
          disabled={busy}
          {...confirmButtonProps}
        >
          {busy ? (
            <CircularProgress size={16} color="inherit" />
          ) : (
            (confirmLabel ?? <FormattedMessage defaultMessage="Confirm" />)
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
