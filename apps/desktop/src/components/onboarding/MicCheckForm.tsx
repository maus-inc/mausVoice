import { ArrowForward, Check } from "@mui/icons-material";
import { Box, Button, Stack, Typography, useTheme } from "@mui/material";
import { NativeRecordingLease } from "../../utils/native-recording-lease";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { FormattedMessage } from "react-intl";
import {
  goToOnboardingPage,
  setOnboardingPreferredMicrophone,
} from "../../actions/onboarding.actions";
import { produceAppState, useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import { AudioWaveform } from "../common/AudioWaveform";
import { MicrophoneSelector } from "../microphone/MicrophoneSelector";
import {
  BackButton,
  DualPaneLayout,
  OnboardingFormLayout,
} from "./OnboardingCommon";

const useDeferredMicrophoneCheck = ({
  blocked,
  isGlobalRecording,
  showMicSelector,
  intentionalStop,
  recordingState,
  startRecording,
}: {
  blocked: RefObject<boolean>;
  isGlobalRecording: boolean;
  showMicSelector: boolean;
  intentionalStop: RefObject<boolean>;
  recordingState: "idle" | "starting" | "recording" | "stopping";
  startRecording: () => Promise<void>;
}) => {
  useEffect(() => {
    if (
      blocked.current &&
      !intentionalStop.current &&
      !isGlobalRecording &&
      !showMicSelector &&
      recordingState === "idle"
    ) {
      void startRecording();
    }
  }, [
    blocked,
    intentionalStop,
    isGlobalRecording,
    showMicSelector,
    recordingState,
    startRecording,
  ]);
};

// Owns onboarding capture and restarts only attempts blocked by dictation.
const useOnboardingMicrophoneCheck = (
  preferredMicrophone: string | null,
  isGlobalRecording: boolean,
  showMicSelector: boolean,
  intentionalStop: RefObject<boolean>,
) => {
  const [recordingState, setRecordingState] = useState<
    "idle" | "starting" | "recording" | "stopping"
  >("idle");
  const isRecording = recordingState === "recording";
  const isStarting = recordingState === "starting";
  // A check skipped because dictation owns the recorder should run once it is free.
  const blockedStartRef = useRef(false);
  const stopPromiseRef = useRef<Promise<void> | null>(null);
  const leaseRef = useRef<NativeRecordingLease | null>(null);

  const startRecording = useCallback(async () => {
    if (isGlobalRecording) {
      blockedStartRef.current = true;
      return;
    }
    if (leaseRef.current) {
      if (stopPromiseRef.current && !intentionalStop.current)
        blockedStartRef.current = true;
      return;
    }
    if (recordingState !== "idle") return;
    blockedStartRef.current = false;
    const lease = new NativeRecordingLease();
    leaseRef.current = lease;
    const isCurrent = () =>
      leaseRef.current === lease && !stopPromiseRef.current;
    setRecordingState("starting");

    try {
      await lease.start(preferredMicrophone);
      if (isCurrent()) setRecordingState("recording");
    } catch (error) {
      if (isCurrent()) {
        leaseRef.current = null;
        console.error("Failed to start recording", error);
        setRecordingState("idle");
      }
    }
  }, [isGlobalRecording, recordingState, preferredMicrophone]);

  const stopRecording = useCallback((): Promise<void> => {
    if (stopPromiseRef.current) return stopPromiseRef.current;
    const lease = leaseRef.current;
    if (!lease) return Promise.resolve();

    setRecordingState("stopping");
    const command = lease.cancel();
    const pending = command
      .then(() => undefined)
      .catch((error: unknown) => {
        blockedStartRef.current = false;
        console.error("Failed to stop recording", error);
      })
      .finally(() => {
        if (leaseRef.current === lease) leaseRef.current = null;
        stopPromiseRef.current = null;
        setRecordingState("idle");
        produceAppState((draft) => {
          if (draft.overlayPhase === "idle") draft.audioLevels = [];
        });
      });
    stopPromiseRef.current = pending;
    return pending;
  }, []);

  const stopRecordingRef = useRef(stopRecording);
  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

  useEffect(() => {
    if (!showMicSelector) {
      void startRecording();
    }

    return () => {
      void stopRecordingRef.current();
    };
  }, [showMicSelector, preferredMicrophone]);

  useDeferredMicrophoneCheck({
    blocked: blockedStartRef,
    isGlobalRecording,
    showMicSelector,
    intentionalStop,
    recordingState,
    startRecording,
  });

  useEffect(() => {
    if (isGlobalRecording && (isRecording || isStarting)) {
      blockedStartRef.current = true;
      void stopRecording();
    }
  }, [isGlobalRecording, isRecording, isStarting, stopRecording]);

  return { isRecording, isStarting, stopRecording };
};

export const MicCheckForm = () => {
  const theme = useTheme();
  const [showMicSelector, setShowMicSelector] = useState(false);
  const intentionalStop = useRef(false);
  const preferredMicrophone = useAppStore(
    (state) => state.onboarding.preferredMicrophone,
  );
  const audioLevels = useAppStore((state) => state.audioLevels);
  const overlayPhase = useAppStore((state) => state.overlayPhase);
  const didSignUpWithAccount = useAppStore(
    (state) => state.onboarding.didSignUpWithAccount,
  );

  // Paused dictations still own the recorder and must not be stopped by a test.
  const isGlobalRecording = overlayPhase !== "idle";
  const { isRecording, isStarting, stopRecording } =
    useOnboardingMicrophoneCheck(
      preferredMicrophone,
      isGlobalRecording,
      showMicSelector,
      intentionalStop,
    );

  const handleChangeMicrophone = async () => {
    trackButtonClick("onboarding_try_another_mic");
    intentionalStop.current = true;
    await stopRecording();
    setShowMicSelector(true);
  };

  const handleMicSelected = () => {
    trackButtonClick("onboarding_use_this_mic");
    intentionalStop.current = false;
    setShowMicSelector(false);
  };

  const handleConfirm = async () => {
    trackButtonClick("onboarding_mic_looks_good");
    intentionalStop.current = true;
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
