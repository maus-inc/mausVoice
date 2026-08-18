import { Box, ButtonBase, Stack, Typography } from "@mui/material";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import type { StreamingToolCall } from "../../state/app.state";
import { useAppStore } from "../../store";

type AgentActivityProps = {
  messageId: string;
};

const ToolCallLine = ({ tc }: { tc: StreamingToolCall }) => (
  <Typography variant="caption" sx={{ color: "text.secondary", fontStyle: "italic" }}>
    {tc.done ? (
      <FormattedMessage defaultMessage="Used {toolName}" values={{ toolName: tc.toolName }} />
    ) : (
      <FormattedMessage defaultMessage="Using {toolName}…" values={{ toolName: tc.toolName }} />
    )}
  </Typography>
);

export const AgentActivity = ({ messageId }: AgentActivityProps) => {
  const streaming = useAppStore((s) => s.streamingMessageById[messageId]);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const startedAtRef = useRef<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (!streaming) {
      return;
    }
    if (streaming.isStreaming && startedAtRef.current == null) {
      startedAtRef.current = Date.now();
      setReasoningOpen(true);
    }
    if (!streaming.isStreaming && startedAtRef.current != null) {
      setElapsedSec(Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000)));
      const t = window.setTimeout(() => setReasoningOpen(false), 1000);
      return () => window.clearTimeout(t);
    }
  }, [streaming]);

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
          <ButtonBase
            onClick={() => setReasoningOpen((o) => !o)}
            aria-expanded={reasoningOpen}
            sx={{
              display: "inline-flex",
              alignItems: "center",
              gap: 0.5,
              color: "text.secondary",
              borderRadius: 0.5,
              px: 0.25,
            }}
          >
            <ChevronRight
              size={14}
              strokeWidth={1.9}
              style={{
                transform: reasoningOpen ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 200ms cubic-bezier(0.23, 1, 0.32, 1)",
              }}
            />
            <Typography variant="caption" sx={{ color: "inherit" }}>
              {isStreaming ? (
                <FormattedMessage defaultMessage="Thinking…" />
              ) : elapsedSec > 0 ? (
                <FormattedMessage
                  defaultMessage="Thought for {seconds} seconds"
                  values={{ seconds: elapsedSec }}
                />
              ) : (
                <FormattedMessage defaultMessage="Thought process" />
              )}
            </Typography>
          </ButtonBase>
          <Box
            sx={{
              display: "grid",
              gridTemplateRows: reasoningOpen ? "1fr" : "0fr",
              transition: "grid-template-rows 180ms cubic-bezier(0.23, 1, 0.32, 1)",
              "@media (prefers-reduced-motion: reduce)": {
                transition: "none",
              },
            }}
          >
            <Typography
              variant="caption"
              sx={{
                overflow: "hidden",
                color: "text.secondary",
                whiteSpace: "pre-wrap",
                display: "block",
                mt: 0.25,
                pl: 1,
                borderLeft: 1,
                borderColor: "divider",
                maxHeight: 200,
              }}
            >
              {reasoning}
            </Typography>
          </Box>
        </Box>
      )}
    </Stack>
  );
};
