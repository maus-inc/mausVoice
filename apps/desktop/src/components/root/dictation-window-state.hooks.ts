import { useAppStore } from "../../store";
import { getAdditionalLanguageEntries } from "../../utils/keyboard.utils";
import { getIsDictationUnlocked } from "../../utils/user.utils";

/** Subscribe the dictation owner to window interaction and language state. */
export function useDictationWindowState() {
  const isActiveSession = useAppStore(
    (state) => state.activeRecordingMode !== null,
  );
  const additionalLanguageEntries = useAppStore(getAdditionalLanguageEntries);
  const hasPendingReview = useAppStore(
    (state) => state.pendingPillReview !== null,
  );
  const isDictationUnlocked = useAppStore(getIsDictationUnlocked);
  return {
    isActiveSession,
    additionalLanguageEntries,
    hasPendingReview,
    isDictationUnlocked,
  };
}
