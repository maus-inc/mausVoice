import { Plus, Search } from "lucide-react";
import {
  Box,
  Button,
  InputAdornment,
  InputBase,
  List,
  Typography,
} from "@mui/material";
import { useMemo, useState, type ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useAppStore } from "../../store";
import { threadDayGroup, type ThreadDayGroup } from "../../utils/date.utils";
import { FadingScrollArea } from "../common/FadingScrollArea";
import { MetalChrome } from "../common/MetalChrome";
import { ConversationListItem } from "./ConversationListItem";

type ConversationListLayoutProps = {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
};

const GROUP_ORDER: ThreadDayGroup[] = ["today", "yesterday", "earlier"];

const EmptyListMessage = ({ message }: { message: ReactNode }) => (
  <Box
    sx={{
      flexGrow: 1,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      px: 1,
    }}
  >
    <Typography variant="body2" sx={{ color: "text.secondary" }}>
      {message}
    </Typography>
  </Box>
);

export const ConversationListLayout = ({
  selectedId,
  onSelect,
  onNewChat,
  onDelete,
}: ConversationListLayoutProps) => {
  const intl = useIntl();
  const conversationIds = useAppStore((s) => s.chat.conversationIds);
  const conversationById = useAppStore((s) => s.conversationById);
  const [query, setQuery] = useState("");

  const conversations = useMemo(
    () =>
      conversationIds
        .map((id) => conversationById[id])
        .filter((conversation) => conversation != null),
    [conversationIds, conversationById],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return conversations;
    return conversations.filter((conversation) => {
      const title = conversation.title.trim()
        ? conversation.title
        : intl.formatMessage({ defaultMessage: "New conversation" });
      return title.toLowerCase().includes(needle);
    });
  }, [conversations, query, intl]);

  const grouped = useMemo(() => {
    const buckets: Record<ThreadDayGroup, typeof filtered> = {
      today: [],
      yesterday: [],
      earlier: [],
    };
    for (const conversation of filtered) {
      buckets[threadDayGroup(conversation.updatedAt)].push(conversation);
    }
    const occupied = GROUP_ORDER.filter((group) => buckets[group].length > 0);
    return { buckets, showLabels: occupied.length > 1, occupied };
  }, [filtered]);

  const groupLabel = (group: ThreadDayGroup) => {
    switch (group) {
      case "today":
        return intl.formatMessage({ defaultMessage: "Today" });
      case "yesterday":
        return intl.formatMessage({ defaultMessage: "Yesterday" });
      case "earlier":
        return intl.formatMessage({ defaultMessage: "Earlier" });
    }
  };

  let listBody: ReactNode;
  if (conversations.length === 0) {
    listBody = (
      <EmptyListMessage
        message={<FormattedMessage defaultMessage="No conversations" />}
      />
    );
  } else if (filtered.length === 0) {
    listBody = (
      <EmptyListMessage
        message={<FormattedMessage defaultMessage="No threads found" />}
      />
    );
  } else {
    listBody = (
      <FadingScrollArea fadeHeight={16} sx={{ px: 0, py: 0.5 }}>
        {grouped.occupied.map((group) => (
          <Box key={group} sx={{ mb: 0.5 }}>
            {grouped.showLabels ? (
              <Typography
                variant="caption"
                sx={{
                  display: "block",
                  px: 1.25,
                  pt: 0.75,
                  pb: 0.25,
                  color: "text.secondary",
                  fontWeight: 600,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                }}
              >
                {groupLabel(group)}
              </Typography>
            ) : null}
            <List disablePadding>
              {grouped.buckets[group].map((conversation) => (
                <ConversationListItem
                  key={conversation.id}
                  conversation={conversation}
                  selected={conversation.id === selectedId}
                  onSelect={() => onSelect(conversation.id)}
                  onDelete={() => onDelete(conversation.id)}
                />
              ))}
            </List>
          </Box>
        ))}
      </FadingScrollArea>
    );
  }

  return (
    <Box
      sx={{
        width: 240,
        maxWidth: 240,
        minWidth: 240,
        display: "flex",
        flexDirection: "column",
        gap: 1,
        pt: 1.5,
        px: 1,
      }}
    >
      <MetalChrome>
        <Button
          onClick={onNewChat}
          data-active={selectedId == null ? "true" : undefined}
          startIcon={<Plus size={16} strokeWidth={2} />}
          sx={{
            justifyContent: "flex-start",
            textTransform: "none",
            fontWeight: 600,
            borderRadius: 1.5,
            px: 1.25,
            py: 0.75,
            color: "text.primary",
            bgcolor: selectedId == null ? "action.selected" : "transparent",
            border: 1,
            borderColor: "divider",
            "&:hover": {
              bgcolor: "action.hover",
            },
          }}
        >
          <FormattedMessage defaultMessage="New Thread" />
        </Button>
      </MetalChrome>

      {conversations.length > 0 ? (
        <InputBase
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={intl.formatMessage({ defaultMessage: "Search chats" })}
          inputProps={{
            "aria-label": intl.formatMessage({
              defaultMessage: "Search chats",
            }),
          }}
          startAdornment={
            <InputAdornment position="start" sx={{ mr: 0.75 }}>
              <Search size={14} strokeWidth={2} />
            </InputAdornment>
          }
          sx={{
            mx: 0.25,
            px: 1,
            py: 0.5,
            borderRadius: 1.5,
            bgcolor: "action.hover",
            fontSize: "0.8125rem",
          }}
        />
      ) : null}

      {listBody}
    </Box>
  );
};
