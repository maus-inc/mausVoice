import { FormattedMessage } from "react-intl";
import { ConfirmDialog } from "../common/ConfirmDialog";

export const ToneEditConfirmations = ({
  deleteOpen,
  discardOpen,
  isBusy,
  onCancelDelete,
  onDelete,
  onCancelDiscard,
  onDiscard,
}: {
  deleteOpen: boolean;
  discardOpen: boolean;
  isBusy: boolean;
  onCancelDelete: () => void;
  onDelete: () => void;
  onCancelDiscard: () => void;
  onDiscard: () => void;
}) => (
  <>
    <ConfirmDialog
      isOpen={deleteOpen}
      title={<FormattedMessage defaultMessage="Delete style" />}
      content={
        <FormattedMessage defaultMessage="Are you sure you want to delete this style?" />
      }
      onCancel={onCancelDelete}
      onConfirm={onDelete}
      busy={isBusy}
      cancelButtonProps={{ autoFocus: true }}
      confirmLabel={<FormattedMessage defaultMessage="Delete" />}
      confirmButtonProps={{ color: "error", disabled: isBusy }}
    />
    <ConfirmDialog
      isOpen={discardOpen}
      title={<FormattedMessage defaultMessage="Discard changes?" />}
      content={
        <FormattedMessage defaultMessage="You have unsaved changes. Closing now loses them." />
      }
      busy={isBusy}
      onCancel={onCancelDiscard}
      onConfirm={onDiscard}
      cancelButtonProps={{ autoFocus: true }}
      confirmLabel={<FormattedMessage defaultMessage="Discard" />}
      confirmButtonProps={{ color: "warning", disabled: isBusy }}
    />
  </>
);
