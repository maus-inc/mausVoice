import type { UnlistenFn } from "@tauri-apps/api/event";
import { listenToAudioChunks } from "../../sessions/audio-chunk-events";
import type { BaseStrategy } from "../../strategies/base.strategy";
import type { RecordingMode } from "../../state/app.state";
import type { TranscriptionSession } from "../../types/transcription-session.types";
import {
  createAudioChunkStartupBuffer,
  type AudioChunkStartupBuffer,
} from "../../utils/audio-chunk-startup-buffer";
import { ensureFloat32Array } from "../../utils/audio.utils";
import { hasFiniteAudioSamples } from "../../utils/audio-samples.utils";
import { getLogger } from "../../utils/log.utils";
import { startAsPromise } from "../../utils/promise.utils";
import { sendPhaseWithoutWaiting } from "../../utils/phase-delivery.utils";
import { NativeRecordingLease } from "../../utils/native-recording-lease";
import { releaseRecordingResource } from "./dictation-cleanup";

export type RecordingStartAttempt = { operation: number };

/** Release the activation at native dispatch, or cancel a pre-dispatch start. */
export function resolveStartAtNativeDispatch(
  start: (
    dispatched: (operation: number) => void,
  ) => Promise<number | undefined>,
  releaseSignal?: AbortSignal,
  cancelBeforeDispatch?: () => void,
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    let dispatched = false;
    const cleanup = () => releaseSignal?.removeEventListener("abort", release);
    const release = () => {
      if (dispatched) return;
      cleanup();
      try {
        cancelBeforeDispatch?.();
        resolve(undefined);
      } catch (error) {
        reject(error);
      }
    };
    if (releaseSignal?.aborted) {
      release();
      return;
    }
    releaseSignal?.addEventListener("abort", release, { once: true });
    // start() may fail before it returns a promise; both outcomes are settled
    // through the same handlers below.
    void startAsPromise(() =>
      start((operation) => {
        dispatched = true;
        cleanup();
        resolve(operation);
      }),
    ).then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** Claim startup without replacing another live or still-starting capture. */
export function claimRecordingStart({
  operationRef,
  pendingRef,
  isStopping,
  hasNativeLease,
  currentMode,
  requestedMode,
}: {
  operationRef: { current: number };
  pendingRef: { current: RecordingStartAttempt | null };
  isStopping: boolean;
  hasNativeLease: boolean;
  currentMode: RecordingMode | null;
  requestedMode: RecordingMode;
}): RecordingStartAttempt | null {
  if (
    isStopping ||
    hasNativeLease ||
    (pendingRef.current !== null &&
      pendingRef.current.operation === operationRef.current) ||
    (currentMode !== null && currentMode !== requestedMode)
  )
    return null;
  const attempt = { operation: ++operationRef.current };
  pendingRef.current = attempt;
  return attempt;
}

export type SessionAudioIntake = {
  buffer: AudioChunkStartupBuffer;
  unlisten: UnlistenFn | null;
  current: boolean;
};

/**
 * A recording start is current only while its operation id, session, and
 * strategy are all still the ones the component holds. Every checkpoint in
 * `startRecording` re-checks this after an await, so a stop, abort, or newer
 * dictation that lands mid-start is detected before it leaks capture.
 */
export const isRecordingStartCurrent = (
  operationId: number,
  currentOperationId: number,
  session: TranscriptionSession,
  currentSession: TranscriptionSession | null,
  strategy: BaseStrategy,
  currentStrategy: BaseStrategy | null,
): boolean =>
  operationId === currentOperationId &&
  currentSession === session &&
  currentStrategy === strategy;

export const forwardAudioChunk = (
  session: TranscriptionSession,
  chunk: Float32Array,
  offset: number,
): void => {
  try {
    session.writeAudioChunk?.(chunk, offset);
  } catch {
    // Provider exceptions can contain dictated audio or credentials.
    getLogger().error("[Dictation] Failed to forward audio chunk");
  }
};

/** Report chunk counts and discontinuities without changing audio delivery. */
const createAudioChunkTracker = () => {
  let receivedChunkCount = 0;
  let receivedSampleCount = 0;
  let lastReceivedOffset: number | null = null;
  return (chunk: ArrayLike<number>, offset: number) => {
    receivedChunkCount += 1;
    receivedSampleCount += chunk.length;
    if (receivedChunkCount <= 3 || receivedChunkCount % 10 === 0) {
      getLogger().verbose(
        `[Dictation] Received chunk #${receivedChunkCount} (total ${receivedSampleCount} samples)`,
      );
    }
    if (lastReceivedOffset !== null && offset !== lastReceivedOffset + 1) {
      getLogger().warning(
        `[Dictation] Audio offset gap: expected ${lastReceivedOffset + 1}, got ${offset}`,
      );
    }
    lastReceivedOffset = offset + chunk.length - 1;
  };
};

/** Route and account for ordered audio chunks while startup is pending. */
const createAudioChunkHandler = (
  session: TranscriptionSession,
  buffer: AudioChunkStartupBuffer,
  isCurrent: () => boolean,
  shouldForwardLive: () => boolean,
) => {
  const trackChunk = createAudioChunkTracker();
  let hasLoggedTrim = false;

  return (samples: number[], offset: number | null) => {
    if (!isCurrent()) return;
    if (offset === null) {
      getLogger().warning(
        "[Dictation] Dropped audio_chunk with no sample offset; the recording stream is no longer contiguous",
      );
      return;
    }
    if (samples.length === 0) return;
    trackChunk(samples, offset);
    if (!shouldForwardLive()) {
      buffer.push(samples, offset);
      if (buffer.overflowed() && !hasLoggedTrim) {
        hasLoggedTrim = true;
        getLogger().warning(
          "[Dictation] Startup audio buffer overflowed; later chunks will be dropped until the session is ready",
        );
      }
    } else {
      if (!hasFiniteAudioSamples(samples)) {
        getLogger().warning("[Dictation] Dropped invalid live audio chunk");
        return;
      }
      forwardAudioChunk(session, ensureFloat32Array(samples), offset);
    }
  };
};

/**
 * The single `audio_chunk` registration in the app. Sessions receive live
 * samples through `writeAudioChunk`, which is also where pretranscribing
 * sessions tap the stream, so intake cannot be registered twice.
 *
 * A chunk that arrives before the session is ready is buffered with its
 * absolute sample index and replayed in order once the sink is installed.
 *
 * A subscription that cannot be established is reported and tolerated rather
 * than thrown: a `local` or `after-stop` session still transcribes the whole
 * recording, so failing the start there would report "Recording failed" for a
 * dictation that was fine. A `live-streaming` session has no such fallback and
 * finalizes to an empty result, which is a gap in `DictationSideEffects` rather
 * than one this module can close.
 */
export const attachSessionAudioIntake = async (
  session: TranscriptionSession,
  isCurrent: () => boolean,
  shouldForwardLive: () => boolean,
  onOverflow: (droppedSamples: number) => void,
  ownerId?: string,
  getGeneration?: () => number | null,
): Promise<SessionAudioIntake> => {
  const buffer = createAudioChunkStartupBuffer(onOverflow);
  if (typeof session.writeAudioChunk !== "function") {
    // Nothing to attach, so report the real staleness result. Returning a
    // constant here would let a start that already lost the race overwrite the
    // shared listener ref and detach the recording that replaced it.
    return { buffer, unlisten: null, current: isCurrent() };
  }

  // A subscription that cannot be established is not a reason to fail the
  // recording, and letting this reject reached the outer start-failure handler
  // and showed "Recording failed" for a dictation that was perfectly fine. The
  // caller tolerates a null `unlisten`; see the caveat on the catch below for
  // the one session kind that cannot survive it.
  let unlisten: UnlistenFn | null;
  try {
    unlisten = await listenToAudioChunks(
      createAudioChunkHandler(session, buffer, isCurrent, shouldForwardLive),
      ownerId,
      getGeneration,
    );
  } catch (error) {
    // Only a session whose `finalize` reads the whole recording passed to it can
    // recover from this, and a live-streaming provider's cannot: it finalizes
    // whatever its socket produced, and with no chunk ever written that is
    // nothing. The recording still happens either way, so this is reported and
    // the start continues; the empty-result path is what has to notice.
    getLogger().warning(
      `Could not subscribe to the audio chunk stream; the session has no live audio and can only recover by transcribing the whole recording: ${error}`,
    );
    return { buffer, unlisten: null, current: isCurrent() };
  }

  if (!isCurrent()) {
    unlisten();
    return { buffer, unlisten: null, current: false };
  }
  return { buffer, unlisten, current: true };
};

export type NativeRecordingLeaseRef = { current: NativeRecordingLease | null };

export const stopNativeRecordingForAbort = (
  ownerRef: NativeRecordingLeaseRef,
  onUnconfirmed: () => void = () => undefined,
): Promise<void> => {
  const lease = ownerRef.current;
  ownerRef.current = null;
  if (!lease) return Promise.resolve();
  // A transport that throws before returning a promise never dispatched the
  // stop, so the lease must stay reachable rather than letting a successor
  // assume the capture was released. A rejection means it did dispatch, and
  // ownership retires with it.
  let transportStarted = false;
  const cancel = (): Promise<void> => {
    const pending = lease.cancel();
    transportStarted = true;
    return pending;
  };
  return startAsPromise(cancel)
    .then(() => undefined)
    .catch((error) => {
      if (!transportStarted && ownerRef.current === null) {
        ownerRef.current = lease;
      }
      getLogger().verbose(`stop_recording failed during abort: ${error}`);
      onUnconfirmed();
    });
};

/**
 * Interim segments arrive from the provider for the recording that is still
 * open. A segment produced by a superseded start is dropped instead of being
 * styled into the live selection.
 */
export const createCurrentSegmentGuard =
  (
    operationId: number,
    getCurrentOperationId: () => number,
    handleInterimSegment: (segment: string) => void,
    isCurrentSession: () => boolean = () => true,
  ) =>
  (segment: string): void => {
    if (operationId === getCurrentOperationId() && isCurrentSession()) {
      handleInterimSegment(segment);
    }
  };

export type RecordingResourceRefs = {
  audioChunkUnlistenRef: { current: UnlistenFn | null };
  sessionRef: { current: TranscriptionSession | null };
  strategyRef: { current: BaseStrategy | null };
  nativeStartOwnerRef: NativeRecordingLeaseRef;
};

export function takeRecordingResources(
  refs: RecordingResourceRefs,
): RecordingResourceRefs {
  const owned = {
    audioChunkUnlistenRef: { current: refs.audioChunkUnlistenRef.current },
    sessionRef: { current: refs.sessionRef.current },
    strategyRef: { current: refs.strategyRef.current },
    nativeStartOwnerRef: { current: refs.nativeStartOwnerRef.current },
  };
  refs.audioChunkUnlistenRef.current = null;
  refs.sessionRef.current = null;
  refs.strategyRef.current = null;
  refs.nativeStartOwnerRef.current = null;
  return owned;
}

/**
 * Releases everything a recording holds when the component unmounts: the
 * intake listener, the session, the strategy, and native capture. Each release
 * is attempted even if an earlier one throws, so a failure cannot strand the
 * native microphone.
 */
export const releaseRecordingResources = ({
  audioChunkUnlistenRef,
  sessionRef,
  strategyRef,
  nativeStartOwnerRef,
  isCurrent = () => true,
}: RecordingResourceRefs & { isCurrent?: () => boolean }): void => {
  const owned = takeRecordingResources({
    audioChunkUnlistenRef,
    sessionRef,
    strategyRef,
    nativeStartOwnerRef,
  });
  const unlisten = owned.audioChunkUnlistenRef.current;
  const session = owned.sessionRef.current;
  const strategy = owned.strategyRef.current;
  const lease = owned.nativeStartOwnerRef.current;
  releaseRecordingResource("Audio listener", "during unmount", () =>
    unlisten?.(),
  );
  releaseRecordingResource("Session", "during unmount", () =>
    session?.cleanup(),
  );
  releaseRecordingResource("Strategy", "during unmount", () =>
    strategy?.cleanup(isCurrent),
  );
  releaseRecordingResource("Native capture", "during unmount", () =>
    lease?.cancel(),
  );
};

/** Retire ownership before an abort awaits IPC, so a restart cannot be captured. */
export const takeRecordingSession = ({
  sessionRef,
  strategyRef,
}: Pick<RecordingResourceRefs, "sessionRef" | "strategyRef">): {
  session: TranscriptionSession | null;
  strategy: BaseStrategy | null;
} => {
  const owned = { session: sessionRef.current, strategy: strategyRef.current };
  sessionRef.current = null;
  strategyRef.current = null;
  return owned;
};

/** Clean only the retired recording; never reset state belonging to its successor. */
export async function finishAbortedRecording(
  owned: ReturnType<typeof takeRecordingSession>,
  operationId: number,
  currentOperationId: () => number,
  clearRecordingState: () => void,
): Promise<void> {
  try {
    owned.session?.cleanup();
  } catch (error) {
    getLogger().warning(`Session cleanup failed during abort: ${error}`);
  }
  try {
    await owned.strategy?.cleanup(() => currentOperationId() === operationId);
  } catch (error) {
    getLogger().warning(`Strategy cleanup failed during abort: ${error}`);
  }
  if (currentOperationId() === operationId) clearRecordingState();
}

/** Release only the listener still owned by this operation, even if cleanup throws. */
export function releaseOwnedAudioListener(
  ref: { current: UnlistenFn | null },
  owned?: UnlistenFn | null,
): void {
  if (owned !== undefined && ref.current !== owned) return;
  const listener = ref.current;
  ref.current = null;
  try {
    listener?.();
  } catch (error) {
    getLogger().warning(`Audio listener cleanup failed: ${error}`);
  }
}

/** Let the session prepare before native capture, tolerating failure but not staleness. */
export async function prepareSessionForCapture(
  session: TranscriptionSession,
  isCurrent: () => boolean,
  ownerId?: string,
  getGeneration?: () => number | null,
): Promise<boolean> {
  try {
    await session.onBeforeRecordingStart?.(ownerId, getGeneration);
  } catch (error) {
    getLogger().warning(
      `Pre-capture session setup failed, continuing without it: ${error}`,
    );
  }
  if (isCurrent()) return true;
  session.cleanup();
  return false;
}

/** Route live provider segments only to the recording that installed them. */
export function configureStreamingInterims(
  session: TranscriptionSession,
  strategy: BaseStrategy,
  operationId: number,
  currentOperationId: () => number,
  isCurrentSession: () => boolean = () => true,
): void {
  if (!session.supportsStreaming()) return;
  const isCurrent = () =>
    operationId === currentOperationId() && isCurrentSession();
  session.setInterimResultCallback(
    createCurrentSegmentGuard(
      operationId,
      currentOperationId,
      (segment) => strategy.handleInterimSegment(segment, isCurrent),
      isCurrentSession,
    ),
  );
}

/** Start deadlines when capture is dispatched, even if its reply is delayed. */
export async function startNativeCapture(
  lease: NativeRecordingLease,
  preferredMicrophone: string | null,
  isCurrent: () => boolean,
  startProviderTimers: () => void,
  onDispatched?: () => void,
): Promise<{ sampleRate: number }> {
  return lease.start(
    preferredMicrophone,
    true,
    () => {
      if (isCurrent()) startProviderTimers();
      onDispatched?.();
    },
    isCurrent,
  );
}

/** Own the phase, native-capture and provider-start checkpoints for one session. */
export async function startPreparedSession({
  session,
  strategy,
  buffer,
  isCurrent,
  lease,
  preferredMicrophone,
  startProviderTimers,
  markReady,
  beforeNativeCapture,
  onNativeStartDispatched,
}: {
  session: TranscriptionSession;
  strategy: BaseStrategy;
  buffer: AudioChunkStartupBuffer;
  isCurrent: () => boolean;
  lease: NativeRecordingLease;
  preferredMicrophone: string | null;
  startProviderTimers: () => void;
  markReady: () => void;
  beforeNativeCapture?: () => void;
  onNativeStartDispatched?: () => void;
}): Promise<boolean> {
  await strategy.onBeforeStart(isCurrent);
  if (!isCurrent()) {
    session.cleanup();
    return false;
  }
  getLogger().info(
    `Starting recording (mic=${preferredMicrophone ?? "default"})`,
  );
  beforeNativeCapture?.();
  if (
    !(await prepareSessionForCapture(
      session,
      isCurrent,
      lease.ownerId,
      () => lease.generation,
    ))
  )
    return false;
  sendPhaseWithoutWaiting((phase) => strategy.setPhase(phase), "recording");
  const capture = startNativeCapture(
    lease,
    preferredMicrophone,
    isCurrent,
    startProviderTimers,
    onNativeStartDispatched,
  ).then(async (result) => {
    if (!isCurrent()) await lease.cancel();
    return result;
  });
  const result = await capture;
  const sampleRate = result.sampleRate;
  buffer.setSampleRate(sampleRate);
  getLogger().verbose(`Recording started (sampleRate=${sampleRate})`);
  if (!isCurrent()) {
    await lease.cancel();
    return false;
  }
  await session.onRecordingStart(sampleRate);
  if (!isCurrent()) {
    await lease.cancel();
    session.cleanup();
    return false;
  }
  buffer.setSink((chunk, offset) => forwardAudioChunk(session, chunk, offset));
  buffer.replay();
  buffer.reset();
  markReady();
  return true;
}

/** A failed old start may release its own session, but never abort a successor. */
export function abortFailedRecordingStart(
  error: unknown,
  session: TranscriptionSession | null,
  operationId: number,
  currentOperationId: number,
  abort: () => Promise<void>,
): boolean {
  if (operationId !== currentOperationId) {
    getLogger().warning(
      "Start failed after a newer recording took over; ignoring stale failure",
    );
    try {
      session?.cleanup();
    } catch (cleanupError) {
      getLogger().warning(`Stale session cleanup failed: ${cleanupError}`);
    }
    return false;
  }
  getLogger().error(`Failed to start recording: ${error}`);
  abort().catch((abortError) =>
    getLogger().error(`Failed to abort recording: ${abortError}`),
  );
  return true;
}
