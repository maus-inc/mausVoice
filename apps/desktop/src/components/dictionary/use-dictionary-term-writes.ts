import { useCallback } from "react";
import type { Term } from "@maus-inc/types";
import { showErrorSnackbar } from "../../actions/app.actions";
import { getAppState, produceAppState } from "../../store";
import { beginLocalDataWrite } from "../../utils/local-data-write-gate";
import {
  deleteDictionaryTerm,
  updateDictionaryTerm,
} from "../../utils/term-mutation-queue";
import { focusAfterDictionaryDelete } from "./dictionary-delete-focus";
import { restoreDictionaryOrder } from "./restore-dictionary-order";

export type DictionaryTermWrites = {
  handleCommit: () => Promise<void>;
  handleDelete: () => Promise<void>;
};

/**
 * Both write paths take one local-data write lease, apply the change
 * optimistically and hand the rollback to the queue's callback.
 */
export const useDictionaryTermWrites = ({
  id,
  term,
  sourceValue,
  destinationValue,
  isReplacement,
}: {
  id: string;
  term: Term | undefined;
  sourceValue: string;
  destinationValue: string;
  isReplacement: boolean;
}): DictionaryTermWrites => {
  const handleCommit = useCallback(async () => {
    if (
      !term ||
      !sourceValue.trim() ||
      (isReplacement && !destinationValue.trim())
    ) {
      return;
    }

    if (
      term.sourceValue === sourceValue &&
      term.destinationValue === destinationValue
    ) {
      return;
    }

    const write = beginLocalDataWrite();
    if (!write) return;
    try {
      const previousTerm = term;
      const updatedTerm = {
        ...term,
        sourceValue,
        destinationValue,
      };

      produceAppState((draft) => {
        draft.termById[id] = updatedTerm;
      }, write.lease);

      await updateDictionaryTerm(
        previousTerm,
        updatedTerm,
        (saved, error) => {
          if (getAppState().termById[id] === updatedTerm) {
            produceAppState((draft) => {
              draft.termById[id] = saved;
            }, write.lease);
          }
          showErrorSnackbar(error);
        },
        write.lease,
      );
    } finally {
      write();
    }
  }, [destinationValue, id, isReplacement, sourceValue, term]);

  const handleDelete = useCallback(async () => {
    if (!term) {
      return;
    }

    const write = beginLocalDataWrite();
    if (!write) return;
    try {
      const previousTerm = term;
      const previousIds = [...getAppState().dictionary.termIds];
      focusAfterDictionaryDelete(id);

      produceAppState((draft) => {
        delete draft.termById[id];
        draft.dictionary.termIds = draft.dictionary.termIds.filter(
          (termId) => termId !== id,
        );
      }, write.lease);

      await deleteDictionaryTerm(
        previousTerm,
        (saved, error) => {
          produceAppState((draft) => {
            // Restore only this deletion, without reverting other edits or removals
            // that completed while the request was pending.
            draft.termById[id] ??= saved;
            restoreDictionaryOrder(draft.dictionary.termIds, previousIds, id);
          }, write.lease);
          showErrorSnackbar(error);
        },
        write.lease,
      );
    } finally {
      write();
    }
  }, [id, term]);

  return { handleCommit, handleDelete };
};
