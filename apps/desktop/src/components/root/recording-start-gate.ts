import {
  getLocalDataClearGeneration,
  isLocalDataClearRequested,
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

/**
 * Start options for a caller that must be able to stop the recording while the
 * start reply is still pending.
 *
 * The handle arrives at admission, before capture can emit its first chunk, so a
 * stop during the opening window reaches the device instead of leaving it open
 * until the reply lands. `handleScoped` keeps that release from unlocking a
 * successor's gate. A stale attempt throws here, which retires its reservation
 * without dispatching `start_recording`, so a late reply never overwrites a newer
 * handle.
 */
export const admittedStartOptions = (
  isCurrent: () => boolean,
  retain: (handle: NativeRecordingHandle) => void,
): NativeRecordingStartOptions => ({
  handleScoped: true,
  onAdmission: (handle) => {
    if (!isCurrent()) throw new Error("Recording start was cancelled");
    retain(handle);
  },
});

/** The facts that decide whether a start or stop may still publish state. */
export type AttemptOwnership = {
  /** False once the component unmounted, so a reply cannot set state. */
  isMounted: () => boolean;
  /** The newest attempt id, bumped by every start and stop. */
  currentOpId: () => number;
};

/**
 * Whether an attempt still owns the UI it opened.
 *
 * A reply may land after a newer start, after the component unmounted, or after
 * a local-data clear began. Each caller needs the same four facts, and inlining
 * them at every branch is how the two microphone surfaces drifted apart.
 */
export const attemptStillOwns = (
  ownership: AttemptOwnership,
  opId: number,
  clearGeneration: number,
): boolean =>
  ownership.isMounted() &&
  opId === ownership.currentOpId() &&
  attemptSurvivedNoClear(clearGeneration);

/**
 * Whether no local-data clear began after an attempt was admitted.
 *
 * A start or stop admitted before a clear must not log, publish or retry into
 * the cleared session, so the same two facts answer both the publish path and
 * the failure path. Both microphone surfaces need it, so it is written once.
 */
export const attemptSurvivedNoClear = (clearGeneration: number): boolean =>
  !isLocalDataClearRequested() &&
  clearGeneration === getLocalDataClearGeneration();

/** What the microphone surfaces share when they open a recording. */
export type GuardedRecordingStartOptions = {
  /** Read the local state that forbids a new start right now. */
  isBlocked: () => boolean;
  /** Ownership facts the reply is judged against. */
  ownership: AttemptOwnership;
  /** The newest attempt id, bumped by every start and stop. */
  opIdRef: { current: number };
  /** The handle the surface keeps, so a stop can reach the opening admission. */
  handleRef: { current: NativeRecordingHandle | null };
  preferredMicrophone: string | null;
  /** Publish the state that owns the start window. */
  setState: (next: "idle" | "starting" | "recording") => void;
  /** Reset per-attempt UI, such as the error text or the preview. */
  onAdmitted?: () => void;
  /** Report a failure that still belongs to this attempt. */
  onError?: (error: unknown, stillOwns: boolean) => void;
};

/**
 * Open a recording and settle its reply against the attempt that asked for it.
 *
 * A reply can land after a newer start, after the surface unmounted, after a
 * local-data clear began, or after a stop already took the handle and tore it
 * down. Each of those has to release only the recording this attempt opened, so
 * the order of the checks is the whole point and it is written once here.
 */
export const runGuardedRecordingStart = async ({
  isBlocked,
  ownership,
  opIdRef,
  handleRef,
  preferredMicrophone,
  setState,
  onAdmitted,
  onError,
}: GuardedRecordingStartOptions): Promise<void> => {
  if (isBlocked() || isLocalDataClearRequested()) return;

  const opId = ++opIdRef.current;
  const clearGeneration = getLocalDataClearGeneration();
  const attemptIsCurrent = (): boolean =>
    attemptStillOwns(ownership, opId, clearGeneration);
  onAdmitted?.();
  setState("starting");

  try {
    const { handle } = await invokeGuardedRecordingStart(
      preferredMicrophone,
      admittedStartOptions(attemptIsCurrent, (admitted) => {
        handleRef.current = admitted;
      }),
    );
    // A stop during the opening window already took this handle and is tearing
    // it down, so only an untouched admission publishes the recording state.
    if (handleRef.current !== handle) {
      await handle.discard().catch(() => undefined);
      return;
    }
    if (!attemptIsCurrent()) {
      if (handleRef.current === handle) handleRef.current = null;
      await handle.discard().catch(() => undefined);
      if (opId === opIdRef.current) setState("idle");
      return;
    }
    setState("recording");
  } catch (error) {
    if (attemptSurvivedNoClear(clearGeneration)) {
      onError?.(error, attemptIsCurrent());
    }
    if (opId === opIdRef.current) setState("idle");
  }
};
