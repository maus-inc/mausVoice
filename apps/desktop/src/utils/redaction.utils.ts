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
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const chr = input.charCodeAt(i);
      hash = (hash << 5) - hash + chr;
      hash |= 0;
    }
    return `[hash:${Math.abs(hash).toString(16).slice(0, 8)}]`;
  }
  if (input.length <= 8) {
    return "***";
  }
  return `${input.slice(0, 2)}***${input.slice(-2)}`;
};

export const redactError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(SECRET_VALUE_PATTERN, "[redacted-secret]");
};

export const redactObject = (
  obj: Record<string, unknown>,
  sensitiveKeys: string[] = [],
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const isSensitive =
      sensitiveKeys.includes(key) ||
      SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
    if (isSensitive && typeof value === "string") {
      result[key] = redactString(value, "full");
    } else if (isSensitive) {
      result[key] = "[redacted]";
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redactObject(
        value as Record<string, unknown>,
        sensitiveKeys,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
};
