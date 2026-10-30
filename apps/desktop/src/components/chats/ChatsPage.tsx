import { ArrowLeft, Plus } from "lucide-react";
import {
  Box,
  Button,
  Chip,
  Divider,
  Stack,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useSearchParams } from "react-router-dom";
import {
  createConversation,
  deleteConversation,
  loadChatMessages,
} from "../../actions/chat.actions";
import { useAppStore } from "../../store";
import { createId } from "../../utils/id.utils";
import { ChatsSideEffects } from "./ChatsSideEffects";
import { ConversationLayout } from "./ConversationLayout";
import { ConversationListLayout } from "./ConversationListLayout";

export default function ChatsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("id");
  const conversationIds = useAppStore((s) => s.chat.conversationIds);
  const title = useAppStore((s) =>
    selectedId ? s.conversationById[selectedId]?.title : undefined,
  );
  const compact = useMediaQuery("(max-width: 839px)");
  const [showList, setShowList] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const listVisible = compact && (showList || !selectedId);

  useLayoutEffect(() => {
    const prior = lastFocused.current;
    // A focused pane can disappear at the breakpoint. Restore only if focus
    // actually belonged to that pane and has not moved elsewhere.
    if (
      prior &&
      (!prior.isConnected || prior.getClientRects().length === 0) &&
      (document.activeElement === document.body ||
        document.activeElement === prior)
    ) {
      const listTarget = listRef.current?.querySelector<HTMLElement>(
        '[aria-current="true"]',
      );
      const target = compact && !listVisible ? backRef.current : listTarget;
      target?.focus();
    }
  }, [compact]);

  const focusIfUnmoved = (
    previous: Element | null,
    target: () => HTMLElement | null,
  ) => {
    requestAnimationFrame(() => {
      if (
        document.activeElement === previous ||
        document.activeElement === document.body
      )
        target()?.focus();
    });
  };

  // URL sync only. Writing the param re-renders and hands the new id to the
  // effect below, so loading here as well would read every conversation twice
  // on each cold open.
  useEffect(() => {
    if (!selectedId && conversationIds.length > 0) {
      setSearchParams({ id: conversationIds[0] }, { replace: true });
    }
  }, [selectedId, conversationIds, setSearchParams]);

  // Every load funnels through here. Deep links, back/forward and chat
  // switches all arrive as a new `selectedId`, so the id alone is enough to
  // decide that a read is due.
  useEffect(() => {
    if (selectedId) {
      void loadChatMessages(selectedId);
    }
  }, [selectedId]);

  const handleSelect = (id: string) => {
    const focused = document.activeElement;
    const keyboard =
      compact &&
      focused instanceof HTMLElement &&
      focused.matches(":focus-visible");
    setSearchParams({ id }, { replace: true });
    setShowList(false);
    if (keyboard) focusIfUnmoved(focused, () => backRef.current);
  };

  const intl = useIntl();

  const handleNewChat = async () => {
    const focused = document.activeElement;
    const keyboard =
      compact &&
      focused instanceof HTMLElement &&
      focused.matches(":focus-visible");
    const now = new Date().toISOString();
    const saved = await createConversation({
      id: createId(),
      title: intl.formatMessage({ defaultMessage: "New conversation" }),
      createdAt: now,
      updatedAt: now,
    });
    setSearchParams({ id: saved.id }, { replace: true });
    setShowList(false);
    if (keyboard) focusIfUnmoved(focused, () => backRef.current);
  };

  const handleDelete = async (id: string) => {
    await deleteConversation(id);
    if (selectedId === id) {
      setSearchParams({}, { replace: true });
    }
  };

  return (
    <Box
      ref={pageRef}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLElement)
          lastFocused.current = event.target;
      }}
      onBlurCapture={(event) => {
        if (
          !event.relatedTarget ||
          !(event.relatedTarget instanceof Node) ||
          !pageRef.current?.contains(event.relatedTarget)
        )
          lastFocused.current = null;
      }}
      sx={{ flexGrow: 1, height: "100%", pb: 2, pr: 2 }}
    >
      <ChatsSideEffects />
      <Box
        sx={{
          height: "100%",
          overflow: "hidden",
          bgcolor: "level1",
          display: "flex",
          flexDirection: "row",
          borderRadius: 2,
        }}
      >
        <Box
          ref={listRef}
          sx={{
            display: compact && !listVisible ? "none" : "flex",
            minWidth: 0,
            flexShrink: 0,
            width: compact ? "100%" : "auto",
          }}
        >
          <ConversationListLayout
            selectedId={selectedId}
            fullWidth={compact}
            onSelect={handleSelect}
            onNewChat={handleNewChat}
            onDelete={handleDelete}
          />
        </Box>
        {!compact && <Divider orientation="vertical" flexItem />}

        <Stack
          sx={{
            display: listVisible ? "none" : "flex",
            flexGrow: 1,
            minWidth: 0,
            minHeight: 0,
          }}
        >
          {compact && selectedId && (
            <Stack
              direction="row"
              sx={{ alignItems: "center", gap: 1, px: 1.5, pt: 1 }}
            >
              <Button
                ref={backRef}
                size="small"
                startIcon={<ArrowLeft size={16} />}
                onClick={(event) => {
                  const focused = document.activeElement;
                  setShowList(true);
                  if (event.detail === 0)
                    focusIfUnmoved(
                      focused,
                      () =>
                        listRef.current?.querySelector<HTMLElement>(
                          '[aria-current="true"]',
                        ) ??
                        listRef.current?.querySelector<HTMLElement>("button") ??
                        null,
                    );
                }}
              >
                <FormattedMessage defaultMessage="Chats" />
              </Button>
              <Typography
                component="h1"
                variant="subtitle2"
                noWrap
                sx={{ minWidth: 0 }}
              >
                {title ||
                  intl.formatMessage({ defaultMessage: "New conversation" })}
              </Typography>
            </Stack>
          )}
          {selectedId ? (
            <ConversationLayout
              key={selectedId}
              conversationId={selectedId}
              compact={compact}
            />
          ) : (
            <Stack
              sx={{
                flexGrow: 1,
                minWidth: 0,
                alignItems: "center",
                justifyContent: "center",
                gap: 1.5,
                px: 3,
              }}
            >
              <Typography
                variant="h6"
                // The empty state's title is the only heading on this route and
                // the shell renders no `h1`, so `component` supplies the level
                // while `variant` keeps the display size.
                component="h1"
                sx={{
                  fontFamily: "var(--font-display)",
                  fontWeight: 500,
                  textAlign: "center",
                  textWrap: "balance",
                }}
              >
                <FormattedMessage defaultMessage="How can I help you today?" />
              </Typography>
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                  textAlign: "center",
                }}
              >
                <FormattedMessage defaultMessage="Start a conversation to get things going" />
              </Typography>
              <Chip
                icon={<Plus size={16} strokeWidth={2} />}
                label={<FormattedMessage defaultMessage="Create new chat" />}
                variant="outlined"
                onClick={handleNewChat}
                sx={{ mt: 1, borderRadius: 999 }}
              />
            </Stack>
          )}
        </Stack>
      </Box>
    </Box>
  );
}
