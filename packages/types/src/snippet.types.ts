export type SnippetTriggerType = "voice" | "hotkey" | "manual";

export type InteractiveSnippet = {
  id: string;
  createdAt: string;
  createdByUserId: string;
  title: string;
  content: string;
  triggerType: SnippetTriggerType;
  triggerValue: string | null;
  variables: SnippetVariable[];
  enabled: boolean;
  isDeleted: boolean;
};

export type SnippetVariable = {
  name: string;
  defaultValue: string | null;
  required: boolean;
};
