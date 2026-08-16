import CloseIcon from "@mui/icons-material/Close";
import { DialogTitle, IconButton } from "@mui/material";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";

type DialogTitleWithCloseProps = {
  onClose: () => void;
  children: ReactNode;
};

export const DialogTitleWithClose = ({
  onClose,
  children,
}: DialogTitleWithCloseProps) => {
  const intl = useIntl();
  return (
    <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
      {children}
      <IconButton
        onClick={onClose}
        size="small"
        sx={{ ml: "auto" }}
        aria-label={intl.formatMessage({ defaultMessage: "Close" })}
      >
        <CloseIcon fontSize="small" />
      </IconButton>
    </DialogTitle>
  );
};
