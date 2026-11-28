import { DeleteForeverOutlined } from "@mui/icons-material";
import SaveIcon from "@mui/icons-material/Save";
import { Button, DialogActions } from "@mui/material";
import { FormattedMessage } from "react-intl";

export const ToneEditActions = ({
  isSystem,
  isBusy,
  canSave,
  onDelete,
  onClose,
  onSave,
}: {
  isSystem: boolean;
  isBusy: boolean;
  canSave: boolean;
  onDelete: () => void;
  onClose: () => void;
  onSave: () => void;
}) => (
  <DialogActions sx={{ px: 3, pb: 2 }}>
    {!isSystem && (
      <Button
        variant="text"
        onClick={onDelete}
        disabled={isBusy}
        color="warning"
        sx={{ mr: "auto" }}
        startIcon={<DeleteForeverOutlined />}
      >
        <FormattedMessage defaultMessage="Delete" />
      </Button>
    )}
    <Button variant="text" onClick={onClose} disabled={isBusy}>
      <FormattedMessage defaultMessage="Cancel" />
    </Button>
    <Button
      variant="contained"
      startIcon={<SaveIcon />}
      onClick={onSave}
      disabled={isBusy || !canSave}
    >
      <FormattedMessage defaultMessage="Save changes" />
    </Button>
  </DialogActions>
);
