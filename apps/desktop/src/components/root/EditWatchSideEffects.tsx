import { useEffect, useRef } from "react";
import {
  EDIT_POLL_MS,
  acceptAutoLearnProposal,
  endEditWatch,
  getVisibleProposalId,
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
  const proposal = useAppStore((state) => state.autoLearn.proposal);
  // Read through a ref so the effect below keeps depending on `enabled` alone. Adding
  // `proposal` to its deps would re-run `endEditWatch` every time a proposal is cleared.
  const proposalRef = useRef(proposal);
  useEffect(() => {
    proposalRef.current = proposal;
  }, [proposal]);

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
    // Gated on a proposal actually being live, because this toast channel is not
    // private to auto-learn. `dismissToast()` takes no argument and enqueues a bare
    // `dismiss_toast`, and `runToast`/`showToast` are shared by `pill-review.actions`,
    // `transcriptions.actions`, `DictationSideEffects` and `composer.utils` -- so an
    // unconditional dismiss clears whichever single toast happens to be on screen.
    //
    // The clearest consequence was at startup: this effect runs on mount when the setting is
    // off, which meant launching the app with auto-learn disabled destroyed whatever toast was
    // already up, including an update-available notice. Turning the setting off mid-session had
    // the same effect on an unrelated progress or pill-review toast.
    //
    // It is still read before `endEditWatch()` on the next line, so the proposal this is here to
    // dismiss is the one that was live a moment ago -- which is the case the original comment
    // wanted, and the case the existing "disabled with a visible proposal" test covers.
    //
    // One case this misses, on purpose: the proposal can expire on its TTL while its toast is
    // still on screen, because the toast queue is serialised behind every other toast
    // (`edit-watch.actions.ts:136`). Turning the setting off in that window leaves that toast up
    // until its own duration runs out. Dropping the gate would fix it and reintroduce the bug
    // above, and the toast channel is shared, so there is no way to ask "is the visible toast
    // ours?" -- `runToast`/`showToast` carry no owner. `recentlyLapsedProposal` knows a proposal
    // lapsed, but it is module-private and is scoped to honouring a click, not to identifying a
    // toast. Worth the trade: a prompt lingering a few seconds beats clearing an update notice.
    if (proposalRef.current) {
      runToast(dismissToast());
    }
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
    // The pill keeps the prompt on screen after the store has moved on, so the
    // action alone cannot say which proposal the user was answering. A click
    // that names a different proposal than the one now showing belongs to a
    // prompt this app has superseded, and acting on it would add or deny a term
    // the user was never shown. The id is also absent from a click raised before
    // prompts carried one, which is equally uncorrelatable.
    if (payload.proposalId !== getVisibleProposalId()) {
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
