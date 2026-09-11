import { ArrowUp } from "lucide-react";
import { FormattedMessage } from "react-intl";
import { openUpdateDialog } from "../../actions/updater.actions";
import { ListTile } from "../common/ListTile";

export const UpdateListTile = () => {
  return (
    <ListTile
      onClick={() => openUpdateDialog()}
      leading={<ArrowUp size={18} strokeWidth={1.9} />}
      title={<FormattedMessage defaultMessage="Update ready" />}
      sx={{
        position: "relative",
        borderRadius: 1,
        border: "1px solid",
        borderColor: "divider",
        overflow: "hidden",
      }}
    />
  );
};
