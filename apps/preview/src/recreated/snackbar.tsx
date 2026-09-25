/**
 * Toast visual — recreated.
 *
 * Why recreated: SnackbarEmitter routes store events through sonner's
 * `<Toaster />`, styled by `SonnerToaster.tsx` GlobalStyles. This mirrors
 * that styled output: a neutral level1 card (hairline + premium hover
 * shadow, theme radius) pinned bottom-right, one quiet surface per type
 * with the status carried by the icon — success/error/info — plus the
 * tone-on-tone close disc. Sonner's type icons are solid
 * `fill="currentColor"` glyphs, matched here with filled MUI icons.
 */
import { Box, IconButton, useTheme } from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import InfoIcon from "@mui/icons-material/Info";
import CloseIcon from "@mui/icons-material/Close";
import { useEffect, useState } from "react";

export type SnackbarMode = "info" | "error" | "success";

const ICON_BY_MODE: Record<SnackbarMode, typeof CheckCircleIcon> = {
  success: CheckCircleIcon,
  error: ErrorIcon,
  info: InfoIcon,
};

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

  useEffect(() => {
    if (controlledOpen !== undefined || !open) return;
    const id = window.setTimeout(() => setOpen(false), autoHideDuration);
    return () => window.clearTimeout(id);
  }, [autoHideDuration, controlledOpen, open]);

  if (!isOpen) return null;

  const ModeIcon = ICON_BY_MODE[mode];
  const iconColor = {
    error: theme.vars?.palette.error.main ?? theme.palette.error.main,
    success: theme.vars?.palette.success.main ?? theme.palette.success.main,
    info: theme.vars?.palette.info.main ?? theme.palette.info.main,
  }[mode];

  return (
    <Box
      role="status"
      sx={(t) => ({
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: t.zIndex.snackbar,
        display: "flex",
        alignItems: "center",
        gap: "6px",
        width: 356,
        boxSizing: "border-box",
        padding: "12px 14px",
        borderRadius: `${theme.shape.borderRadius}px`,
        backgroundColor: t.vars?.palette.level1 ?? t.palette.background.paper,
        border: `1px solid ${t.vars?.palette.divider ?? t.palette.divider}`,
        boxShadow:
          t.palette.mode === "dark"
            ? `0 2px 4px rgba(0,0,0,0.4), 0 12px 28px rgba(0,0,0,0.28)`
            : `0 2px 4px rgba(26,23,18,0.12), 0 12px 28px rgba(26,23,18,0.16)`,
        fontFamily: t.typography.fontFamily,
        fontSize: t.typography.pxToRem(13.5),
      })}
    >
      <ModeIcon
        sx={{ flexShrink: 0, width: 16, height: 16, color: iconColor }}
      />
      <Box
        component="span"
        sx={{
          color: "text.primary",
          fontWeight: theme.typography.fontWeightMedium,
          lineHeight: 1.5,
          overflowWrap: "anywhere",
        }}
      >
        {message}
      </Box>
      <IconButton
        size="small"
        aria-label="close"
        onClick={() => setOpen(false)}
        sx={(t) => ({
          ml: "auto",
          width: 20,
          height: 20,
          borderRadius: "50%",
          border: `1px solid ${t.vars?.palette.divider ?? t.palette.divider}`,
          backgroundColor:
            t.vars?.palette.background.paper ?? t.palette.background.paper,
          color: t.vars?.palette.text.secondary ?? t.palette.text.secondary,
          "&:hover": {
            backgroundColor:
              t.vars?.palette.level1 ?? t.palette.background.paper,
            color: t.vars.palette.text.primary,
          },
          "& .MuiSvgIcon-root": { fontSize: 12 },
        })}
      >
        <CloseIcon />
      </IconButton>
    </Box>
  );
};
