import type { Transcription } from "@maus-inc/types";
import { getTranscriptionRepo } from "../repos";
import { produceAppState } from "../store";
import { showErrorSnackbar } from "../actions/app.actions";

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
let hydrated = false;
let deletionRevision = 0;

// Read the persisted queue before a list load can expose a pending deletion,
// even if the startup resume effect has not run yet.
const hydrateQueuedIds = (): void => {
  if (hydrated || typeof localStorage === "undefined") return;
  hydrated = true;
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(PENDING_DELETE_STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(parsed)) return;
    for (const id of parsed) {
      if (typeof id === "string" && !queuedIds.has(id)) {
        queuedIds.add(id);
        deletionRevision += 1;
      }
    }
  } catch {
    // An unreadable queue cannot provide any IDs to hide.
  }
};

export const getTranscriptionDeletionRevision = (): number => {
  hydrateQueuedIds();
  return deletionRevision;
};

export const isTranscriptionPendingDelete = (id: string): boolean => {
  hydrateQueuedIds();
  return queuedIds.has(id);
};

const writeQueuedIds = (): void => {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    if (queuedIds.size === 0) {
      localStorage.removeItem(PENDING_DELETE_STORAGE_KEY);
      return;
    }
    localStorage.setItem(
      PENDING_DELETE_STORAGE_KEY,
      JSON.stringify([...queuedIds]),
    );
  } catch {
    // Quota or private mode. Timers and IPC still use in-memory queuedIds.
  }
};

const restoreInStore = (snapshot: Transcription): void => {
  produceAppState((draft) => {
    draft.transcriptionById[snapshot.id] = snapshot;
    if (!draft.transcriptions.transcriptionIds.includes(snapshot.id)) {
      // The repository lists newest first. Undo and failed deletes must not
      // move an older recording to the top of History.
      const created = Date.parse(snapshot.createdAt);
      const index = Number.isFinite(created)
        ? draft.transcriptions.transcriptionIds.findIndex((id) => {
            const other = draft.transcriptionById[id];
            return other && Date.parse(other.createdAt) < created;
          })
        : 0;
      const insertAt =
        index < 0 ? draft.transcriptions.transcriptionIds.length : index;
      draft.transcriptions.transcriptionIds.splice(insertAt, 0, snapshot.id);
    }
  });
};

const removeFromStore = (id: string): void => {
  produceAppState((draft) => {
    delete draft.transcriptionById[id];
    draft.transcriptions.transcriptionIds =
      draft.transcriptions.transcriptionIds.filter(
        (transcriptionId) => transcriptionId !== id,
      );
  });
};

const invokeDelete = (id: string, snapshot?: Transcription): void => {
  void getTranscriptionRepo()
    .deleteTranscription(id)
    .then(() => {
      queuedIds.delete(id);
      deletionRevision += 1;
      writeQueuedIds();
      removeFromStore(id);
    })
    .catch((error) => {
      if (snapshot) {
        queuedIds.delete(id);
        deletionRevision += 1;
        writeQueuedIds();
        restoreInStore(snapshot);
        showErrorSnackbar(error);
      }
      // Resume path has no snapshot: leave `id` in queuedIds so the next
      // launch retries. Do not toast — a missing row plus a launch-time
      // snackbar would spam every start.
    });
};

const commitDelete = (id: string): void => {
  const pending = pendingById.get(id);
  pendingById.delete(id);
  if (!pending) {
    return;
  }
  invokeDelete(id, pending.snapshot);
};

export const scheduleTranscriptionDelete = (
  snapshot: Transcription,
  delayMs: number,
): void => {
  const existing = pendingById.get(snapshot.id);
  if (existing) {
    clearTimeout(existing.timer);
  }
  hydrateQueuedIds();
  queuedIds.add(snapshot.id);
  deletionRevision += 1;
  writeQueuedIds();
  removeFromStore(snapshot.id);
  const timer = setTimeout(() => commitDelete(snapshot.id), delayMs);
  pendingById.set(snapshot.id, { snapshot, timer });
};

export const undoTranscriptionDelete = (id: string): boolean => {
  const pending = pendingById.get(id);
  if (!pending) {
    return false;
  }
  clearTimeout(pending.timer);
  pendingById.delete(id);
  queuedIds.delete(id);
  deletionRevision += 1;
  writeQueuedIds();
  restoreInStore(pending.snapshot);
  return true;
};

export const flushPendingTranscriptionDeletes = (): void => {
  if (!hasResumed) {
    return;
  }
  writeQueuedIds();
  for (const [id, pending] of pendingById) {
    clearTimeout(pending.timer);
    pendingById.delete(id);
    invokeDelete(id);
  }
};

/** Next launch: finish deletes whose IPC never completed on quit. */
export const resumePendingTranscriptionDeletes = (): void => {
  hasResumed = true;
  if (typeof localStorage === "undefined") {
    return;
  }
  let stored: string[] = [];
  try {
    const raw = localStorage.getItem(PENDING_DELETE_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    stored = Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return;
  }
  for (const id of stored) {
    if (!queuedIds.has(id)) {
      queuedIds.add(id);
      deletionRevision += 1;
    }
    if (pendingById.has(id)) {
      continue;
    }
    invokeDelete(id);
  }
  writeQueuedIds();
};
