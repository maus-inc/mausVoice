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
