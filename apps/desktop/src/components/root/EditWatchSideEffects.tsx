import { useEffect, useRef } from "react";
import {
  EDIT_POLL_MS,
  acceptAutoLearnProposal,
  endEditWatch,
  pollEditWatch,
  rejectAutoLearnProposal,
} from "../../actions/edit-watch.actions";
import { dismissToast, runToast } from "../../actions/toast.actions";
import { useIntervalAsync } from "../../hooks/helper.hooks";
import { useToastAction } from "../../hooks/toast.hooks";
import { useAppStore } from "../../store";
import { getMyUserPreferences } from "../../utils/user.utils";

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
    if (enabled) {
      return;
    }
    // The native proposal toast outlives the store. Turning the setting off
    // cleared the proposal the Accept and Ignore buttons acted on, but left the
    // toast on screen with both buttons live: Add then did nothing at all, and
    // inside the click grace window it could add a term from an earlier prompt.
    // Dismissing it with the watch leaves nothing actionable to click.
    //
    // The dismiss is unconditional rather than gated on a proposal being live:
    // the toast is only ever shown for a proposal, and a proposal that is not in
    // the store any more is exactly the case where a leftover toast would be
    // stranded with no way to tell it apart.
    runToast(dismissToast());
    endEditWatch();
  }, [enabled]);

  // The watch is transient polling state (90s window) owned by this
  // component. Unmounting without clearing it left a stale snapshot that
  // could still propose a term after the app left the dictation screen or
  // shut the side-effect tree down.
  useEffect(() => () => endEditWatch(), []);

  useIntervalAsync(EDIT_POLL_MS, async () => {
    await pollEditWatch();
  }, [enabled]);

  // Read through a ref because the toast listener is registered once and would
  // otherwise keep answering with the `enabled` value from its first render.
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useToastAction(async (payload) => {
    if (
      payload.action !== "auto_learn_accept" &&
      payload.action !== "auto_learn_reject"
    ) {
      return;
    }
    // A click that was already on its way when the setting was turned off would
    // otherwise still reach the accept path, where the grace window can add a
    // term from the prompt the user has just dismissed. The feature is off, so
    // there is nothing to add on its behalf.
    if (!enabledRef.current) {
      return;
    }
    if (payload.action === "auto_learn_accept") {
      await acceptAutoLearnProposal();
    } else {
      rejectAutoLearnProposal();
    }
  });

  return null;
};
