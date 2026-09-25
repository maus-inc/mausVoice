import { SendRounded, StopRounded } from "@mui/icons-material";
import { Box, IconButton, InputBase } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { abortAgent, sendChatMessage } from "../../actions/chat.actions";
import { getLogger } from "../../utils/log.utils";

type ChatPromptBoxProps = {
  conversationId: string;
  running: boolean;
  onSend: (text: string) => void;
};

export const ChatPromptBox = ({
  conversationId,
  running,
  onSend,
}: ChatPromptBoxProps) => {
  const intl = useIntl();
  const inputLabel = intl.formatMessage({ defaultMessage: "Type a message…" });
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const editRevision = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sendingRef.current || running) return;
    const revision = editRevision.current;
    sendingRef.current = true;
    setSending(true);
    try {
      await sendChatMessage(conversationId, text, () => {
        if (!mounted.current) return;
        // Do not erase a new draft typed while the write was pending.
        if (editRevision.current === revision) setInput("");
        onSend(text);
      });
    } catch (error) {
      // Repository/provider errors can contain the submitted text or credentials.
      getLogger().error("Failed to send message");
      if (mounted.current) showErrorSnackbar(error);
    } finally {
      sendingRef.current = false;
      if (mounted.current) setSending(false);
    }
  };

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        p: 1,
        borderRadius: 1,
        border: 1,
        borderColor: "divider",
      }}
    >
      <InputBase
        fullWidth
        placeholder={inputLabel}
        slotProps={{ input: { "aria-label": inputLabel } }}
        value={input}
        onChange={(e) => {
          editRevision.current += 1;
          setInput(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (running) return;
            void handleSend();
          }
        }}
        sx={{ px: 1 }}
      />
      {running ? (
        <IconButton
          onClick={() => abortAgent(conversationId)}
          color="error"
          size="small"
          aria-label={intl.formatMessage({ defaultMessage: "Stop generating" })}
        >
          <StopRounded />
        </IconButton>
      ) : (
        <IconButton
          onClick={() => void handleSend()}
          color="primary"
          size="small"
          disabled={sending}
          aria-label={intl.formatMessage({ defaultMessage: "Send message" })}
        >
          <SendRounded />
        </IconButton>
      )}
    </Box>
  );
};
