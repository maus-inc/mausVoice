import type { RecordingMode } from "../../state/app.state";
import {
  isLocalDataClearRequested,
  subscribeToLocalDataClearRequested,
  withLocalDataWrite,
} from "../../utils/local-data-write-gate";
import { getLogger } from "../../utils/log.utils";
import {
  beginNativeRecording,
  NativeRecordingBusyError,
  type NativeRecordingHandle,
  type NativeRecordingStartOptions,
} from "../../utils/native-recording-session";

/** Invalidate and unwind any active session as soon as a clear is requested. */
export const subscribeRecordingAbortForClear = (
  isActive: () => boolean,
  abort: () => Promise<void>,
): (() => void) =>
  subscribeToLocalDataClearRequested(() => {
    if (!isActive()) return;
    void abort().catch((error) => {
      getLogger().warning(
        `Failed to abort recording during local-data clear: ${error}`,
      );
    });
  });

/** Handle a start even when another parallel startup step has already failed. */
export const settleRecordingStart = async <T>(
  start: Promise<T>,
  isCurrent: () => boolean,
  onCurrent: () => void,
  onStale: () => Promise<void>,
): Promise<T> => {
  const result = await start;
  if (isCurrent()) onCurrent();
  else await onStale();
  return result;
};

/**
 * Keep an in-flight microphone start ahead of destructive local cleanup, and
 * open it under a native recording admission so every later stop or discard can
 * prove the stream it is tearing down is the one it started.
 */
export const invokeGuardedRecordingStart = (
  preferredMicrophone: string | null,
  options: NativeRecordingStartOptions = {},
): Promise<{ sampleRate: number; handle: NativeRecordingHandle }> =>
  withLocalDataWrite(() => beginNativeRecording(preferredMicrophone, options));

/** Reject before replacing any shared session state. ActivationController
 * handles the rejection without scheduling that shortcut's stop callback. */
export const assertDictationStartAvailable = (
  hasActiveTake: boolean,
  isStopping: boolean,
  mode?: {
    current: RecordingMode | null;
    requested: RecordingMode;
  },
): void => {
  const blockedByAgentPanel =
    mode?.current === "agent" && mode.requested !== "agent";
  if (
    hasActiveTake ||
    isStopping ||
    blockedByAgentPanel ||
    isLocalDataClearRequested()
  ) {
    throw new NativeRecordingBusyError(
      "A dictation session is not available to start",
    );
  }
};

/** A shortcut can only stop the operation it claimed, even if its controller
 * outlives a cancel, a settings change, or a later shortcut's recording. */
export const bindRecordingActivation = (
  start: (claim: (operation: number) => void) => Promise<void>,
  getCurrentOperation: () => number,
  stop: () => Promise<void>,
) => {
  let ownedOperation: number | null = null;
  return {
    start: async () => {
      ownedOperation = null;
      await start((operation) => {
        ownedOperation ??= operation;
      });
    },
    stop: async () => {
      const owned = ownedOperation;
      ownedOperation = null;
      if (owned !== null && getCurrentOperation() === owned) await stop();
    },
  };
};
