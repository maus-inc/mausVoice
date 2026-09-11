import { useMemo, useState } from "react";
import { Box, Button, Stack, TextField, Typography } from "@mui/material";
import { keyframes, useTheme } from "@mui/material/styles";
import { FormattedMessage, useIntl } from "react-intl";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatPart } from "@maus-inc/types";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import {
  editAndResend,
  laterMessagesHaveToolActivity,
} from "../../actions/chat.actions";
import { useAppStore } from "../../store";
import {
  isEditableTarget,
  useContextMenu,
  type ContextMenuItem,
} from "../common/ContextMenu";
import {
  ReasoningPart,
  RunNotePart,
  ToolResultPart,
  ToolStepPart,
  useMessageParts,
} from "./ChatMessageParts";
import { ToolPermissionCard } from "./ToolPermissionCard";

const thinkingShimmer = keyframes`
  0% { background-position: 200% 50%; }
  100% { background-position: -200% 50%; }
`;

type ChatMessageBubbleProps = {
  id: string;
};

const BubbleTextContent = ({ texts }: { texts: ChatPart[] }) => (
  <Stack spacing={1}>
    {texts.map((part, index) =>
      part.kind === "text" ? (
        <Markdown key={`text-${index}`} remarkPlugins={[remarkGfm]}>
          {part.text}
        </Markdown>
      ) : null,
    )}
  </Stack>
);

const bubbleSx = (isMe: boolean) => ({
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
});

export const ChatMessageBubble = ({ id }: ChatMessageBubbleProps) => {
  const theme = useTheme();
  const intl = useIntl();
  const ctxMenu = useContextMenu();
  const { message, parts, permissions } = useMessageParts(id);
  const isStreaming = useAppStore((s) => !!s.streamingMessageById[id]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmDrop, setConfirmDrop] = useState(false);

  const content = message?.content ?? "";
  const contextMenuItems = useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = [];
    if (content.trim()) {
      items.push({
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
      });
    }
    if (message?.role === "user") {
      items.push({
        label: intl.formatMessage({ defaultMessage: "Edit and resend" }),
        onClick: () => {
          setDraft(content);
          setConfirmDrop(false);
          setEditing(true);
        },
      });
    }
    return items;
  }, [content, intl, message?.role]);

  if (!message) {
    return null;
  }

  const timeline = parts.filter(
    (p) =>
      p.kind === "tool" || p.kind === "reasoning" || p.kind === "permission",
  );
  const texts = parts.filter((p) => p.kind === "text");
  const notes = parts.filter((p) => p.kind === "status" || p.kind === "error");
  const isToolResultOnly =
    parts.length === 1 && parts[0]?.kind === "tool-result";

  if (isToolResultOnly) {
    const part = parts[0];
    if (part?.kind !== "tool-result") return null;
    return <ToolResultPart part={part} />;
  }

  const isEmpty = texts.length === 0;
  if (
    message.role === "assistant" &&
    isEmpty &&
    timeline.length === 0 &&
    !isStreaming
  )
    return null;

  const isMe = message.role === "user";

  const saveEdit = () => {
    const text = draft.trim();
    if (!text) return;
    if (
      !confirmDrop &&
      laterMessagesHaveToolActivity(message.conversationId, id)
    ) {
      setConfirmDrop(true);
      return;
    }
    setEditing(false);
    setConfirmDrop(false);
    void editAndResend(message.conversationId, id, text);
  };

  return (
    <Stack
      onContextMenu={(e) => {
        // Yield right-clicks on editable text to the provider's clipboard menu.
        if (isEditableTarget(e.target)) return;
        if (contextMenuItems.length === 0) return;
        ctxMenu.handleContextMenu(e.nativeEvent, contextMenuItems);
      }}
    >
      {timeline.length > 0 && (
        <Stack spacing={0.25} sx={{ px: 0.5, mb: 0.5 }}>
          {timeline.map((part, index) => {
            const key = `${part.kind}-${index}`;
            if (part.kind === "reasoning")
              return <ReasoningPart key={key} part={part} />;
            if (part.kind === "tool")
              return <ToolStepPart key={key} part={part} />;
            if (part.kind === "permission") {
              const permission = permissions.find(
                (p) => p.id === part.permissionId,
              );
              return permission ? (
                <ToolPermissionCard key={key} permission={permission} />
              ) : null;
            }
            return null;
          })}
        </Stack>
      )}
      <Stack
        direction="row"
        sx={{
          justifyContent: isMe ? "flex-end" : "flex-start",
        }}
      >
        <Box sx={bubbleSx(isMe)}>
          {editing ? (
            <Stack spacing={1}>
              <TextField
                multiline
                autoFocus
                fullWidth
                size="small"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setConfirmDrop(false);
                }}
                aria-label={intl.formatMessage({
                  defaultMessage: "Edit message",
                })}
              />
              <Stack
                direction="row"
                spacing={1}
                sx={{ justifyContent: "flex-end" }}
              >
                <Button
                  size="small"
                  variant="text"
                  onClick={() => {
                    setEditing(false);
                    setConfirmDrop(false);
                  }}
                >
                  <FormattedMessage defaultMessage="Cancel" />
                </Button>
                <Button
                  size="small"
                  variant="contained"
                  disabled={!draft.trim()}
                  onClick={saveEdit}
                >
                  {confirmDrop ? (
                    <FormattedMessage defaultMessage="Drop later messages and resend" />
                  ) : (
                    <FormattedMessage defaultMessage="Resend" />
                  )}
                </Button>
              </Stack>
            </Stack>
          ) : isEmpty ? (
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
              <FormattedMessage defaultMessage="Thinking…" />
            </Typography>
          ) : (
            <BubbleTextContent texts={texts} />
          )}
        </Box>
      </Stack>
      {notes.length > 0 && (
        <Stack spacing={0.25} sx={{ px: 0.5, mt: 0.5 }}>
          {notes.map((part, index) =>
            part.kind === "status" || part.kind === "error" ? (
              <RunNotePart
                key={`${part.kind}-${index}`}
                part={part}
                conversationId={message.conversationId}
              />
            ) : null,
          )}
        </Stack>
      )}
      {ctxMenu.renderMenu()}
    </Stack>
  );
};
