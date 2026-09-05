const MAX_ERROR_MESSAGE_LENGTH = 512;
const MAX_REDACT_DEPTH = 8;
const REDACTED = "[redacted]";

const BEARER_TOKEN = /\bBearer\s+[0-9a-z._~+/-]+={0,2}/gi;
const PROVIDER_KEY_PREFIX = /\b(?:csk_|gsk_|sk-ant-|xai-|sk-)[0-9a-z_-]{8,}/gi;
const LABELED_SECRET =
  /\b(api[_-]?key|apiKey|authorization|access_token|refresh_token)\s*[:=]\s*(?:"[^"]*"|[^\s,;]+)/gi;

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
    .replace(LABELED_SECRET, "$1=[redacted]");

const capLength = (message: string): string =>
  message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : message;

const redactUnknown = (
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown => {
  if (typeof value === "string") return redactSensitiveTokens(value);
  if (
    value === null ||
    typeof value !== "object" ||
    depth >= MAX_REDACT_DEPTH
  ) {
    return value;
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = isSecretKey(key)
      ? REDACTED
      : redactUnknown(child, depth + 1, seen);
  }
  return out;
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
