import { DeleteOutlineRounded, MoreVertRounded } from "@mui/icons-material";
import { Box, IconButton, ListItemButton, Typography } from "@mui/material";
import { useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { Conversation } from "@maus-inc/types";
import { formatRelativeTime } from "../../utils/date.utils";
import {
  MenuPopoverBuilder,
  type MenuPopoverItem,
} from "../common/MenuPopover";
import { useContextMenu, type ContextMenuItem } from "../common/ContextMenu";

type ConversationListItemProps = {
  conversation: Conversation;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
};

export const ConversationListItem = ({
  conversation,
  selected,
  onSelect,
  onDelete,
}: ConversationListItemProps) => {
  const intl = useIntl();
  const [hovered, setHovered] = useState(false);

  const ctxMenu = useContextMenu();

  // No rename entry point exists for conversations (chat.actions has no
  // renameConversation), so the context menu carries only Delete. Reuses the
  // page-wired `onDelete` handler (which calls deleteConversation) rather than
  // forking the delete path.
  const contextMenuItems = useMemo<ContextMenuItem[]>(
    () => [
      {
        label: intl.formatMessage({ defaultMessage: "Delete conversation" }),
        danger: true,
        onClick: onDelete,
      },
    ],
    [onDelete, intl],
  );

  const menuItems: MenuPopoverItem[] = [
    {
      kind: "listItem",
      title: intl.formatMessage({ defaultMessage: "Delete" }),
      leading: <DeleteOutlineRounded fontSize="small" />,
      onClick: ({ close }) => {
        close();
        onDelete();
      },
    },
  ];

  return (
    <Box
      component="div"
      onContextMenu={(e) =>
        ctxMenu.handleContextMenu(e.nativeEvent, contextMenuItems)
      }
    >
      <ListItemButton
        selected={selected}
        onClick={onSelect}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        sx={{ borderRadius: 1, py: 0.75, px: 1, pr: hovered ? 0.5 : 1.5 }}
      >
        <Box sx={{ overflow: "hidden", flexGrow: 1, minWidth: 0 }}>
          <Typography
            variant="body2"
            noWrap
            sx={{
              lineHeight: 1.3,
            }}
          >
            {conversation.title}
          </Typography>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              lineHeight: 1.2,
            }}
          >
            {formatRelativeTime(intl, conversation.updatedAt)}
          </Typography>
        </Box>
        {hovered && (
          <MenuPopoverBuilder
            items={menuItems}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
          >
            {({ ref, open }) => (
              <IconButton
                ref={ref}
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  open();
                }}
                sx={{ ml: 0.5, flexShrink: 0 }}
              >
                <MoreVertRounded sx={{ fontSize: 16 }} />
              </IconButton>
            )}
          </MenuPopoverBuilder>
        )}
      </ListItemButton>
      {ctxMenu.renderMenu()}
    </Box>
  );
};
