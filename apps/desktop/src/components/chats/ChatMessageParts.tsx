import {
  BuildRounded,
  CheckCircleOutlineRounded,
  ErrorOutlineRounded,
  HourglassEmptyRounded,
  LoopRounded,
} from "@mui/icons-material";
import { Box, Button, Collapse, Stack, Typography } from "@mui/material";
import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import type { ChatPart, ChatToolStatus } from "@maus-inc/types";
import type { AgentRunState } from "../../state/agent.state";
import { retryAssistant } from "../../actions/chat.actions";
import { useAppStore } from "../../store";
import { partsForMessage } from "../../utils/chat-parts.utils";
import { OverflowTypography } from "../common/OverflowTypography";

const statusIcon = (status: ChatToolStatus) => {
  switch (status) {
    case "complete":
      return (
        <CheckCircleOutlineRounded
          sx={{ fontSize: 14, color: "success.main", flexShrink: 0 }}
        />
      );
    case "denied":
    case "failed":
      return (
        <ErrorOutlineRounded
          sx={{ fontSize: 14, color: "error.main", flexShrink: 0 }}
        />
      );
    case "approval":
      return (
        <HourglassEmptyRounded
          sx={{ fontSize: 14, color: "warning.main", flexShrink: 0 }}
        />
      );
    case "running":
      return (
        <LoopRounded sx={{ fontSize: 14, color: "info.main", flexShrink: 0 }} />
      );
    default:
      return (
        <BuildRounded
          sx={{ fontSize: 14, color: "text.secondary", flexShrink: 0 }}
        />
      );
  }
};

const statusLabel = (part: Extract<ChatPart, { kind: "tool" }>) => {
  switch (part.status) {
    case "complete":
      return (
        <FormattedMessage
          defaultMessage="Used {toolName}"
          values={{ toolName: part.toolName }}
        />
      );
    case "denied":
      return (
        <FormattedMessage
          defaultMessage="{toolName} was denied"
          values={{ toolName: part.toolName }}
        />
      );
    case "failed":
      return (
        <FormattedMessage
          defaultMessage="{toolName} failed"
          values={{ toolName: part.toolName }}
        />
      );
    case "approval":
      return (
        <FormattedMessage
          defaultMessage="{toolName} needs approval"
          values={{ toolName: part.toolName }}
        />
      );
    case "running":
      return (
        <FormattedMessage
          defaultMessage="Using {toolName}…"
          values={{ toolName: part.toolName }}
        />
      );
    default:
      return (
        <FormattedMessage
          defaultMessage="{toolName} queued"
          values={{ toolName: part.toolName }}
        />
      );
  }
};

export const ToolStepPart = ({
  part,
}: {
  part: Extract<ChatPart, { kind: "tool" }>;
}) => (
  <Stack
    direction="row"
    spacing={0.75}
    sx={{ alignItems: "center", px: 0.5, minWidth: 0, overflow: "hidden" }}
  >
    {statusIcon(part.status)}
    <OverflowTypography
      variant="caption"
      color="text.secondary"
      sx={{ minWidth: 0 }}
    >
      {statusLabel(part)}
      {part.reason ? ` — ${part.reason}` : ""}
    </OverflowTypography>
  </Stack>
);

export const ToolResultPart = ({
  part,
}: {
  part: Extract<ChatPart, { kind: "tool-result" }>;
}) => {
  const toolInfo = useAppStore((s) => s.toolInfoById[part.toolName]);
  return (
    <Stack
      direction="row"
      spacing={0.75}
      sx={{ alignItems: "center", px: 0.5, minWidth: 0, overflow: "hidden" }}
    >
      <BuildRounded
        sx={{ fontSize: 14, color: "text.secondary", flexShrink: 0 }}
      />
      <OverflowTypography
        variant="caption"
        color="text.secondary"
        sx={{ minWidth: 0 }}
      >
        {toolInfo?.description ?? part.toolName}
        {part.reason ? ` — ${part.reason}` : ""}
      </OverflowTypography>
    </Stack>
  );
};

export const ReasoningPart = ({
  part,
}: {
  part: Extract<ChatPart, { kind: "reasoning" }>;
}) => {
  const [open, setOpen] = useState(part.open);
  return (
    <Box>
      <Typography
        variant="caption"
        onClick={() => setOpen((o) => !o)}
        sx={{
          color: "text.secondary",
          cursor: "pointer",
          userSelect: "none",
          "&:hover": { textDecoration: "underline" },
        }}
      >
        {part.open ? (
          <FormattedMessage defaultMessage="Thinking…" />
        ) : (
          <FormattedMessage defaultMessage="Thought process" />
        )}
      </Typography>
      <Collapse in={open}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{
            whiteSpace: "pre-wrap",
            display: "block",
            mt: 0.25,
            pl: 1,
            borderLeft: 2,
            borderColor: "divider",
            maxHeight: 200,
            overflow: "auto",
          }}
        >
          {part.text}
        </Typography>
      </Collapse>
    </Box>
  );
};

export const RunNotePart = ({
  part,
  conversationId,
}: {
  part: Extract<ChatPart, { kind: "status" | "error" }>;
  conversationId: string;
}) => (
  <Stack direction="row" spacing={1} sx={{ alignItems: "center", px: 0.5 }}>
    <Typography
      variant="caption"
      color={part.kind === "error" ? "error" : "text.secondary"}
    >
      {part.text}
    </Typography>
    {part.kind === "error" && (
      <Button
        size="small"
        variant="text"
        onClick={() => void retryAssistant(conversationId)}
      >
        <FormattedMessage defaultMessage="Retry" />
      </Button>
    )}
  </Stack>
);

type RunNote = { kind: "error" | "status"; text: string };

const runNoteFor = (
  agentState: AgentRunState | null | undefined,
  stoppedText: string,
): RunNote | null => {
  if (!agentState) return null;
  if (agentState.status === "error" && agentState.error) {
    return { kind: "error", text: agentState.error };
  }
  if (agentState.status === "error" || agentState.aborted) {
    return { kind: "status", text: stoppedText };
  }
  return null;
};

export const useMessageParts = (messageId: string) => {
  const intl = useIntl();
  const message = useAppStore((s) => s.chatMessageById[messageId]);
  const streaming = useAppStore((s) => s.streamingMessageById[messageId]);
  const agentState = useAppStore((s) =>
    message
      ? s.agentStateByConversationId?.[message.conversationId]
      : undefined,
  );
  const permissions = useAppStore((s) =>
    message
      ? Object.values(s.toolPermissionById ?? {}).filter(
          (p) => p.conversationId === message.conversationId,
        )
      : [],
  );
  const isLast = useAppStore((s) => {
    if (!message) return false;
    const ids =
      s.chatMessageIdsByConversationId?.[message.conversationId] ?? [];
    return ids[ids.length - 1] === messageId;
  });

  if (!message)
    return { message: undefined, parts: [] as ChatPart[], permissions };

  // The run note belongs to the run, so it renders once under the latest
  // message instead of repeating under every bubble.
  const runNote =
    !streaming && isLast
      ? runNoteFor(
          agentState,
          intl.formatMessage({ defaultMessage: "Stopped." }),
        )
      : null;

  const parts = partsForMessage({
    message,
    streaming,
    liveToolCalls: streaming ? (agentState?.toolCalls ?? []) : [],
    permissions,
    runNote,
  });
  return { message, parts, permissions };
};
