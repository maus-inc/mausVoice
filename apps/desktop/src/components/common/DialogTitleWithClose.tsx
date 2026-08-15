import CloseIcon from "@mui/icons-material/Close";
import { DialogTitle, IconButton } from "@mui/material";
import type { ReactNode } from "react";

type DialogTitleWithCloseProps = {
  onClose: () => void;
  children: ReactNode;
};

export const DialogTitleWithClose = ({
  onClose,
  children,
}: DialogTitleWithCloseProps) => {
  return (
    <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
      {children}
      <IconButton
        onClick={onClose}
        size="small"
        sx={{ ml: "auto" }}
        aria-label="Close"
      >
        <CloseIcon fontSize="small" />
      </IconButton>
    </DialogTitle>
  );
};
