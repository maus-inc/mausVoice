/**
 * Shared classification for provider HTTP failures.
 *
 * Every OpenAI-compatible provider rejects a wrong key, a retired model, and a
 * malformed request with a 4xx. Retrying those spends quota and delay for a
 * result that cannot change, and the raw SDK error is a JSON blob naming a
 * model the user has no way to act on. Each provider keeps its own wording, but
 * the status and code readers and the secret scrubbing are written once here so
 * a new provider inherits the behavior instead of copying it.
 *
 * Which statuses are worth not retrying is deliberately not here. It is not a
 * property of HTTP: a status that is terminal for one model is model-scoped for
 * another, so a shared set silently becomes the policy every provider adopts and
 * each one then has to argue with it. Groq's own reasoning for its set, which
 * excludes both 403 and 404, is recorded at `ACCOUNT_SCOPED_GENERATE_TEXT_STATUSES`
 * in `groq.utils.ts`, and the same reasoning does not hold for every provider.
 */

/** The provider error code for a request naming a model it does not serve. */
export const PROVIDER_MODEL_NOT_FOUND_CODE = "model_not_found";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The HTTP status a provider rejection carries, or undefined for a network
 * failure, an abort, or a provider that reported no status.
 */
export const readProviderStatus = (error: unknown): number | undefined => {
  const status = asRecord(error)?.status;
  return typeof status === "number" ? status : undefined;
};

/**
 * The provider's machine-readable error code, for example
 * `model_not_found`. The OpenAI-compatible SDKs put it on the parsed error
 * body, so read both that and a code set directly on the error.
 */
export const readProviderCode = (error: unknown): string | undefined => {
  const outer = asRecord(error);
  const direct = outer?.code;
  if (typeof direct === "string") {
    return direct;
  }
  const nested = asRecord(outer?.error)?.code;
  return typeof nested === "string" ? nested : undefined;
};

const PROVIDER_SECRET_PATTERNS: RegExp[] = [
  // Groq issues `gsk_`, Cerebras `csk_`, and the OpenAI-compatible providers
  // `sk-` or `sk_`. The leading \b keeps `task-123` from matching `sk-`.
  /\b(?:gsk|csk|sk)[-_][a-z0-9_-]+/gi,
  /bearer\s+[a-z0-9._~+/=-]+/gi,
  /authorization:\s*[^\s;,]+/gi,
  /api[_-]?key[:=]\s*[a-z0-9._~+/=-]+/gi,
];

/**
 * Replace the literal API key and common authorization material anywhere in a
 * provider message. The OpenAI-compatible SDKs echo the supplied key in their
 * own error strings ("Incorrect API key provided: gsk_..."), and some proxies
 * echo the Authorization header. Never reveals the key value itself (no
 * length or first characters), so a message like "key gsk_ab" redacts the
 * whole token.
 */
export const redactProviderMessage = (message: string): string =>
  PROVIDER_SECRET_PATTERNS.reduce(
    (cleaned, pattern) => cleaned.replace(pattern, "[redacted]"),
    message,
  );
