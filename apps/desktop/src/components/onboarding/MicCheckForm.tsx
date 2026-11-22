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
import {
  getLocalDataClearGeneration,
  isLocalDataClearRequested,
} from "../../utils/local-data-write-gate";
import { AudioWaveform } from "../common/AudioWaveform";
import { MicrophoneSelector } from "../microphone/MicrophoneSelector";
import {
  admittedStartOptions,
  attemptStillOwns,
  attemptSurvivedNoClear,
  invokeGuardedRecordingStart,
  subscribeRecordingAbortForClear,
} from "../root/recording-start-gate";
import {
  BackButton,
  DualPaneLayout,
  OnboardingFormLayout,
} from "./OnboardingCommon";
import { type NativeRecordingHandle } from "../../utils/native-recording-session";

export const MicCheckForm = () => {
  const theme = useTheme();

  const [recordingState, setRecordingState] = useState<
    "idle" | "starting" | "recording" | "stopping"
  >("idle");
  const [showMicSelector, setShowMicSelector] = useState(false);
  const preferredMicrophone = useAppStore(
    (state) => state.onboarding.preferredMicrophone,
  );

  const audioLevels = useAppStore((state) => state.audioLevels);
  const overlayPhase = useAppStore((state) => state.overlayPhase);
  const didSignUpWithAccount = useAppStore(
    (state) => state.onboarding.didSignUpWithAccount,
  );

  const isGlobalRecording =
    overlayPhase === "recording" || overlayPhase === "loading";
  const isRecording = recordingState === "recording";
  const isStarting = recordingState === "starting";
  const mountedRef = useRef(true);
  const opIdRef = useRef(0);
  const recordingStateRef = useRef(recordingState);
  const handleRef = useRef<NativeRecordingHandle | null>(null);
  recordingStateRef.current = recordingState;

  const setSyncedRecordingState = useCallback(
    (next: "idle" | "starting" | "recording" | "stopping") => {
      recordingStateRef.current = next;
      if (mountedRef.current) {
        setRecordingState(next);
      }
    },
    [],
  );

  const attemptIsCurrent = useCallback(
    (opId: number, clearGeneration: number) =>
      attemptStillOwns(
        {
          isMounted: () => mountedRef.current,
          currentOpId: () => opIdRef.current,
        },
        opId,
        clearGeneration,
      ),
    [],
  );

  const startRecording = useCallback(async () => {
    if (
      isGlobalRecording ||
      recordingStateRef.current !== "idle" ||
      isLocalDataClearRequested()
    ) {
      return;
    }

    const opId = ++opIdRef.current;
    const clearGeneration = getLocalDataClearGeneration();
    setSyncedRecordingState("starting");

    try {
      const { handle } = await invokeGuardedRecordingStart(
        preferredMicrophone ?? null,
        admittedStartOptions(
          () => attemptIsCurrent(opId, clearGeneration),
          (admitted) => {
            handleRef.current = admitted;
          },
        ),
      );
      // A stop during the opening window already took this handle and is tearing
      // it down, so only an untouched admission publishes the recording state.
      if (handleRef.current !== handle) {
        // That stop may have failed, leaving the admitted capture open while the
        // form reports idle. Discard is idempotent and scoped to this admission,
        // so it confirms the release without reaching a successor.
        await handle.discard().catch(() => undefined);
        return;
      }
      if (!attemptIsCurrent(opId, clearGeneration)) {
        // Release only the recording this attempt opened. The global helper
        // discards whatever session is current, which by now may belong to a
        // later start that superseded this one.
        if (handleRef.current === handle) handleRef.current = null;
        await handle.discard().catch(() => undefined);
        if (opId === opIdRef.current) {
          setSyncedRecordingState("idle");
        }
        return;
      }
      setSyncedRecordingState("recording");
    } catch (error) {
      if (attemptSurvivedNoClear(clearGeneration)) {
        console.error("Failed to start recording", error);
      }
      if (opId === opIdRef.current) {
        setSyncedRecordingState("idle");
      }
    }
  }, [
    attemptIsCurrent,
    isGlobalRecording,
    preferredMicrophone,
    setSyncedRecordingState,
  ]);

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
    if (!showMicSelector) {
      void startRecording();
    }

    return () => {
      void stopRecordingRef.current();
    };
  }, [showMicSelector, preferredMicrophone]);

  useEffect(() => {
    if (isGlobalRecording && (isRecording || isStarting)) {
      void stopRecording();
    }
  }, [isGlobalRecording, isRecording, isStarting, stopRecording]);

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
