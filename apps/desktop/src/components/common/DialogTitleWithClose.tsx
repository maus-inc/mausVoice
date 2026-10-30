import { X } from "lucide-react";
import { Box, DialogTitle, IconButton } from "@mui/material";
import type { ReactNode } from "react";
import { useId } from "react";
import { useIntl } from "react-intl";

type DialogTitleWithCloseProps = {
  onClose: () => void;
  children: ReactNode;
  /**
   * ID for the title element, to be handed to the enclosing `Dialog`'s
   * `aria-labelledby`.
   *
   * A `DialogTitle` is not automatically the dialog's accessible name: without
   * `aria-labelledby` on the `Dialog`, assistive technology announces an unnamed
   * dialog and the user cannot tell which one just opened. `useDialogTitleId`
   * generates the id so each call site wires the two halves together.
   */
  titleId?: string;
};

export const useDialogTitleId = (): string => useId();

export const DialogTitleWithClose = ({
  onClose,
  children,
  titleId,
}: DialogTitleWithCloseProps) => {
  const intl = useIntl();
  const generatedId = useId();
  const labelId = titleId ?? generatedId;
  return (
    <DialogTitle
      id={`${labelId}-container`}
      sx={{ display: "flex", alignItems: "center", gap: 1 }}
    >
      <Box
        component="span"
        id={labelId}
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: 1,
          minWidth: 0,
        }}
      >
        {children}
      </Box>
      <IconButton
        onClick={onClose}
        size="small"
        sx={{ ml: "auto" }}
        aria-label={intl.formatMessage({ defaultMessage: "Close" })}
      >
        <X size={16} strokeWidth={2} />
      </IconButton>
    </DialogTitle>
  );
};
