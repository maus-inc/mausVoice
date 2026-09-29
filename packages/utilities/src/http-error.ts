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
 * Outermost ceiling on a parsed `Retry-After` hint, so a hostile or careless
 * header cannot become an unbounded wait. It is the value a background caller
 * passes as `maxRetryDelayMs` to honour a hint in full; an interactive caller
 * keeps the far shorter `DEFAULT_MAX_RETRY_DELAY_MS`, and a dictation must.
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
 * `MAX_RETRY_AFTER_MS`. An explicit delta-seconds hint is returned as written,
 * including "0", so a caller can tell a deliberate "retry now" apart from a
 * hint that was never sent. Whether "0" becomes an instant retry is the
 * caller's decision to make: `retry` keeps its own delay as the floor, so a 0
 * hint there still waits out that delay. A missing, malformed, or already
 * elapsed hint returns `null` so the caller keeps its own backoff: a date in the
 * past is no longer an instruction, and returning 0 for it would turn a rate
 * limit into a busy retry.
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
  if (!Number.isFinite(targetMs) || targetMs <= now) {
    return null;
  }
  return Math.min(targetMs - now, MAX_RETRY_AFTER_MS);
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
 * Read one header off a response header bag. The provider SDKs hand over a
 * plain record built by `parseHeaders` (lowercased names), while a raw fetch
 * error carries a `Headers` instance, so both shapes are read here.
 */
const readHeader = (bag: unknown, name: string): string | null => {
  if (typeof bag !== "object" || bag === null) {
    return null;
  }
  const get = (bag as { get?: unknown }).get;
  if (typeof get === "function") {
    const value = (get as (header: string) => unknown).call(bag, name);
    return typeof value === "string" ? value : null;
  }
  const record = bag as Record<string, unknown>;
  const key = Object.keys(record).find(
    (candidate) => candidate.toLowerCase() === name,
  );
  const value = key === undefined ? undefined : record[key];
  return typeof value === "string" ? value : null;
};

/**
 * The `Retry-After` hint a thrown value carries, if any. `APIError` puts the
 * response headers straight on the error and a fetch error keeps them on
 * `response.headers`, so a rate limit reaches the retry policy as data rather
 * than as prose.
 */
const readRetryAfterHeader = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const carrier = error as { headers?: unknown; response?: unknown };
  const fromResponse =
    typeof carrier.response === "object" && carrier.response !== null
      ? (carrier.response as { headers?: unknown }).headers
      : undefined;
  return (
    readHeader(carrier.headers, "retry-after") ??
    readHeader(fromResponse, "retry-after")
  );
};

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
  return new HttpError(status, message, {
    retryAfter: readRetryAfterHeader(error),
  });
};
