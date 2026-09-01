export type RedactionMode = "full" | "hash" | "truncate";

const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /key/i,
  /auth/i,
  /credential/i,
  /private/i,
  /apikey/i,
  /api[_-]?key/i,
];

const SECRET_VALUE_PATTERN =
  /(sk|gsk|ghp|gho|xox|xai|nvapi)[_-][a-z0-9]{20,}/gi;

const hashString = (input: string): string => {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const chr = input.codePointAt(i) ?? 0;
    hash = Math.trunc((hash << 5) - hash + chr);
  }
  return `[hash:${Math.abs(hash).toString(16).slice(0, 8)}]`;
};

const truncateString = (input: string): string => {
  if (input.length <= 8) {
    return "***";
  }
  return `${input.slice(0, 2)}***${input.slice(-2)}`;
};

export const redactString = (
  input: string,
  mode: RedactionMode = "full",
): string => {
  if (!input) {
    return input;
  }
  if (mode === "full") {
    return "[redacted]";
  }
  if (mode === "hash") {
    return hashString(input);
  }
  return truncateString(input);
};

export const redactError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(SECRET_VALUE_PATTERN, "[redacted-secret]");
};

const isNestedObject = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === "object" && !Array.isArray(value);
};

const isSensitiveKey = (key: string, sensitiveKeys: string[]): boolean => {
  return (
    sensitiveKeys.includes(key) ||
    SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))
  );
};

export const redactObject = (
  obj: Record<string, unknown>,
  sensitiveKeys: string[] = [],
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveKey(key, sensitiveKeys)) {
      result[key] =
        typeof value === "string" ? redactString(value, "full") : "[redacted]";
    } else if (isNestedObject(value)) {
      result[key] = redactObject(value, sensitiveKeys);
    } else {
      result[key] = value;
    }
  }
  return result;
};
