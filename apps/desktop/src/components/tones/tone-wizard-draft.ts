export type ToneWizardDraft = {
  name: string;
  category: string;
  outputLength: string;
  exampleInputOutput: string;
  promptTemplate: string;
};

export const hasWizardDraft = (
  draft: ToneWizardDraft,
  sampleText: string,
  initialSampleText: string,
): boolean =>
  Boolean(
    draft.name ||
    draft.category ||
    draft.outputLength ||
    draft.exampleInputOutput ||
    draft.promptTemplate,
  ) || sampleText !== initialSampleText;
