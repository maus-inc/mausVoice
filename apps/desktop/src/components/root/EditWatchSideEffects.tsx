import { useEffect } from "react";
import {
  acceptAutoLearnProposal,
  clearAutoLearnProposal,
  endEditWatch,
  pollEditWatch,
  rejectAutoLearnProposal,
} from "../../actions/edit-watch.actions";
import { useIntervalAsync } from "../../hooks/helper.hooks";
import { useToastAction } from "../../hooks/toast.hooks";
import { useAppStore } from "../../store";
import { getMyUserPreferences } from "../../utils/user.utils";

const POLL_INTERVAL_MS = 1500;

/**
 * Drives the background correction watcher: polls the focused text field
 * while a dictation snapshot is active and routes the pill's accept/reject
 * actions back to the auto-learn proposal.
 */
export const EditWatchSideEffects = () => {
  const enabled = useAppStore(
    (state) => getMyUserPreferences(state)?.autoLearnFromEditsEnabled ?? false,
  );

  useEffect(() => {
    if (!enabled) {
      endEditWatch();
      clearAutoLearnProposal();
    }
  }, [enabled]);

  useIntervalAsync(POLL_INTERVAL_MS, async () => {
    await pollEditWatch();
  }, [enabled]);

  useToastAction(async (payload) => {
    if (payload.action === "auto_learn_accept") {
      await acceptAutoLearnProposal();
    } else if (payload.action === "auto_learn_reject") {
      rejectAutoLearnProposal();
    }
  });

  return null;
};
