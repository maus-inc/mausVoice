export type SnippetVariableType =
  "text" | "multiline" | "choice" | "multiselect" | "date" | "clipboard";

export type SnippetVariableChoice = {
  label: string;
  value: string;
};

/**
 * A snippet variable definition.
 *
 * For `multiselect`, the selected values are stored as a comma-joined string
 * in `SnippetFillIn.variableValues[name]`. Consumers split on "," to recover
 * the array. `choices` enumerates the allowed options.
 */
export type SnippetVariable = {
  name: string;
  type: SnippetVariableType;
  label: string;
  defaultValue?: string;
  choices?: SnippetVariableChoice[];
  required?: boolean;
};

export type Snippet = {
  id: string;
  trigger: string;
  body: string;
  variables: SnippetVariable[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SnippetFillIn = {
  snippetId: string;
  variableValues: Record<string, string>;
  renderedAt: string;
};
