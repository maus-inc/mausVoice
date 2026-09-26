/**
 * Client statuses that another identical attempt cannot fix: a malformed
 * request, a missing or exhausted credential, a forbidden or absent resource,
 * or a payload the service refuses to process. Resending the same call only
 * repeats the same rejection, so the shared `retry` helper treats these as
 * terminal by default.
 *
 * The set is exactly the set the provider utils already filtered themselves
 * (`isCerebrasTerminalStatus`), so moving the default into the helper cannot
 * change a call site that already rejected these statuses.
 */
export const TERMINAL_CLIENT_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 402, 403, 404, 422,
]);

/**
 * Ceiling for a server-provided `Retry-After` hint. A dictation is an
 * interactive session, so an honest but long hint (or a hostile one) must not
 * stall it; the helper falls back to its own backoff once the cap passes.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

export const isTerminalHttpStatus = (status: number): boolean =>
  TERMINAL_CLIENT_STATUSES.has(status);

/**
 * Read a numeric HTTP status off a thrown value. Provider SDKs (`openai`,
 * `groq`, `deepseek`, `claude`, `cerebras`) put one on their API errors, so
 * the shared helpers read it from the raw error as well as from `HttpError`.
 */
export const readHttpStatus = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
};

/**
 * RFC 9110 allows `Retry-After` as delta-seconds ("120") or as an HTTP-date
 * ("Wed, 21 Oct 2015 07:28:00 GMT"). Both are honoured and both are capped at
 * `MAX_RETRY_AFTER_MS`. A missing, malformed, or already-elapsed hint returns
 * `null` so the caller keeps its own backoff.
 */
export const parseRetryAfterMs = (
  retryAfter: string | null | undefined,
  now: number = Date.now(),
): number | null => {
  const value = retryAfter?.trim();
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    // A negative delta is not a date, and V8 parses it as one, so reject it
    // here instead of falling through to a bogus "retry immediately".
    return seconds < 0 ? null : Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const targetMs = Date.parse(value);
  if (!Number.isFinite(targetMs)) {
    return null;
  }
  return Math.min(Math.max(0, targetMs - now), MAX_RETRY_AFTER_MS);
};

/**
 * A non-2xx HTTP response as a typed error. Carries the status so retry
 * policies can read it as data, and the parsed `Retry-After` hint so a rate
 * limit is honoured without parsing the message string.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(
    status: number,
    message: string,
    options?: { retryAfter?: string | null },
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryAfterMs = parseRetryAfterMs(options?.retryAfter);
  }
}

/**
 * Normalise any thrown value into an `HttpError` when it carries a numeric
 * status, preserving the original message. A provider SDK error already
 * exposes `status`, so wrapping it gives every provider the same error shape
 * and keeps message-text parsing out of the retry policy. Values without a
 * status (aborts, parse failures, network errors) are returned untouched.
 */
export const toHttpError = (error: unknown): unknown => {
  if (error instanceof HttpError) {
    return error;
  }
  const status = readHttpStatus(error);
  if (status === undefined) {
    return error;
  }
  const message =
    error instanceof Error ? error.message : `HTTP request failed: ${status}`;
  return new HttpError(status, message);
};
