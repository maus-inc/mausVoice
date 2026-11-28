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
/**
 * Bound on copied PCM payloads, including the in-flight WAV write.
 * A cap of four is four jobs total, not four waiters behind one writer.
 */
export const MAX_HISTORY_PERSIST_QUEUE = 4;

export const isHistoryPersistQueueFull = (): boolean =>
  queueDepth >= MAX_HISTORY_PERSIST_QUEUE;

export type PersistBeforeDeliveryInput = {
  /** The caller supplied a write hook, so the row can be started early. */
  hasPersistenceHook: boolean;
  reviewBeforeInsert: boolean;
  remoteDeviceId: string | null;
  insertionMethod: string;
  handsFreeDelayMs: number;
  activeSimulatedTypingCount: number;
  queueFull: boolean;
};

/**
 * Decides whether the History row can be written while delivery runs instead
 * of after it settles.
 *
 * Review-before-insert can still edit the text and a remote target records its
 * delivery outcome on the row, so both keep the serial path. Simulated typing
 * can take the length of the transcript and a hands-free delay holds delivery
 * open for seconds, so those also stay serial: the stop path re-reads Incognito
 * after delivery settles, and a mode change during the wait must not race a
 * write that already started.
 */
export const shouldPersistBeforeDelivery = ({
  hasPersistenceHook,
  reviewBeforeInsert,
  remoteDeviceId,
  insertionMethod,
  handsFreeDelayMs,
  activeSimulatedTypingCount,
  queueFull,
}: PersistBeforeDeliveryInput): boolean =>
  hasPersistenceHook &&
  !reviewBeforeInsert &&
  remoteDeviceId === null &&
  insertionMethod !== "type" &&
  handsFreeDelayMs <= 0 &&
  activeSimulatedTypingCount === 0 &&
  !queueFull;

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
    // Reject, do not throw: persistTranscriptNow is chained with .catch in the
    // strategy. A sync throw skips delivery for a take that only failed to save.
    return Promise.reject(error);
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
