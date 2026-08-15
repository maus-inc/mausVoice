import MicIcon from "@mui/icons-material/Mic";
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useMemo, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import { applyVoiceEditInstruction } from "../../actions/composer.actions";

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      }) => void)
    | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

const closeComposerWindow = async () => {
  await getCurrentWindow()
    .close()
    .catch(() => undefined);
};

export const ComposerPage = () => {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const requestId = params.get("requestId") ?? "";
  const [text, setText] = useState(params.get("text") ?? "");
  const [instruction, setInstruction] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const finish = async (accepted: boolean) => {
    await emit("composer-result", {
      requestId,
      accepted,
      text: accepted ? text : "",
    });
    await closeComposerWindow();
  };

  const applyEdit = async () => {
    if (!instruction.trim() || !text.trim() || isEditing) return;
    setIsEditing(true);
    setEditError(null);
    try {
      const edited = await applyVoiceEditInstruction({ text, instruction });
      if (edited) setText(edited);
      setInstruction("");
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "Edit failed.");
    } finally {
      setIsEditing(false);
    }
  };

  const toggleVoiceInstruction = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const SpeechRecognition =
      (window as SpeechWindow).SpeechRecognition ??
      (window as SpeechWindow).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.lang = document.documentElement.lang || "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const first = event.results[0]?.[0]?.transcript;
      if (first) setInstruction((current) => `${current} ${first}`.trim());
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setIsListening(false);
    };
    recognition.onerror = () => {
      recognitionRef.current = null;
      setIsListening(false);
    };
    recognitionRef.current = recognition;
    setIsListening(true);
    recognition.start();
  };

  return (
    <Box
      sx={{
        minHeight: "100vh",
        bgcolor: "background.default",
        p: { xs: 2, sm: 3 },
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Paper
        elevation={8}
        sx={{
          width: "100%",
          maxWidth: 640,
          borderRadius: 3,
          p: { xs: 2, sm: 3 },
        }}
      >
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              <FormattedMessage defaultMessage="Review transcript" />
            </Typography>
            <Typography variant="body2" color="text.secondary">
              <FormattedMessage defaultMessage="Edit the text before inserting it." />
            </Typography>
          </Box>
          <TextField
            autoFocus
            multiline
            minRows={7}
            fullWidth
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-label="Transcript"
          />
          {editError && (
            <Typography variant="caption" color="error">
              {editError}
            </Typography>
          )}
          <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
            <TextField
              fullWidth
              size="small"
              label={<FormattedMessage defaultMessage="Voice Edit Mode" />}
              placeholder={"Make this shorter or turn it into bullets"}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  void applyEdit();
                }
              }}
            />
            <IconButton
              color={isListening ? "error" : "primary"}
              onClick={toggleVoiceInstruction}
              aria-label="Dictate edit instruction"
              disabled={isEditing}
            >
              <MicIcon />
            </IconButton>
            <Button
              variant="outlined"
              onClick={() => void applyEdit()}
              disabled={!instruction.trim() || isEditing}
              sx={{ whiteSpace: "nowrap", minHeight: 40 }}
            >
              {isEditing ? (
                <CircularProgress size={18} />
              ) : (
                <FormattedMessage defaultMessage="Apply" />
              )}
            </Button>
          </Stack>
          <Stack
            direction="row"
            spacing={1}
            sx={{ justifyContent: "flex-end" }}
          >
            <Button variant="text" onClick={() => void finish(false)}>
              <FormattedMessage defaultMessage="Cancel" />
            </Button>
            <Button
              variant="contained"
              onClick={() => void finish(true)}
              disabled={!text.trim()}
            >
              <FormattedMessage defaultMessage="Insert" />
            </Button>
          </Stack>
        </Stack>
      </Paper>
    </Box>
  );
};
