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
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { applyVoiceEditInstruction } from "../../actions/composer.actions";
import { transcribeAudio } from "../../actions/transcribe.actions";
import { getTranscribeAudioRepo } from "../../repos";
import { getAppState, produceAppState } from "../../store";
import { getLogger } from "../../utils/log.utils";
import { getMyPreferredMicrophone } from "../../utils/user.utils";
import type { StopRecordingResponse } from "../../types/transcription-session.types";

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
  const intl = useIntl();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const requestId = params.get("requestId") ?? "";
  const [text, setText] = useState("");
  const [instruction, setInstruction] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const providerRecordingRef = useRef(false);

  // Voice Edit Mode relies on the webview's SpeechRecognition API, which only
  // exists on Chromium-based webviews. Feature-detect once so we can disable
  // the mic button with a clear message instead of silently no-op'ing (or
  // crashing when `toggleVoiceInstruction` can't construct a recognizer).
  const speechRecognitionSupported = useMemo(() => {
    const speechWindow = window as SpeechWindow;
    return Boolean(
      speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition,
    );
  }, []);

  // Prefer routing the spoken instruction through the configured mausVoice
  // transcription provider (the same provider selection dictation uses). This
  // is available whenever a transcription repo can be resolved from the active
  // preferences. We probe it once up front (mirroring how the rest of the app
  // selects a provider) and fall back to the webview's SpeechRecognition only
  // when the configured provider cannot be used on this platform.
  const canUseConfiguredProvider = useMemo(() => {
    try {
      getTranscribeAudioRepo();
      return true;
    } catch {
      return false;
    }
  }, []);

  // The mic is usable if either the configured provider path or the browser's
  // SpeechRecognition (webview-supported) fallback is available.
  const voiceInstructionSupported =
    speechRecognitionSupported || canUseConfiguredProvider;

  useEffect(() => {
    let active = true;
    void invoke<string | null>("composer_peek_text", { requestId })
      .then((initialText) => {
        if (active) setText(initialText ?? "");
      })
      .catch(() => {
        if (active) {
          setEditError(
            intl.formatMessage({
              defaultMessage: "Unable to load transcript.",
            }),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [intl, requestId]);

  // Release the native recorder if the composer window closes mid-recording
  // so we never leave the global audio capture running (webview lifecycle).
  useEffect(() => {
    return () => {
      if (providerRecordingRef.current) {
        providerRecordingRef.current = false;
        void invoke("stop_recording").catch(() => undefined);
      }
    };
  }, []);

  const finish = async (accepted: boolean) => {
    try {
      await emit("composer-result", {
        requestId,
        accepted,
        text: accepted ? text : "",
      });
    } finally {
      await closeComposerWindow();
    }
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
      setEditError(
        error instanceof Error
          ? error.message
          : intl.formatMessage({ defaultMessage: "Edit failed." }),
      );
    } finally {
      setIsEditing(false);
    }
  };

  const startBrowserSpeechRecognition = () => {
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

  // Primary path: capture audio natively and route it through the configured
  // mausVoice transcription provider. Reuses `transcribeAudio`, which applies
  // the exact same provider-selection logic dictation uses (local Whisper/ONNX
  // or a cloud provider such as Groq), so the spoken instruction is
  // transcribed by the user's selected engine.
  const startProviderRecording = async (): Promise<boolean> => {
    try {
      await invoke("start_recording", {
        args: {
          preferredMicrophone: getMyPreferredMicrophone(getAppState()) ?? null,
        },
      });
      providerRecordingRef.current = true;
      setIsListening(true);
      return true;
    } catch (error) {
      getLogger().warning(
        `Voice Edit Mode: configured provider recording unavailable, falling back to browser speech recognition (${error})`,
      );
      return false;
    }
  };

  const stopProviderRecording = async () => {
    try {
      const response = await invoke<StopRecordingResponse>("stop_recording");
      const samples =
        response.samples instanceof Float32Array
          ? Array.from(response.samples)
          : response.samples;
      const sampleRate = response.sampleRate ?? 0;
      if (samples && samples.length > 0 && sampleRate > 0) {
        const result = await transcribeAudio({ samples, sampleRate });
        const transcript = result.sanitizedTranscript.trim();
        if (transcript) {
          setInstruction((current) => `${current} ${transcript}`.trim());
        }
      }
    } catch (error) {
      getLogger().warning(
        `Voice Edit Mode: provider transcription failed (${error})`,
      );
      // Graceful fallback to the browser SpeechRecognition path when the
      // webview supports it (mirrors the existing feature detection).
      if (speechRecognitionSupported) {
        startBrowserSpeechRecognition();
      } else {
        setEditError(
          intl.formatMessage({
            defaultMessage: "Voice editing is not supported on this platform",
          }),
        );
      }
    } finally {
      setIsListening(false);
      produceAppState((draft) => {
        draft.audioLevels = [];
      });
    }
  };

  const toggleVoiceInstruction = async () => {
    if (isListening) {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      } else if (providerRecordingRef.current) {
        providerRecordingRef.current = false;
        void stopProviderRecording();
      }
      return;
    }

    // Primary: use the configured transcription provider when one can be
    // resolved from the active preferences.
    if (canUseConfiguredProvider) {
      if (await startProviderRecording()) {
        return;
      }
    }

    // Fallback: browser SpeechRecognition, only when the webview supports it.
    if (speechRecognitionSupported) {
      startBrowserSpeechRecognition();
      return;
    }

    setEditError(
      intl.formatMessage({
        defaultMessage: "Voice editing is not supported on this platform",
      }),
    );
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
            aria-label={intl.formatMessage({ defaultMessage: "Transcript" })}
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
              placeholder={intl.formatMessage({
                defaultMessage: "Make this shorter or turn it into bullets",
              })}
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
              aria-label={intl.formatMessage({
                defaultMessage: "Dictate edit instruction",
              })}
              disabled={isEditing || !voiceInstructionSupported}
              title={
                voiceInstructionSupported
                  ? undefined
                  : intl.formatMessage({
                      defaultMessage:
                        "Voice editing is not supported on this platform",
                    })
              }
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
          {!voiceInstructionSupported && (
            <Typography variant="caption" color="text.secondary">
              <FormattedMessage defaultMessage="Voice editing is not supported on this platform." />
            </Typography>
          )}
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
