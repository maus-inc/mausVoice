import { DeleteOutlineRounded, MoreVertRounded } from "@mui/icons-material";
import { Box, IconButton, ListItemButton, ListItemText } from "@mui/material";
import { useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { Conversation } from "@maus-inc/types";
import { formatShortDate, formatShortTime } from "../../utils/date.utils";
import {
  MenuPopoverBuilder,
  type MenuPopoverItem,
} from "../common/MenuPopover";
import {
  isEditableTarget,
  useContextMenu,
  type ContextMenuItem,
} from "../common/ContextMenu";

type ConversationListItemProps = {
  conversation: Conversation;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
};

type TimestampTextProps = {
  value: string;
  hidden: boolean;
  /** Vertical offset while hidden, so the swap reads as a slide, not a blink. */
  hiddenShift: number;
};

const TimestampText = ({ value, hidden, hiddenShift }: TimestampTextProps) => (
  <Box
    component="span"
    aria-hidden={hidden ? "true" : undefined}
    sx={(theme) => ({
      gridArea: "1 / 1",
      opacity: hidden ? 0 : 1,
      transform: hidden ? `translateY(${hiddenShift}px)` : "none",
      transition: theme.transitions.create(["opacity", "transform"], {
        duration: theme.transitions.duration.short,
        easing: theme.transitions.easing.easeOut,
      }),
      // Users who prefer reduced motion get an instant swap with no slide.
      "@media (prefers-reduced-motion: reduce)": {
        transform: "none",
        transition: "none",
      },
    })}
  >
    {value}
  </Box>
);

export const ConversationListItem = ({
  conversation,
  selected,
  onSelect,
  onDelete,
}: ConversationListItemProps) => {
  const intl = useIntl();
  const [hovered, setHovered] = useState(false);

  const ctxMenu = useContextMenu();

  // The row rests on the short date. Hover and the open conversation reveal
  // the precise time.
  const showTime = hovered || selected;

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
      onContextMenu={(e) => {
        // Yield right-clicks on editable text to the provider's clipboard menu.
        if (isEditableTarget(e.target)) return;
        ctxMenu.handleContextMenu(e.nativeEvent, contextMenuItems);
      }}
    >
      <ListItemButton
        selected={selected}
        onClick={onSelect}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        sx={{ borderRadius: 1, py: 0.75, px: 1, pr: hovered ? 0.5 : 1.5 }}
      >
        {/* ListItemText slots are required here. The MuiListItemButton theme
           re-colors `.MuiListItemText-primary/secondary` when the row is
           selected, which keeps the timestamp readable on the inverted
           selected background in light mode. Hand-rolled Typography children
           keep `text.secondary` there and turn invisible. */}
        <ListItemText
          primary={conversation.title}
          secondary={
            <Box component="span" sx={{ display: "inline-grid" }}>
              <TimestampText
                value={formatShortDate(intl, conversation.updatedAt)}
                hidden={showTime}
                hiddenShift={-3}
              />
              <TimestampText
                value={formatShortTime(intl, conversation.updatedAt)}
                hidden={!showTime}
                hiddenShift={3}
              />
            </Box>
          }
          slotProps={{
            primary: {
              variant: "body2",
              noWrap: true,
              sx: { lineHeight: 1.3 },
            },
            secondary: {
              variant: "caption",
              sx: { lineHeight: 1.2 },
            },
          }}
          sx={{ my: 0 }}
        />
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
