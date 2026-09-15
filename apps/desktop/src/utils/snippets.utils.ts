import type { Snippet } from "../types/snippets.types";

export const encodeMultiselectValue = (values: string[]): string => {
  return JSON.stringify(values);
};

export const decodeMultiselectValue = (stored: string): string[] => {
  if (!stored) {
    return [];
  }
  const parsed: unknown = JSON.parse(stored);
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "string")) {
    throw new Error("Invalid multiselect value");
  }
  return parsed;
};

type ExpandOptions = {
  variableValues: Record<string, string>;
  clipboardText?: string;
  now?: Date;
};

const formatDate = (date: Date): string => date.toISOString().slice(0, 10);
const formatTime = (date: Date): string =>
  `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
const formatDateTime = (date: Date): string =>
  `${formatDate(date)} ${formatTime(date)}`;

export const expandSnippetBody = (
  body: string,
  snippet: Pick<Snippet, "variables">,
  options: ExpandOptions,
): string => {
  const now = options.now ?? new Date();
  const builtIns: Record<string, string> = {
    DATE: formatDate(now),
    TIME: formatTime(now),
    DATETIME: formatDateTime(now),
    CLIPBOARD: options.clipboardText ?? "",
  };

  return body.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    if (name in builtIns) {
      return builtIns[name];
    }
    const variable = snippet.variables.find((v) => v.name === name);
    const raw = options.variableValues[name];
    if (raw === undefined || raw === "") {
      return variable?.defaultValue ?? "";
    }
    if (variable?.type === "multiselect") {
      try {
        const values = decodeMultiselectValue(raw);
        return values.join(", ");
      } catch {
        return raw;
      }
    }
    return raw;
  });
};

export const expandSnippet = (
  snippet: Snippet,
  variableValues: Record<string, string>,
  clipboardText = "",
  now?: Date,
): string => {
  return expandSnippetBody(snippet.body, snippet, {
    variableValues,
    clipboardText,
    now,
  });
};

export const validateSnippetTrigger = (trigger: string): string | null => {
  if (!trigger.trim()) {
    return "Trigger must not be empty";
  }
  if (trigger.includes(" ")) {
    return "Trigger must not contain spaces";
  }
  if (!trigger.startsWith(":") && !trigger.startsWith(";")) {
    return "Trigger should start with : or ; for global expansion";
  }
  return null;
};
