import { discardResponseBody } from "@maus-inc/utilities";
import { secureFetch as fetch } from "../utils/secure-fetch.utils";
import { startAsPromise } from "../utils/promise.utils";

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

export const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

export const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
};

/** Stop waiting on retired work without abandoning its eventual cleanup. */
export const raceWithAbort = async <T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> => {
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

/** Never surface transport details that can echo private sidecar requests. */
const throwTransportFailure = (error: unknown, signal: AbortSignal): never => {
  signal.throwIfAborted();
  if (error instanceof Error && error.name === "AbortError") {
    throw new DOMException("Sidecar request cancelled", "AbortError");
  }
  throw new Error("Sidecar transport failed");
};

export const fetchWithTimeout = async (
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> => {
  const callerSignal = init?.signal;
  if (callerSignal?.aborted) throw callerSignal.reason;
  const controller = new AbortController();
  let abortFromCaller = () => {};
  const callerCancellation = new Promise<never>((_, reject) => {
    abortFromCaller = () => {
      const reason = callerSignal?.reason;
      controller.abort(reason);
      reject(reason);
    };
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  });
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const error = new Error("Request timed out");
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });

  try {
    // Sidecars are bound to their own loopback port and have no redirecting
    // routes. Never replay private audio to a redirect-selected destination.
    // A synchronous transport failure is routed through the same
    // abort-aware wrapper as a rejection.
    const request = startAsPromise(() =>
      fetch(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      }),
    ).then(
      (response) => {
        // Some transports ignore abort. Retire a response that arrives after
        // we have stopped waiting rather than leaving its stream alive.
        if (controller.signal.aborted) discardResponseBody(response);
        return response;
      },
      (error: unknown) => throwTransportFailure(error, controller.signal),
    );
    return await Promise.race([request, timeoutPromise, callerCancellation]);
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
};
