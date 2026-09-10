export type RedactionMode = "full" | "hash" | "truncate";

const SENSITIVE_KEY_PATTERNS = [
  /password|passwd|pwd/i,
  /secret|clientSecret|client_secret/i,
  /tokens?|accessTokens?|refreshTokens?|idTokens?/i,
  /authorization|auth(?:Header|orization|_header)?/i,
  /credential/i,
  /private/i,
  /api[_-]?key/i,
  /(?:access[_-]?key|key[_-]?id|session[_-]?key)/i,
];

const SECRET_VALUE_PATTERN =
  /(sk|gsk|ghp|gho|xox|xai|nvapi)(?:[_-][a-zA-Z0-9]{2,})*?[_-][a-zA-Z0-9]{20,}/gi;

async function sha256Prefix(input: string): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const encoded = new TextEncoder().encode(input);
    const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
    const hashBytes = new Uint8Array(hashBuffer);
    const prefix = Array.from(hashBytes.slice(0, 4))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `[hash:${prefix}]`;
  }

  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(input).digest("hex");
  return `[hash:${hash.slice(0, 8)}]`;
}

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
    return sha256Prefix(input);
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

const redactStringValue = (value: string): string => {
  return value.replace(SECRET_VALUE_PATTERN, "[redacted-secret]");
};

const redactArray = (
  arr: unknown[],
  sensitiveKeys: string[],
  forceFull = false,
  seen: WeakSet<object> = new WeakSet(),
): Promise<unknown[]> => {
  return Promise.all(
    arr.map(async (item) => {
      if (typeof item === "string") {
        return forceFull ? redactString(item, "full") : redactStringValue(item);
      }
      if (isNestedObject(item)) {
        return redactObject(item, sensitiveKeys, forceFull, seen);
      }
      if (Array.isArray(item)) {
        if (seen.has(item)) {
          return "[circular]";
        }
        seen.add(item);
        try {
          return await redactArray(item, sensitiveKeys, forceFull, seen);
        } finally {
          seen.delete(item);
        }
      }
      return forceFull ? "[redacted]" : item;
    }),
  );
};

const redactWithCycleGuard = async (
  value: Record<string, unknown> | unknown[],
  seen: WeakSet<object>,
  redact: () => Promise<Record<string, unknown> | unknown[]>,
): Promise<Record<string, unknown> | unknown[] | "[circular]"> => {
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  try {
    return await redact();
  } finally {
    seen.delete(value);
  }
};

/**
 * Redact sensitive keys and recursively redact nested objects and arrays.
 * Values under a sensitive key are fully redacted at every depth.
 * Circular references are replaced with "[circular]".
 */
export const redactObject = async (
  obj: Record<string, unknown>,
  sensitiveKeys: string[] = [],
  forceFull = false,
  seen: WeakSet<object> = new WeakSet(),
): Promise<Record<string, unknown>> => {
  const result: Record<string, unknown> = {};
  seen.add(obj);
  try {
    for (const [key, value] of Object.entries(obj)) {
      const sensitive = forceFull || isSensitiveKey(key, sensitiveKeys);
      if (typeof value === "string") {
        result[key] = sensitive
          ? await redactString(value, "full")
          : redactStringValue(value);
      } else if (isNestedObject(value) || Array.isArray(value)) {
        const nested = Array.isArray(value)
          ? () => redactArray(value, sensitiveKeys, sensitive, seen)
          : () => redactObject(value, sensitiveKeys, sensitive, seen);
        result[key] = await redactWithCycleGuard(value, seen, nested);
      } else {
        result[key] = sensitive ? "[redacted]" : value;
      }
    }
  } finally {
    seen.delete(obj);
  }
  return result;
};
