import type { ChatMessage, ChatPart, ToolPermission } from "@maus-inc/types";
import { Box, Button, Stack, TextField, Typography } from "@mui/material";
import { keyframes, useTheme } from "@mui/material/styles";
import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { createMarkdownLink } from "../common/markdown-link";
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

export const chatBubbleMaxWidth = {
  xs: "86%",
  sm: "78%",
} as const;

const ChatMarkdownTable = ({ children, ...props }: ComponentProps<"table">) => (
  <Box data-chat-table-scroll="" sx={{ maxWidth: "100%", overflowX: "auto" }}>
    <table {...props}>{children}</table>
  </Box>
);

const markdownComponents: Components = {
  a: createMarkdownLink("a link in the chat"),
  table: ChatMarkdownTable,
};

const markdownBlockSx = (filled: boolean) => ({
  "& > *": { mt: 0, mb: 0 },
  "& > * + *": { mt: 1 },
  "& > * + h1, & > * + h2, & > * + h3, & > * + h4, & > * + h5, & > * + h6": {
    mt: 1.5,
  },
  "& h1 + *, & h2 + *, & h3 + *, & h4 + *, & h5 + *, & h6 + *": { mt: 0.75 },
  "& p, & li": { textWrap: "wrap" },
  "& h1, & h2, & h3, & h4, & h5, & h6": {
    fontWeight: 600,
    lineHeight: 1.3,
    letterSpacing: "-0.01em",
    textWrap: "wrap",
  },
  "& h1": { fontSize: "1.125rem" },
  "& h2": { fontSize: "1.0625rem" },
  "& h3, & h4, & h5, & h6": { fontSize: "1rem" },
  "& ul, & ol": { pl: 2.5 },
  "& li + li": { mt: 0.375 },
  "& li > p": { m: 0 },
  "& li > p + p": { mt: 0.5 },
  "& blockquote": {
    pl: 1.5,
    borderLeft: 2,
    borderColor: filled ? "currentColor" : "divider",
    opacity: filled ? 0.88 : 1,
    color: filled ? "inherit" : "text.secondary",
    "& > *": { m: 0 },
    "& > * + *": { mt: 0.75 },
  },
  "& hr": {
    border: 0,
    borderTop: 1,
    borderColor: filled ? "currentColor" : "divider",
    opacity: filled ? 0.24 : 1,
  },
  "& a": {
    color: "inherit",
    textDecoration: "underline",
    textUnderlineOffset: "0.18em",
    textDecorationThickness: "1px",
  },
});

const filledChipBg = "color-mix(in srgb, currentColor 14%, transparent)";
const filledBlockBg = "color-mix(in srgb, currentColor 11%, transparent)";
const filledBorder = "color-mix(in srgb, currentColor 22%, transparent)";

const markdownCodeAndTableSx = (filled: boolean) => ({
  "& :not(pre) > code": {
    px: 0.625,
    py: 0.125,
    borderRadius: 0.375,
    bgcolor: filled ? filledChipBg : "action.selected",
    fontSize: "0.85em",
    overflowWrap: "anywhere",
  },
  "& pre": {
    p: 1.25,
    maxWidth: "100%",
    borderRadius: 0.5,
    bgcolor: filled ? filledBlockBg : "action.selected",
    overflowX: "auto",
    overflowWrap: "normal",
    wordBreak: "normal",
  },
  "& pre code": {
    p: 0,
    bgcolor: "transparent",
    fontSize: "0.85em",
    whiteSpace: "pre",
    overflowWrap: "normal",
    wordBreak: "normal",
  },
  "& [data-chat-table-scroll] > table": {
    borderCollapse: "collapse",
    width: "max-content",
    minWidth: "100%",
  },
  "& th, & td": {
    border: 1,
    borderColor: filled ? filledBorder : "divider",
    px: 1,
    py: 0.625,
    textAlign: "left",
    verticalAlign: "top",
    overflowWrap: "break-word",
    wordBreak: "normal",
  },
  "& th": {
    bgcolor: filled ? filledBlockBg : "action.selected",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
});

export const bubbleSx = (isMe: boolean, editing = false) => {
  const filled = isMe && !editing;
  return {
    minWidth: 0,
    width: editing ? "100%" : "fit-content",
    maxWidth: chatBubbleMaxWidth,
    px: 2,
    py: 1.5,
    borderRadius: 1,
    border: editing ? 1 : 0,
    borderColor: editing ? "divider" : "transparent",
    bgcolor: filled ? "primary.main" : "action.hover",
    color: filled ? "primary.contrastText" : "text.primary",
    fontSize: "0.9375rem",
    lineHeight: 1.55,
    overflowWrap: "anywhere",
    wordBreak: "normal",
    "& button": { overflowWrap: "normal", wordBreak: "normal" },
    ...markdownBlockSx(filled),
    ...markdownCodeAndTableSx(filled),
  };
};

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
  // Focus the draft explicitly once it has mounted rather than with a DOM
  // `autoFocus` prop: `autoFocus` fires as an attribute and cannot be deferred,
  // so it races anything that moves focus in the same commit. This mirrors
  // ContextMenu's own "focus after commit, not via autoFocus" rule.
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <Stack
      spacing={1}
      onKeyDown={(event) => {
        // Escape cancels the edit, matching every other dismissible surface in
        // the app. Without it the only way out is hunting for the Cancel button
        // with a pointer, which strands keyboard and screen-reader users.
        //
        // While an input method is composing, Escape belongs to the IME: it
        // dismisses the candidate window. Acting on it here would close the
        // editor and throw away a half-typed word.
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <TextField
        multiline
        inputRef={inputRef}
        fullWidth
        size="small"
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        aria-label={intl.formatMessage({
          defaultMessage: "Edit message",
        })}
      />
      <Stack
        direction="row"
        sx={{
          justifyContent: "flex-end",
          flexWrap: "wrap",
          gap: 1,
        }}
      >
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
  let normalBody: ReactNode;
  if (texts.length === 0) {
    normalBody = <ThinkingMessage />;
  } else if (texts.length === 1) {
    normalBody = (
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {texts[0].text}
      </Markdown>
    );
  } else {
    normalBody = (
      <Stack spacing={1} sx={{ minWidth: 0 }}>
        {texts.map((part, index) => (
          <Box
            key={index}
            sx={{
              minWidth: 0,
              "& > *": { mt: 0, mb: 0 },
              "& > * + *": { mt: 1 },
            }}
          >
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {part.text}
            </Markdown>
          </Box>
        ))}
      </Stack>
    );
  }
  return (
    <Stack
      direction="row"
      sx={{ minWidth: 0, justifyContent: isMe ? "flex-end" : "flex-start" }}
    >
      <Box data-chat-bubble="" sx={bubbleSx(isMe, Boolean(editor))}>
        {editor ?? normalBody}
      </Box>
    </Stack>
  );
};

const MessageTimeline = ({
  timeline,
  permissions,
}: {
  timeline: TimelinePart[];
  permissions: ToolPermission[];
}) =>
  timeline.length > 0 ? (
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
  ) : null;

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
