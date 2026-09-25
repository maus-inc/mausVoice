import type { ChatMessage, ChatPart, ToolPermission } from "@maus-inc/types";
import { Box, Button, Stack, TextField, Typography } from "@mui/material";
import { keyframes, useTheme } from "@mui/material/styles";
import type { ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ReasoningPart,
  RunNotePart,
  RetryButton,
  ToolStepPart,
} from "./ChatMessageParts";
import { ToolPermissionCard } from "./ToolPermissionCard";

type TextPart = Extract<ChatPart, { kind: "text" }>;
type TimelinePart = Extract<
  ChatPart,
  { kind: "tool" | "reasoning" | "permission" }
>;
type NotePart = Extract<ChatPart, { kind: "error" | "status" }>;

// Result-only rows are handled before this predicate. Empty successful
// assistants remain visible when they own Retry; other empty rows stay hidden.
export const shouldRenderMessage = (
  message: ChatMessage,
  parts: ChatPart[],
  isStreaming: boolean,
  canRetry: boolean,
): boolean =>
  message.role !== "assistant" ||
  isStreaming ||
  canRetry ||
  parts.some((part) => part.kind !== "tool-result");

const thinkingShimmer = keyframes`
  0% { background-position: 200% 50%; }
  100% { background-position: -200% 50%; }
`;

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

export const MessageEditForm = ({
  draft,
  confirmDrop,
  onChange,
  onCancel,
  onSave,
}: {
  draft: string;
  confirmDrop: boolean;
  onChange: (text: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) => {
  const intl = useIntl();
  return (
    <Stack spacing={1}>
      <TextField
        multiline
        autoFocus
        fullWidth
        size="small"
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        aria-label={intl.formatMessage({
          defaultMessage: "Edit message",
        })}
      />
      <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
        <Button size="small" variant="text" onClick={onCancel}>
          <FormattedMessage defaultMessage="Cancel" />
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={!draft.trim()}
          onClick={onSave}
        >
          {confirmDrop ? (
            <FormattedMessage defaultMessage="Drop later messages and resend" />
          ) : (
            <FormattedMessage defaultMessage="Resend" />
          )}
        </Button>
      </Stack>
    </Stack>
  );
};

const ThinkingMessage = () => {
  const theme = useTheme();
  return (
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
  );
};

const MessageBody = ({
  texts,
  editor,
  isStreaming,
  isMe,
}: {
  texts: TextPart[];
  editor: ReactNode;
  isStreaming: boolean;
  isMe: boolean;
}) => {
  if (!editor && texts.length === 0 && !isStreaming) return null;
  const normalBody =
    texts.length === 0 ? (
      <ThinkingMessage />
    ) : (
      <Stack spacing={1}>
        {texts.map((part) => (
          <Markdown key="text" remarkPlugins={[remarkGfm]}>
            {part.text}
          </Markdown>
        ))}
      </Stack>
    );
  return (
    <Stack
      direction="row"
      sx={{ justifyContent: isMe ? "flex-end" : "flex-start" }}
    >
      <Box sx={bubbleSx(isMe)}>{editor ?? normalBody}</Box>
    </Stack>
  );
};

const MessageTimeline = ({
  timeline,
  permissions,
}: {
  timeline: TimelinePart[];
  permissions: ToolPermission[];
}) => (
  <>
    {timeline.length > 0 && (
      <Stack spacing={0.25} sx={{ px: 0.5, mb: 0.5 }}>
        {timeline.map((part) => {
          if (part.kind === "reasoning")
            return <ReasoningPart key="reasoning" part={part} />;
          if (part.kind === "tool")
            return <ToolStepPart key={`tool-${part.toolCallId}`} part={part} />;
          if (part.kind === "permission") {
            const permission = permissions.find(
              (p) => p.id === part.permissionId,
            );
            return permission ? (
              <ToolPermissionCard
                key={`permission-${part.permissionId}`}
                permission={permission}
              />
            ) : null;
          }
          return null;
        })}
      </Stack>
    )}
  </>
);

const MessageRunNotes = ({
  notes,
  canRetry,
  conversationId,
}: {
  notes: NotePart[];
  canRetry: boolean;
  conversationId: string;
}) => (
  <>
    {notes.length > 0 && (
      <Stack spacing={0.25} sx={{ px: 0.5, mt: 0.5 }}>
        {notes.map((part) => (
          <RunNotePart
            key={part.kind}
            part={part}
            conversationId={conversationId}
          />
        ))}
      </Stack>
    )}
    {canRetry && notes.length === 0 && (
      <Stack direction="row" sx={{ px: 0.5, mt: 0.5 }}>
        <RetryButton conversationId={conversationId} />
      </Stack>
    )}
  </>
);

export const ChatMessageContent = ({
  parts,
  permissions,
  editor,
  isStreaming,
  isMe,
  canRetry,
  conversationId,
}: {
  parts: ChatPart[];
  permissions: ToolPermission[];
  editor: ReactNode;
  isStreaming: boolean;
  isMe: boolean;
  canRetry: boolean;
  conversationId: string;
}) => {
  const timeline = parts.filter(
    (part) =>
      part.kind === "tool" ||
      part.kind === "reasoning" ||
      part.kind === "permission",
  );
  const texts = parts.filter((part) => part.kind === "text");
  const notes = parts.filter(
    (part) => part.kind === "status" || part.kind === "error",
  );
  return (
    <>
      <MessageTimeline timeline={timeline} permissions={permissions} />
      <MessageBody
        texts={texts}
        editor={editor}
        isStreaming={isStreaming}
        isMe={isMe}
      />
      <MessageRunNotes
        notes={notes}
        canRetry={canRetry}
        conversationId={conversationId}
      />
    </>
  );
};
