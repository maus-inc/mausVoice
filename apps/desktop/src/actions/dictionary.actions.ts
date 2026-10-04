import { Term } from "@maus-inc/types";
import dayjs from "dayjs";
import { setLocalStorageValue } from "./local-storage.actions";
import { getTermRepo } from "../repos";
import { produceAppState } from "../store";
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

type GlossaryResult = { created: Term[]; failed: number };

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
): Promise<void> => {
  const normalized = sourceValue.trim();
  if (!normalized) {
    return;
  }

  const newTerm: Term = {
    id: createId(),
    createdAt: dayjs().toISOString(),
    sourceValue: normalized,
    destinationValue: "",
    isReplacement: false,
  };

  produceAppState((draft) => {
    draft.termById[newTerm.id] = newTerm;
    draft.dictionary.termIds = [newTerm.id, ...draft.dictionary.termIds];
  });

  try {
    const persisted = await getTermRepo().createTerm(newTerm);
    produceAppState((draft) => {
      draft.termById[persisted.id] = persisted;
    });
    result.created.push(persisted);
    // Every path that grows the dictionary satisfies the "add a word to
    // your dictionary" onboarding item, whether it is auto-learn, an
    // edit-watch proposal, the add-to-dictionary hotkey or this dialog.
    setLocalStorageValue("mausvoice:checklist-dictionary", true);
  } catch (error) {
    produceAppState((draft) => {
      delete draft.termById[newTerm.id];
      draft.dictionary.termIds = draft.dictionary.termIds.filter(
        (id) => id !== newTerm.id,
      );
    });
    getLogger().warning(`Failed to create glossary term: ${error}`);
    result.failed += 1;
  }
};

/**
 * Adds each value as a glossary term (not a replacement rule). Optimistic
 * update with rollback per term, so one failure does not abort the rest.
 * Returns the terms that were persisted and how many failed.
 */
export const createGlossaryTerms = async (
  sourceValues: string[],
): Promise<GlossaryResult> => {
  const result: GlossaryResult = { created: [], failed: 0 };

  // One value at a time, in the order given. Each step prepends its own id to
  // the dictionary's ordered list, so the list a caller ends up with is the
  // reverse of the input and only a sequential run produces that. Chaining the
  // promises rather than awaiting inside a loop states the requirement in the
  // shape of the code instead of leaving it to look accidental.
  await sourceValues.reduce(
    (chain, sourceValue) =>
      chain.then(() => addGlossaryTerm(sourceValue, result)),
    Promise.resolve(),
  );

  return result;
};
