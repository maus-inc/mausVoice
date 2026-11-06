import type { Term } from "@maus-inc/types";
import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { showErrorSnackbar } from "../../actions/app.actions";
import { getTermRepo } from "../../repos";
import { getAppState, produceAppState } from "../../store";

// Keep the inline draft, optimistic updates, and rollback together so both
// field commits and deletion restore the same term on persistence failure.
export const useDictionaryRowEditor = (id: string, term: Term | undefined) => {
  const [sourceValue, setSourceValue] = useState(term?.sourceValue ?? "");
  const [destinationValue, setDestinationValue] = useState(
    term?.destinationValue ?? "",
  );

  useEffect(() => {
    setSourceValue(term?.sourceValue ?? "");
    setDestinationValue(term?.destinationValue ?? "");
  }, [term?.sourceValue, term?.destinationValue]);

  const handleFieldChange =
    (field: "source" | "destination") =>
    (event: ChangeEvent<HTMLInputElement>) => {
      if (field === "source") {
        setSourceValue(event.target.value);
      } else {
        setDestinationValue(event.target.value);
      }
    };

  const handleCommit = useCallback(async () => {
    if (!term) {
      return;
    }

    if (
      term.sourceValue === sourceValue &&
      term.destinationValue === destinationValue
    ) {
      return;
    }

    const previousTerm = term;
    const updatedTerm = {
      ...term,
      sourceValue,
      destinationValue,
    };

    produceAppState((draft) => {
      draft.termById[id] = updatedTerm;
    });

    try {
      await getTermRepo().updateTerm(updatedTerm);
    } catch (error) {
      produceAppState((draft) => {
        draft.termById[id] = previousTerm;
      });
      setSourceValue(previousTerm.sourceValue);
      setDestinationValue(previousTerm.destinationValue);
      showErrorSnackbar(error);
    }
  }, [destinationValue, id, sourceValue, term]);

  const handleDelete = useCallback(async () => {
    if (!term) {
      return;
    }

    const previousTerm = term;
    const previousIds = [...getAppState().dictionary.termIds];

    produceAppState((draft) => {
      delete draft.termById[id];
      draft.dictionary.termIds = draft.dictionary.termIds.filter(
        (termId) => termId !== id,
      );
    });

    try {
      await getTermRepo().deleteTerm(id);
    } catch (error) {
      produceAppState((draft) => {
        draft.termById[id] = previousTerm;
        draft.dictionary.termIds = previousIds;
      });
      setSourceValue(previousTerm.sourceValue);
      setDestinationValue(previousTerm.destinationValue);
      showErrorSnackbar(error);
    }
  }, [id, term]);

  return {
    sourceValue,
    destinationValue,
    handleFieldChange,
    handleCommit,
    handleDelete,
  };
};
