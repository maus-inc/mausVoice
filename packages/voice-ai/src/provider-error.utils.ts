/**
 * Shared classification for provider HTTP failures.
 *
 * Every OpenAI-compatible provider rejects a wrong key, a retired model, and a
 * malformed request with a 4xx. Retrying those spends quota and delay for a
 * result that cannot change, and the raw SDK error is a JSON blob naming a
 * model the user has no way to act on. Each provider keeps its own wording, but
 * the status set, the status and code readers, the secret scrubbing, and the
 * error type they build are written once here so a new provider inherits the
 * behavior instead of copying it.
 */

/** The provider error code for a request naming a model it does not serve. */
export const PROVIDER_MODEL_NOT_FOUND_CODE = "model_not_found";

/** True when a status must not be retried (billing, auth, bad request). */
export const isProviderTerminalStatus = (status: number): boolean =>
  status === 400 ||
  status === 401 ||
  status === 402 ||
  status === 403 ||
  status === 404 ||
  status === 422;

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

/**
 * A provider failure that has been given an actionable message. `status` and
 * `code` are carried so a caller can branch without parsing the message. The
 * API key, the authorization header, and the raw request body are never
 * attached.
 */
export class ProviderError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(
    message: string,
    options: { status?: number; code?: string } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.status = options.status;
    this.code = options.code;
  }
}

/** True when a thrown value carries a non-retryable provider HTTP status. */
export const isProviderTerminalError = (error: unknown): boolean => {
  const status =
    error instanceof ProviderError ? error.status : readProviderStatus(error);
  return status !== undefined && isProviderTerminalStatus(status);
};
