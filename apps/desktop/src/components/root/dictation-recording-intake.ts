import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listenToAudioChunks } from "../../sessions/audio-chunk-events";
import type { BaseStrategy } from "../../strategies/base.strategy";
import type { TranscriptionSession } from "../../types/transcription-session.types";
import {
  createAudioChunkStartupBuffer,
  type AudioChunkStartupBuffer,
} from "../../utils/audio-chunk-startup-buffer";
import { ensureFloat32Array } from "../../utils/audio.utils";
import { getLogger } from "../../utils/log.utils";

export type SessionAudioIntake = {
  buffer: AudioChunkStartupBuffer;
  unlisten: UnlistenFn | null;
  current: boolean;
  /** True only when registering the Tauri audio_chunk listener rejected. */
  subscriptionFailed: boolean;
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
  } catch (error) {
    getLogger().error(`[Dictation] Failed to forward audio chunk: ${error}`);
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
): Promise<SessionAudioIntake> => {
  const buffer = createAudioChunkStartupBuffer(onOverflow);
  if (typeof session.writeAudioChunk !== "function") {
    // Nothing to attach, so report the real staleness result. Returning a
    // constant here would let a start that already lost the race overwrite the
    // shared listener ref and detach the recording that replaced it.
    return {
      buffer,
      unlisten: null,
      current: isCurrent(),
      subscriptionFailed: false,
    };
  }

  let receivedChunkCount = 0;
  let receivedSampleCount = 0;
  let lastForwardedOffset: number | null = null;
  let hasLoggedTrim = false;

  // A subscription that cannot be established is not a reason to fail the
  // recording; letting this reject reached the outer start-failure handler and
  // showed "Recording failed" for a dictation that was otherwise fine. The
  // caller tolerates a null `unlisten`: local/after-stop sessions can use the
  // captured recording directly, while live sessions route an empty result to
  // failed-audio recovery at stop.
  let unlisten: UnlistenFn | null;
  try {
    unlisten = await listenToAudioChunks((samples, offset) => {
      if (!isCurrent()) return;
      if (offset === null) {
        getLogger().warning(
          "[Dictation] Dropped audio_chunk with no sample offset; the recording stream is no longer contiguous",
        );
        return;
      }
      const chunk = ensureFloat32Array(samples);
      if (chunk.length === 0) return;
      receivedChunkCount += 1;
      receivedSampleCount += chunk.length;
      if (receivedChunkCount <= 3 || receivedChunkCount % 10 === 0) {
        getLogger().verbose(
          `[Dictation] Received chunk #${receivedChunkCount} (total ${receivedSampleCount} samples)`,
        );
      }
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
        forwardAudioChunk(session, chunk, offset);
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
    return {
      buffer,
      unlisten: null,
      current: isCurrent(),
      subscriptionFailed: true,
    };
  }

  if (!isCurrent()) {
    unlisten();
    return {
      buffer,
      unlisten: null,
      current: false,
      subscriptionFailed: false,
    };
  }
  return {
    buffer,
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
  await invoke("stop_recording").catch((error) => {
    getLogger().verbose(`stop_recording failed after stale start: ${error}`);
  });
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
  return invoke("stop_recording")
    .then(() => undefined)
    .catch((error) => {
      getLogger().verbose(`stop_recording failed during abort: ${error}`);
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
  invoke("stop_recording").catch(() => undefined);
};
