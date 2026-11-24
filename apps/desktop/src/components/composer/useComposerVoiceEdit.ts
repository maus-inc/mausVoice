import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyVoiceEditInstruction } from "../../actions/composer.actions";
import { transcribeAudio } from "../../actions/transcribe.actions";
import { getGenerateTextRepo, getTranscribeAudioRepo } from "../../repos";
import { getAppState, produceAppState, useAppStore } from "../../store";
import { getMyPreferredMicrophone } from "../../utils/user.utils";
import { getLogger } from "../../utils/log.utils";
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

export const useVoiceEditAvailability = (intl: ReturnType<typeof useIntl>) => {
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

  return {
    speechRecognitionSupported,
    hasGenerationProvider,
    voiceInstructionSupported,
    disabledReason,
  };
};

const editFailureMessage = (
  error: unknown,
  intl: ReturnType<typeof useIntl>,
): string =>
  error instanceof Error
    ? error.message
    : intl.formatMessage({ defaultMessage: "Edit failed." });

export const useVoiceEdit = ({
  intl,
  mountedRef,
}: {
  intl: ReturnType<typeof useIntl>;
  mountedRef: React.RefObject<boolean>;
}) => {
  const [text, setText] = useState("");
  const [undoText, setUndoText] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const recorderRef = useRef<VoiceInstructionRecorder | null>(null);
  const userEditedRef = useRef(false);

  const applyEdit = async () => {
    if (!instruction.trim() || !text.trim() || isEditing) return;
    setIsEditing(true);
    setEditError(null);
    const currentText = text;
    try {
      const edited = await applyVoiceEditInstruction({
        text: currentText,
        instruction,
      });
      if (mountedRef.current) {
        if (edited !== undefined) {
          setUndoText(currentText);
          setText((latest) => (latest === currentText ? edited : latest));
        }
        setInstruction("");
      }
    } catch (error) {
      if (mountedRef.current) {
        setEditError(editFailureMessage(error, intl));
      }
    } finally {
      if (mountedRef.current) setIsEditing(false);
    }
  };

  const toggleVoiceInstruction = () => {
    void recorderRef.current?.toggle();
  };

  const handleTextChange = (next: string) => {
    userEditedRef.current = true;
    setText(next);
  };

  const handleUndo = () => {
    setText(undoText ?? "");
    setUndoText(null);
  };

  return {
    text,
    setText,
    undoText,
    instruction,
    setInstruction,
    isEditing,
    editError,
    setEditError,
    isListening,
    setIsListening,
    recorderRef,
    userEditedRef,
    applyEdit,
    toggleVoiceInstruction,
    handleTextChange,
    handleUndo,
  };
};

export const useVoiceInstructionRecorder = ({
  speechRecognitionSupported,
  intlRef,
  recorderRef,
  onListeningChange,
  onTranscript,
  onError,
}: {
  speechRecognitionSupported: boolean;
  intlRef: React.RefObject<ReturnType<typeof useIntl>>;
  recorderRef: React.RefObject<VoiceInstructionRecorder | null>;
  onListeningChange: (listening: boolean) => void;
  onTranscript: (spoken: string) => void;
  onError: (message: string) => void;
}) => {
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
      unsupportedMessage: () =>
        intlRef.current.formatMessage({
          defaultMessage: "Voice editing is not supported on this platform",
        }),
      recordingUnavailableMessage: (operation) =>
        operation === "stop"
          ? intlRef.current.formatMessage({
              defaultMessage: "Failed to stop recording",
            })
          : intlRef.current.formatMessage({
              defaultMessage: "Could not start recording. Please try again.",
            }),
      onListeningChange,
      onTranscript,
      onError,
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
};

export const useVoiceRecorderMessages = (intl: ReturnType<typeof useIntl>) => {
  // A locale change updates recorder errors without replacing a live recorder.
  const intlRef = useRef(intl);
  useEffect(() => {
    intlRef.current = intl;
  }, [intl]);
  return { intlRef };
};

export const useComposerPeekText = ({
  intl,
  requestId,
  setText,
  setEditError,
  userEditedRef,
}: {
  intl: ReturnType<typeof useIntl>;
  requestId: string;
  setText: (value: string) => void;
  setEditError: (value: string | null) => void;
  userEditedRef: React.RefObject<boolean>;
}) => {
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
    return () => {
      active = false;
    };
  }, [intl, requestId]);
};

export const useComposerFinish = ({
  intl,
  requestId,
  text,
  recorderRef,
  setEditError,
  mountedRef,
}: {
  intl: ReturnType<typeof useIntl>;
  requestId: string;
  text: string;
  recorderRef: React.RefObject<VoiceInstructionRecorder | null>;
  setEditError: (value: string | null) => void;
  mountedRef: React.RefObject<boolean>;
}) => {
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
    [intl, requestId, text],
  );

  const cancel = useCallback(() => {
    finish(false).catch(() => undefined);
  }, [finish]);
  const insert = useCallback(() => {
    finish(true).catch(() => undefined);
  }, [finish]);

  useEscapeToCancel(finish);

  return { cancel, insert };
};

const useEscapeToCancel = (finish: (accepted: boolean) => Promise<void>) => {
  // Esc cancels the composer, matching the window close-request path which is
  // already wired to Cancel (composer.utils.ts). This completes the keyboard
  // loop opened by the auto-focused transcript field and Cmd/Ctrl+Enter to apply.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void finish(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [finish]);
};
