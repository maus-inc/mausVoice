import type { StopRecordingResponse } from "../types/transcription-session.types";
import { getLogger } from "./log.utils";
import { logOnRejection } from "./promise.utils";

/**
 * History persistence (WAV over Tauri IPC + SQLite) is slow and must not hold
 * the dictation stop path. Overlapping dictations still must not interleave
 * those writes: `store_transcription_audio` is a blocking IPC of the full PCM
 * buffer, and a second take starting while the first WAV is in flight can
 * starve the recorder. Jobs therefore start only after the previous job
 * settles, on a copied sample buffer so a later recording cannot alias it.
 */

let persistTail: Promise<void> = Promise.resolve();
let queueDepth = 0;
/** Bound copied PCM payloads waiting behind a slow WAV write. */
export const MAX_HISTORY_PERSIST_QUEUE = 4;

export const snapshotStopRecordingAudio = (
  audio: StopRecordingResponse,
): StopRecordingResponse => {
  const samples = audio.samples;
  if (samples instanceof Float32Array) {
    return { ...audio, samples: samples.slice() };
  }
  if (Array.isArray(samples)) {
    return { ...audio, samples: samples.slice() };
  }
  return { ...audio, samples: [] };
};

export type EnqueueHistoryPersistOptions = {
  /**
   * The caller `await`s the job and handles failure itself. Skip
   * `logOnRejection` or a rejected store is logged twice, once here and once
   * at the awaiter.
   */
  awaited?: boolean;
};

export const enqueueHistoryPersist = <T>(
  work: () => Promise<T>,
  context: string,
  options?: EnqueueHistoryPersistOptions,
): Promise<T> => {
  if (queueDepth >= MAX_HISTORY_PERSIST_QUEUE) {
    const error = new Error(
      `History persist queue full (${queueDepth}): ${context}`,
    );
    getLogger().warning(error.message);
    const rejected = Promise.reject(error);
    if (!options?.awaited) {
      logOnRejection(rejected, context);
    }
    return rejected;
  }
  queueDepth += 1;
  if (queueDepth > 1) {
    getLogger().verbose(
      `History persist queue depth ${queueDepth} (${context})`,
    );
  }
  const run = persistTail.then(async () => {
    try {
      return await work();
    } finally {
      queueDepth = Math.max(0, queueDepth - 1);
    }
  });
  persistTail = run.then(
    () => undefined,
    () => undefined,
  );
  if (!options?.awaited) {
    logOnRejection(run, context);
  }
  return run;
};

/** Test seam: wait until every enqueued persist has settled. */
export const flushHistoryPersist = (): Promise<void> => persistTail;

/**
 * Test seam: drop a hanging tail so later cases are not serialized behind it.
 * Does not cancel work already started on the previous tail.
 */
export const resetHistoryPersistQueue = (): void => {
  persistTail = Promise.resolve();
  queueDepth = 0;
};
