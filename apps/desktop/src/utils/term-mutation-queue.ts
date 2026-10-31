import {
  type LocalDataWriteLease,
  withLocalDataWrite,
} from "./local-data-write-gate";
import type { Term } from "@maus-inc/types";
import { getTermRepo } from "../repos";
import { trackDictionaryMutation } from "./dictionary-mutations";

type Lane = { saved: Term | null; tail: Promise<void> };
const lanes = new Map<string, Lane>();

// SQLite updates and deletes can otherwise complete out of order: updates
// clear the soft-delete flag, so a late update can resurrect a deleted term.
const enqueue = (
  baseline: Term,
  operation: (lane: Lane, lease: LocalDataWriteLease) => Promise<void>,
  initialSaved: Term | null = baseline,
  existingLease?: LocalDataWriteLease,
): Promise<void> =>
  withLocalDataWrite(async (lease) => {
    let lane = lanes.get(baseline.id);
    if (!lane) {
      lane = { saved: initialSaved, tail: Promise.resolve() };
      lanes.set(baseline.id, lane);
    }
    const current = lane;
    const previous = current.tail;
    const result = trackDictionaryMutation(() =>
      previous.then(() => operation(current, lease)),
    );
    const tail = result.catch(() => {});
    current.tail = tail;
    void tail.then(() => {
      if (lanes.get(baseline.id) === current && current.tail === tail) {
        lanes.delete(baseline.id);
      }
    });
    return result;
  }, existingLease);

export const updateDictionaryTerm = (
  baseline: Term,
  updated: Term,
  onFailure: (saved: Term, error: unknown) => void,
  existingLease?: LocalDataWriteLease,
): Promise<void> =>
  enqueue(
    baseline,
    async (lane, lease) => {
      if (!lane.saved) return;
      try {
        await getTermRepo().updateTerm(updated, lease);
        lane.saved = updated;
      } catch (error) {
        onFailure(lane.saved, error);
      }
    },
    baseline,
    existingLease,
  );

export const deleteDictionaryTerm = (
  baseline: Term,
  onFailure: (saved: Term, error: unknown) => void,
  existingLease?: LocalDataWriteLease,
): Promise<void> =>
  enqueue(
    baseline,
    async (lane, lease) => {
      if (!lane.saved) return;
      try {
        await getTermRepo().deleteTerm(baseline.id, lease);
      } catch (error) {
        onFailure(lane.saved, error);
      }
    },
    baseline,
    existingLease,
  );

export const createDictionaryTerm = (
  term: Term,
  onSuccess: (created: Term) => void,
  onFailure: (error: unknown) => void,
  existingLease?: LocalDataWriteLease,
): Promise<void> =>
  enqueue(
    term,
    async (lane, lease) => {
      try {
        const created = await getTermRepo().createTerm(term, lease);
        lane.saved = created;
        onSuccess(created);
      } catch (error) {
        onFailure(error);
      }
    },
    null,
    existingLease,
  );
