import {
  Button,
  ButtonProps,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
} from "@mui/material";
import { ReactNode, useId } from "react";
import { FormattedMessage, useIntl } from "react-intl";

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
  /**
   * Names the progress indicator shown while `busy`. A string because it lands
   * in `aria-label`; `FormattedMessage` would render a node there.
   */
  busyLabel?: string;
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
  busyLabel,
}: ConfirmDialogProps) => {
  const intl = useIntl();
  const confirmContent = confirmLabel ?? (
    <FormattedMessage defaultMessage="Confirm" />
  );
  const cancelContent = cancelLabel ?? (
    <FormattedMessage defaultMessage="Cancel" />
  );
  const progressLabel =
    busyLabel ?? intl.formatMessage({ defaultMessage: "Working" });

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
          // The label stays in the DOM while the button is busy. Replacing it
          // with a bare spinner left the button with no accessible name at all,
          // so a screen reader announced an unlabelled disabled control and the
          // user could not tell what was being confirmed. `aria-busy` and the
          // named progressbar carry the in-flight state instead.
          aria-busy={busy || undefined}
        >
          {busy ? (
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: "center", justifyContent: "center" }}
            >
              <CircularProgress
                size={16}
                color="inherit"
                role="progressbar"
                aria-label={progressLabel}
              />
              <span>{confirmContent}</span>
            </Stack>
          ) : (
            confirmContent
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
