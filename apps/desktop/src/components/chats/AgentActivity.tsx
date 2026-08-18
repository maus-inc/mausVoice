/**
 * Pattern from siriwatknp/mui-treasury ai-reasoning.tsx:
 * button trigger, duration tracking, auto-open while streaming, auto-close 1s after.
 */
import { Box, Stack, Typography } from "@mui/material";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { FormattedMessage } from "react-intl";
import type { StreamingToolCall } from "../../state/app.state";
import { useAppStore } from "../../store";

type AgentActivityProps = {
  messageId: string;
};

const AUTO_CLOSE_DELAY = 1000;

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
  const [isOpen, setIsOpen] = useState(true);
  const [duration, setDuration] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [hasAutoClosed, setHasAutoClosed] = useState(false);

  const isStreaming = streaming?.isStreaming ?? false;

  useEffect(() => {
    if (isStreaming) {
      if (startTime === null) {
        setStartTime(Date.now());
        setIsOpen(true);
      }
    } else if (startTime !== null) {
      setDuration(Math.max(1, Math.ceil((Date.now() - startTime) / 1000)));
      setStartTime(null);
    }
  }, [isStreaming, startTime]);

  useEffect(() => {
    if (!isStreaming && isOpen && !hasAutoClosed && duration > 0) {
      const timer = window.setTimeout(() => {
        setIsOpen(false);
        setHasAutoClosed(true);
      }, AUTO_CLOSE_DELAY);
      return () => window.clearTimeout(timer);
    }
  }, [isStreaming, isOpen, hasAutoClosed, duration]);

  if (!streaming) {
    return null;
  }

  const { toolCalls, reasoning } = streaming;
  if (toolCalls.length === 0 && reasoning.length === 0) {
    return null;
  }

  return (
    <Stack spacing={0.25} sx={{ px: 0.5, mb: 0.5 }}>
      {toolCalls.map((tc) => (
        <ToolCallLine key={tc.toolCallId} tc={tc} />
      ))}
      {reasoning.length > 0 && (
        <Box>
          <Box
            component="button"
            type="button"
            onClick={() => setIsOpen((o) => !o)}
            aria-expanded={isOpen}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              color: "text.secondary",
              fontSize: "0.875rem",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              p: 0,
              "&:hover": { color: "text.primary" },
            }}
          >
            <Typography variant="caption" sx={{ color: "inherit" }}>
              {isStreaming || duration === 0 ? (
                <FormattedMessage defaultMessage="Thinking…" />
              ) : (
                <FormattedMessage
                  defaultMessage="Thought for {seconds} seconds"
                  values={{ seconds: duration }}
                />
              )}
            </Typography>
            <ChevronDown
              size={16}
              strokeWidth={1.9}
              style={{
                transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
                transition: "transform 200ms",
              }}
            />
          </Box>
          {isOpen && (
            <Typography
              variant="caption"
              sx={{
                mt: 1,
                color: "text.secondary",
                whiteSpace: "pre-wrap",
                display: "block",
                pl: 1,
                borderLeft: 1,
                borderColor: "divider",
                maxHeight: 200,
                overflow: "auto",
              }}
            >
              {reasoning}
            </Typography>
          )}
        </Box>
      )}
    </Stack>
  );
};
