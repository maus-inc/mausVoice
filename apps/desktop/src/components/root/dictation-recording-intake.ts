import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  listenToAudioChunks,
  type AudioChunkAdmission,
} from "../../sessions/audio-chunk-events";
import type { TranscriptionSessionKind } from "../../sessions";
import type { BaseStrategy } from "../../strategies/base.strategy";
import type { TranscriptionSession } from "../../types/transcription-session.types";
import {
  createAudioChunkStartupBuffer,
  type AudioChunkStartupBuffer,
} from "../../utils/audio-chunk-startup-buffer";
import { ensureFloat32Array } from "../../utils/audio.utils";
import { getLogger } from "../../utils/log.utils";
import {
  discardNativeRecording,
  type NativeRecordingHandle,
} from "../../utils/native-recording-session";

export type SessionAudioIntake = {
  buffer: AudioChunkStartupBuffer;
  unlisten: UnlistenFn | null;
  current: boolean;
  /** True only when registering the Tauri audio_chunk listener rejected. */
  subscriptionFailed: boolean;
  /** True once any part of the live stream is known to be invalid. */
  hasDiscontinuity: () => boolean;
  /** Stop accepting events and complete a contiguous prefix from the native recording. */
  sealLiveAudio: (
    samples: number[] | Float32Array,
    sampleRate?: number,
  ) => boolean;
  /** Forward replayed startup audio while tracking synchronous write failures. */
  forward: (chunk: Float32Array, offset: number) => void;
};

/**
 * Whether a failed audio-chunk subscription marks the recording's empty stop
 * result as a live-provider failure that routes into failed-audio recovery.
 *
 * Only live-streaming providers meet that bar: they cannot use the native
 * waveform at stop, so a lost subscription leaves them with no transcript at
 * all. Batch/after-stop and local sessions still transcribe the captured
 * recording — the failure only disables pause pretranscription — so flagging
 * them would store honest empty results as failures with a live-provider
 * warning that never applied to them.
 *
 * The discriminator is the session kind recorded at construction, not
 * `supportsStreaming()`: Azure streams audio live yet returns false from it.
 */
export const requiresLiveIntakeRecovery = (
  sessionKind: TranscriptionSessionKind,
  subscriptionFailed: boolean,
): boolean => subscriptionFailed && sessionKind === "live-streaming";

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
): boolean => {
  try {
    if (!session.writeAudioChunk) return false;
    session.writeAudioChunk(chunk, offset);
    return true;
  } catch (error) {
    getLogger().error(`[Dictation] Failed to forward audio chunk: ${error}`);
    return false;
  }
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
 * dictation that was fine. A `live-streaming` session cannot transcribe the full
 * captured waveform after this failure and may finalize empty; the stop path
 * still receives the native recording and the empty-result handler retains it
 * for retry when the strategy and persistence preferences allow. This is
 * recovery storage, not an automatic whole-recording transcription fallback.
 */
export const attachSessionAudioIntake = async (
  session: TranscriptionSession,
  isCurrent: () => boolean,
  shouldForwardLive: () => boolean,
  onOverflow: (droppedSamples: number) => void,
  getAdmission: () => AudioChunkAdmission | null,
): Promise<SessionAudioIntake> => {
  let discontinuity = false;
  let sealed = false;
  let sealResult = false;
  let nextOffset = 0;
  const buffer = createAudioChunkStartupBuffer((droppedSamples) => {
    discontinuity = true;
    onOverflow(droppedSamples);
  });
  const forward = (chunk: Float32Array, offset: number) => {
    if (!forwardAudioChunk(session, chunk, offset)) discontinuity = true;
  };
  const fillMissingTail = (
    samples: number[] | Float32Array,
    sampleRate?: number,
  ): boolean => {
    const missing = samples.length - nextOffset;
    if (missing === 0) return true;
    if (
      !sampleRate ||
      !Number.isSafeInteger(sampleRate) ||
      sampleRate < 1 ||
      missing > sampleRate * 2
    ) {
      discontinuity = true;
      return false;
    }
    const waveform = ensureFloat32Array(samples);
    const chunkSize = Math.max(1, Math.floor(sampleRate / 10));
    for (
      let offset = nextOffset;
      offset < waveform.length;
      offset += chunkSize
    ) {
      forward(waveform.slice(offset, offset + chunkSize), offset);
      if (discontinuity) return false;
    }
    return true;
  };
  const common = {
    buffer,
    hasDiscontinuity: () => discontinuity,
    forward,
    sealLiveAudio: (
      samples: number[] | Float32Array,
      sampleRate?: number,
    ): boolean => {
      // Native event delivery is asynchronous. Once native stop returns, use
      // its retained waveform to fill a short contiguous suffix and ignore late
      // IPCs. A middle gap cannot be repaired after later audio was sent. Do
      // not flood a provider if delivery has stalled for a long time.
      if (sealed) return sealResult;
      sealed = true;
      if (nextOffset > samples.length || !getAdmission()) {
        discontinuity = true;
      }
      if (discontinuity) return false;
      sealResult = fillMissingTail(samples, sampleRate);
      return sealResult;
    },
  };
  if (typeof session.writeAudioChunk !== "function") {
    // Nothing to attach, so report the real staleness result. Returning a
    // constant here would let a start that already lost the race overwrite the
    // shared listener ref and detach the recording that replaced it.
    discontinuity = true;
    return {
      ...common,
      unlisten: null,
      current: isCurrent(),
      subscriptionFailed: false,
    };
  }

  let receivedChunkCount = 0;
  let receivedSampleCount = 0;
  let lastForwardedOffset: number | null = null;
  let hasLoggedTrim = false;

  const acceptsAdmission = (chunkAdmission: AudioChunkAdmission | null) => {
    const admitted = getAdmission();
    // Before admission, queued events belong to another recording. Afterward,
    // untagged events cannot be trusted; another owner's events are ignored.
    if (!admitted) return false;
    if (!chunkAdmission) {
      discontinuity = true;
      return false;
    }
    return (
      chunkAdmission.ownerId === admitted.ownerId &&
      chunkAdmission.generation === admitted.generation
    );
  };

  const hasValidOffset = (offset: number | null): offset is number => {
    if (offset === null) {
      discontinuity = true;
      getLogger().warning(
        "[Dictation] Dropped audio_chunk with no sample offset; the recording stream is no longer contiguous",
      );
      return false;
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      discontinuity = true;
      getLogger().warning(
        "[Dictation] Dropped audio_chunk with an invalid sample offset; the recording stream is no longer contiguous",
      );
      return false;
    }
    return true;
  };

  // A subscription that cannot be established is not a reason to fail the
  // recording; letting this reject reached the outer start-failure handler and
  // showed "Recording failed" for a dictation that was otherwise fine. The
  // caller tolerates a null `unlisten`: local/after-stop sessions can use the
  // captured recording directly, while live sessions route an empty result to
  // failed-audio recovery at stop.
  let unlisten: UnlistenFn | null;
  try {
    unlisten = await listenToAudioChunks((samples, offset, chunkAdmission) => {
      if (
        sealed ||
        !isCurrent() ||
        !acceptsAdmission(chunkAdmission) ||
        !hasValidOffset(offset)
      )
        return;
      const chunk = ensureFloat32Array(samples);
      if (chunk.length === 0) return;
      receivedChunkCount += 1;
      receivedSampleCount += chunk.length;
      if (receivedChunkCount <= 3 || receivedChunkCount % 10 === 0) {
        getLogger().verbose(
          `[Dictation] Received chunk #${receivedChunkCount} (total ${receivedSampleCount} samples)`,
        );
      }
      if (
        offset !== nextOffset ||
        !Number.isSafeInteger(offset + chunk.length)
      ) {
        discontinuity = true;
      }
      nextOffset = offset + chunk.length;
      if (lastForwardedOffset !== null && offset !== lastForwardedOffset + 1) {
        getLogger().warning(
          `[Dictation] Audio offset gap: expected ${lastForwardedOffset + 1}, got ${offset}`,
        );
      }
      lastForwardedOffset = offset + chunk.length - 1;
      if (!shouldForwardLive()) {
        buffer.push(chunk, offset);
        if (buffer.overflowed() && !hasLoggedTrim) {
          hasLoggedTrim = true;
          getLogger().warning(
            "[Dictation] Startup audio buffer overflowed; later chunks will be dropped until the session is ready",
          );
        }
      } else {
        forward(chunk, offset);
      }
    });
  } catch (error) {
    // With no audio_chunk listener, a live-streaming provider cannot use the
    // native waveform passed to finalize; it returns whatever its socket produced
    // (often no transcript). Keep capture running so stop can retain that waveform
    // for retry through the empty-result handler when policy allows. This does not
    // provide an automatic batch-transcription fallback.
    getLogger().warning(
      `Could not subscribe to audio chunks. Non-streaming sessions may transcribe the captured recording at stop; live-streaming sessions cannot receive its audio and rely on retry retention when policy allows: ${error}`,
    );
    discontinuity = true;
    return {
      ...common,
      unlisten: null,
      current: isCurrent(),
      subscriptionFailed: true,
    };
  }

  if (!isCurrent()) {
    unlisten();
    return {
      ...common,
      unlisten: null,
      current: false,
      subscriptionFailed: false,
    };
  }
  return {
    ...common,
    unlisten,
    current: true,
    subscriptionFailed: false,
  };
};

type NativeStartOwnerRef = { current: number | null };

/**
 * Native stops an abort issued that its own invocation could not apply.
 *
 * An abort releases the claim and issues `stop_recording` with no `await`
 * between them, but a start that is still inside its own `await start_recording`
 * has not opened the microphone yet, so that stop can land against a recorder
 * that does not exist and return immediately. The claim is then gone and the
 * stream is still about to come up, which leaves a live recorder with no owner:
 * nothing stops it, and the user records continuously from an input they did not
 * choose.
 *
 * The debt is keyed by the caller's ref so each recording tracks its own, and it
 * is discharged by the superseded start that reports in and stops the stream it
 * actually opened. Keyed rather than module-global so an unmounted recording
 * cannot leave an entry behind for the next one.
 */
const owedNativeStops = new WeakMap<NativeStartOwnerRef, Set<number>>();

/**
 * The native admission each start opened, keyed by the ref that claimed it.
 *
 * The admission carries the `(ownerId, generation)` pair native requires for
 * every later command, so a stop issued on behalf of a specific start can only
 * reach that start's stream. A stop for a superseded start therefore cannot cut
 * a newer recording even when it arrives late.
 */
const startHandles = new WeakMap<
  NativeStartOwnerRef,
  Map<number, NativeRecordingHandle>
>();

/** Record the admission a start opened, so its stop can address it. */
export const trackNativeStartHandle = (
  ownerRef: NativeStartOwnerRef,
  operationId: number,
  handle: NativeRecordingHandle,
): void => {
  const handles = startHandles.get(ownerRef) ?? new Map();
  handles.set(operationId, handle);
  startHandles.set(ownerRef, handles);
};

const takeNativeStartHandle = (
  ownerRef: NativeStartOwnerRef,
  operationId: number,
): NativeRecordingHandle | null => {
  const handles = startHandles.get(ownerRef);
  const handle = handles?.get(operationId) ?? null;
  handles?.delete(operationId);
  return handle;
};

const oweNativeStop = (ownerRef: NativeStartOwnerRef, operationId: number) => {
  const owed = owedNativeStops.get(ownerRef) ?? new Set<number>();
  owed.add(operationId);
  owedNativeStops.set(ownerRef, owed);
};

/**
 * Stops native capture for a start that opened the microphone and then found
 * itself superseded. A recording a newer one has taken over is left alone, so a
 * stale start cannot silence a live stream.
 *
 * It also discharges a stop an abort still owed this operation (see
 * `owedNativeStops`). Without that, the abort had already released the claim, so
 * the ref held nothing and this helper declined to stop the stream this very
 * start was in the middle of opening.
 */
export const stopOwnedNativeStart = async (
  ownerRef: NativeStartOwnerRef,
  operationId: number,
): Promise<void> => {
  const owner = ownerRef.current;
  const owed = owedNativeStops.get(ownerRef)?.delete(operationId) ?? false;
  // A newer recording owns the claim: it is responsible for the stream now, and
  // stopping here would cut off a live dictation this stale start knows nothing
  // about.
  if (owner !== null && owner !== operationId) return;
  if (owner === operationId) {
    ownerRef.current = null;
  } else if (!owed) {
    // The claim is already released and no abort is waiting on this start, so
    // whatever stopped this operation has run and a second stop would only
    // reach a recorder that a newer recording may already own.
    return;
  }
  const handle = takeNativeStartHandle(ownerRef, operationId);
  await (handle ? handle.discard() : discardNativeRecording()).catch(
    (error: unknown) => {
      getLogger().verbose(
        `discard_recording failed after stale start: ${error}`,
      );
    },
  );
};

/**
 * Releases the native-start claim and stops capture, unconditionally.
 *
 * This is the abort path, and it is deliberately the opposite of
 * `stopOwnedNativeStart`: an abort always stops the stream it was tearing down.
 *
 * The claim is taken and the stop is issued with no `await` between them, which
 * is the point. The abort used to release the claim, then await the pill's idle
 * phase, and only then decide whether a newer start had taken ownership. A
 * restart landing inside that window called `start_recording` while the old
 * stream was still live -- native reports an already-active recorder as success,
 * so the restart silently inherited the old capture instead of opening the
 * microphone it asked for -- and then the abort skipped its stop while the
 * superseded start's own `stopOwnedNativeStart` also declined, because the ref no
 * longer held its id. Nothing stopped the stream and the user recorded
 * continuously from the wrong input.
 *
 * With no await in between, nothing else can run between taking the claim and
 * releasing the stream, and a restart that begins afterwards calls
 * `start_recording` against a stopped recorder.
 *
 * A start still inside `start_recording` is the one case that stop cannot reach,
 * so the claim it held is recorded as owed: it stops the stream itself when it
 * finds out it was superseded.
 */
export const stopNativeRecordingForAbort = (
  ownerRef: NativeStartOwnerRef,
): Promise<void> => {
  const released = ownerRef.current;
  ownerRef.current = null;
  if (released !== null) {
    oweNativeStop(ownerRef, released);
  }
  // A start that is still opening is addressed through its own admission; one
  // that already handed ownership over is whatever the module holds live.
  const handle =
    released !== null ? takeNativeStartHandle(ownerRef, released) : null;
  return (handle ? handle.discard() : discardNativeRecording()).catch(
    (error: unknown) => {
      getLogger().verbose(`discard_recording failed during abort: ${error}`);
    },
  );
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
  ) =>
  (segment: string): void => {
    if (operationId === getCurrentOperationId()) {
      handleInterimSegment(segment);
    }
  };

export type RecordingResourceRefs = {
  audioChunkUnlistenRef: { current: UnlistenFn | null };
  sessionRef: { current: TranscriptionSession | null };
  strategyRef: { current: BaseStrategy | null };
};

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
}: RecordingResourceRefs): void => {
  audioChunkUnlistenRef.current?.();
  audioChunkUnlistenRef.current = null;
  sessionRef.current?.cleanup();
  const strategyCleanup = strategyRef.current?.cleanup();
  void strategyCleanup?.catch((error) => {
    getLogger().warning(`Strategy cleanup failed during unmount: ${error}`);
  });
  void discardNativeRecording();
};
