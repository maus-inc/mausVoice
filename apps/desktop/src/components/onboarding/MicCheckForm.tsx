import { ArrowForward, Check } from "@mui/icons-material";
import { Box, Button, Stack, Typography, useTheme } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import {
  goToOnboardingPage,
  setOnboardingPreferredMicrophone,
} from "../../actions/onboarding.actions";
import { getAppState, produceAppState, useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import {
  getLocalDataClearGeneration,
  isLocalDataClearRequested,
} from "../../utils/local-data-write-gate";
import { AudioWaveform } from "../common/AudioWaveform";
import { MicrophoneSelector } from "../microphone/MicrophoneSelector";
import {
  invokeGuardedRecordingStart,
  subscribeRecordingAbortForClear,
} from "../root/recording-start-gate";
import {
  BackButton,
  DualPaneLayout,
  OnboardingFormLayout,
} from "./OnboardingCommon";
import type { NativeRecordingHandle } from "../../utils/native-recording-session";

type RecordingState = "idle" | "starting" | "recording" | "stopping";

const isCapturePhase = (
  phase: ReturnType<typeof getAppState>["overlayPhase"],
) => phase === "recording" || phase === "paused" || phase === "loading";

const useMicCheckRecording = (preferredMicrophone: string | null) => {
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const overlayPhase = useAppStore((state) => state.overlayPhase);
  const isGlobalRecording = isCapturePhase(overlayPhase);
  const isRecording = recordingState === "recording";
  const isStarting = recordingState === "starting";
  const mountedRef = useRef(true);
  const opIdRef = useRef(0);
  const recordingStateRef = useRef(recordingState);
  const admittedRef = useRef<NativeRecordingHandle | null>(null);
  // Start and stop are serialized: a start requested while a capture is closing
  // runs after that release, instead of bouncing off the stopping state or
  // racing the in-flight open.
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const setSyncedRecordingState = useCallback((next: RecordingState) => {
    recordingStateRef.current = next;
    if (mountedRef.current) {
      setRecordingState(next);
    }
  }, []);

  const enqueue = useCallback((task: () => Promise<void>): Promise<void> => {
    const next = queueRef.current.then(task, task);
    queueRef.current = next;
    return next;
  }, []);

  const startRecording = useCallback(
    (isCancelled: () => boolean = () => false) =>
      enqueue(async () => {
        if (
          isCancelled() ||
          isCapturePhase(getAppState().overlayPhase) ||
          recordingStateRef.current !== "idle" ||
          isLocalDataClearRequested()
        ) {
          return;
        }

        const opId = ++opIdRef.current;
        const clearGeneration = getLocalDataClearGeneration();
        setSyncedRecordingState("starting");

        const isCurrent = () =>
          mountedRef.current &&
          opId === opIdRef.current &&
          !isCapturePhase(getAppState().overlayPhase) &&
          !isLocalDataClearRequested() &&
          clearGeneration === getLocalDataClearGeneration();

        try {
          const { handle } = await invokeGuardedRecordingStart(
            preferredMicrophone ?? null,
            {
              onAdmission: (admitted) => {
                // Throw before opening the stream; the start helper discards the
                // cancelled admission using its exact owner/generation pair.
                if (!isCurrent()) {
                  throw new DOMException(
                    "Microphone check cancelled",
                    "AbortError",
                  );
                }
                admittedRef.current = admitted;
              },
            },
          );
          admittedRef.current = handle;
          if (!isCurrent()) {
            admittedRef.current = null;
            if (handle.isLive()) await handle.discard();
            if (opId === opIdRef.current) {
              setSyncedRecordingState("idle");
            }
            return;
          }
          setSyncedRecordingState("recording");
        } catch (error) {
          if (isCurrent()) console.error("Failed to start recording", error);
          admittedRef.current = null;
          if (opId === opIdRef.current) {
            setSyncedRecordingState("idle");
          }
        }
      }),
    [enqueue, preferredMicrophone, setSyncedRecordingState],
  );

  const stopRecording = useCallback(
    () =>
      enqueue(async () => {
        const currentState = recordingStateRef.current;
        if (currentState !== "recording" && currentState !== "starting") {
          return;
        }

        opIdRef.current += 1;
        const handle = admittedRef.current;
        admittedRef.current = null;
        if (!handle) {
          setSyncedRecordingState("idle");
          return;
        }
        setSyncedRecordingState("stopping");
        await handle.discard().catch((error: unknown) => {
          console.error("Failed to stop recording", error);
        });
        setSyncedRecordingState("idle");
        if (!isLocalDataClearRequested()) {
          produceAppState((draft) => {
            draft.audioLevels = [];
          });
        }
      }),
    [enqueue, setSyncedRecordingState],
  );

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribeClear = subscribeRecordingAbortForClear(
      () =>
        recordingStateRef.current === "starting" ||
        recordingStateRef.current === "recording",
      stopRecording,
    );
    return () => {
      mountedRef.current = false;
      unsubscribeClear();
    };
  }, [stopRecording]);

  useEffect(() => {
    if (isGlobalRecording && (isRecording || isStarting)) {
      void stopRecording();
    }
  }, [isGlobalRecording, isRecording, isStarting, stopRecording]);

  return { recordingState, startRecording, stopRecording };
};

export const MicCheckForm = () => {
  const theme = useTheme();

  const [showMicSelector, setShowMicSelector] = useState(false);
  const preferredMicrophone = useAppStore(
    (state) => state.onboarding.preferredMicrophone,
  );

  const audioLevels = useAppStore((state) => state.audioLevels);
  const didSignUpWithAccount = useAppStore(
    (state) => state.onboarding.didSignUpWithAccount,
  );
  const { recordingState, startRecording, stopRecording } =
    useMicCheckRecording(preferredMicrophone);
  const isRecording = recordingState === "recording";
  const isStarting = recordingState === "starting";

  useEffect(() => {
    let cancelled = false;
    if (!showMicSelector) {
      void startRecording(() => cancelled);
    }

    return () => {
      cancelled = true;
      void stopRecording();
    };
  }, [showMicSelector, startRecording, stopRecording]);

  const handleChangeMicrophone = async () => {
    trackButtonClick("onboarding_try_another_mic");
    await stopRecording();
    setShowMicSelector(true);
  };

  const handleMicSelected = () => {
    trackButtonClick("onboarding_use_this_mic");
    setShowMicSelector(false);
  };

  const handleConfirm = async () => {
    trackButtonClick("onboarding_mic_looks_good");
    await stopRecording();
    if (didSignUpWithAccount) {
      goToOnboardingPage("unlockedPro");
    } else {
      goToOnboardingPage("tutorial");
    }
  };

  const form = (
    <OnboardingFormLayout back={<BackButton />} actions={<div />}>
      <Stack
        spacing={2}
        sx={{
          pb: 8,
        }}
      >
        <Typography
          variant="h4"
          sx={{
            fontWeight: 600,
          }}
        >
          <FormattedMessage defaultMessage="Test your microphone" />
        </Typography>
        <Typography
          variant="body1"
          sx={{
            color: "text.secondary",
          }}
        >
          <FormattedMessage defaultMessage="Say something and watch the waves respond to your voice." />
        </Typography>
      </Stack>
    </OnboardingFormLayout>
  );

  const rightContent = (
    <Stack
      spacing={3}
      sx={{
        bgcolor: "level1",
        borderRadius: 2,
        p: 4,
        maxWidth: 400,
        width: "100%",
      }}
    >
      {showMicSelector ? (
        <>
          <Typography
            variant="h6"
            sx={{
              fontWeight: 600,
            }}
          >
            <FormattedMessage defaultMessage="Choose a different microphone" />
          </Typography>
          <MicrophoneSelector
            value={preferredMicrophone}
            onChange={(value) => {
              setOnboardingPreferredMicrophone(value);
            }}
          />
          <Stack
            direction="row"
            sx={{
              justifyContent: "flex-end",
            }}
          >
            <Button
              variant="contained"
              onClick={handleMicSelected}
              endIcon={<Check />}
            >
              <FormattedMessage defaultMessage="Use this mic" />
            </Button>
          </Stack>
        </>
      ) : (
        <>
          <Typography
            variant="h6"
            sx={{
              fontWeight: 600,
            }}
          >
            <FormattedMessage defaultMessage="Do the waves respond to your voice?" />
          </Typography>

          <Box
            sx={{
              bgcolor: "level2",
              borderRadius: 2,
              p: 2,
              position: "relative",
              overflow: "hidden",
            }}
          >
            <Box
              sx={{
                position: "relative",
                width: "100%",
                height: 80,
                display: "flex",
                alignItems: "center",
              }}
            >
              <AudioWaveform
                levels={audioLevels}
                active={isRecording}
                processing={isStarting}
                style={{ width: "100%", height: "100%" }}
              />
              <Box
                sx={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: -1,
                  right: -1,
                  pointerEvents: "none",
                  background: `linear-gradient(90deg, ${theme.vars?.palette.level2} 0%, transparent 18%, transparent 82%, ${theme.vars?.palette.level2} 100%)`,
                }}
              />
            </Box>
          </Box>

          <Stack
            direction="row"
            spacing={2}
            sx={{
              justifyContent: "flex-end",
            }}
          >
            <Button
              variant="text"
              onClick={() => void handleChangeMicrophone()}
            >
              <FormattedMessage defaultMessage="Try another mic" />
            </Button>
            <Button
              variant="contained"
              onClick={() => void handleConfirm()}
              endIcon={<ArrowForward />}
            >
              <FormattedMessage defaultMessage="Looks good" />
            </Button>
          </Stack>
        </>
      )}
    </Stack>
  );

  return (
    <DualPaneLayout
      flex={[2, 3]}
      left={form}
      right={rightContent}
      rightSx={{ bgcolor: "transparent" }}
    />
  );
};
