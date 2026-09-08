import { Term } from "@maus-inc/types";
import dayjs from "dayjs";
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

/**
 * Adds each value as a glossary term (not a replacement rule). Optimistic
 * update with rollback per term, so one failure does not abort the rest.
 * Returns the terms that were persisted and how many failed.
 */
export const createGlossaryTerms = async (
  sourceValues: string[],
): Promise<{ created: Term[]; failed: number }> => {
  const created: Term[] = [];
  let failed = 0;

  for (const sourceValue of sourceValues) {
    const normalized = sourceValue.trim();
    if (!normalized) {
      continue;
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
      created.push(persisted);
    } catch (error) {
      produceAppState((draft) => {
        delete draft.termById[newTerm.id];
        draft.dictionary.termIds = draft.dictionary.termIds.filter(
          (id) => id !== newTerm.id,
        );
      });
      getLogger().warning(`Failed to create glossary term: ${error}`);
      failed++;
    }
  }

  return { created, failed };
};
