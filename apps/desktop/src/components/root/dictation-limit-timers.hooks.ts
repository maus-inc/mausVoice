import { useCallback } from "react";
import { useIntl } from "react-intl";
import { runToast, showToast } from "../../actions/toast.actions";
import { getAppState } from "../../store";
import type { TranscriptionSession } from "../../types/transcription-session.types";
import {
  DEFAULT_DICTATION_LIMIT_MINUTES,
  getDictationRecordingTimerDurations,
  getEffectiveDictationLimitMinutes,
  getProviderRecordingTimerDurations,
  shouldEnableDictationLimit,
} from "../../utils/dictation-limit.utils";
import { getLogger } from "../../utils/log.utils";
import {
  getMyUserPreferences,
  getTranscriptionPrefs,
} from "../../utils/user.utils";
import { scheduleOwnedTimer, type TimerRef } from "./dictation-timers";

const stopAtLimit = (
  stopRecording: (operation: number) => Promise<void>,
  operation: number,
): void => {
  stopRecording(operation).catch((error: unknown) =>
    getLogger().error(`Failed to stop at recording limit: ${error}`),
  );
};

/** Own active-audio and provider wall-clock recording deadlines. */
export function useRecordingLimitTimers({
  recordingWarningTimerRef,
  recordingAutoStopTimerRef,
  providerWarningTimerRef,
  providerAutoStopTimerRef,
  clearUserRecordingTimers,
  clearProviderRecordingTimers,
  sessionRef,
  recordingOperationRef,
  stopRecording,
}: {
  recordingWarningTimerRef: TimerRef;
  recordingAutoStopTimerRef: TimerRef;
  providerWarningTimerRef: TimerRef;
  providerAutoStopTimerRef: TimerRef;
  clearUserRecordingTimers: () => void;
  clearProviderRecordingTimers: () => void;
  sessionRef: { current: TranscriptionSession | null };
  recordingOperationRef: { current: number };
  stopRecording: (operation: number) => Promise<void>;
}) {
  const intl = useIntl();
  const startUserRecordingTimers = useCallback(() => {
    const operation = recordingOperationRef.current;
    clearUserRecordingTimers();

    const state = getAppState();
    const preferences = getMyUserPreferences(state);
    const transcriptionPrefs = getTranscriptionPrefs(state);
    const dictationLimitMinutes = shouldEnableDictationLimit(
      transcriptionPrefs.mode,
    )
      ? getEffectiveDictationLimitMinutes(preferences)
      : DEFAULT_DICTATION_LIMIT_MINUTES;
    const { warningDurationMs, autoStopDurationMs } =
      getDictationRecordingTimerDurations(dictationLimitMinutes);

    if (warningDurationMs !== null) {
      scheduleOwnedTimer(
        recordingWarningTimerRef,
        () => {
          if (recordingOperationRef.current !== operation) return;
          getLogger().warning(
            `Recording duration warning (${dictationLimitMinutes} min limit)`,
          );
          runToast(
            showToast({
              message: intl.formatMessage({
                defaultMessage: "Recording will stop in 60 seconds",
              }),
              toastType: "info",
              duration: 5_000,
            }),
          );
        },
        warningDurationMs,
      );
    }

    if (autoStopDurationMs !== null) {
      scheduleOwnedTimer(
        recordingAutoStopTimerRef,
        () => {
          if (recordingOperationRef.current !== operation) return;
          getLogger().warning(
            `Recording auto-stopped (${dictationLimitMinutes} min limit)`,
          );
          runToast(
            showToast({
              message: intl.formatMessage({
                defaultMessage: "Recording stopped: duration limit reached",
              }),
              toastType: "info",
              duration: 5_000,
            }),
          );
          stopAtLimit(stopRecording, operation);
        },
        autoStopDurationMs,
      );
    }
  }, [clearUserRecordingTimers, intl, recordingOperationRef, stopRecording]);

  const startProviderRecordingTimers = useCallback(() => {
    const operation = recordingOperationRef.current;
    clearProviderRecordingTimers();

    const providerLimitMs =
      sessionRef.current?.getMaximumRecordingDurationMs?.() ?? null;
    const { warningDurationMs, autoStopDurationMs } =
      getProviderRecordingTimerDurations(providerLimitMs);
    if (autoStopDurationMs === null) {
      return;
    }

    if (warningDurationMs !== null) {
      scheduleOwnedTimer(
        providerWarningTimerRef,
        () => {
          if (recordingOperationRef.current !== operation) return;
          getLogger().warning(
            `Provider recording duration warning (${providerLimitMs} ms limit)`,
          );
          runToast(
            showToast({
              message: intl.formatMessage({
                defaultMessage:
                  "Provider limit: recording will stop in 60 seconds",
              }),
              toastType: "info",
              duration: 5_000,
            }),
          );
        },
        warningDurationMs,
      );
    }
    scheduleOwnedTimer(
      providerAutoStopTimerRef,
      () => {
        if (recordingOperationRef.current !== operation) return;
        getLogger().warning(
          `Recording auto-stopped at provider limit (${providerLimitMs} ms)`,
        );
        runToast(
          showToast({
            message: intl.formatMessage({
              defaultMessage:
                "Recording stopped: provider duration limit reached",
            }),
            toastType: "info",
            duration: 5_000,
          }),
        );
        stopAtLimit(stopRecording, operation);
      },
      autoStopDurationMs,
    );
  }, [
    clearProviderRecordingTimers,
    intl,
    recordingOperationRef,
    sessionRef,
    stopRecording,
  ]);

  return { startUserRecordingTimers, startProviderRecordingTimers };
}
