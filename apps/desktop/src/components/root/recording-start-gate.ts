import {
  subscribeToLocalDataClearRequested,
  withLocalDataWrite,
} from "../../utils/local-data-write-gate";
import { getLogger } from "../../utils/log.utils";
import {
  beginNativeRecording,
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
