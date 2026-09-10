import { ArrowDownwardRounded } from "@mui/icons-material";
import { Box, Button, Chip, Stack, Typography } from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import { sendChatMessage } from "../../actions/chat.actions";
import { useAppStore } from "../../store";
import { getLogger } from "../../utils/log.utils";
import { FadingScrollArea } from "../common/FadingScrollArea";
import { TipCard } from "../onboarding/TipCard";
import { ChatMessageBubble } from "./ChatMessageBubble";
import { ChatPromptBox } from "./ChatPromptBox";
import { ToolPermissionCard } from "./ToolPermissionCard";

type ConversationLayoutProps = {
  conversationId: string;
};

const AUTO_SCROLL_THRESHOLD_PX = 32;

const isNearBottom = (node: HTMLDivElement) =>
  node.scrollHeight - node.clientHeight - node.scrollTop <=
  AUTO_SCROLL_THRESHOLD_PX;

export const ConversationLayout = ({
  conversationId,
}: ConversationLayoutProps) => {
  const messageIds = useAppStore(
    (s) => s.chatMessageIdsByConversationId[conversationId] ?? [],
  );
  const toolPermissions = useAppStore((s) => s.toolPermissionById);
  const agentRunning = useAppStore((s) => {
    const status = s.agentStateByConversationId?.[conversationId]?.status;
    return status === "calling-llm" || status === "processing-tools";
  });
  const conversationPermissions = useMemo(
    () =>
      Object.values(toolPermissions).filter(
        (p) =>
          p.conversationId === conversationId &&
          p.status === "pending" &&
          !p.toolCallId,
      ),
    [toolPermissions, conversationId],
  );
  const [sending, setSending] = useState(false);
  const [stuck, setStuck] = useState(true);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    const node = scrollViewportRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, []);

  const handleScroll = useCallback(() => {
    const node = scrollViewportRef.current;
    if (!node) return;
    shouldStickToBottomRef.current = isNearBottom(node);
    setStuck(shouldStickToBottomRef.current);
  }, []);

  useEffect(() => {
    shouldStickToBottomRef.current = true;
    const frameId = requestAnimationFrame(scrollToBottom);
    return () => cancelAnimationFrame(frameId);
  }, [conversationId, scrollToBottom]);

  useEffect(() => {
    if (shouldStickToBottomRef.current) {
      scrollToBottom();
    }
  }, [messageIds.length, scrollToBottom]);

  useEffect(() => {
    const contentNode = contentRef.current;
    const viewportNode = scrollViewportRef.current;
    if (!contentNode || !viewportNode || typeof ResizeObserver === "undefined")
      return;

    const observer = new ResizeObserver(() => {
      if (shouldStickToBottomRef.current) {
        requestAnimationFrame(scrollToBottom);
      }
    });

    observer.observe(contentNode);
    observer.observe(viewportNode);

    return () => observer.disconnect();
  }, [conversationId, scrollToBottom]);

  const handlePrompt = async (text: string) => {
    if (sending) return;
    shouldStickToBottomRef.current = true;
    setStuck(true);
    setSending(true);
    try {
      await sendChatMessage(conversationId, text);
    } catch (error) {
      getLogger().error("Failed to send message", error);
    } finally {
      setSending(false);
    }
  };

  const handleSent = () => {
    shouldStickToBottomRef.current = true;
    setStuck(true);
  };

  return (
    <Stack
      sx={{
        flexGrow: 1,
        minWidth: 0,
        height: "100%",
        overflow: "hidden",
      }}
    >
      <Box sx={{ px: 2, pt: 2 }}>
        <TipCard id="assistant-mode" />
      </Box>
      <FadingScrollArea
        fadeHeight={32}
        viewportRef={scrollViewportRef}
        onScroll={handleScroll}
        sx={{ pt: 5, pb: 5, px: 2 }}
      >
        <Stack
          ref={contentRef}
          sx={{ minHeight: "100%", justifyContent: "flex-end" }}
        >
          {messageIds.length === 0 ? (
            <Box
              sx={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Stack sx={{ alignItems: "center", gap: 1.5, maxWidth: 420 }}>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  <FormattedMessage defaultMessage="No messages yet" />
                </Typography>
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{ flexWrap: "wrap", justifyContent: "center" }}
                >
                  <Chip
                    label={
                      <FormattedMessage defaultMessage="Polish my last dictation" />
                    }
                    variant="outlined"
                    clickable
                    onClick={() =>
                      void handlePrompt("Polish my last dictation.")
                    }
                  />
                  <Chip
                    label={
                      <FormattedMessage defaultMessage="Fix the grammar" />
                    }
                    variant="outlined"
                    clickable
                    onClick={() =>
                      void handlePrompt("Fix the grammar in my last dictation.")
                    }
                  />
                  <Chip
                    label={
                      <FormattedMessage defaultMessage="Summarize it briefly" />
                    }
                    variant="outlined"
                    clickable
                    onClick={() =>
                      void handlePrompt("Summarize my last dictation briefly.")
                    }
                  />
                </Stack>
              </Stack>
            </Box>
          ) : (
            <Stack spacing={1.5}>
              {messageIds.map((id) => (
                <ChatMessageBubble key={id} id={id} />
              ))}
              {conversationPermissions.map((p) => (
                <ToolPermissionCard key={p.id} permission={p} />
              ))}
            </Stack>
          )}
        </Stack>
      </FadingScrollArea>

      {!stuck && messageIds.length > 0 && (
        <Box sx={{ display: "flex", justifyContent: "center", mt: -4 }}>
          <Button
            size="small"
            variant="contained"
            startIcon={<ArrowDownwardRounded />}
            onClick={() => {
              shouldStickToBottomRef.current = true;
              setStuck(true);
              scrollToBottom();
            }}
            sx={{ zIndex: 1 }}
          >
            <FormattedMessage defaultMessage="Back to latest" />
          </Button>
        </Box>
      )}

      <Box sx={{ px: 2, pb: 2 }}>
        <ChatPromptBox
          conversationId={conversationId}
          running={agentRunning}
          onSend={handleSent}
        />
      </Box>
    </Stack>
  );
};
