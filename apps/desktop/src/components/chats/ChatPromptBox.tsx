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
    } catch {
      // A repository or provider error can carry the submitted text, a
      // transcript, or a credential, and it goes straight into a snackbar the
      // user sees (and a screenshot they may share). The detail goes to the
      // log, where it is redacted and stays on the machine; the snackbar gets a
      // localized sentence that says the same thing without the payload.
      getLogger().error("Failed to send message");
      if (mounted.current) {
        showErrorSnackbar(
          intl.formatMessage({
            defaultMessage: "Failed to send message. Please try again.",
          }),
        );
      }
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
          // `isComposing` is the IME's own "I am assembling a candidate" flag.
          // An Enter that carries it is the user accepting a composition, not
          // asking to send, and submitting there discarded the candidate and
          // posted a half-finished word.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
