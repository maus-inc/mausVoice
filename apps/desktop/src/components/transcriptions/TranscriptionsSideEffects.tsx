import { useEffect } from "react";
import { resumeAllInterruptedPostProcessEditRetries } from "../../actions/transcriptions.actions";
import { useOnExit } from "../../hooks/helper.hooks";
import { INITIAL_TRANSCRIPTIONS_STATE } from "../../state/transcriptions.state";
import { produceAppState } from "../../store";
import { refreshVisibleTranscriptions } from "../../utils/visible-transcriptions";

export const TranscriptionsSideEffects = () => {
  useEffect(() => {
    let current = true;
    void refreshVisibleTranscriptions(() => current).catch(console.error);
    // Same handoff as the History page: a claim written before a restart has no
    // process behind it, so the first surface that loads History delivers it.
    // The scan walks every History page, so a claim on an older row is
    // delivered too, not just the rows this list loaded.
    resumeAllInterruptedPostProcessEditRetries();
    return () => {
      current = false;
    };
  }, []);

  useOnExit(() => {
    produceAppState((draft) => {
      Object.assign(draft.transcriptions, INITIAL_TRANSCRIPTIONS_STATE);
    });
  });

  return null;
};
