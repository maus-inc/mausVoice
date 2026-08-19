import { useMemo } from "react";
import { BuildRounded } from "@mui/icons-material";
import { Box, Stack, Typography } from "@mui/material";
import { keyframes, useTheme } from "@mui/material/styles";
import Markdown from "react-markdown";
import { FormattedMessage, useIntl } from "react-intl";
import remarkGfm from "remark-gfm";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import { useAppStore } from "../../store";
import { useContextMenu, type ContextMenuItem } from "../common/ContextMenu";
import { OverflowTypography } from "../common/OverflowTypography";
import { AgentActivity } from "./AgentActivity";

const thinkingShimmer = keyframes`
  0% { background-position: 200% 50%; }
  100% { background-position: -200% 50%; }
`;

type ChatMessageBubbleProps = {
  id: string;
};

export const ChatMessageBubble = ({ id }: ChatMessageBubbleProps) => {
  const theme = useTheme();
  const message = useAppStore((s) => s.chatMessageById[id]);
  const isStreaming = useAppStore((s) => !!s.streamingMessageById[id]);

  const intl = useIntl();
  const ctxMenu = useContextMenu();
  const content = message?.content ?? "";
  const contextMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!content.trim()) return [];
    return [
      {
        label: intl.formatMessage({ defaultMessage: "Copy message" }),
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(content);
            showSnackbar(
              intl.formatMessage({ defaultMessage: "Copied successfully" }),
              { mode: "success" },
            );
          } catch (error) {
            showErrorSnackbar(error);
          }
        },
      },
    ];
  }, [content, intl]);

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
    <Stack
      onContextMenu={(e) => {
        if (contextMenuItems.length === 0) return;
        ctxMenu.handleContextMenu(
          e.nativeEvent,
          contextMenuItems,
          "chat-message",
        );
      }}
    >
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
            bgcolor: isMe ? "primary.main" : "action.hover",
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
                color: "transparent",
                backgroundImage: `linear-gradient(90deg, rgb(${theme.vars?.palette.text.primaryChannel} / 0.35) 0%, rgb(${theme.vars?.palette.text.primaryChannel} / 0.9) 50%, rgb(${theme.vars?.palette.text.primaryChannel} / 0.35) 100%)`,
                backgroundSize: "200% 100%",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                animation: `${thinkingShimmer} 1.6s linear infinite`,
              }}
            >
              <FormattedMessage defaultMessage="Thinking" />
            </Typography>
          ) : (
            <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
          )}
        </Box>
      </Stack>
      {ctxMenu.renderMenu()}
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
      <BuildRounded
        sx={{ fontSize: 14, color: "text.secondary", flexShrink: 0 }}
      />
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
