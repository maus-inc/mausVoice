import { Box, Stack, Typography } from "@mui/material";
import { Wrench } from "lucide-react";
import Markdown from "react-markdown";
import { FormattedMessage } from "react-intl";
import remarkGfm from "remark-gfm";
import { useAppStore } from "../../store";
import { OverflowTypography } from "../common/OverflowTypography";
import { AgentActivity } from "./AgentActivity";

type ChatMessageBubbleProps = {
  id: string;
};

export const ChatMessageBubble = ({ id }: ChatMessageBubbleProps) => {
  const message = useAppStore((s) => s.chatMessageById[id]);
  const isStreaming = useAppStore((s) => !!s.streamingMessageById[id]);
  if (!message) {
    return null;
  }

  const metadata = message.metadata as Record<string, unknown> | null;

  if (metadata?.type === "tool-result") {
    return (
      <ToolResultBubble
        toolName={metadata.toolName as string}
        reason={metadata.reason as string | undefined}
      />
    );
  }

  const isEmpty = !message.content?.trim();
  if (message.role === "assistant" && isEmpty && !isStreaming) return null;

  const isMe = message.role === "user";

  return (
    <Stack>
      <AgentActivity messageId={id} />
      <Stack
        direction="row"
        sx={{
          justifyContent: isMe ? "flex-end" : "flex-start",
        }}
      >
        <Box
          sx={{
            maxWidth: "75%",
            px: 2,
            py: 1,
            borderRadius: 1,
            bgcolor: isMe ? "primary.main" : "level1",
            border: isMe ? "none" : 1,
            borderColor: "divider",
            color: isMe ? "primary.contrastText" : "text.primary",
            "& p": { m: 0 },
            "& p + p": { mt: 1 },
            "& pre": {
              my: 1,
              p: 1,
              borderRadius: 0.5,
              bgcolor: "action.selected",
              overflow: "auto",
            },
            "& code": {
              fontSize: "0.85em",
            },
            "& ul, & ol": { my: 0.5, pl: 2.5 },
            "& table": {
              borderCollapse: "collapse",
              my: 1,
              width: "100%",
            },
            "& th, & td": {
              border: 1,
              borderColor: "divider",
              px: 1,
              py: 0.5,
              textAlign: "left",
            },
            "& th": {
              bgcolor: "action.selected",
              fontWeight: 600,
            },
            fontSize: "0.875rem",
          }}
        >
          {isEmpty ? (
            <Typography
              variant="body2"
              sx={{
                width: "fit-content",
                fontWeight: 500,
                color: "text.secondary",
                "@keyframes thinkingPulse": {
                  "0%, 100%": { opacity: 0.45 },
                  "50%": { opacity: 1 },
                },
                animation: "thinkingPulse 1.4s ease-in-out infinite",
                "@media (prefers-reduced-motion: reduce)": {
                  animation: "none",
                  opacity: 0.8,
                },
              }}
            >
              <FormattedMessage defaultMessage="Thinking…" />
            </Typography>
          ) : (
            <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
          )}
        </Box>
      </Stack>
    </Stack>
  );
};

const ToolResultBubble = ({
  toolName,
  reason,
}: {
  toolName: string;
  reason?: string;
}) => {
  const toolInfo = useAppStore((s) => s.toolInfoById[toolName]);

  return (
    <Stack
      direction="row"
      spacing={0.75}
      sx={{
        alignItems: "center",
        px: 0.5,
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      <Wrench size={14} strokeWidth={1.9} style={{ flexShrink: 0, opacity: 0.7 }} />
      <OverflowTypography
        variant="caption"
        color="text.secondary"
        sx={{ minWidth: 0 }}
      >
        {toolInfo?.description ?? toolName}
        {reason ? ` — ${reason}` : ""}
      </OverflowTypography>
    </Stack>
  );
};
