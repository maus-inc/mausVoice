export type SnippetVariableType =
  "text" | "multiline" | "choice" | "multiselect" | "date" | "clipboard";

export type SnippetVariableChoice = {
  label: string;
  value: string;
};

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
