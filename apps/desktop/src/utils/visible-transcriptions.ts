import { getTranscriptionRepo } from "../repos";
import { produceAppState } from "../store";
import { registerTranscriptions } from "./app.utils";
import {
  getTranscriptionDeletionRevision,
  isTranscriptionPendingDelete,
} from "./pending-transcription-delete";

/** Apply a list only if no deletion changed while it was being loaded. */
export const refreshVisibleTranscriptions = async (
  isCurrent: () => boolean,
): Promise<void> => {
  while (isCurrent()) {
    const revision = getTranscriptionDeletionRevision();
    const rows = await getTranscriptionRepo().listTranscriptions();
    if (!isCurrent()) return;
    if (revision !== getTranscriptionDeletionRevision()) continue;
    const visible = rows.filter((row) => !isTranscriptionPendingDelete(row.id));
    produceAppState((draft) => {
      registerTranscriptions(draft, visible);
      draft.transcriptions.transcriptionIds = visible.map((row) => row.id);
    });
    return;
  }
};
