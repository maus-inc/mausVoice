import { resumeAllInterruptedPostProcessEditRetries } from "../../actions/transcriptions.actions";
import { useAsyncEffect } from "../../hooks/async.hooks";
import { useOnExit } from "../../hooks/helper.hooks";
import { getTranscriptionRepo } from "../../repos";
import { INITIAL_TRANSCRIPTIONS_STATE } from "../../state/transcriptions.state";
import { produceAppState } from "../../store";
import { registerTranscriptions } from "../../utils/app.utils";

export const TranscriptionsSideEffects = () => {
  useAsyncEffect(async () => {
    const transcriptions = await getTranscriptionRepo().listTranscriptions();
    produceAppState((draft) => {
      registerTranscriptions(draft, transcriptions);
      draft.transcriptions.transcriptionIds = transcriptions.map((t) => t.id);
    });
    // A row a previous run claimed for automatic recovery and never reported
    // back on is picked up here, because the claim outlives the process that
    // wrote it. The scan walks every History page, so a claim on an older row
    // is delivered too, not just the rows this list loaded.
    resumeAllInterruptedPostProcessEditRetries();
  }, []);

  useOnExit(() => {
    produceAppState((draft) => {
      Object.assign(draft.transcriptions, INITIAL_TRANSCRIPTIONS_STATE);
    });
  });

  return null;
};
