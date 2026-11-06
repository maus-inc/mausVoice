import type { Transcription } from "@maus-inc/types";
import { getRec } from "@maus-inc/utilities";
import { getTranscriptionRepo } from "../repos";
import {
  getSessionOnlyTranscriptionIds,
  unmarkTranscriptionSessionOnly,
} from "./session-only-transcriptions";
import { getAppState, produceAppState } from "../store";
import {
  getLocalDataClearGeneration,
  isLocalDataClearRequested,
} from "./local-data-write-gate";
import { registerTranscriptions } from "./app.utils";
import {
  getTranscriptionDeletionRevision,
  isTranscriptionPendingDelete,
} from "./pending-transcription-delete";

const getSessionOnlyInsertIndex = (
  merged: readonly string[],
  createdAt: string,
  byId: Record<string, Transcription>,
): number => {
  const olderIndex = merged.findIndex((existing) => {
    const row = getRec(byId, existing);
    return row !== undefined && row.createdAt < createdAt;
  });
  return olderIndex === -1 ? merged.length : olderIndex;
};

/**
 * The repository list never contains session-only rows, so a plain
 * replacement would drop the incognito import memory records from History
 * mid-session. Keep the ones the state still holds, each at its created-at
 * position among the persisted ids.
 */
const withSessionOnlyRows = (
  persistedIds: readonly string[],
  byId: Record<string, Transcription>,
): string[] => {
  const merged = [...persistedIds];
  for (const id of getSessionOnlyTranscriptionIds()) {
    const record = getRec(byId, id);
    if (!record) {
      // Prune ids whose record left the state, except while a delete is
      // still undoable: the undo restores the record and the row must
      // survive later refreshes until the pending window closes.
      if (!isTranscriptionPendingDelete(id)) {
        unmarkTranscriptionSessionOnly(id);
      }
      continue;
    }
    if (merged.includes(id)) {
      continue;
    }
    merged.splice(
      getSessionOnlyInsertIndex(merged, record.createdAt, byId),
      0,
      id,
    );
  }
  return merged;
};

/** Apply a list only if no deletion changed while it was being loaded. */
export const refreshVisibleTranscriptions = async (
  isCurrent: () => boolean,
): Promise<void> => {
  const generation = getLocalDataClearGeneration();
  while (isCurrent() && !isLocalDataClearRequested()) {
    const revision = getTranscriptionDeletionRevision();
    const before = getAppState().transcriptionById;
    const rows = await getTranscriptionRepo().listTranscriptions();
    if (
      !isCurrent() ||
      isLocalDataClearRequested() ||
      getLocalDataClearGeneration() !== generation
    )
      return;
    if (revision !== getTranscriptionDeletionRevision()) continue;
    const visible = rows.filter((row) => !isTranscriptionPendingDelete(row.id));
    // A retry or edit can finish while the list request is in flight. Do not
    // replace its newer row with the list request’s earlier snapshot.
    const current = getAppState().transcriptionById;
    const unchanged = visible.filter(
      (row) => getRec(before, row.id) === getRec(current, row.id),
    );
    produceAppState((draft) => {
      registerTranscriptions(draft, unchanged);
      draft.transcriptions.transcriptionIds = withSessionOnlyRows(
        visible.map((row) => row.id),
        current,
      );
    });
    return;
  }
};
