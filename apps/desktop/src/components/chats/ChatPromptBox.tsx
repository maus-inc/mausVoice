import { SendRounded, StopRounded } from "@mui/icons-material";
import { Box, IconButton, InputBase } from "@mui/material";
import { useState } from "react";
import { useIntl } from "react-intl";
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
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    onSend(text);
    setSending(true);
    try {
      await sendChatMessage(conversationId, text);
    } catch (error) {
      getLogger().error("Failed to send message", error);
    } finally {
      setSending(false);
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
        placeholder={intl.formatMessage({
          defaultMessage: "Type a message…",
        })}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
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
