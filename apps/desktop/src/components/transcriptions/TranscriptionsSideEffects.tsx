import { useEffect } from "react";
import { useOnExit } from "../../hooks/helper.hooks";
import { INITIAL_TRANSCRIPTIONS_STATE } from "../../state/transcriptions.state";
import { produceAppState } from "../../store";
import { refreshVisibleTranscriptions } from "../../utils/visible-transcriptions";

export const TranscriptionsSideEffects = () => {
  useEffect(() => {
    let current = true;
    void refreshVisibleTranscriptions(() => current).catch(console.error);
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
