import { Box, Collapse, Stack, Typography } from "@mui/material";
import { useState } from "react";
import { FormattedMessage } from "react-intl";
import type { StreamingToolCall } from "../../state/app.state";
import { useAppStore } from "../../store";

type AgentActivityProps = {
  messageId: string;
};

const ToolCallLine = ({ tc }: { tc: StreamingToolCall }) => (
  <Typography
    variant="caption"
    sx={{
      color: "text.secondary",
      fontStyle: "italic",
    }}
  >
    {tc.done ? (
      <FormattedMessage
        defaultMessage="Used {toolName}"
        values={{ toolName: tc.toolName }}
      />
    ) : (
      <FormattedMessage
        defaultMessage="Using {toolName}…"
        values={{ toolName: tc.toolName }}
      />
    )}
  </Typography>
);

export const AgentActivity = ({ messageId }: AgentActivityProps) => {
  const streaming = useAppStore((s) => s.streamingMessageById[messageId]);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  if (!streaming) {
    return null;
  }

  const { toolCalls, reasoning, isStreaming } = streaming;
  const hasActivity = toolCalls.length > 0 || reasoning.length > 0;
  if (!hasActivity) {
    return null;
  }

  return (
    <Stack spacing={0.25} sx={{ px: 0.5, mb: 0.5 }}>
      {toolCalls.map((tc) => (
        <ToolCallLine key={tc.toolCallId} tc={tc} />
      ))}
      {reasoning.length > 0 && (
        <Box>
          <Typography
            variant="caption"
            onClick={() => setReasoningOpen((o) => !o)}
            sx={{
              color: "text.secondary",
              cursor: "pointer",
              userSelect: "none",
              "&:hover": { textDecoration: "underline" },
            }}
          >
            {isStreaming ? (
              <FormattedMessage defaultMessage="Thinking…" />
            ) : (
              <FormattedMessage defaultMessage="Thought process" />
            )}
          </Typography>
          <Collapse in={reasoningOpen}>
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
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
              {reasoning}
            </Typography>
          </Collapse>
        </Box>
      )}
    </Stack>
  );
};
