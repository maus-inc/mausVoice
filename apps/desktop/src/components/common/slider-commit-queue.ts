import {
  type LocalDataWriteRelease,
  beginLocalDataWrite,
  getLocalDataClearGeneration,
  isLocalDataClearRequested,
  subscribeToLocalDataClearRequested,
} from "../../utils/local-data-write-gate";

type QueuedSliderCommit = {
  value: number;
  interaction: number;
  clearGeneration: number;
  releaseWrite: LocalDataWriteRelease | null;
};

export type SliderCommitQueueCallbacks = {
  runCommit: (value: number) => void | Promise<void>;
  onRollback: (interaction: number) => void;
  onSettled: (pendingCount: number) => void;
};

export type SliderCommitQueue = {
  getPendingCount: () => number;
  submit: (value: number, interaction: number) => void;
};

/**
 * Serializes asynchronous slider commits per control and coalesces rapid queued
 * adjustments while an earlier commit is still running. A queued commit holds a
 * local-data write lease from the user's release gesture and drops immediately
 * if a local-data clear begins before it starts.
 */
export const createSliderCommitQueue = (
  callbacks: SliderCommitQueueCallbacks,
): SliderCommitQueue => {
  let running = false;
  let pendingCount = 0;
  let queued: QueuedSliderCommit | null = null;
  let unsubscribeClear: (() => void) | null = null;

  const detachClearSubscription = () => {
    unsubscribeClear?.();
    unsubscribeClear = null;
  };

  const cancelQueuedForClear = () => {
    if (!queued) return;
    const cancelled = queued;
    queued = null;
    detachClearSubscription();
    cancelled.releaseWrite?.();
    pendingCount = Math.max(0, pendingCount - 1);
    callbacks.onRollback(cancelled.interaction);
    callbacks.onSettled(pendingCount);
  };

  const execute = (
    value: number,
    interaction: number,
    heldWrite: LocalDataWriteRelease | null,
  ) => {
    const finishAttempt = () => {
      heldWrite?.();
      pendingCount = Math.max(0, pendingCount - 1);
      const next = queued;
      queued = null;
      detachClearSubscription();
      if (!next) {
        running = false;
        callbacks.onSettled(pendingCount);
        return;
      }
      if (
        isLocalDataClearRequested() ||
        next.clearGeneration !== getLocalDataClearGeneration()
      ) {
        next.releaseWrite?.();
        pendingCount = Math.max(0, pendingCount - 1);
        running = false;
        callbacks.onRollback(next.interaction);
        callbacks.onSettled(pendingCount);
        return;
      }
      execute(next.value, next.interaction, next.releaseWrite);
    };

    try {
      Promise.resolve(callbacks.runCommit(value))
        .catch(() => {
          callbacks.onRollback(interaction);
        })
        .finally(finishAttempt);
    } catch {
      callbacks.onRollback(interaction);
      finishAttempt();
    }
  };

  return {
    getPendingCount: () => pendingCount,
    submit(value: number, interaction: number) {
      if (!running) {
        running = true;
        pendingCount += 1;
        execute(value, interaction, null);
        return;
      }
      if (isLocalDataClearRequested()) {
        callbacks.onRollback(interaction);
        callbacks.onSettled(pendingCount);
        return;
      }
      const releaseWrite = beginLocalDataWrite();
      const clearGeneration = getLocalDataClearGeneration();
      if (queued) {
        queued.releaseWrite?.();
        queued = { value, interaction, clearGeneration, releaseWrite };
        return;
      }
      pendingCount += 1;
      queued = { value, interaction, clearGeneration, releaseWrite };
      unsubscribeClear =
        subscribeToLocalDataClearRequested(cancelQueuedForClear);
    },
  };
};
