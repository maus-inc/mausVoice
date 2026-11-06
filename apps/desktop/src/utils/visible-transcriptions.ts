import { getRec } from "@maus-inc/utilities";
import { getTranscriptionRepo } from "../repos";
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
      draft.transcriptions.transcriptionIds = visible.map((row) => row.id);
    });
    return;
  }
};
