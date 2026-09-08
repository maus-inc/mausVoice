/**
 * SnackbarEmitter visual — recreated.
 *
 * Why recreated: reads snackbar* fields from the zustand store. The MUI
 * Snackbar configuration is copied verbatim from
 * components/root/SnackbarEmitter.tsx: key-per-message, clickaway ignored,
 * message in #fff span, bottom-center anchor, small close IconButton.
 * Mode fills: error.main / success.main / primary.main.
 */
import CloseIcon from "@mui/icons-material/Close";
import { IconButton, Snackbar, useTheme } from "@mui/material";
import { useState } from "react";

export type SnackbarMode = "info" | "error" | "success";

export const SnackbarPreview = ({
  message,
  mode = "info",
  open: controlledOpen,
  autoHideDuration = 4000,
}: {
  message: string;
  mode?: SnackbarMode;
  open?: boolean;
  autoHideDuration?: number;
}) => {
  const theme = useTheme();
  const [open, setOpen] = useState(controlledOpen ?? true);
  const isOpen = controlledOpen ?? open;

  const backgroundColor =
    mode === "error"
      ? theme.palette.error.main
      : mode === "success"
        ? theme.palette.success.main
        : theme.palette.primary.main;

  return (
    <Snackbar
      open={isOpen}
      autoHideDuration={controlledOpen === undefined ? autoHideDuration : null}
      onClose={(_, reason) => {
        if (reason === "clickaway") return;
        setOpen(false);
      }}
      message={<span style={{ color: "#fff" }}>{message}</span>}
      anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      action={
        <IconButton size="small" aria-label="close" color="inherit" onClick={() => setOpen(false)}>
          <CloseIcon fontSize="small" style={{ color: "#fff" }} />
        </IconButton>
      }
      slotProps={{ content: { style: { backgroundColor } } }}
    />
  );
};
