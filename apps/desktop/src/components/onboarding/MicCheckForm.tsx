import { ArrowForward, Check } from "@mui/icons-material";
import { Box, Button, Stack, Typography, useTheme } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import { FormattedMessage } from "react-intl";
import {
  goToOnboardingPage,
  setOnboardingPreferredMicrophone,
} from "../../actions/onboarding.actions";
import { produceAppState, useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import { isLocalDataClearRequested } from "../../utils/local-data-write-gate";
import { AudioWaveform } from "../common/AudioWaveform";
import { MicrophoneSelector } from "../microphone/MicrophoneSelector";
import {
  runGuardedRecordingStart,
  subscribeRecordingAbortForClear,
} from "../root/recording-start-gate";
import {
  BackButton,
  DualPaneLayout,
  OnboardingFormLayout,
} from "./OnboardingCommon";
import { type NativeRecordingHandle } from "../../utils/native-recording-session";

type RecordingState = "idle" | "starting" | "recording" | "stopping";

const useMicCheckRecording = (preferredMicrophone: string | null) => {
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const overlayPhase = useAppStore((state) => state.overlayPhase);
  const isGlobalRecording =
    overlayPhase === "recording" || overlayPhase === "loading";
  const isRecording = recordingState === "recording";
  const isStarting = recordingState === "starting";
  const mountedRef = useRef(true);
  const opIdRef = useRef(0);
  const recordingStateRef = useRef(recordingState);
  const handleRef = useRef<NativeRecordingHandle | null>(null);
  recordingStateRef.current = recordingState;

  const setSyncedRecordingState = useCallback((next: RecordingState) => {
    recordingStateRef.current = next;
    if (mountedRef.current) {
      setRecordingState(next);
    }
  }, []);

  const startRecording = useCallback(
    () =>
      runGuardedRecordingStart({
        isBlocked: () =>
          isGlobalRecording || recordingStateRef.current !== "idle",
        ownership: {
          isMounted: () => mountedRef.current,
          currentOpId: () => opIdRef.current,
        },
        opIdRef,
        handleRef,
        preferredMicrophone,
        setState: setSyncedRecordingState,
        onError: (error) => console.error("Failed to start recording", error),
      }),
    [isGlobalRecording, preferredMicrophone, setSyncedRecordingState],
  );

  const stopRecording = useCallback(async () => {
    const currentState = recordingStateRef.current;
    if (currentState !== "recording" && currentState !== "starting") {
      return;
    }

    opIdRef.current += 1;
    setSyncedRecordingState("stopping");

    // Stop the recording this form admitted. A global stop would reach whatever
    // session is current, which a later start may own. The admission is retained
    // before capture starts, so this reaches the device even while the start reply
    // is still pending; the bumped op id keeps a late reply from publishing over
    // the stop.
    const handle = handleRef.current;
    handleRef.current = null;
    try {
      if (handle) await handle.stop();
    } catch (error) {
      console.error("Failed to stop recording", error);
      // A rejected stop can leave the device open, and this handle is the only
      // reference to it, so release it instead of dropping it.
      if (handle) {
        void handle.discard().catch((cause) => {
          console.error("Failed to discard the mic check recording", cause);
        });
      }
    } finally {
      setSyncedRecordingState("idle");
      if (!isLocalDataClearRequested()) {
        produceAppState((draft) => {
          draft.audioLevels = [];
        });
      }
    }
  }, [setSyncedRecordingState]);

  const stopRecordingRef = useRef(stopRecording);
  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribeClear = subscribeRecordingAbortForClear(
      () =>
        recordingStateRef.current === "starting" ||
        recordingStateRef.current === "recording",
      () => stopRecordingRef.current(),
    );
    return () => {
      mountedRef.current = false;
      unsubscribeClear();
    };
  }, []);

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
    if (!showMicSelector) {
      void startRecording();
    }

    return () => {
      void stopRecording();
    };
  }, [showMicSelector, preferredMicrophone]);

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
