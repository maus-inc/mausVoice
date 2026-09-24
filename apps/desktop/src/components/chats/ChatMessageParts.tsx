import {
  BuildRounded,
  CheckCircleOutlineRounded,
  ErrorOutlineRounded,
  HourglassEmptyRounded,
  LoopRounded,
} from "@mui/icons-material";
import { Box, Button, Collapse, Stack, Typography } from "@mui/material";
import { useEffect, useId, useState } from "react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import type { ChatMessage, ChatPart, ChatToolStatus } from "@maus-inc/types";
import { retryAssistant } from "../../actions/chat.actions";
import { showErrorSnackbar } from "../../actions/app.actions";
import type { AgentRunState } from "../../state/agent.state";
import { useAppStore } from "../../store";
import {
  partsForMessage,
  persistedRunOutcomeOf,
  type MessagePartsInput,
} from "../../utils/chat-parts.utils";
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
    case "unknown":
      return (
        <>
          {part.toolName} (<FormattedMessage defaultMessage="Unknown" />)
        </>
      );
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

const ReasonSuffix = ({ reason }: { reason?: string }) =>
  reason ? (
    <>
      {" "}
      <FormattedMessage defaultMessage="— {reason}" values={{ reason }} />
    </>
  ) : null;

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
      <ReasonSuffix reason={part.reason} />
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
        <ReasonSuffix reason={part.reason} />
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
  useEffect(() => {
    setOpen(part.open);
  }, [part.open]);
  const panelId = `reasoning-panel-${useId()}`;
  return (
    <Box>
      <Button
        variant="text"
        size="small"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        sx={{
          color: "text.secondary",
          cursor: "pointer",
          userSelect: "none",
          p: 0,
          minWidth: 0,
          fontSize: "inherit",
          fontWeight: "inherit",
          lineHeight: "inherit",
          textAlign: "left",
          "&:hover": {
            textDecoration: "underline",
            backgroundColor: "transparent",
          },
        }}
      >
        {open ? (
          <FormattedMessage defaultMessage="Thinking…" />
        ) : (
          <FormattedMessage defaultMessage="Thought process" />
        )}
      </Button>
      <Collapse in={open} id={panelId}>
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

export const RetryButton = ({ conversationId }: { conversationId: string }) => (
  <Button
    size="small"
    variant="text"
    onClick={() => void retryAssistant(conversationId).catch(showErrorSnackbar)}
  >
    <FormattedMessage defaultMessage="Retry" />
  </Button>
);

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
    {part.kind === "error" && <RetryButton conversationId={conversationId} />}
  </Stack>
);

const isActiveRun = (state: AgentRunState | undefined): boolean =>
  state !== undefined &&
  state.status !== "done" &&
  state.status !== "error" &&
  !state.aborted;

const getRunNote = (
  message: ChatMessage,
  agentState: AgentRunState | undefined,
  intl: IntlShape,
): MessagePartsInput["runNote"] => {
  // A new run's startup must not display the previous attempt's error.
  if (isActiveRun(agentState)) return null;
  let outcome = persistedRunOutcomeOf(message);
  if (agentState?.aborted) outcome = "aborted";
  else if (agentState?.status === "error") outcome = "error";
  if (outcome === "aborted") {
    return {
      kind: "status",
      text: intl.formatMessage({ defaultMessage: "Stopped." }),
    };
  }
  if (outcome === "error") {
    return {
      kind: "error",
      text:
        agentState?.error ||
        intl.formatMessage({ defaultMessage: "Something went wrong." }),
    };
  }
  return null;
};

const canRetryMessage = (
  message: ChatMessage,
  agentState: AgentRunState | undefined,
  streaming: boolean,
  isRunNoteAnchor: boolean,
  runNote: MessagePartsInput["runNote"],
): boolean =>
  isRunNoteAnchor &&
  message.role === "assistant" &&
  !streaming &&
  !isActiveRun(agentState) &&
  runNote?.kind !== "status";

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
  const isRunNoteAnchor = useAppStore((s) => {
    if (!message) return false;
    const ids =
      s.chatMessageIdsByConversationId?.[message.conversationId] ?? [];
    // Tool-result rows can follow the final assistant message. Keep its run
    // note visible without duplicating it onto those result-only rows.
    for (let index = ids.length - 1; index >= 0; index -= 1) {
      const candidate = s.chatMessageById[ids[index]];
      if (candidate?.metadata?.type === "tool-result") continue;
      return ids[index] === messageId;
    }
    return false;
  });

  if (!message)
    return {
      message: undefined,
      parts: [] as ChatPart[],
      permissions,
      canRetry: false,
    };

  const runNote =
    !streaming && isRunNoteAnchor
      ? getRunNote(message, agentState, intl)
      : null;

  const parts = partsForMessage({
    message,
    streaming,
    liveToolCalls: streaming ? (agentState?.toolCalls ?? []) : [],
    permissions,
    runNote,
  });
  const canRetry = canRetryMessage(
    message,
    agentState,
    Boolean(streaming),
    isRunNoteAnchor,
    runNote,
  );
  return { message, parts, permissions, canRetry };
};
