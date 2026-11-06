import { Term } from "@maus-inc/types";
import dayjs from "dayjs";
import { setLocalStorageValue } from "./local-storage.actions";
import { getTermRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import { registerTerms } from "../utils/app.utils";
import { createId } from "../utils/id.utils";
import { createDictionaryTerm } from "../utils/term-mutation-queue";
import {
  dictionaryMutationRevision,
  waitForDictionaryMutations,
} from "../utils/dictionary-mutations";
import { getLogger } from "../utils/log.utils";
import {
  type LocalDataWriteLease,
  withLocalDataWrite,
} from "../utils/local-data-write-gate";

export const loadDictionary = async (): Promise<void> => {
  while (true) {
    const beforeWait = dictionaryMutationRevision();
    await waitForDictionaryMutations();
    const revision = dictionaryMutationRevision();
    if (beforeWait !== revision) continue;
    const terms = await getTermRepo().listTerms();
    if (revision !== dictionaryMutationRevision()) continue;
    const activeTerms = terms.sort(
      (a, b) => dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf(),
    );
    produceAppState((draft) => {
      registerTerms(draft, terms);
      draft.dictionary.termIds = activeTerms.map((term) => term.id);
    });
    return;
  }
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
  lease: LocalDataWriteLease,
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
  }, lease);

  await createDictionaryTerm(
    newTerm,
    (persisted) => {
      if (getAppState().termById[newTerm.id] === newTerm) {
        produceAppState((draft) => {
          draft.termById[persisted.id] = persisted;
        }, lease);
      }
      result.created.push(persisted);
      // All glossary creation paths satisfy the onboarding checklist.
      setLocalStorageValue("mausvoice:checklist-dictionary", true, lease);
    },
    (error) => {
      produceAppState((draft) => {
        delete draft.termById[newTerm.id];
        draft.dictionary.termIds = draft.dictionary.termIds.filter(
          (id) => id !== newTerm.id,
        );
      }, lease);
      getLogger().warning(`Failed to create glossary term: ${error}`);
      result.failed += 1;
    },
    lease,
  );
};

/**
 * Adds each value as a glossary term (not a replacement rule). Optimistic
 * update with rollback per term, so one failure does not abort the rest.
 * Returns the terms that were persisted and how many failed.
 */
export const createGlossaryTerms = async (
  sourceValues: string[],
  existingLease?: LocalDataWriteLease,
): Promise<GlossaryResult> =>
  withLocalDataWrite(async (lease) => {
    const result: GlossaryResult = { created: [], failed: 0 };

    // One value at a time, in the order given. Each step prepends its own id to
    // the dictionary's ordered list, so the list a caller ends up with is the
    // reverse of the input and only a sequential run produces that. Chaining the
    // promises rather than awaiting inside a loop states the requirement in the
    // shape of the code instead of leaving it to look accidental.
    await sourceValues.reduce(
      (chain, sourceValue) =>
        chain.then(() => addGlossaryTerm(sourceValue, result, lease)),
      Promise.resolve(),
    );

    return result;
  }, existingLease);
