import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { Term } from "@maus-inc/types";

export type DictionaryDraft = {
  sourceValue: string;
  destinationValue: string;
  handleFieldChange: (
    field: "source" | "destination",
  ) => (event: ChangeEvent<HTMLInputElement>) => void;
};

/**
 * The row's two editable fields, kept in step with the persisted term without
 * discarding a draft the user has typed but not yet committed.
 */
export const useDictionaryDraft = (term: Term | undefined): DictionaryDraft => {
  const [sourceValue, setSourceValue] = useState(term?.sourceValue ?? "");
  const [destinationValue, setDestinationValue] = useState(
    term?.destinationValue ?? "",
  );

  const lastSource = useRef(term?.sourceValue ?? "");
  const lastDestination = useRef(term?.destinationValue ?? "");
  useEffect(() => {
    const nextSource = term?.sourceValue ?? "";
    const nextDestination = term?.destinationValue ?? "";
    // Do not overwrite a newer, still-uncommitted draft when a previous
    // request succeeds or rolls back.
    const previousSource = lastSource.current;
    const previousDestination = lastDestination.current;
    setSourceValue((value) => (value === previousSource ? nextSource : value));
    setDestinationValue((value) =>
      value === previousDestination ? nextDestination : value,
    );
    lastSource.current = nextSource;
    lastDestination.current = nextDestination;
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

  return { sourceValue, destinationValue, handleFieldChange };
};
