import {
  discardResponseBody,
  HttpError,
  raceAbort,
  readAbortableResponseJson,
  readHttpStatus,
} from "@maus-inc/utilities";
import { readSafeProviderError } from "./provider-error-body.utils";

/** Integration endpoints omit the detail suffix when the body is empty. */
export const assertProviderIntegrationOk = async (
  response: Response,
  provider: string,
  secrets: readonly string[] = [],
): Promise<void> => {
  if (response.ok) return;
  const detail = (await readSafeProviderError(response, secrets)) ?? "";
  throw new HttpError(
    response.status,
    detail
      ? `${provider} responded ${response.status}: ${detail}`
      : `${provider} responded with status ${response.status}`,
    { retryAfter: response.headers.get("retry-after") },
  );
};

/** Stop waiting when a transport ignores cancellation, and retire late responses. */
export const requestAbortableTransport = async (
  url: string,
  init: RequestInit | undefined,
  transport: typeof globalThis.fetch,
): Promise<Response> => {
  const signal = init?.signal;
  signal?.throwIfAborted();
  // The async wrapper keeps a transport that throws before returning a promise
  // on the same path as a rejection: an abort reason wins over both.
  const operation = (async () => transport(url, init))().catch(
    (error: unknown) => {
      signal?.throwIfAborted();
      throw error;
    },
  );
  if (!signal) return operation;

  let response: Response | undefined;
  try {
    response = await raceAbort(operation, signal);
    signal.throwIfAborted();
    return response;
  } catch (error) {
    if (signal.aborted) {
      if (response) discardResponseBody(response);
      else void operation.then(discardResponseBody, () => {});
      signal.throwIfAborted();
    }
    throw error;
  }
};

/** Inspect an untrusted failure without letting a throwing accessor escape. */
const hasErrorName = (error: unknown, name: string): boolean => {
  try {
    return error instanceof Error && error.name === name;
  } catch {
    return false;
  }
};

export const isAbortError = (error: unknown): boolean =>
  hasErrorName(error, "AbortError");

/** Name the transport failure so callers can branch on abort and timeout. */
const transportFailureName = (error: unknown): string => {
  if (isAbortError(error)) return "AbortError";
  if (hasErrorName(error, "TimeoutError")) return "TimeoutError";
  return "ProviderTransportError";
};

/** Keep retry metadata while omitting transport messages and causes. */
class PrivateTransportFailure extends Error {
  readonly status: number | undefined;

  constructor(provider: string, error: unknown, status: number | undefined) {
    super(`${provider} transport request failed`);
    this.name = transportFailureName(error);
    this.status = status;
  }
}

class PrivateTransportHttpFailure extends HttpError {
  constructor(provider: string, error: HttpError, status: number) {
    super(status, `${provider} transport request failed (HTTP ${status})`);
    const hint = error.retryAfterMs;
    Object.defineProperty(this, "retryAfterMs", {
      value: typeof hint === "number" && Number.isFinite(hint) ? hint : null,
      enumerable: true,
    });
    this.name = isAbortError(error) ? "AbortError" : "ProviderTransportError";
  }
}

const sanitizeProviderTransportFailure = (
  provider: string,
  error: unknown,
  status: number | undefined,
): Error =>
  error instanceof HttpError && status !== undefined
    ? new PrivateTransportHttpFailure(provider, error, status)
    : new PrivateTransportFailure(provider, error, status);

/** Sanitize private requests without altering HTTP retry classification. */
export const requestSensitiveTransport = async (
  url: string,
  init: RequestInit | undefined,
  transport: typeof globalThis.fetch,
  provider: string,
  sanitize: (error: unknown, status: number | undefined) => Error = (
    error,
    status,
  ) => sanitizeProviderTransportFailure(provider, error, status),
): Promise<Response> => {
  try {
    return await requestAbortableTransport(url, init, transport);
  } catch (error) {
    init?.signal?.throwIfAborted();
    let status: number | undefined;
    try {
      status = readHttpStatus(error);
    } catch {
      // A hostile status accessor leaves the status unknown.
    }
    let safe: Error;
    try {
      safe = sanitize(error, status);
    } catch {
      try {
        safe = sanitizeProviderTransportFailure(provider, error, status);
      } catch {
        safe = new PrivateTransportFailure(provider, undefined, status);
      }
    }
    throw safe;
  }
};

/** Preserve cancellation without exposing transport error details. */
export const requestPrivateTransport = async (
  url: string,
  init: RequestInit | undefined,
  transport: typeof globalThis.fetch,
  provider: string,
  failureMessage: string,
): Promise<Response> => {
  init?.signal?.throwIfAborted();
  try {
    return await requestAbortableTransport(url, init, transport);
  } catch (error) {
    init?.signal?.throwIfAborted();
    if (isAbortError(error)) {
      throw new DOMException(`${provider} request cancelled`, "AbortError");
    }
    throw new Error(failureMessage);
  }
};

/**
 * Some requests carry private audio or text that a provider may quote in part.
 * No pattern scrubber can reliably recognize such fragments, so do not expose
 * this response body. Keep HTTP status and retry metadata for the caller.
 */
export const assertPrivateProviderResponseOk = (
  response: Response,
  prefix: string,
): void => {
  if (response.ok) return;
  discardResponseBody(response);
  throw new HttpError(response.status, `${prefix} ${response.status}`, {
    retryAfter: response.headers.get("retry-after"),
  });
};

/** Avoid leaking fragments of private provider responses in JSON parser errors. */
export const parsePrivateProviderJson = async <T>(
  response: Response,
  provider: string,
  signal?: AbortSignal,
): Promise<T> => {
  try {
    return await readAbortableResponseJson<T>(response, signal);
  } catch {
    signal?.throwIfAborted();
    throw new Error(`${provider} response could not be decoded`);
  }
};
