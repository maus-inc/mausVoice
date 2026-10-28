import type { Transcription } from "@maus-inc/types";
import { getTranscriptionRepo } from "../repos";
import { produceAppState } from "../store";
import { showErrorSnackbar } from "../actions/app.actions";
import {
  type LocalDataWriteLease,
  beginLocalDataWrite,
  isLocalDataClearRequested,
  isMainLocalDataWindow,
  withLocalDataWriteSync,
} from "./local-data-write-gate";
import { getLocalStorage } from "./local-storage.utils";

export const PENDING_DELETE_STORAGE_KEY =
  "mausvoice.pending-transcription-deletes";

type PendingDelete = {
  snapshot: Transcription;
  timer: ReturnType<typeof setTimeout>;
};

const pendingById = new Map<string, PendingDelete>();
/** Timer + in-flight IPC. Written to localStorage so quit cannot drop deletes. */
const queuedIds = new Set<string>();
let hasResumed = false;

const writeQueuedIds = (lease?: LocalDataWriteLease): void => {
  const storage = getLocalStorage();
  if (!storage) return;

  withLocalDataWriteSync(() => {
    try {
      if (queuedIds.size === 0) {
        storage.removeItem(PENDING_DELETE_STORAGE_KEY);
      } else {
        storage.setItem(
          PENDING_DELETE_STORAGE_KEY,
          JSON.stringify([...queuedIds]),
        );
      }
    } catch {
      // Quota or private mode. Timers and IPC still use in-memory queuedIds.
    }
  }, lease);
};

const restoreInStore = (
  snapshot: Transcription,
  lease?: LocalDataWriteLease,
): void => {
  produceAppState((draft) => {
    draft.transcriptionById[snapshot.id] = snapshot;
    if (!draft.transcriptions.transcriptionIds.includes(snapshot.id)) {
      draft.transcriptions.transcriptionIds.unshift(snapshot.id);
    }
  }, lease);
};

const removeFromStore = (id: string, lease?: LocalDataWriteLease): void => {
  produceAppState((draft) => {
    delete draft.transcriptionById[id];
    draft.transcriptions.transcriptionIds =
      draft.transcriptions.transcriptionIds.filter(
        (transcriptionId) => transcriptionId !== id,
      );
  }, lease);
};

/**
 * Start a delete under an existing operation lease when supplied. In
 * particular, pagehide flushes share one lease across the database delete,
 * local-storage queue update, and in-memory state update so a clear cannot
 * slip between those steps.
 */
const invokeDelete = (
  id: string,
  snapshot?: Transcription,
  existingLease?: LocalDataWriteLease,
): Promise<void> => {
  const ownedWrite = existingLease ? undefined : beginLocalDataWrite();
  const lease = existingLease ?? ownedWrite?.lease;
  if (!lease) {
    if (snapshot && !isLocalDataClearRequested()) restoreInStore(snapshot);
    return Promise.resolve();
  }

  return (async () => {
    try {
      await getTranscriptionRepo().deleteTranscription(id, lease);
      queuedIds.delete(id);
      writeQueuedIds(lease);
      removeFromStore(id, lease);
    } catch (error) {
      if (snapshot) {
        queuedIds.delete(id);
        writeQueuedIds(lease);
        restoreInStore(snapshot, lease);
        showErrorSnackbar(error);
      }
      // Resume path has no snapshot: leave the id queued so the next launch retries.
    } finally {
      ownedWrite?.();
    }
  })();
};

const commitDelete = (id: string): void => {
  const pending = pendingById.get(id);
  pendingById.delete(id);
  if (!pending) return;
  void invokeDelete(id, pending.snapshot);
};

export const scheduleTranscriptionDelete = (
  snapshot: Transcription,
  delayMs: number,
): void => {
  withLocalDataWriteSync((lease) => {
    const existing = pendingById.get(snapshot.id);
    if (existing) clearTimeout(existing.timer);

    queuedIds.add(snapshot.id);
    writeQueuedIds(lease);
    removeFromStore(snapshot.id, lease);
    const timer = setTimeout(() => commitDelete(snapshot.id), delayMs);
    pendingById.set(snapshot.id, { snapshot, timer });
  });
};

export const undoTranscriptionDelete = (id: string): boolean =>
  withLocalDataWriteSync((lease) => {
    const pending = pendingById.get(id);
    if (!pending) return false;

    clearTimeout(pending.timer);
    pendingById.delete(id);
    queuedIds.delete(id);
    writeQueuedIds(lease);
    restoreInStore(pending.snapshot, lease);
    return true;
  }) ?? false;

export const flushPendingTranscriptionDeletes = (): void => {
  if (!hasResumed || !isMainLocalDataWindow()) return;
  const releaseWrite = beginLocalDataWrite();
  if (!releaseWrite) return;

  const deletions: Promise<void>[] = [];
  try {
    writeQueuedIds(releaseWrite.lease);
    for (const [id, pending] of pendingById) {
      clearTimeout(pending.timer);
      pendingById.delete(id);
      deletions.push(invokeDelete(id, pending.snapshot, releaseWrite.lease));
    }
  } finally {
    // Keep the owner lease alive until every asynchronous delete and its
    // follow-up storage/store updates have settled. Releasing it after merely
    // starting the IPC would let clear race those follow-up writes.
    void Promise.allSettled(deletions).then(() => releaseWrite());
  }
};

/** Next launch: finish deletes whose IPC never completed on quit. */
export const resumePendingTranscriptionDeletes = (): void => {
  if (!isMainLocalDataWindow()) return;
  hasResumed = true;
  const storage = getLocalStorage();
  if (!storage) return;

  let stored: string[] = [];
  try {
    const raw = storage.getItem(PENDING_DELETE_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    stored = Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return;
  }

  for (const id of stored) {
    queuedIds.add(id);
    if (!pendingById.has(id)) void invokeDelete(id);
  }
  writeQueuedIds();
};

/** Cancels pending delete timers after the native database has been cleared. */
export const resetPendingTranscriptionDeletes = (): void => {
  for (const pending of pendingById.values()) {
    clearTimeout(pending.timer);
  }
  pendingById.clear();
  queuedIds.clear();
};
