import { Globe, Trash2 } from "lucide-react";
import { IconButton, Tooltip } from "@mui/material";
import { FormattedMessage, useIntl } from "react-intl";

/**
 * Global terms are organization-managed. The disabled badge is the only
 * control those rows get, which keeps the right-click menu in lockstep with
 * the inline surface.
 */
export const DictionaryRowActions = ({
  isGlobal,
  termSourceValue,
  onDelete,
}: {
  isGlobal: boolean;
  termSourceValue: string;
  onDelete: () => void;
}) => {
  const intl = useIntl();

  if (isGlobal) {
    return (
      <Tooltip
        disableInteractive
        title={
          <FormattedMessage defaultMessage="This term is managed by your organization." />
        }
      >
        <span>
          <IconButton size="small" disabled>
            <Globe size={16} strokeWidth={1.9} />
          </IconButton>
        </span>
      </Tooltip>
    );
  }

  return (
    <IconButton
      data-dictionary-delete
      aria-label={intl.formatMessage(
        { defaultMessage: "Delete dictionary item {term}" },
        { term: termSourceValue },
      )}
      onClick={(event) => {
        // A second click at the same location may now hit the next row.
        if (event.detail <= 1) void onDelete();
      }}
      size="small"
    >
      <Trash2 size={16} strokeWidth={1.9} />
    </IconButton>
  );
};
