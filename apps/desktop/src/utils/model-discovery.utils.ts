import {
  discardResponseBody,
  raceAbort,
  readAbortableResponseJson,
} from "@maus-inc/utilities";

const throwModelFailure = (
  provider: string,
  reason: string,
  error: unknown,
  signal?: AbortSignal | null,
): never => {
  signal?.throwIfAborted();
  let isAbort = false;
  try {
    isAbort = error instanceof Error && error.name === "AbortError";
  } catch {
    // Hostile accessors must not leak a second transport exception.
  }
  if (isAbort) {
    throw new DOMException(
      `${provider} model discovery cancelled`,
      "AbortError",
    );
  }
  throw new Error(`${provider} model discovery ${reason}`);
};

/** Transport errors may echo configured endpoint credentials or request data. */
export const fetchModelResponse = async (
  provider: string,
  transport: typeof globalThis.fetch,
  url: string,
  init?: RequestInit,
): Promise<Response> => {
  const signal = init?.signal;
  signal?.throwIfAborted();
  let operation: Promise<Response> | undefined;
  let response: Response | undefined;
  try {
    operation = transport(url, init);
    response = signal ? await raceAbort(operation, signal) : await operation;
    signal?.throwIfAborted();
    return response;
  } catch (error) {
    if (signal?.aborted && operation) {
      if (response) discardResponseBody(response);
      else void operation.then(discardResponseBody, () => {});
    }
    return throwModelFailure(provider, "request failed", error, signal);
  }
};

/** JSON parser errors can contain fragments of a provider-controlled body. */
export const parseModelResponse = async <T>(
  provider: string,
  response: Response,
  signal?: AbortSignal,
): Promise<T> => {
  try {
    return await readAbortableResponseJson<T>(response, signal);
  } catch (error) {
    return throwModelFailure(provider, "returned invalid JSON", error, signal);
  }
};
