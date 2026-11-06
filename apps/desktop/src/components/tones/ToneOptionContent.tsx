import { Edit, Public } from "@mui/icons-material";
import { IconButton, Stack, Tooltip } from "@mui/material";
import { useIntl } from "react-intl";

/** Shared content for desktop and preview style-picker options. */
export const ToneOptionContent = ({
  name,
  isGlobal,
  isSystem,
  onEdit,
  globalLabel,
}: {
  name: string;
  isGlobal?: boolean | null;
  isSystem?: boolean | null;
  onEdit: () => void;
  globalLabel?: string;
}) => {
  const intl = useIntl();
  return (
    <Stack
      direction="row"
      sx={{
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
      }}
    >
      <div>{name}</div>
      {isGlobal ? (
        <Tooltip
          title={
            globalLabel ??
            intl.formatMessage({
              id: "this_is_a_global_style_and_cannot_be_edited",
              defaultMessage: "This is a global style and cannot be edited",
            })
          }
        >
          <Public fontSize="small" sx={{ color: "text.secondary" }} />
        </Tooltip>
      ) : !isSystem ? (
        <IconButton
          size="small"
          onClick={(event) => {
            event.stopPropagation();
            event.preventDefault();
            onEdit();
          }}
        >
          <Edit fontSize="small" />
        </IconButton>
      ) : null}
    </Stack>
  );
};
