import { LoadingButton } from "@mui/lab";
import { Alert, Box, Button, Stack, useTheme } from "@mui/material";
import { Nullable } from "@maus-inc/types";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { FormattedMessage } from "react-intl";
import { produceAppState, useAppStore } from "../../store";
import { buildWaveFile, ensureFloat32Array } from "../../utils/audio.utils";
import { NativeRecordingLease } from "../../utils/native-recording-lease";
import type { StopRecordingResponse } from "../../types/transcription-session.types";
import { AudioWaveform } from "../common/AudioWaveform";

const createPreviewUrl = (
  rawSamples: number[] | Float32Array,
  sampleRate: number,
): string | null => {
  if (!sampleRate || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return null;
  }

  const samples = ensureFloat32Array(rawSamples ?? []);

  if (samples.length === 0) {
    return null;
  }

  const wavBuffer = buildWaveFile(samples, sampleRate);
  const blob = new Blob([wavBuffer], { type: "audio/wav" });
  return URL.createObjectURL(blob);
};

const usePreviewPlayback = ({
  previewUrl,
  previewAudioRef,
  setIsPreviewPlaying,
}: {
  previewUrl: string | null;
  previewAudioRef: MutableRefObject<HTMLAudioElement | null>;
  setIsPreviewPlaying: (playing: boolean) => void;
}) => {
  useEffect(() => {
    if (!previewUrl) {
      setIsPreviewPlaying(false);
      return;
    }

    const audio = new Audio(previewUrl);
    audio.preload = "auto";

    const handlePlay = () => setIsPreviewPlaying(true);
    const handlePause = () => setIsPreviewPlaying(false);
    const handleEnded = () => setIsPreviewPlaying(false);

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);

    previewAudioRef.current = audio;

    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      audio.pause();
      if (previewAudioRef.current === audio) {
        previewAudioRef.current = null;
      }
    };
  }, [previewUrl, previewAudioRef, setIsPreviewPlaying]);
};

const MicrophoneRecordControl = ({
  isTestRunning,
  isTestLoading,
  isTestStopping,
  disableStartButton,
  disableStopButton,
  buttonLayout,
  onStartTest,
  onStopTest,
}: {
  isTestRunning: boolean;
  isTestLoading: boolean;
  isTestStopping: boolean;
  disableStartButton: boolean;
  disableStopButton: boolean;
  buttonLayout: "row" | "column";
  onStartTest: () => void;
  onStopTest: () => void;
}) => (
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
);

const MicrophonePreviewControl = ({
  previewUrl,
  disabled,
  buttonLayout,
  isPreviewPlaying,
  onTogglePreview,
}: {
  previewUrl: string | null;
  disabled: boolean;
  buttonLayout: "row" | "column";
  isPreviewPlaying: boolean;
  onTogglePreview: () => void;
}) => (
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
      <MicrophoneRecordControl
        buttonLayout={buttonLayout}
        isTestRunning={isTestRunning}
        isTestLoading={isTestLoading}
        isTestStopping={isTestStopping}
        disableStartButton={disableStartButton}
        disableStopButton={disableStopButton}
        onStartTest={onStartTest}
        onStopTest={onStopTest}
      />
      <MicrophonePreviewControl
        previewUrl={previewUrl}
        disabled={disabled}
        buttonLayout={buttonLayout}
        isPreviewPlaying={isPreviewPlaying}
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

type RecordingStopMode = "preview" | "silent";

// Owns the temporary WAV URL and its audio element as a single lifecycle.
const useRecordingPreview = (setTestError: (error: string | null) => void) => {
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

  const showRecordingPreview = useCallback(
    (samples: number[] | Float32Array, sampleRate: number) => {
      const url = createPreviewUrl(samples, sampleRate);
      updatePreviewUrl(url);
      if (!url) {
        setTestError(
          "We didn't detect any audio. Try speaking while the test is running.",
        );
      }
    },
    [setTestError, updatePreviewUrl],
  );

  const finishRecordingPreview = useCallback(
    (response: StopRecordingResponse, mode: RecordingStopMode) => {
      if (mode === "silent") updatePreviewUrl(null);
      else {
        showRecordingPreview(response.samples, response.sampleRate ?? 0);
        if (response.captureFailed) {
          setTestError(
            "The preview may be incomplete. The microphone may still be in use. If its indicator stays on, quit the app.",
          );
        }
      }
    },
    [setTestError, showRecordingPreview, updatePreviewUrl],
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
        if (previewAudioRef.current !== audio) return;
        setTestError(null);
        setIsPreviewPlaying(true);
      })
      .catch((error) => {
        if (previewAudioRef.current !== audio) return;
        console.error("Failed to play recorded preview", error);
        setTestError("Unable to play the recorded preview.");
        setIsPreviewPlaying(false);
      });
  }, [setTestError]);

  return {
    previewUrl,
    isPreviewPlaying,
    clearPreviewUrl,
    finishRecordingPreview,
    handleTogglePreview,
  };
};

// A completed test must not erase a newer dictation's waveform.
const clearTestAudioLevels = () => {
  produceAppState((draft) => {
    if (draft.overlayPhase === "idle") draft.audioLevels = [];
  });
};

async function finishMicrophoneTest(
  lease: NativeRecordingLease,
  mode: RecordingStopMode,
  isCurrent: () => boolean,
  finishPreview: (
    response: StopRecordingResponse,
    mode: RecordingStopMode,
  ) => void,
): Promise<void> {
  if (mode === "silent") {
    await lease.cancel();
    return;
  }
  const response = await lease.stop();
  if (isCurrent()) finishPreview(response, mode);
}

// Serializes microphone-test transitions and retires recording on teardown.
const useMicrophoneRecording = ({
  preferredMicrophone,
  disabled,
  isGlobalRecording,
  clearPreviewUrl,
  finishRecordingPreview,
  setTestError,
}: {
  preferredMicrophone: Nullable<string>;
  disabled: boolean;
  isGlobalRecording: boolean;
  clearPreviewUrl: () => void;
  finishRecordingPreview: (
    response: StopRecordingResponse,
    mode: RecordingStopMode,
  ) => void;
  setTestError: (error: string | null) => void;
}) => {
  const [testState, setTestState] = useState<
    "idle" | "starting" | "recording" | "stopping"
  >("idle");
  // React has not necessarily committed a new disabled button between clicks.
  const leaseRef = useRef<NativeRecordingLease | null>(null);
  const startingRef = useRef(false);
  const stoppingRef = useRef(false);
  const lifecycleRef = useRef(0);
  const mountedRef = useRef(false);

  const isTestRunning = testState === "recording";
  const isTestLoading = testState === "starting";
  const isTestStopping = testState === "stopping";
  const isTestActive = isTestRunning || isTestLoading;

  const disableStartButton =
    disabled || isGlobalRecording || isTestLoading || isTestRunning;
  const disableStopButton = disabled || isTestStopping;

  const handleStartTest = useCallback(async () => {
    if (startingRef.current || stoppingRef.current || disableStartButton) {
      return;
    }
    startingRef.current = true;

    setTestError(null);
    clearPreviewUrl();
    setTestState("starting");

    const lease = new NativeRecordingLease();
    leaseRef.current = lease;
    const isCurrent = () =>
      mountedRef.current && leaseRef.current === lease && !stoppingRef.current;
    try {
      await lease.start(preferredMicrophone ?? null);
      if (isCurrent()) {
        setTestState("recording");
      }
    } catch (error) {
      if (isCurrent()) {
        leaseRef.current = null;
        console.error("Failed to start microphone test", error);
        setTestError("Unable to start microphone test. Please try again.");
        setTestState("idle");
      }
    } finally {
      startingRef.current = false;
    }
  }, [clearPreviewUrl, disableStartButton, preferredMicrophone, setTestError]);

  const handleStopTest = useCallback(
    async (mode: RecordingStopMode = "preview") => {
      const lease = leaseRef.current;
      if (stoppingRef.current || !lease) {
        return;
      }
      stoppingRef.current = true;
      const lifecycle = lifecycleRef.current;
      const isCurrentLifecycle = () =>
        mountedRef.current && lifecycle === lifecycleRef.current;
      setTestState("stopping");

      try {
        await finishMicrophoneTest(
          lease,
          mode,
          isCurrentLifecycle,
          finishRecordingPreview,
        );
      } catch (error) {
        console.error("Failed to stop microphone test", error);
        if (mode === "preview" && isCurrentLifecycle()) {
          setTestError("Unable to stop microphone test. Please try again.");
        }
      } finally {
        if (leaseRef.current === lease) leaseRef.current = null;
        stoppingRef.current = false;
        if (isCurrentLifecycle()) setTestState("idle");
        clearTestAudioLevels();
      }
    },
    [setTestError, finishRecordingPreview],
  );

  useEffect(() => {
    if (isTestActive && isGlobalRecording) {
      void handleStopTest("silent");
    }
  }, [handleStopTest, isGlobalRecording, isTestActive]);

  const handleStopTestRef = useRef(handleStopTest);
  useEffect(() => {
    handleStopTestRef.current = handleStopTest;
  }, [handleStopTest]);

  useEffect(() => {
    mountedRef.current = true;
    lifecycleRef.current += 1;
    return () => {
      mountedRef.current = false;
      lifecycleRef.current += 1;
      void handleStopTestRef.current("silent");
      clearPreviewUrl();
    };
  }, [clearPreviewUrl]);

  return {
    isTestRunning,
    isTestLoading,
    isTestStopping,
    disableStartButton,
    disableStopButton,
    handleStartTest,
    handleStopTest,
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
  const overlayPhase = useAppStore((state) => state.overlayPhase);
  const audioLevels = useAppStore((state) => state.audioLevels);
  const theme = useTheme();
  const effectiveFadeColor =
    fadeColor === "level0"
      ? theme.vars?.palette.level0
      : theme.vars?.palette?.level1;

  const [testError, setTestError] = useState<string | null>(null);
  const {
    previewUrl,
    isPreviewPlaying,
    clearPreviewUrl,
    finishRecordingPreview,
    handleTogglePreview,
  } = useRecordingPreview(setTestError);
  // A paused dictation still owns the native recorder.
  const isGlobalRecording = overlayPhase !== "idle";
  const {
    isTestRunning,
    isTestLoading,
    isTestStopping,
    disableStartButton,
    disableStopButton,
    handleStartTest,
    handleStopTest,
  } = useMicrophoneRecording({
    preferredMicrophone,
    disabled,
    isGlobalRecording,
    clearPreviewUrl,
    finishRecordingPreview,
    setTestError,
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
        onDismissError={() => setTestError(null)}
      />
    </Stack>
  );
};
