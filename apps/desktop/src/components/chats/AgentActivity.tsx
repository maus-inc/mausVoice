/**
 * Pattern from siriwatknp/mui-treasury ai-reasoning.tsx:
 * button trigger, duration tracking, auto-open while streaming, auto-close 1s after.
 * Motion: watermelon disclosure spring + assistant-ui thinking elapsed line.
 */
import { Box, Stack, Typography } from "@mui/material";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, ChevronDown } from "lucide-react";
import { DotMatrixLoader } from "../common/DotMatrixLoader";
import { useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import type { StreamingToolCall } from "../../state/app.state";
import { springSnappy } from "../../styles/motion";
import { useAppStore } from "../../store";

type AgentActivityProps = {
  messageId: string;
};

const AUTO_CLOSE_DELAY = 1000;

const ThinkingCaption = ({
  isStreaming,
  duration,
}: {
  isStreaming: boolean;
  duration: number;
}) => {
  if (isStreaming && duration > 0) {
    return (
      <FormattedMessage
        defaultMessage="Thinking · {seconds}s"
        values={{ seconds: duration }}
      />
    );
  }
  if (isStreaming || duration === 0) {
    return <FormattedMessage defaultMessage="Thinking…" />;
  }
  return (
    <FormattedMessage
      defaultMessage="Thought for {seconds} seconds"
      values={{ seconds: duration }}
    />
  );
};

const ToolCallLine = ({ tc }: { tc: StreamingToolCall }) => {
  const intl = useIntl();
  return (
    <Stack
      direction="row"
      spacing={0.75}
      sx={{ alignItems: "center", minWidth: 0 }}
    >
      {tc.done ? (
        <Check
          size={14}
          strokeWidth={2}
          color="var(--mui-palette-text-secondary)"
        />
      ) : (
        <DotMatrixLoader
          seed={tc.toolCallId}
          size={14}
          dotSize={2}
          aria-label={intl.formatMessage({ defaultMessage: "Running tool" })}
        />
      )}
      <Typography
        variant="caption"
        sx={{ color: "text.secondary", fontStyle: "italic", minWidth: 0 }}
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
    </Stack>
  );
};

export const AgentActivity = ({ messageId }: AgentActivityProps) => {
  const streaming = useAppStore((s) => s.streamingMessageById[messageId]);
  const [isOpen, setIsOpen] = useState(true);
  const [duration, setDuration] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const [hasAutoClosed, setHasAutoClosed] = useState(false);
  const reduceMotion = useReducedMotion();

  const isStreaming = streaming?.isStreaming ?? false;

  useEffect(() => {
    if (isStreaming) {
      if (startTimeRef.current === null) {
        startTimeRef.current = Date.now();
        setIsOpen(true);
      }
    } else if (startTimeRef.current !== null) {
      setDuration(
        Math.max(1, Math.ceil((Date.now() - startTimeRef.current) / 1000)),
      );
      startTimeRef.current = null;
    }
  }, [isStreaming]);

  useEffect(() => {
    if (!isStreaming) {
      return;
    }
    const tick = () => {
      if (startTimeRef.current == null) return;
      setDuration(
        Math.max(1, Math.ceil((Date.now() - startTimeRef.current) / 1000)),
      );
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [isStreaming]);

  useEffect(() => {
    if (isStreaming || !isOpen || hasAutoClosed || duration === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setIsOpen(false);
      setHasAutoClosed(true);
    }, AUTO_CLOSE_DELAY);
    return () => window.clearTimeout(timer);
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
              <ThinkingCaption isStreaming={isStreaming} duration={duration} />
            </Typography>
            <Box
              component={reduceMotion ? "span" : motion.span}
              animate={reduceMotion ? undefined : { rotate: isOpen ? 180 : 0 }}
              transition={springSnappy}
              style={{ display: "inline-flex" }}
            >
              <ChevronDown size={16} strokeWidth={1.9} />
            </Box>
          </Box>
          <AnimatePresence initial={false}>
            {isOpen && (
              <Typography
                component={reduceMotion ? "span" : motion.span}
                variant="caption"
                {...(reduceMotion
                  ? {}
                  : {
                      initial: { opacity: 0, height: 0 },
                      animate: { opacity: 1, height: "auto" },
                      exit: { opacity: 0, height: 0 },
                      transition: springSnappy,
                    })}
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
          </AnimatePresence>
        </Box>
      )}
    </Stack>
  );
};
