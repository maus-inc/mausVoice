export type RedactionMode = "full" | "hash" | "truncate";

const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /auth/i,
  /credential/i,
  /private/i,
  /apikey/i,
  /api[_-]?key/i,
];

const SECRET_VALUE_PATTERN =
  /(sk|gsk|ghp|gho|xox|xai|nvapi)(?:[_-][a-zA-Z0-9]{2,})*?[_-][a-zA-Z0-9]{20,}/gi;

const hashString = async (input: string): Promise<string> => {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashBytes = new Uint8Array(hashBuffer);
  const prefix = Array.from(hashBytes.slice(0, 4))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `[hash:${prefix}]`;
};

const truncateString = (input: string): string => {
  if (input.length <= 8) {
    return "***";
  }
  return `${input.slice(0, 2)}***${input.slice(-2)}`;
};

/**
 * Redact a string according to the given mode.
 * "full" replaces with [redacted], "hash" replaces with a short hash,
 * "truncate" shows only the first and last two characters.
 */
export const redactString = async (
  input: string,
  mode: RedactionMode = "full",
): Promise<string> => {
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

/**
 * Redact any embedded secrets from an error message.
 */
export const redactError = async (error: unknown): Promise<string> => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(SECRET_VALUE_PATTERN, "[redacted-secret]");
};

const isNestedObject = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === "object" && !Array.isArray(value);
};

const isSensitiveKey = (key: string, sensitiveKeys: string[]): boolean => {
  const lowerKey = key.toLowerCase();
  return (
    sensitiveKeys.some((k) => k.toLowerCase() === lowerKey) ||
    SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))
  );
};

/**
 * Redact sensitive keys and recursively redact nested objects and arrays.
 */
export const redactObject = async (
  obj: Record<string, unknown>,
  sensitiveKeys: string[] = [],
): Promise<Record<string, unknown>> => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveKey(key, sensitiveKeys)) {
      if (typeof value === "string") {
        result[key] = await redactString(value, "full");
      } else {
        result[key] = "[redacted]";
      }
    } else if (isNestedObject(value)) {
      result[key] = await redactObject(value, sensitiveKeys);
    } else if (Array.isArray(value)) {
      result[key] = await redactArray(value, sensitiveKeys);
    } else {
      result[key] = value;
    }
  }
  return result;
};

const redactArray = async (
  arr: unknown[],
  sensitiveKeys: string[],
): Promise<unknown[]> => {
  return Promise.all(
    arr.map(async (item) => {
      if (isNestedObject(item)) {
        return redactObject(item, sensitiveKeys);
      }
      if (Array.isArray(item)) {
        return redactArray(item, sensitiveKeys);
      }
      return item;
    }),
  );
};
