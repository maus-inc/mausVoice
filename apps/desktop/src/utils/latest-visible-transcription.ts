import type { Transcription } from "@maus-inc/types";
import { getTranscriptionRepo } from "../repos";
import {
  getTranscriptionDeletionRevision,
  isTranscriptionPendingDelete,
} from "./pending-transcription-delete";

/** Find the newest non-deleted row, even while delayed deletes are in flight. */
export const latestVisibleTranscription = async (): Promise<
  Transcription | undefined
> => {
  const limit = 20;
  while (true) {
    const revision = getTranscriptionDeletionRevision();
    let offset = 0;
    while (true) {
      const rows = await getTranscriptionRepo().listTranscriptions({
        limit,
        offset,
      });
      if (revision !== getTranscriptionDeletionRevision()) break;
      const visible = rows.find((row) => !isTranscriptionPendingDelete(row.id));
      if (visible || rows.length < limit) return visible;
      offset += rows.length;
    }
  }
};
