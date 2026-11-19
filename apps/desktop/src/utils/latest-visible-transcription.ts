import type { Transcription } from "@maus-inc/types";
import { getTranscriptionRepo } from "../repos";
import {
  getTranscriptionDeletionRevision,
  isTranscriptionPendingDelete,
} from "./pending-transcription-delete";
import {
  transcriptionCreationRevision,
  waitForTranscriptionCreations,
} from "./transcription-creation-tracker";

/** Find the newest non-deleted row, even while delayed deletes are in flight. */
export const latestVisibleTranscription = async (): Promise<
  Transcription | undefined
> => {
  const limit = 20;
  while (true) {
    await waitForTranscriptionCreations();
    const creationRevision = transcriptionCreationRevision();
    const revision = getTranscriptionDeletionRevision();
    let offset = 0;
    while (true) {
      const rows = await getTranscriptionRepo().listTranscriptions({
        limit,
        offset,
      });
      await waitForTranscriptionCreations();
      if (
        revision !== getTranscriptionDeletionRevision() ||
        creationRevision !== transcriptionCreationRevision()
      )
        break;
      const visible = rows.find((row) => !isTranscriptionPendingDelete(row.id));
      if (visible || rows.length < limit) return visible;
      offset += rows.length;
    }
  }
};
