import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { Mic } from "lucide-react";
import { MetalChrome } from "../common/MetalChrome";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { applyVoiceEditInstruction } from "../../actions/composer.actions";
import { transcribeAudio } from "../../actions/transcribe.actions";
import { getTranscribeAudioRepo, getGenerateTextRepo } from "../../repos";
import { getAppState, produceAppState, useAppStore } from "../../store";
import { getLogger } from "../../utils/log.utils";
import { composerOriginalRequestId } from "../../utils/composer-request-id.utils";
import { countWords } from "../../utils/string.utils";
import { getMyPreferredMicrophone } from "../../utils/user.utils";
import {
  VoiceInstructionRecorder,
  type SpeechRecognitionConstructor,
} from "./voiceInstructionRecorder";

type SpeechWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

const closeComposerWindow = async () => {
  await getCurrentWindow()
    .close()
    .catch(() => undefined);
};

/** Accept a result only while the transcript revision that produced it is current. */
const isApplicableEdit = (
  edited: string | undefined,
  requestedVersion: number,
  currentVersion: number,
): edited is string =>
  edited !== undefined && requestedVersion === currentVersion;

/** Preserve a new instruction typed while the earlier request was in flight. */
const clearSubmittedInstruction = (
  latest: string,
  submitted: string,
): string => (latest === submitted ? "" : latest);

/** Own an edit request and avoid applying results to a newer transcript. */
/** Keep the microphone button and its explanation in agreement. */
const getVoiceEditDisabledReason = (
  supported: boolean,
  hasGenerationProvider: boolean,
  intl: IntlShape,
): string | null => {
  if (supported) return null;
  return hasGenerationProvider
    ? intl.formatMessage({
        defaultMessage: "Voice editing is not supported on this platform",
      })
    : intl.formatMessage({
        defaultMessage:
          "Configure a text-generation provider to use Voice Edit Mode.",
      });
};

type ComposerVoiceEditOptions = {
  text: string;
  instruction: string;
  setText: Dispatch<SetStateAction<string>>;
  setUndoText: Dispatch<SetStateAction<string | null>>;
  setInstruction: Dispatch<SetStateAction<string>>;
  setEditError: Dispatch<SetStateAction<string | null>>;
  mountedRef: RefObject<boolean>;
  transcriptEditVersionRef: RefObject<number>;
  intl: IntlShape;
};

/** Keep only results whose owner and input revision are still current. */
const acceptComposerEdit = (
  edited: string | undefined,
  version: number,
  options: ComposerVoiceEditOptions,
): void => {
  const {
    mountedRef,
    transcriptEditVersionRef,
    text,
    instruction,
    setUndoText,
    setText,
    setInstruction,
  } = options;
  if (!mountedRef.current) return;
  if (isApplicableEdit(edited, version, transcriptEditVersionRef.current)) {
    setUndoText(text);
    setText((latest) => (latest === text ? edited : latest));
  }
  setInstruction((latest) => clearSubmittedInstruction(latest, instruction));
};

const useComposerVoiceEdit = (options: ComposerVoiceEditOptions) => {
  const {
    text,
    instruction,
    setEditError,
    mountedRef,
    transcriptEditVersionRef,
    intl,
  } = options;
  const [isEditing, setIsEditing] = useState(false);
  // React state commits after the event batch, so claim the request first.
  const pendingRef = useRef(false);
  const applyEdit = async () => {
    if (!instruction.trim() || !text.trim() || pendingRef.current) return;
    pendingRef.current = true;
    setIsEditing(true);
    setEditError(null);
    const currentText = text;
    const transcriptEditVersion = transcriptEditVersionRef.current;
    try {
      const edited = await applyVoiceEditInstruction({
        text: currentText,
        instruction,
      });
      acceptComposerEdit(edited, transcriptEditVersion, options);
    } catch (error) {
      if (mountedRef.current) {
        setEditError(
          error instanceof Error
            ? error.message
            : intl.formatMessage({ defaultMessage: "Edit failed." }),
        );
      }
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setIsEditing(false);
    }
  };

  return { isEditing, applyEdit };
};

/** Own the recorder's lifecycle independently from transcript editing. */
const useVoiceInstructionRecorder = (
  speechRecognitionSupported: boolean,
  intl: IntlShape,
  setInstruction: Dispatch<SetStateAction<string>>,
  setEditError: Dispatch<SetStateAction<string | null>>,
) => {
  const [isListening, setIsListening] = useState(false);
  const recorderRef = useRef<VoiceInstructionRecorder | null>(null);
  // Held in a ref and refreshed in an effect (never during render) so a locale
  // change while the composer is open updates the recorder's unsupported
  // message without a render-phase ref write.
  const unsupportedMessageRef = useRef(
    intl.formatMessage({
      defaultMessage: "Voice editing is not supported on this platform",
    }),
  );
  const recordingUnavailableMessageRef = useRef(
    intl.formatMessage({
      defaultMessage: "Could not start recording. Please try again.",
    }),
  );
  const captureFailedMessageRef = useRef(
    intl.formatMessage({
      defaultMessage:
        "The recording may be incomplete. The microphone may still be in use. If its indicator stays on, quit the app.",
    }),
  );
  useEffect(() => {
    unsupportedMessageRef.current = intl.formatMessage({
      defaultMessage: "Voice editing is not supported on this platform",
    });
    recordingUnavailableMessageRef.current = intl.formatMessage({
      defaultMessage: "Could not start recording. Please try again.",
    });
    captureFailedMessageRef.current = intl.formatMessage({
      defaultMessage:
        "The recording may be incomplete. The microphone may still be in use. If its indicator stays on, quit the app.",
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
      recordingUnavailableMessage: () => recordingUnavailableMessageRef.current,
      captureFailedMessage: () => captureFailedMessageRef.current,
      onListeningChange: setIsListening,
      onTranscript: (spoken) =>
        setInstruction((current) => `${current} ${spoken}`.trim()),
      onError: setEditError,
      onResetLevels: () =>
        produceAppState((draft) => {
          // Transcription may finish after a new dictation starts.
          if (draft.overlayPhase === "idle") draft.audioLevels = [];
        }),
      logger: getLogger(),
    });
    recorderRef.current = recorder;
    return () => {
      recorder.dispose();
      recorderRef.current = null;
    };
  }, [speechRecognitionSupported]);

  return { isListening, recorderRef };
};

/** Announce the composer and load its initial text without overwriting edits. */
const useInitialComposerTranscript = (
  requestId: string,
  intl: IntlShape,
  userEditedRef: RefObject<boolean>,
  setText: Dispatch<SetStateAction<string>>,
  setSessionOriginal: Dispatch<SetStateAction<string>>,
  setEditError: Dispatch<SetStateAction<string | null>>,
) => {
  useEffect(() => {
    let active = true;
    // Signal the host process that the webview is alive and responsive.
    // The host (reviewTextInComposer) uses this to cancel its 15s blank-
    // page safety net. Emit on every mount so a re-render that re-runs
    // this effect does not strand the host's safety timer.
    emit("composer-ready", { requestId }).catch(() => undefined);
    void invoke<string | null>("composer_peek_text", { requestId })
      .then((initialText) => {
        if (active && !userEditedRef.current) setText(initialText ?? "");
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
    // The unedited reference is a separate native handoff, not a URL query.
    // An older host may not have supplied one; keep its legacy query fallback.
    void invoke<string | null>("composer_peek_text", {
      requestId: composerOriginalRequestId(requestId),
    })
      .then((original) => {
        if (active && typeof original === "string")
          setSessionOriginal(original);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [
    intl,
    requestId,
    userEditedRef,
    setText,
    setSessionOriginal,
    setEditError,
  ]);
};

/** Complete a composer session and wire Escape to the same cancel path. */
const useComposerFinish = (
  requestId: string,
  text: string,
  intl: IntlShape,
  recorderRef: RefObject<VoiceInstructionRecorder | null>,
  mountedRef: RefObject<boolean>,
  setEditError: Dispatch<SetStateAction<string | null>>,
) => {
  const finish = useCallback(
    async (accepted: boolean) => {
      recorderRef.current?.dispose();
      try {
        await emit("composer-result", {
          requestId,
          accepted,
          text: accepted ? text : "",
        });
        await closeComposerWindow();
      } catch (error) {
        getLogger().error("Failed to emit composer result");
        if (mountedRef.current) {
          setEditError(
            error instanceof Error
              ? error.message
              : intl.formatMessage({
                  defaultMessage: "Unable to send composer result.",
                }),
          );
        }
      }
    },
    [intl, requestId, text, recorderRef, mountedRef, setEditError],
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

  return finish;
};

/** Track capture and generation availability as the composer store hydrates. */
const useComposerCapabilities = () => {
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

  return {
    speechRecognitionSupported,
    hasGenerationProvider,
    voiceInstructionSupported,
  };
};

/** The editable transcript and its original/undo context. */
const TranscriptReview = ({
  transcriptRef,
  text,
  onTextChange,
  editError,
  sessionOriginal,
  undoText,
  isEditing,
  onUndo,
  intl,
}: {
  transcriptRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  onTextChange: (value: string) => void;
  editError: string | null;
  sessionOriginal: string;
  undoText: string | null;
  isEditing: boolean;
  onUndo: (previousText: string) => void;
  intl: IntlShape;
}) => (
  <>
    <TextField
      inputRef={transcriptRef}
      multiline
      minRows={7}
      fullWidth
      value={text}
      onChange={(event) => onTextChange(event.target.value)}
      aria-label={intl.formatMessage({ defaultMessage: "Transcript" })}
    />
    {editError && (
      <Typography variant="caption" color="error">
        {editError}
      </Typography>
    )}
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <Typography variant="caption" color="text.secondary">
        <FormattedMessage
          defaultMessage="{count, plural, one {# word} other {# words}}"
          values={{ count: countWords(text) }}
        />
        {sessionOriginal !== "" && text !== sessionOriginal ? (
          <>
            {" · "}
            <FormattedMessage defaultMessage="Unsaved Changes" />
          </>
        ) : null}
      </Typography>
      {undoText !== null && (
        <Button
          size="small"
          variant="text"
          disabled={isEditing}
          onClick={() => onUndo(undoText)}
        >
          <FormattedMessage defaultMessage="Undo edit" />
        </Button>
      )}
    </Stack>
    {sessionOriginal !== "" && (
      <Accordion disableGutters>
        <AccordionSummary>
          <Typography variant="subtitle2">
            <FormattedMessage
              defaultMessage="Original transcript ({count, plural, one {# word} other {# words}})"
              values={{ count: countWords(sessionOriginal) }}
            />
          </Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ whiteSpace: "pre-wrap" }}
          >
            {sessionOriginal}
          </Typography>
        </AccordionDetails>
      </Accordion>
    )}
  </>
);

/** Instruction entry and capture controls share one capability explanation. */
const VoiceEditControls = ({
  instruction,
  setInstruction,
  isListening,
  toggleVoiceInstruction,
  isEditing,
  applyEdit,
  hasGenerationProvider,
  voiceInstructionSupported,
  intl,
}: {
  instruction: string;
  setInstruction: Dispatch<SetStateAction<string>>;
  isListening: boolean;
  toggleVoiceInstruction: () => void;
  isEditing: boolean;
  applyEdit: () => Promise<void>;
  hasGenerationProvider: boolean;
  voiceInstructionSupported: boolean;
  intl: IntlShape;
}) => {
  const disabledReasonId = useId();
  const disabledReason = getVoiceEditDisabledReason(
    voiceInstructionSupported,
    hasGenerationProvider,
    intl,
  );

  return (
    <>
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
              event.preventDefault();
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
          aria-describedby={disabledReason ? disabledReasonId : undefined}
        >
          <Mic size={20} strokeWidth={2} />
        </IconButton>
        <Button
          variant="outlined"
          onClick={() => void applyEdit()}
          disabled={!instruction.trim() || isEditing || !hasGenerationProvider}
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
        <Typography
          id={disabledReasonId}
          variant="caption"
          color="text.secondary"
        >
          {disabledReason}
        </Typography>
      )}
    </>
  );
};

/** Final session actions share the same completion path as Escape. */
const ComposerActions = ({
  text,
  isEditing,
  finish,
}: {
  text: string;
  isEditing: boolean;
  finish: (accepted: boolean) => Promise<void>;
}) => (
  <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
    <Button
      variant="text"
      onClick={() => {
        finish(false).catch(() => undefined);
      }}
    >
      <FormattedMessage defaultMessage="Cancel" />
    </Button>
    <MetalChrome>
      <Button
        variant="contained"
        onClick={() => {
          finish(true).catch(() => undefined);
        }}
        disabled={isEditing || !text.trim()}
      >
        <FormattedMessage defaultMessage="Insert" />
      </Button>
    </MetalChrome>
  </Stack>
);

/** Own editable session state, revision tracking, and in-flight edit lifetime. */
const useComposerSession = (intl: IntlShape) => {
  const [text, setText] = useState("");
  const [undoText, setUndoText] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const userEditedRef = useRef(false);
  // A pending AI edit must not create an undo point for text the user changed.
  const transcriptEditVersionRef = useRef(0);
  // Tracks mount state so async edit work cannot setState after the composer
  // window is torn down (Esc / Cancel / unmount during a network round-trip).
  const mountedRef = useRef(true);
  const { isEditing, applyEdit } = useComposerVoiceEdit({
    text,
    instruction,
    setText,
    setUndoText,
    setInstruction,
    setEditError,
    mountedRef,
    transcriptEditVersionRef,
    intl,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const updateTranscript = (value: string) => {
    userEditedRef.current = true;
    transcriptEditVersionRef.current += 1;
    setText(value);
  };
  const undoEdit = (previousText: string) => {
    setText(previousText);
    setUndoText(null);
  };

  return {
    text,
    setText,
    undoText,
    instruction,
    setInstruction,
    editError,
    setEditError,
    userEditedRef,
    mountedRef,
    isEditing,
    applyEdit,
    updateTranscript,
    undoEdit,
  };
};

export const ComposerPage = () => {
  const intl = useIntl();
  // Focus the transcript field explicitly once it has mounted rather than with
  // a DOM `autoFocus` prop: `autoFocus` fires as an attribute and cannot be
  // deferred, so it races anything that moves focus in the same commit. This
  // mirrors ContextMenu's own "focus after commit, not via autoFocus" rule.
  // `TextField` forwards `inputRef` to the underlying `<textarea>` (it passes
  // it straight to `Input`'s `inputRef`), so this reaches the real element.
  const transcriptRef = useRef<HTMLTextAreaElement | null>(null);
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const requestId = params.get("requestId") ?? "";
  // Support older composer links, but new sessions obtain this through the
  // native handoff rather than placing transcript text in a URL.
  const [sessionOriginal, setSessionOriginal] = useState(
    () => params.get("original") ?? "",
  );
  const {
    text,
    setText,
    undoText,
    instruction,
    setInstruction,
    editError,
    setEditError,
    userEditedRef,
    mountedRef,
    isEditing,
    applyEdit,
    updateTranscript,
    undoEdit,
  } = useComposerSession(intl);

  const {
    speechRecognitionSupported,
    hasGenerationProvider,
    voiceInstructionSupported,
  } = useComposerCapabilities();

  useEffect(() => {
    transcriptRef.current?.focus();
  }, []);

  const { isListening, recorderRef } = useVoiceInstructionRecorder(
    speechRecognitionSupported,
    intl,
    setInstruction,
    setEditError,
  );

  useInitialComposerTranscript(
    requestId,
    intl,
    userEditedRef,
    setText,
    setSessionOriginal,
    setEditError,
  );

  const finish = useComposerFinish(
    requestId,
    text,
    intl,
    recorderRef,
    mountedRef,
    setEditError,
  );

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
          <TranscriptReview
            transcriptRef={transcriptRef}
            text={text}
            onTextChange={updateTranscript}
            editError={editError}
            sessionOriginal={sessionOriginal}
            undoText={undoText}
            isEditing={isEditing}
            onUndo={undoEdit}
            intl={intl}
          />
          <VoiceEditControls
            instruction={instruction}
            setInstruction={setInstruction}
            isListening={isListening}
            toggleVoiceInstruction={toggleVoiceInstruction}
            isEditing={isEditing}
            applyEdit={applyEdit}
            hasGenerationProvider={hasGenerationProvider}
            voiceInstructionSupported={voiceInstructionSupported}
            intl={intl}
          />
          <ComposerActions text={text} isEditing={isEditing} finish={finish} />
        </Stack>
      </Paper>
    </Box>
  );
};
