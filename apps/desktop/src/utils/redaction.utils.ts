export type RedactionMode = "full" | "hash" | "truncate";

/**
 * The modes a synchronous call can produce. "hash" is excluded by type
 * because crypto.subtle returns a promise and node:crypto is unreachable from
 * a synchronous webview call, so a hashed value cannot exist here.
 */
export type SyncRedactionMode = Exclude<RedactionMode, "hash">;

const REDACTED = "[redacted]";

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
 * Redact a string without awaiting, for callers that cannot return a promise.
 * "hash" is absent from the mode union because it needs promise-based crypto.
 */
export const redactStringSync = (
  input: string,
  mode: SyncRedactionMode = "full",
): string => {
  if (!input) {
    return input;
  }
  return mode === "truncate" ? truncateString(input) : REDACTED;
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
  if (mode === "hash") {
    return sha256Prefix(input);
  }
  return redactStringSync(input, mode);
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

function redactArray(
  values: unknown[],
  sensitiveKeys: string[],
  forceFull: boolean,
  seen: WeakSet<object>,
): unknown[] {
  const result: unknown[] = [];
  for (const value of values) {
    result.push(redactValue(value, sensitiveKeys, forceFull, seen));
  }
  return result;
}

function redactFields(
  obj: Record<string, unknown>,
  sensitiveKeys: string[],
  forceFull: boolean,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    // Assignment would invoke the inherited __proto__ setter for parsed JSON.
    Object.defineProperty(result, key, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: redactValue(
        value,
        sensitiveKeys,
        forceFull || isSensitiveKey(key, sensitiveKeys),
        seen,
      ),
    });
  }
  return result;
}

/**
 * A value with its own toJSON is rendered by JSON.stringify through that
 * method, so walking its own properties would replace the rendered form with
 * an empty object. Such a value is a leaf here, and is still redacted when it
 * sits under a sensitive key.
 */
const hasCustomJsonForm = (value: object): boolean =>
  typeof (value as { toJSON?: unknown }).toJSON === "function";

const isTraversable = (
  value: unknown,
): value is Record<string, unknown> | unknown[] => {
  return (
    Array.isArray(value) || (isNestedObject(value) && !hasCustomJsonForm(value))
  );
};

function redactValue(
  value: unknown,
  sensitiveKeys: string[],
  forceFull: boolean,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return forceFull
      ? redactStringSync(value, "full")
      : redactStringValue(value);
  }
  if (!isTraversable(value)) {
    return forceFull ? REDACTED : value;
  }
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    return Array.isArray(value)
      ? redactArray(value, sensitiveKeys, forceFull, seen)
      : redactFields(value, sensitiveKeys, forceFull, seen);
  } finally {
    seen.delete(value);
  }
}

/**
 * Redact sensitive keys and embedded secret patterns in a plain object.
 * Values under a sensitive key are fully redacted at every depth.
 * Circular references are replaced with "[circular]".
 *
 * This is the synchronous entry point, so a caller that cannot return a
 * promise, such as the log serializer, can use it.
 */
export const redactObjectSync = (
  obj: Record<string, unknown>,
  sensitiveKeys: string[] = [],
  forceFull = false,
  seen: WeakSet<object> = new WeakSet(),
): Record<string, unknown> => {
  const alreadySeen = seen.has(obj);
  seen.add(obj);
  try {
    return redactFields(obj, sensitiveKeys, forceFull, seen);
  } finally {
    if (!alreadySeen) seen.delete(obj);
  }
};

/**
 * The promise returning form of redactObjectSync, kept for callers that
 * already await it. The traversal itself is synchronous.
 */
export const redactObject = async (
  obj: Record<string, unknown>,
  sensitiveKeys: string[] = [],
  forceFull = false,
  seen: WeakSet<object> = new WeakSet(),
): Promise<Record<string, unknown>> => {
  return redactObjectSync(obj, sensitiveKeys, forceFull, seen);
};
