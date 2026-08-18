import type { Transcription } from "@maus-inc/types";
import { getTranscriptionRepo } from "../repos";
import { produceAppState } from "../store";
import { showErrorSnackbar } from "../actions/app.actions";

type PendingDelete = {
  snapshot: Transcription;
  timer: ReturnType<typeof setTimeout>;
};

const pendingById = new Map<string, PendingDelete>();

const restoreInStore = (snapshot: Transcription): void => {
  produceAppState((draft) => {
    draft.transcriptionById[snapshot.id] = snapshot;
    if (!draft.transcriptions.transcriptionIds.includes(snapshot.id)) {
      draft.transcriptions.transcriptionIds.unshift(snapshot.id);
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

const commitDelete = (id: string): void => {
  const pending = pendingById.get(id);
  pendingById.delete(id);
  if (!pending) {
    return;
  }
  void getTranscriptionRepo()
    .deleteTranscription(id)
    .catch((error) => {
      restoreInStore(pending.snapshot);
      showErrorSnackbar(error);
    });
};

export const scheduleTranscriptionDelete = (
  snapshot: Transcription,
  delayMs: number,
): void => {
  const existing = pendingById.get(snapshot.id);
  if (existing) {
    clearTimeout(existing.timer);
  }
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
  restoreInStore(pending.snapshot);
  return true;
};

export const flushPendingTranscriptionDeletes = (): void => {
  for (const id of [...pendingById.keys()]) {
    const pending = pendingById.get(id);
    if (pending) {
      clearTimeout(pending.timer);
    }
    commitDelete(id);
  }
};
