import type { Term } from "@maus-inc/types";
import { getTermRepo } from "../repos";
import { trackDictionaryMutation } from "./dictionary-mutations";

type Lane = { saved: Term | null; tail: Promise<void> };
const lanes = new Map<string, Lane>();

// SQLite updates and deletes can otherwise complete out of order: updates
// clear the soft-delete flag, so a late update can resurrect a deleted term.
const enqueue = (
  baseline: Term,
  operation: (lane: Lane) => Promise<void>,
  initialSaved: Term | null = baseline,
): Promise<void> => {
  let lane = lanes.get(baseline.id);
  if (!lane) {
    lane = { saved: initialSaved, tail: Promise.resolve() };
    lanes.set(baseline.id, lane);
  }
  const current = lane;
  const previous = current.tail;
  const result = trackDictionaryMutation(() =>
    previous.then(() => operation(current)),
  );
  const tail = result.catch(() => {});
  current.tail = tail;
  void tail.then(() => {
    if (lanes.get(baseline.id) === current && current.tail === tail) {
      lanes.delete(baseline.id);
    }
  });
  return result;
};

export const updateDictionaryTerm = (
  baseline: Term,
  updated: Term,
  onFailure: (saved: Term, error: unknown) => void,
): Promise<void> =>
  enqueue(baseline, async (lane) => {
    if (!lane.saved) return;
    try {
      await getTermRepo().updateTerm(updated);
      lane.saved = updated;
    } catch (error) {
      onFailure(lane.saved, error);
    }
  });

export const deleteDictionaryTerm = (
  baseline: Term,
  onFailure: (saved: Term, error: unknown) => void,
): Promise<void> =>
  enqueue(baseline, async (lane) => {
    if (!lane.saved) return;
    try {
      await getTermRepo().deleteTerm(baseline.id);
    } catch (error) {
      onFailure(lane.saved, error);
    }
  });

export const createDictionaryTerm = (
  term: Term,
  onSuccess: (created: Term) => void,
  onFailure: (error: unknown) => void,
): Promise<void> =>
  enqueue(
    term,
    async (lane) => {
      try {
        const created = await getTermRepo().createTerm(term);
        lane.saved = created;
        onSuccess(created);
      } catch (error) {
        onFailure(error);
      }
    },
    null,
  );
