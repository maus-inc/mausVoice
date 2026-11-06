import { useCallback, useRef } from "react";
import { useIntl } from "react-intl";
import { runToast, showToast } from "../../actions/toast.actions";
import { getAppState } from "../../store";
import type { BaseStrategy } from "../../strategies/base.strategy";
import type { TranscriptionSession } from "../../types/transcription-session.types";
import { getLogger } from "../../utils/log.utils";
import { sendPhaseWithoutWaiting } from "../../utils/phase-delivery.utils";
import type { NativeRecordingLeaseRef } from "./dictation-recording-intake";

export type PauseOwner = {
  sessionRef: { current: TranscriptionSession | null };
  strategyRef: { current: BaseStrategy | null };
  operationRef: { current: number };
  isPausedRef: { current: boolean };
  isStoppingRef: { current: boolean };
  nativeStartOwnerRef: NativeRecordingLeaseRef;
  clearUserRecordingTimers: () => void;
  startUserRecordingTimers: () => void;
};

type TransitionRef = { current: number | null };

const isPauseOwnerCurrent = (
  owner: PauseOwner,
  operation: number,
  session: TranscriptionSession,
  strategy: BaseStrategy,
): boolean =>
  owner.operationRef.current === operation &&
  owner.sessionRef.current === session &&
  owner.strategyRef.current === strategy &&
  !owner.isStoppingRef.current;

const releaseTransition = (ref: TransitionRef, operation: number): void => {
  if (ref.current === operation) ref.current = null;
};

/** Claim one transition per recording; retired transitions cannot touch a successor. */
function beginTransition(
  owner: PauseOwner,
  ref: TransitionRef,
  generationRef: { current: object | null },
  expectedPaused: boolean,
) {
  const session = owner.sessionRef.current;
  const strategy = owner.strategyRef.current;
  const operation = owner.operationRef.current;
  if (
    owner.isPausedRef.current !== expectedPaused ||
    owner.isStoppingRef.current ||
    !session ||
    !strategy ||
    ref.current === operation
  )
    return null;
  ref.current = operation;
  const generation = {};
  generationRef.current = generation;
  return {
    strategy,
    lease: owner.nativeStartOwnerRef.current,
    current: () =>
      generationRef.current === generation &&
      isPauseOwnerCurrent(owner, operation, session, strategy),
    release: () => releaseTransition(ref, operation),
  };
}

/** Pause/resume only mutates the recording that issued the asynchronous IPC. */
export function useDictationPause(owner: PauseOwner) {
  const { isPausedRef, clearUserRecordingTimers, startUserRecordingTimers } =
    owner;
  const intl = useIntl();
  const transitionRef = useRef<number | null>(null);
  const generationRef = useRef<object | null>(null);
  const pauseDictation = useCallback(async () => {
    if (getAppState().activeRecordingMode === null) return;
    const transition = beginTransition(
      owner,
      transitionRef,
      generationRef,
      false,
    );
    if (!transition) return;
    try {
      getLogger().info("Pausing dictation");
      if (!transition.lease) return;
      await transition.lease.pause();
      if (!transition.current()) return;
      isPausedRef.current = true;
      clearUserRecordingTimers();
      sendPhaseWithoutWaiting(
        (phase) => transition.strategy.setPhase(phase),
        "paused",
      );
      if (!transition.current()) return;
      runToast(
        showToast({
          message: intl.formatMessage({ defaultMessage: "Dictation paused" }),
          toastType: "info",
          duration: 2_000,
          isCurrent: transition.current,
        }),
      );
    } catch (error) {
      getLogger().error(`Failed to pause dictation: ${error}`);
      if (transition.current())
        runToast(
          showToast({
            message: intl.formatMessage({
              defaultMessage:
                "Could not pause dictation. Recording may continue.",
            }),
            toastType: "error",
            duration: 5_000,
            isCurrent: transition.current,
          }),
        );
    } finally {
      transition.release();
    }
  }, [owner, clearUserRecordingTimers, intl, isPausedRef]);

  const resumeDictation = useCallback(async () => {
    const transition = beginTransition(
      owner,
      transitionRef,
      generationRef,
      true,
    );
    if (!transition) return;
    try {
      getLogger().info("Resuming dictation");
      if (!transition.lease) return;
      await transition.lease.resume();
      if (!transition.current()) return;
      isPausedRef.current = false;
      sendPhaseWithoutWaiting(
        (phase) => transition.strategy.setPhase(phase),
        "recording",
      );
      if (!transition.current()) return;
      startUserRecordingTimers();
    } catch (error) {
      getLogger().error(`Failed to resume dictation: ${error}`);
      if (transition.current())
        runToast(
          showToast({
            message: intl.formatMessage({
              defaultMessage: "Could not resume dictation",
            }),
            toastType: "error",
            duration: 5_000,
            isCurrent: transition.current,
          }),
        );
    } finally {
      transition.release();
    }
  }, [owner, startUserRecordingTimers, intl, isPausedRef]);
  return { pauseDictation, resumeDictation };
}
