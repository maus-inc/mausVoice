import { useRef } from "react";
import { FormattedMessage } from "react-intl";
import { ConfirmDialog } from "../common/ConfirmDialog";

/** Let the nested confirmation restore focus before closing its parent. */
export const ToneCreateDiscard = ({
  open,
  onCancel,
  onDiscard,
}: {
  open: boolean;
  onCancel: () => void;
  onDiscard: () => void;
}) => {
  const discardAfterExit = useRef(false);
  return (
    <ConfirmDialog
      isOpen={open}
      title={<FormattedMessage defaultMessage="Discard changes?" />}
      content={
        <FormattedMessage defaultMessage="You have unsaved changes. Closing now loses them." />
      }
      onCancel={onCancel}
      onConfirm={() => {
        discardAfterExit.current = true;
        onCancel();
      }}
      onExited={() => {
        if (discardAfterExit.current) {
          discardAfterExit.current = false;
          onDiscard();
        }
      }}
      cancelButtonProps={{ autoFocus: true }}
      confirmLabel={<FormattedMessage defaultMessage="Discard" />}
      confirmButtonProps={{ color: "warning" }}
    />
  );
};
