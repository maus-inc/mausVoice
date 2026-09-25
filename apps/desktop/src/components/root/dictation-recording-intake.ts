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
    return { buffer, unlisten: null, current: isCurrent() };
  }

  let receivedChunkCount = 0;
  let receivedSampleCount = 0;
  let lastForwardedOffset: number | null = null;
  let hasLoggedTrim = false;

  const unlisten = await listenToAudioChunks((samples, offset) => {
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

  if (!isCurrent()) {
    unlisten();
    return { buffer, unlisten: null, current: false };
  }
  return { buffer, unlisten, current: true };
};

/**
 * Stops native capture only for the start that still owns it. A recording that
 * already handed ownership back, or one a newer recording has taken over, is
 * left alone so a stale start cannot silence a live stream.
 */
export const stopOwnedNativeStart = async (
  ownerRef: { current: number | null },
  operationId: number,
): Promise<void> => {
  if (ownerRef.current !== operationId) return;
  ownerRef.current = null;
  await invoke("stop_recording").catch((error) => {
    getLogger().verbose(`stop_recording failed after stale start: ${error}`);
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
