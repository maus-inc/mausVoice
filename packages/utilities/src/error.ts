const MAX_ERROR_MESSAGE_LENGTH = 512;
const MAX_REDACT_DEPTH = 8;
const REDACTED = "[redacted]";

const BEARER_TOKEN = /\bBearer\s+\S+/gi;
const PROVIDER_KEY_PREFIX = /\b(?:csk_|gsk_|sk-ant-|xai-|sk-)[0-9a-z_-]{8,}/gi;
const SECRET_LABEL = String.raw`"?\b(api[_-]?key|apiKey|authorization|access_token|refresh_token)\b"?`;
const LABELED_SECRET_QUOTED = new RegExp(
  String.raw`${SECRET_LABEL}\s*([:=])\s*"(?:\\.|[^"\\])*"`,
  "gi",
);
const LABELED_SECRET_BARE = new RegExp(
  String.raw`${SECRET_LABEL}\s*([:=])\s*([^\s,;})]+)`,
  "gi",
);
/**
 * Bare values that describe the field instead of carrying a credential
 * (`api_key=required`, `authorization: missing`). Left readable so validation
 * messages stay useful. Anything else after a secret label is redacted.
 */
const PLACEHOLDER_VALUES = new Set([
  "required",
  "missing",
  "invalid",
  "expired",
  "revoked",
  "null",
  "undefined",
  "none",
  "empty",
  "true",
  "false",
]);

const SECRET_KEY_ALIASES = new Set([
  "apikey",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "bearer",
]);

const isSecretKey = (key: string): boolean =>
  SECRET_KEY_ALIASES.has(key.replace(/[_-]/g, "").toLowerCase());

const redactSensitiveTokens = (message: string): string =>
  message
    .replace(BEARER_TOKEN, "Bearer [redacted]")
    .replace(PROVIDER_KEY_PREFIX, REDACTED)
    .replace(LABELED_SECRET_QUOTED, "$1$2[redacted]")
    .replace(
      LABELED_SECRET_BARE,
      (match, label: string, sep: string, value: string) =>
        PLACEHOLDER_VALUES.has(value.toLowerCase())
          ? match
          : `${label}${sep}${REDACTED}`,
    );

const capLength = (message: string): string =>
  message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : message;

const redactUnknown = (
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown => {
  const walkCollection = (collection: object): unknown => {
    if (seen.has(collection)) return "[Circular]";
    seen.add(collection);
    if (Array.isArray(collection)) {
      return collection.map((item) => redactUnknown(item, depth + 1, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(collection)) {
      out[key] = isSecretKey(key)
        ? REDACTED
        : redactUnknown(child, depth + 1, seen);
    }
    return out;
  };

  if (typeof value === "string") return redactSensitiveTokens(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_REDACT_DEPTH) return REDACTED;
  return walkCollection(value);
};

const redactJsonIfPossible = (message: string): string => {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return redactSensitiveTokens(message);
  }
  try {
    return JSON.stringify(redactUnknown(JSON.parse(trimmed), 0, new WeakSet()));
  } catch {
    return redactSensitiveTokens(message);
  }
};

const messageFromUnknown = (error: unknown): string => {
  if (typeof error === "string") return redactJsonIfPossible(error);
  if (error instanceof Error) return redactJsonIfPossible(error.message);
  try {
    return (
      JSON.stringify(redactUnknown(error, 0, new WeakSet())) ??
      redactSensitiveTokens(String(error))
    );
  } catch {
    return redactSensitiveTokens(String(error));
  }
};

/**
 * Coerce any thrown value to a readable message without producing
 * `[object Object]` for plain objects. Obvious tokens are redacted and
 * the result is capped so logs and tool-failure text cannot dump secrets
 * or huge payloads.
 */
export const unknownToMessage = (error: unknown): string =>
  capLength(messageFromUnknown(error));
