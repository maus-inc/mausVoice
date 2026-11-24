import { useCallback, useState } from "react";
import type { Tone } from "@maus-inc/types";
import { sameToneDraft } from "./tone-form.utils";

export type ToneEditDraft = {
  name: string;
  category: string;
  outputLength: string;
  exampleInputOutput: string;
  promptTemplate: string;
};

const draftOf = (tone: Tone): ToneEditDraft => ({
  name: tone.name,
  category: tone.category ?? "",
  outputLength: tone.outputLength ?? "",
  exampleInputOutput: tone.exampleInputOutput ?? "",
  promptTemplate: tone.promptTemplate,
});

export const useToneEditDraft = (tone: Tone) => {
  const [baseline, setBaseline] = useState(tone);
  const [draft, setDraft] = useState<ToneEditDraft>(() => draftOf(tone));

  const setName = useCallback((name: string) => {
    setDraft((current) => ({ ...current, name }));
  }, []);
  const setCategory = useCallback((category: string) => {
    setDraft((current) => ({ ...current, category }));
  }, []);
  const setOutputLength = useCallback((outputLength: string) => {
    setDraft((current) => ({ ...current, outputLength }));
  }, []);
  const setExampleInputOutput = useCallback((exampleInputOutput: string) => {
    setDraft((current) => ({ ...current, exampleInputOutput }));
  }, []);
  const setPromptTemplate = useCallback((promptTemplate: string) => {
    setDraft((current) => ({ ...current, promptTemplate }));
  }, []);

  const resetTo = useCallback((next: Tone) => {
    setBaseline(next);
    setDraft(draftOf(next));
  }, []);

  const trimmedName = draft.name.trim();
  const trimmedPrompt = draft.promptTemplate.trim();

  return {
    draft,
    baseline,
    setName,
    setCategory,
    setOutputLength,
    setExampleInputOutput,
    setPromptTemplate,
    resetTo,
    trimmedName,
    trimmedPrompt,
    isValid: trimmedName.length > 0 && trimmedPrompt.length > 0,
    hasChanges: !sameToneDraft(draft, baseline),
    sourceChanged: !sameToneDraft(tone, baseline),
  };
};
