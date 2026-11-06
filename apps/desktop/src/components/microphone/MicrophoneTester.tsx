import { LoadingButton } from "@mui/lab";
import { Alert, Box, Button, Stack, useTheme } from "@mui/material";
import { Nullable } from "@maus-inc/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import { produceAppState, useAppStore } from "../../store";
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
  buttonLayout: "row" | "column";
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
  return (
    <Stack
      direction={buttonLayout}
      spacing={1.5}
      sx={{
        alignItems: buttonLayout === "row" ? "center" : "stretch",
        width: "100%",
        justifyContent: justifyButtons,
      }}
    >
      <LoadingButton
        variant={isTestRunning ? "outlined" : "contained"}
        color={isTestRunning ? "error" : "primary"}
        onClick={isTestRunning ? onStopTest : onStartTest}
        loading={isTestLoading || isTestStopping}
        disabled={isTestRunning ? disableStopButton : disableStartButton}
        fullWidth={buttonLayout === "column"}
      >
        {isTestRunning ? (
          <FormattedMessage defaultMessage="Finish" />
        ) : (
          <FormattedMessage defaultMessage="Record" />
        )}
      </LoadingButton>
      <Button
        variant="outlined"
        disabled={previewUrl == null || disabled}
        onClick={onTogglePreview}
        fullWidth={buttonLayout === "column"}
      >
        {isPreviewPlaying ? (
          <FormattedMessage defaultMessage="Pause" />
        ) : (
          <FormattedMessage defaultMessage="Play" />
        )}
      </Button>
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

export const MicrophoneTester = ({
  preferredMicrophone,
  waveformHeight = 96,
  disabled = false,
  buttonLayout = "row",
  fadeColor = "level0",
  justifyButtons = "flex-start",
}: MicrophoneTesterProps) => {
  const overlayPhase = useAppStore((state) => state.overlayPhase);
  const audioLevels = useAppStore((state) => state.audioLevels);
  const theme = useTheme();
  const effectiveFadeColor =
    fadeColor === "level0"
      ? theme.vars?.palette.level0
      : theme.vars?.palette?.level1;

  const [testState, setTestState] = useState<
    "idle" | "starting" | "recording" | "stopping"
  >("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const previewUrlRef = useRef<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const isGlobalRecording =
    overlayPhase === "recording" || overlayPhase === "loading";
  const isTestRunning = testState === "recording";
  const isTestLoading = testState === "starting";
  const isTestStopping = testState === "stopping";
  const mountedRef = useRef(true);
  const opIdRef = useRef(0);
  const testStateRef = useRef(testState);
  testStateRef.current = testState;

  const setSyncedTestState = useCallback(
    (next: "idle" | "starting" | "recording" | "stopping") => {
      testStateRef.current = next;
      if (mountedRef.current) {
        setTestState(next);
      }
    },
    [],
  );

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

  const handleStartTest = useCallback(async () => {
    if (
      testStateRef.current !== "idle" ||
      isGlobalRecording ||
      disabled ||
      isLocalDataClearRequested()
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
        !mountedRef.current ||
        opId !== opIdRef.current ||
        isLocalDataClearRequested() ||
        clearGeneration !== getLocalDataClearGeneration()
      ) {
        await invokeStopRecording().catch(() => undefined);
        if (opId === opIdRef.current) {
          setSyncedTestState("idle");
        }
        return;
      }
      setSyncedTestState("recording");
    } catch (error) {
      if (
        !isLocalDataClearRequested() &&
        clearGeneration === getLocalDataClearGeneration()
      ) {
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
        const rate = response.sampleRate ?? 0;

        if (!opts?.silent && !isLocalDataClearRequested()) {
          const url = createPreviewUrl(response.samples, rate);
          if (response.captureFailed) {
            // The device stopped delivering audio partway through the test. The
            // preview still plays what was captured, and the test says why it
            // is short instead of reporting a clean result.
            updatePreviewUrl(url ?? null);
            setTestError(
              "The microphone stopped partway through. The preview is shorter than the test.",
            );
          } else if (url) {
            updatePreviewUrl(url);
          } else {
            updatePreviewUrl(null);
            setTestError(
              "We didn't detect any audio. Try speaking while the test is running.",
            );
          }
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

  const disableStartButton =
    disabled || isGlobalRecording || isTestLoading || isTestRunning;
  const disableStopButton = disabled || isTestStopping;

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
        onDismissError={() => setTestError(null)}
      />
    </Stack>
  );
};
