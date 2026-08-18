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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { applyVoiceEditInstruction } from "../../actions/composer.actions";
import { transcribeAudio } from "../../actions/transcribe.actions";
import { getTranscribeAudioRepo, getGenerateTextRepo } from "../../repos";
import { getAppState, produceAppState, useAppStore } from "../../store";
import { getLogger } from "../../utils/log.utils";
import { getMyPreferredMicrophone } from "../../utils/user.utils";
import {
  VoiceInstructionRecorder,
  type SpeechRecognitionLike,
} from "./voiceInstructionRecorder";

type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
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
  const recorderRef = useRef<VoiceInstructionRecorder | null>(null);
  // Tracks mount state so async edit work cannot setState after the composer
  // window is torn down (Esc / Cancel / unmount during a network round-trip).
  const mountedRef = useRef(true);

  // Voice Edit Mode relies on the webview's SpeechRecognition API, which only
  // exists on Chromium-based webviews. Feature-detect once so we can disable
  // the mic button with a clear message instead of silently no-op'ing (or
  // crashing when `toggleVoiceInstruction` can't construct a recognizer). This
  // is constant for the webview's lifetime, so capturing it by value is safe.
  const speechRecognitionSupported = useMemo(() => {
    const speechWindow = window as SpeechWindow;
    return Boolean(
      speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition,
    );
  }, []);

  // The composer is a fresh webview whose store starts empty and is populated
  // asynchronously by RootSideEffects (preferences + API keys). Subscribe to the
  // slices that drive provider resolution so availability stays live and the UI
  // enables Voice Edit once data loads, instead of freezing the empty first
  // render.
  const aiTranscription = useAppStore((s) => s.settings.aiTranscription);
  const apiKeyById = useAppStore((s) => s.apiKeyById);
  const userPrefs = useAppStore((s) => s.userPrefs);

  const canUseConfiguredProvider = useMemo(() => {
    try {
      getTranscribeAudioRepo();
      return true;
    } catch {
      return false;
    }
  }, [aiTranscription, apiKeyById]);

  const hasGenerationProvider = useMemo(() => {
    try {
      return Boolean(getGenerateTextRepo().repo);
    } catch {
      return false;
    }
  }, [userPrefs, apiKeyById]);

  // The feature is available when a generation provider is configured and a
  // capture path exists (the configured transcription provider or the
  // webview's SpeechRecognition fallback).
  const voiceInstructionSupported =
    hasGenerationProvider &&
    (speechRecognitionSupported || canUseConfiguredProvider);

  // Single discriminant for why Voice Edit dictation is unavailable, so the mic
  // button and its caption always report the same cause.
  let disabledReason: string | null = null;
  if (!voiceInstructionSupported) {
    disabledReason = !hasGenerationProvider
      ? intl.formatMessage({
          defaultMessage:
            "Configure a text-generation provider to use Voice Edit Mode.",
        })
      : intl.formatMessage({
          defaultMessage: "Voice editing is not supported on this platform",
        });
  }

  // Held in a ref and refreshed in an effect (never during render) so a locale
  // change while the composer is open updates the recorder's unsupported
  // message without a render-phase ref write.
  const unsupportedMessageRef = useRef(
    intl.formatMessage({
      defaultMessage: "Voice editing is not supported on this platform",
    }),
  );
  useEffect(() => {
    unsupportedMessageRef.current = intl.formatMessage({
      defaultMessage: "Voice editing is not supported on this platform",
    });
  }, [intl]);

  // Construct the recorder in an effect (not during render) so StrictMode's
  // double render cannot leave a discarded, undisposed instance. Provider
  // availability is re-probed on every start via canUseProvider, so the recorder
  // never freezes a stale first-render capability.
  useEffect(() => {
    const recorder = new VoiceInstructionRecorder({
      invoke,
      transcribe: async ({ samples, sampleRate }) => {
        const result = await transcribeAudio({ samples, sampleRate });
        return result.sanitizedTranscript.trim();
      },
      getPreferredMicrophone: () =>
        getMyPreferredMicrophone(getAppState()) ?? null,
      createSpeechRecognition: () => {
        const speechWindow = window as SpeechWindow;
        const Ctor =
          speechWindow.SpeechRecognition ??
          speechWindow.webkitSpeechRecognition;
        return Ctor ? new Ctor() : null;
      },
      getLang: () => document.documentElement.lang || "en-US",
      canUseProvider: () => {
        try {
          getTranscribeAudioRepo();
          return true;
        } catch {
          return false;
        }
      },
      speechRecognitionSupported,
      unsupportedMessage: () => unsupportedMessageRef.current,
      onListeningChange: setIsListening,
      onTranscript: (spoken) =>
        setInstruction((current) => `${current} ${spoken}`.trim()),
      onError: setEditError,
      onResetLevels: () =>
        produceAppState((draft) => {
          draft.audioLevels = [];
        }),
      logger: getLogger(),
    });
    recorderRef.current = recorder;
    return () => {
      recorder.dispose();
      recorderRef.current = null;
    };
  }, [speechRecognitionSupported]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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

  const finish = useCallback(
    async (accepted: boolean) => {
      recorderRef.current?.dispose();
      try {
        await emit("composer-result", {
          requestId,
          accepted,
          text: accepted ? text : "",
        });
      } finally {
        await closeComposerWindow();
      }
    },
    [requestId, text],
  );

  // Esc cancels the composer, matching the window close-request path which is
  // already wired to Cancel (composer.utils.ts). This completes the keyboard
  // loop opened by the auto-focused transcript field and Cmd/Ctrl+Enter to apply.
  // `finish` is declared above this effect so its dependency array does not read
  // a `const` that is still in the temporal dead zone during render.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void finish(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [finish]);

  const applyEdit = async () => {
    if (!instruction.trim() || !text.trim() || isEditing) return;
    setIsEditing(true);
    setEditError(null);
    try {
      const edited = await applyVoiceEditInstruction({ text, instruction });
      if (mountedRef.current && edited !== undefined) setText(edited);
      setInstruction("");
    } catch (error) {
      if (mountedRef.current) {
        setEditError(
          error instanceof Error
            ? error.message
            : intl.formatMessage({ defaultMessage: "Edit failed." }),
        );
      }
    } finally {
      if (mountedRef.current) setIsEditing(false);
    }
  };

  const toggleVoiceInstruction = () => {
    void recorderRef.current?.toggle();
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
              title={disabledReason ?? undefined}
            >
              <MicIcon />
            </IconButton>
            <Button
              variant="outlined"
              onClick={() => void applyEdit()}
              disabled={
                !instruction.trim() || isEditing || !hasGenerationProvider
              }
              sx={{ whiteSpace: "nowrap", minHeight: 40 }}
            >
              {isEditing ? (
                <CircularProgress size={18} />
              ) : (
                <FormattedMessage defaultMessage="Apply" />
              )}
            </Button>
          </Stack>
          {disabledReason && (
            <Typography variant="caption" color="text.secondary">
              {disabledReason}
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
              disabled={isEditing || !text.trim()}
            >
              <FormattedMessage defaultMessage="Insert" />
            </Button>
          </Stack>
        </Stack>
      </Paper>
    </Box>
  );
};
