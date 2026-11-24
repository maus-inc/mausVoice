import { LoadingButton } from "@mui/lab";
import { Alert, Box, Button, Stack, useTheme } from "@mui/material";
import { Nullable } from "@maus-inc/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import { produceAppState, useAppStore } from "../../store";
import type { StopRecordingResponse } from "../../types/transcription-session.types";
import {
  getLocalDataClearGeneration,
  isLocalDataClearRequested,
} from "../../utils/local-data-write-gate";
import { invokeStopRecording } from "../../utils/native-recording-session";
import { AudioWaveform } from "../common/AudioWaveform";
import {
  invokeGuardedRecordingStart,
  subscribeRecordingAbortForClear,
} from "../root/recording-start-gate";
import {
  createPreviewUrl,
  usePreviewPlayback,
} from "./microphone-test-preview";

type MicTestState = "idle" | "starting" | "recording" | "stopping";

type TestButtonLayout = "row" | "column";

const TestRecordButton = ({
  isTestRunning,
  isTestLoading,
  isTestStopping,
  disableStartButton,
  disableStopButton,
  fullWidth,
  onStartTest,
  onStopTest,
}: {
  isTestRunning: boolean;
  isTestLoading: boolean;
  isTestStopping: boolean;
  disableStartButton: boolean;
  disableStopButton: boolean;
  fullWidth: boolean;
  onStartTest: () => void;
  onStopTest: () => void;
}) => (
  <LoadingButton
    variant={isTestRunning ? "outlined" : "contained"}
    color={isTestRunning ? "error" : "primary"}
    onClick={isTestRunning ? onStopTest : onStartTest}
    loading={isTestLoading || isTestStopping}
    disabled={isTestRunning ? disableStopButton : disableStartButton}
    fullWidth={fullWidth}
  >
    {isTestRunning ? (
      <FormattedMessage defaultMessage="Finish" />
    ) : (
      <FormattedMessage defaultMessage="Record" />
    )}
  </LoadingButton>
);

const TestPreviewButton = ({
  previewUrl,
  isPreviewPlaying,
  disabled,
  fullWidth,
  onTogglePreview,
}: {
  previewUrl: string | null;
  isPreviewPlaying: boolean;
  disabled: boolean;
  fullWidth: boolean;
  onTogglePreview: () => void;
}) => (
  <Button
    variant="outlined"
    disabled={previewUrl == null || disabled}
    onClick={onTogglePreview}
    fullWidth={fullWidth}
  >
    {isPreviewPlaying ? (
      <FormattedMessage defaultMessage="Pause" />
    ) : (
      <FormattedMessage defaultMessage="Play" />
    )}
  </Button>
);

const MicrophoneTestControls = ({
  buttonLayout,
  justifyButtons,
  isTestRunning,
  isTestLoading,
  isTestStopping,
  disableStartButton,
  disableStopButton,
  disabled,
  previewUrl,
  isPreviewPlaying,
  onStartTest,
  onStopTest,
  onTogglePreview,
}: {
  buttonLayout: TestButtonLayout;
  justifyButtons: "flex-start" | "center" | "flex-end" | "space-between";
  isTestRunning: boolean;
  isTestLoading: boolean;
  isTestStopping: boolean;
  disableStartButton: boolean;
  disableStopButton: boolean;
  disabled: boolean;
  previewUrl: string | null;
  isPreviewPlaying: boolean;
  onStartTest: () => void;
  onStopTest: () => void;
  onTogglePreview: () => void;
}) => {
  const fullWidth = buttonLayout === "column";
  return (
    <Stack
      direction={buttonLayout}
      spacing={1.5}
      sx={{
        alignItems: fullWidth ? "stretch" : "center",
        width: "100%",
        justifyContent: justifyButtons,
      }}
    >
      <TestRecordButton
        isTestRunning={isTestRunning}
        isTestLoading={isTestLoading}
        isTestStopping={isTestStopping}
        disableStartButton={disableStartButton}
        disableStopButton={disableStopButton}
        fullWidth={fullWidth}
        onStartTest={onStartTest}
        onStopTest={onStopTest}
      />
      <TestPreviewButton
        previewUrl={previewUrl}
        isPreviewPlaying={isPreviewPlaying}
        disabled={disabled}
        fullWidth={fullWidth}
        onTogglePreview={onTogglePreview}
      />
    </Stack>
  );
};

const MicrophoneTestAlerts = ({
  isGlobalRecording,
  testError,
  onDismissError,
}: {
  isGlobalRecording: boolean;
  testError: string | null;
  onDismissError: () => void;
}) => {
  return (
    <>
      {isGlobalRecording && (
        <Alert severity="info">
          <FormattedMessage defaultMessage="You cannot start a microphone test while a transcription is in progress." />
        </Alert>
      )}

      {testError && (
        <Alert severity="warning" onClose={onDismissError}>
          {testError}
        </Alert>
      )}
    </>
  );
};

export type MicrophoneTesterProps = {
  preferredMicrophone: Nullable<string>;
  waveformHeight?: number;
  disabled?: boolean;
  buttonLayout?: "row" | "column";
  fadeColor?: string;
  justifyButtons?: "flex-start" | "center" | "flex-end" | "space-between";
};

const canStartTest = ({
  testState,
  isGlobalRecording,
  disabled,
}: {
  testState: string;
  isGlobalRecording: boolean;
  disabled: boolean;
}): boolean =>
  testState === "idle" &&
  !isGlobalRecording &&
  !disabled &&
  !isLocalDataClearRequested();

const isClearGenerationCurrent = (clearGeneration: number): boolean =>
  !isLocalDataClearRequested() &&
  clearGeneration === getLocalDataClearGeneration();

const isStaleRecordingAttempt = ({
  mounted,
  opId,
  currentOpId,
  clearGeneration,
  currentClearGeneration,
}: {
  mounted: boolean;
  opId: number;
  currentOpId: number;
  clearGeneration: number;
  currentClearGeneration: number;
}): boolean =>
  !mounted ||
  opId !== currentOpId ||
  isLocalDataClearRequested() ||
  clearGeneration !== currentClearGeneration;
const isRecordingOverlayPhase = (
  phase: ReturnType<typeof useAppStore.getState>["overlayPhase"],
): boolean => phase === "recording" || phase === "loading";

const publishPreviewOutcome = ({
  response,
  createPreviewUrl: createPreview,
  updatePreviewUrl,
  setTestError,
}: {
  response: StopRecordingResponse;
  createPreviewUrl: typeof createPreviewUrl;
  updatePreviewUrl: (url: string | null) => void;
  setTestError: (message: string | null) => void;
}): void => {
  const url = createPreview(response.samples, response.sampleRate ?? 0);
  if (response.captureFailed) {
    updatePreviewUrl(url ?? null);
    setTestError(
      "The microphone stopped partway through. The preview is shorter than the test.",
    );
    return;
  }
  if (url) {
    updatePreviewUrl(url);
    return;
  }
  updatePreviewUrl(null);
  setTestError(
    "We didn't detect any audio. Try speaking while the test is running.",
  );
};

const usePreviewAudio = ({
  setTestError,
}: {
  setTestError: (message: string | null) => void;
}) => {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const previewUrlRef = useRef<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const releasePreviewAudio = useCallback(() => {
    const audio = previewAudioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
      previewAudioRef.current = null;
    }
    setIsPreviewPlaying(false);
  }, []);

  const clearPreviewUrl = useCallback(() => {
    releasePreviewAudio();
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewUrl(null);
  }, [releasePreviewAudio]);

  const updatePreviewUrl = useCallback(
    (url: string | null) => {
      releasePreviewAudio();
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
      previewUrlRef.current = url;
      setPreviewUrl(url);
    },
    [releasePreviewAudio],
  );

  useEffect(() => () => clearPreviewUrl(), [clearPreviewUrl]);

  usePreviewPlayback({
    previewUrl,
    previewAudioRef,
    setIsPreviewPlaying,
  });

  const handleTogglePreview = useCallback(() => {
    const audio = previewAudioRef.current;
    if (!audio) {
      return;
    }

    if (!audio.paused && !audio.ended) {
      audio.pause();
      return;
    }

    audio
      .play()
      .then(() => {
        setTestError(null);
        setIsPreviewPlaying(true);
      })
      .catch((error) => {
        console.error("Failed to play recorded preview", error);
        setTestError("Unable to play the recorded preview.");
        setIsPreviewPlaying(false);
      });
  }, []);

  return {
    previewUrl,
    isPreviewPlaying,
    setIsPreviewPlaying,
    previewUrlRef,
    clearPreviewUrl,
    updatePreviewUrl,
    handleTogglePreview,
  };
};

const useMicrophoneTestLifecycle = ({
  testState,
  testStateRef,
  isGlobalRecording,
  previewUrlRef,
  mountedRef,
  clearPreviewUrl,
  handleStopTest,
}: {
  mountedRef: React.RefObject<boolean>;
  testState: MicTestState;
  testStateRef: React.RefObject<MicTestState>;
  isGlobalRecording: boolean;
  previewUrlRef: React.RefObject<string | null>;
  clearPreviewUrl: () => void;
  handleStopTest: (options: { silent?: boolean }) => Promise<void>;
}) => {
  useEffect(() => {
    if (
      (testState === "recording" || testState === "starting") &&
      isGlobalRecording
    ) {
      void handleStopTest({ silent: true });
    }
  }, [handleStopTest, isGlobalRecording, testState]);

  const handleStopTestRef = useRef(handleStopTest);
  useEffect(() => {
    handleStopTestRef.current = handleStopTest;
  }, [handleStopTest]);

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribeClear = subscribeRecordingAbortForClear(
      () =>
        testStateRef.current === "starting" ||
        testStateRef.current === "recording" ||
        previewUrlRef.current !== null,
      async () => {
        clearPreviewUrl();
        await handleStopTestRef.current({ silent: true });
      },
    );
    return () => {
      mountedRef.current = false;
      unsubscribeClear();
      void handleStopTestRef.current({ silent: true });
      clearPreviewUrl();
    };
  }, [clearPreviewUrl]);
};

const useMicrophoneTest = ({
  preferredMicrophone,
  disabled,
}: {
  preferredMicrophone: string | null;
  disabled: boolean;
}) => {
  const overlayPhase = useAppStore((state) => state.overlayPhase);
  const audioLevels = useAppStore((state) => state.audioLevels);
  const [testState, setTestState] = useState<MicTestState>("idle");
  const [testError, setTestError] = useState<string | null>(null);

  const isGlobalRecording = isRecordingOverlayPhase(overlayPhase);
  const isTestRunning = testState === "recording";
  const isTestLoading = testState === "starting";
  const isTestStopping = testState === "stopping";
  const mountedRef = useRef(true);
  const opIdRef = useRef(0);
  const testStateRef = useRef(testState);
  testStateRef.current = testState;

  const setSyncedTestState = useCallback((next: MicTestState) => {
    testStateRef.current = next;
    if (mountedRef.current) {
      setTestState(next);
    }
  }, []);

  const {
    previewUrl,
    isPreviewPlaying,
    previewUrlRef,
    clearPreviewUrl,
    updatePreviewUrl,
    handleTogglePreview,
  } = usePreviewAudio({ setTestError });

  const handleStartTest = useCallback(async () => {
    if (
      !canStartTest({
        testState: testStateRef.current,
        isGlobalRecording,
        disabled,
      })
    ) {
      return;
    }

    const opId = ++opIdRef.current;
    const clearGeneration = getLocalDataClearGeneration();
    setTestError(null);
    clearPreviewUrl();
    setSyncedTestState("starting");

    try {
      await invokeGuardedRecordingStart(preferredMicrophone ?? null);
      if (
        isStaleRecordingAttempt({
          mounted: mountedRef.current,
          opId,
          currentOpId: opIdRef.current,
          clearGeneration,
          currentClearGeneration: getLocalDataClearGeneration(),
        })
      ) {
        await invokeStopRecording().catch(() => undefined);
        if (opId === opIdRef.current) {
          setSyncedTestState("idle");
        }
        return;
      }
      setSyncedTestState("recording");
    } catch (error) {
      if (isClearGenerationCurrent(clearGeneration)) {
        console.error("Failed to start microphone test", error);
        if (mountedRef.current && opId === opIdRef.current) {
          setTestError("Unable to start microphone test. Please try again.");
        }
      }
      if (opId === opIdRef.current) {
        setSyncedTestState("idle");
      }
    }
  }, [
    clearPreviewUrl,
    disabled,
    isGlobalRecording,
    preferredMicrophone,
    setSyncedTestState,
  ]);

  /** Publish what the test captured, and say why when it is not a clean take.
   *
   * A device that stops delivering audio partway through still yields usable
   * samples, so the preview plays them and the message explains the short
   * result instead of reporting a clean test. */
  const showPreviewOutcome = useCallback(
    (response: StopRecordingResponse) =>
      publishPreviewOutcome({
        response,
        createPreviewUrl,
        updatePreviewUrl,
        setTestError,
      }),
    [createPreviewUrl, setTestError, updatePreviewUrl],
  );

  const handleStopTest = useCallback(
    async (opts?: { silent?: boolean }) => {
      const currentState = testStateRef.current;
      if (currentState !== "recording" && currentState !== "starting") {
        return;
      }

      opIdRef.current += 1;
      setSyncedTestState("stopping");

      try {
        const response = await invokeStopRecording();

        if (!opts?.silent && !isLocalDataClearRequested()) {
          showPreviewOutcome(response);
        } else {
          updatePreviewUrl(null);
        }
      } catch (error) {
        console.error("Failed to stop microphone test", error);
        if (!opts?.silent && !isLocalDataClearRequested()) {
          setTestError("Unable to stop microphone test. Please try again.");
        }
      } finally {
        setSyncedTestState("idle");
        if (!isLocalDataClearRequested()) {
          produceAppState((draft) => {
            draft.audioLevels = [];
          });
        }
      }
    },
    [setSyncedTestState, updatePreviewUrl],
  );

  useMicrophoneTestLifecycle({
    testState,
    testStateRef,
    isGlobalRecording,
    previewUrlRef,
    mountedRef,
    clearPreviewUrl,
    handleStopTest,
  });

  const disableStartButton =
    disabled || isGlobalRecording || isTestLoading || isTestRunning;
  const disableStopButton = disabled || isTestStopping;

  return {
    audioLevels,
    testError,
    previewUrl,
    isPreviewPlaying,
    isGlobalRecording,
    isTestRunning,
    isTestLoading,
    isTestStopping,
    disableStartButton,
    disableStopButton,
    handleStartTest,
    handleStopTest,
    handleTogglePreview,
    dismissTestError: () => setTestError(null),
  };
};

export const MicrophoneTester = ({
  preferredMicrophone,
  waveformHeight = 96,
  disabled = false,
  buttonLayout = "row",
  fadeColor = "level0",
  justifyButtons = "flex-start",
}: MicrophoneTesterProps) => {
  const theme = useTheme();
  const effectiveFadeColor =
    fadeColor === "level0"
      ? theme.vars?.palette.level0
      : theme.vars?.palette?.level1;
  const {
    audioLevels,
    testError,
    previewUrl,
    isPreviewPlaying,
    isGlobalRecording,
    isTestRunning,
    isTestLoading,
    isTestStopping,
    disableStartButton,
    disableStopButton,
    handleStartTest,
    handleStopTest,
    handleTogglePreview,
    dismissTestError,
  } = useMicrophoneTest({
    preferredMicrophone: preferredMicrophone ?? null,
    disabled,
  });
  return (
    <Stack spacing={1.5}>
      <Box
        sx={{
          position: "relative",
          width: "100%",
          height: waveformHeight,
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
        }}
      >
        <AudioWaveform
          levels={audioLevels}
          active={isTestRunning}
          processing={isTestLoading || isTestStopping}
          style={{ width: "100%", height: "100%" }}
        />
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background: `linear-gradient(90deg, ${effectiveFadeColor} 0%, transparent 18%, transparent 82%, ${effectiveFadeColor} 100%)`,
          }}
        />
      </Box>

      <MicrophoneTestControls
        buttonLayout={buttonLayout}
        justifyButtons={justifyButtons}
        isTestRunning={isTestRunning}
        isTestLoading={isTestLoading}
        isTestStopping={isTestStopping}
        disableStartButton={disableStartButton}
        disableStopButton={disableStopButton}
        disabled={disabled}
        previewUrl={previewUrl}
        isPreviewPlaying={isPreviewPlaying}
        onStartTest={() => void handleStartTest()}
        onStopTest={() => void handleStopTest()}
        onTogglePreview={handleTogglePreview}
      />

      <MicrophoneTestAlerts
        isGlobalRecording={isGlobalRecording}
        testError={testError}
        onDismissError={dismissTestError}
      />
    </Stack>
  );
};
