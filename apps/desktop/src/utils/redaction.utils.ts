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
  /(sk|gsk|ghp|gho|xox|xai|nvapi)(?:[_-][a-z0-9]{2,})*?[_-][a-z0-9]{20,}/gi;

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

async function redactArray(
  values: unknown[],
  sensitiveKeys: string[],
  forceFull: boolean,
  seen: WeakSet<object>,
): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const value of values) {
    result.push(await redactValue(value, sensitiveKeys, forceFull, seen));
  }
  return result;
}

async function redactFields(
  obj: Record<string, unknown>,
  sensitiveKeys: string[],
  forceFull: boolean,
  seen: WeakSet<object>,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    // Assignment would invoke the inherited __proto__ setter for parsed JSON.
    Object.defineProperty(result, key, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: await redactValue(
        value,
        sensitiveKeys,
        forceFull || isSensitiveKey(key, sensitiveKeys),
        seen,
      ),
    });
  }
  return result;
}

async function redactValue(
  value: unknown,
  sensitiveKeys: string[],
  forceFull: boolean,
  seen: WeakSet<object>,
): Promise<unknown> {
  if (typeof value === "string") {
    return forceFull ? redactString(value, "full") : redactStringValue(value);
  }
  if (!Array.isArray(value) && !isNestedObject(value)) {
    return forceFull ? "[redacted]" : value;
  }
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    return Array.isArray(value)
      ? await redactArray(value, sensitiveKeys, forceFull, seen)
      : await redactFields(value, sensitiveKeys, forceFull, seen);
  } finally {
    seen.delete(value);
  }
}

/**
 * Redact sensitive keys and embedded secret patterns in a plain object.
 * Values under a sensitive key are fully redacted at every depth.
 * Circular references are replaced with "[circular]".
 */
export const redactObject = async (
  obj: Record<string, unknown>,
  sensitiveKeys: string[] = [],
  forceFull = false,
  seen: WeakSet<object> = new WeakSet(),
): Promise<Record<string, unknown>> => {
  const alreadySeen = seen.has(obj);
  seen.add(obj);
  try {
    return await redactFields(obj, sensitiveKeys, forceFull, seen);
  } finally {
    if (!alreadySeen) seen.delete(obj);
  }
};
