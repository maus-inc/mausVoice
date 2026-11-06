import { Term } from "@maus-inc/types";
import dayjs from "dayjs";
import { setLocalStorageValue } from "./local-storage.actions";
import { getTermRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import { registerTerms } from "../utils/app.utils";
import { createId } from "../utils/id.utils";
import { getLogger } from "../utils/log.utils";

export const loadDictionary = async (): Promise<void> => {
  const terms = await getTermRepo().listTerms();
  const activeTerms = terms.sort(
    (a, b) => dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf(),
  );

  produceAppState((draft) => {
    registerTerms(draft, terms);
    draft.dictionary.termIds = activeTerms.map((term) => term.id);
  });
};

type GlossaryResult = Awaited<ReturnType<typeof createGlossaryTerms>>;

/** A glossary term carries no replacement value; it only pins a spelling. */
const buildGlossaryTerm = (sourceValue: string): Term => ({
  id: createId(),
  createdAt: dayjs().toISOString(),
  sourceValue,
  destinationValue: "",
  isReplacement: false,
});

/** Show the term before the database confirms it. */
const publishOptimisticTerm = (term: Term): void => {
  produceAppState((draft) => {
    draft.termById[term.id] = term;
    draft.dictionary.termIds = [term.id, ...draft.dictionary.termIds];
  });
};

/** Undo only our own optimistic insert: a later edit may own the term now. */
const rollbackGlossaryTerm = (term: Term): void => {
  if (getAppState().termById[term.id] !== term) return;
  produceAppState((draft) => {
    delete draft.termById[term.id];
    draft.dictionary.termIds = draft.dictionary.termIds.filter(
      (id) => id !== term.id,
    );
  });
};

/**
 * Checklist failures must not turn a successful database write into a reported
 * failure or roll the persisted term out of the dictionary.
 */
const markDictionaryChecklistDone = (shouldContinue: () => boolean): void => {
  try {
    setLocalStorageValue("mausvoice:checklist-dictionary", true);
  } catch {
    if (shouldContinue()) {
      getLogger().warning("Could not update the dictionary checklist");
    }
  }
};

/**
 * Adds one value as a glossary term (not a replacement rule). Optimistic update
 * with rollback, so one failure does not abort the rest.
 *
 * The accumulator is threaded through rather than returned because a term is
 * counted as created before the localStorage write that follows it, and the
 * order in which the terms land in it is the caller's input order.
 */
const addGlossaryTerm = async (
  sourceValue: string,
  result: GlossaryResult,
  shouldContinue: () => boolean,
): Promise<void> => {
  if (!shouldContinue()) return;
  const normalized = sourceValue.trim();
  if (!normalized) return;

  const newTerm = buildGlossaryTerm(normalized);
  publishOptimisticTerm(newTerm);

  if (!shouldContinue()) {
    rollbackGlossaryTerm(newTerm);
    return;
  }
  let persisted: Term;
  try {
    persisted = await getTermRepo().createTerm(newTerm);
  } catch (error) {
    rollbackGlossaryTerm(newTerm);
    if (!shouldContinue()) return;
    getLogger().warning(`Failed to create glossary term: ${error}`);
    result.failed += 1;
    return;
  }
  if (!shouldContinue()) {
    rollbackGlossaryTerm(newTerm);
    return;
  }
  produceAppState((draft) => {
    draft.termById[persisted.id] = persisted;
  });
  if (!shouldContinue()) {
    rollbackGlossaryTerm(persisted);
    return;
  }
  result.created.push(persisted);
  markDictionaryChecklistDone(shouldContinue);
};

/**
 * Adds each value as a glossary term (not a replacement rule). Optimistic
 * update with rollback per term, so one failure does not abort the rest.
 * Returns the terms that were persisted and how many failed.
 */
export const createGlossaryTerms = async (
  sourceValues: string[],
  shouldContinue: () => boolean = () => true,
): Promise<{ created: Term[]; failed: number }> => {
  const result: GlossaryResult = { created: [], failed: 0 };

  // One value at a time, in the order given. Each step prepends its own id to
  // the dictionary's ordered list, so the list a caller ends up with is the
  // reverse of the input and only a sequential run produces that. Chaining the
  // promises rather than awaiting inside a loop states the requirement in the
  // shape of the code instead of leaving it to look accidental.
  await sourceValues.reduce(
    (chain, sourceValue) =>
      chain.then(() => addGlossaryTerm(sourceValue, result, shouldContinue)),
    Promise.resolve(),
  );

  return result;
};
