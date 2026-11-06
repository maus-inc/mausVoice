import { ArrowDownwardRounded } from "@mui/icons-material";
import { Box, Button, Chip, Stack, Typography } from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { sendChatMessage } from "../../actions/chat.actions";
import { useAppStore } from "../../store";
import { getLogger } from "../../utils/log.utils";
import { FadingScrollArea } from "../common/FadingScrollArea";
import { TipCard } from "../onboarding/TipCard";
import { AgentLiveAnnouncer } from "./AgentLiveAnnouncer";
import { ChatMessageBubble } from "./ChatMessageBubble";
import { ChatPromptBox } from "./ChatPromptBox";
import { ToolPermissionCard } from "./ToolPermissionCard";

const AUTO_SCROLL_THRESHOLD_PX = 32;

const isNearBottom = (node: HTMLDivElement) =>
  node.scrollHeight - node.clientHeight - node.scrollTop <=
  AUTO_SCROLL_THRESHOLD_PX;

/** Keep the viewport following new content only while the reader is at the end. */
const useConversationScroll = (
  conversationId: string,
  messageCount: number,
) => {
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
    setStuck(true);
    const frameId = requestAnimationFrame(() => {
      if (shouldStickToBottomRef.current) scrollToBottom();
    });
    return () => cancelAnimationFrame(frameId);
  }, [conversationId, scrollToBottom]);

  useEffect(() => {
    if (shouldStickToBottomRef.current) {
      scrollToBottom();
    }
  }, [messageCount, scrollToBottom]);

  useEffect(() => {
    const contentNode = contentRef.current;
    const viewportNode = scrollViewportRef.current;
    if (!contentNode || !viewportNode || typeof ResizeObserver === "undefined")
      return;

    let pendingFrame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (!shouldStickToBottomRef.current || pendingFrame !== undefined) return;
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = undefined;
        if (shouldStickToBottomRef.current) scrollToBottom();
      });
    });

    observer.observe(contentNode);
    observer.observe(viewportNode);

    return () => {
      observer.disconnect();
      if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
    };
  }, [conversationId, scrollToBottom]);

  const markStuck = () => {
    shouldStickToBottomRef.current = true;
    setStuck(true);
  };
  return {
    stuck,
    scrollViewportRef,
    contentRef,
    scrollToBottom,
    handleScroll,
    markStuck,
  };
};

export const ConversationLayout = ({
  conversationId,
}: {
  conversationId: string;
}) => {
  const intl = useIntl();
  const messageIds = useAppStore(
    (s) => s.chatMessageIdsByConversationId[conversationId] ?? [],
  );
  const latestMessage = useAppStore((s) => {
    const ids = s.chatMessageIdsByConversationId[conversationId];
    const latestId = ids?.[ids.length - 1];
    return latestId ? s.chatMessageById[latestId] : undefined;
  });
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
  const sendingRef = useRef(false);
  const {
    stuck,
    scrollViewportRef,
    contentRef,
    scrollToBottom,
    handleScroll,
    markStuck,
  } = useConversationScroll(conversationId, messageIds.length);

  const handlePrompt = async (text: string) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    markStuck();
    try {
      await sendChatMessage(conversationId, text);
    } catch (error) {
      getLogger().error("Failed to send message");
      showErrorSnackbar(error);
    } finally {
      sendingRef.current = false;
    }
  };

  const handleSent = () => {
    markStuck();
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
      <AgentLiveAnnouncer
        agentRunning={agentRunning}
        latestMessageId={messageIds.at(-1) ?? null}
        latestMessageRole={latestMessage?.role ?? null}
      />
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
                      void handlePrompt(
                        intl.formatMessage({
                          defaultMessage: "Polish my last dictation",
                        }),
                      )
                    }
                  />
                  <Chip
                    label={
                      <FormattedMessage defaultMessage="Fix the grammar" />
                    }
                    variant="outlined"
                    clickable
                    onClick={() =>
                      void handlePrompt(
                        intl.formatMessage({
                          defaultMessage:
                            "Fix the grammar in my last dictation.",
                        }),
                      )
                    }
                  />
                  <Chip
                    label={
                      <FormattedMessage defaultMessage="Summarize it briefly" />
                    }
                    variant="outlined"
                    clickable
                    onClick={() =>
                      void handlePrompt(
                        intl.formatMessage({
                          defaultMessage:
                            "Summarize my last dictation briefly.",
                        }),
                      )
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
              markStuck();
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
          key={conversationId}
          conversationId={conversationId}
          running={agentRunning}
          onSend={handleSent}
        />
      </Box>
    </Stack>
  );
};
