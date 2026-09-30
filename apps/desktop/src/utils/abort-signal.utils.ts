import type { CustomFetch } from "@maus-inc/voice-ai";

export type CombinedAbortSignal = {
  signal: AbortSignal;
  /**
   * Detaches the fallback listeners from the input signals. Call it once the
   * work the signal guards has settled, so a long-lived input does not
   * accumulate one listener per request. No-op when nothing was linked.
   */
  dispose: () => void;
};

const noop = (): void => {};

/**
 * Signal that aborts when either input aborts. Uses `AbortSignal.any` where
 * the webview has it (older WebKit does not) and links manually otherwise.
 */
export const combineAbortSignals = (
  first: AbortSignal | null | undefined,
  second: AbortSignal | null | undefined,
): CombinedAbortSignal | undefined => {
  const only = first ?? second;
  if (!first || !second)
    return only ? { signal: only, dispose: noop } : undefined;
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any([first, second]), dispose: noop };
  }

  // The inputs are often as long-lived as a dictation, so linking them by hand
  // must not leave a listener behind per request. `dispose` removes both.
  const controller = new AbortController();
  const sources = [first, second];
  const detach = (): void => {
    sources.forEach((source, index) => {
      source.removeEventListener("abort", listeners[index]);
    });
  };
  const listeners = sources.map((source) => () => {
    detach();
    controller.abort(source.reason);
  });

  const alreadyAborted = sources.find((source) => source.aborted);
  if (alreadyAborted) {
    controller.abort(alreadyAborted.reason);
  } else {
    sources.forEach((source, index) => {
      source.addEventListener("abort", listeners[index], { once: true });
    });
  }
  return { signal: controller.signal, dispose: detach };
};

const BODY_READERS = [
  "arrayBuffer",
  "blob",
  "formData",
  "json",
  "text",
] as const;

/**
 * Tie `dispose` to the body being read rather than to the fetch settling.
 *
 * `fetch` resolves on response headers, so disposing in a `finally` around it
 * detached both listeners while the caller was still reading the body. Every
 * provider here reads the body afterwards with `await response.json()`, so a
 * dictation signal aborting during that read no longer reached the request and
 * the upload kept running after the user had already discarded the recording.
 *
 * It only ever differed by webview, which is what made it a quiet bug: the
 * `AbortSignal.any` branch has a no-op `dispose` and stayed cancellable, so this
 * worked on the webviews that have it and silently stopped working on the older
 * WebKit ones that do not.
 *
 * A body that is never read leaves its listener attached until one of the source
 * signals aborts, which detaches both. The caller's signal is the dictation's, so
 * that is the end of the recording rather than the end of the session -- the
 * worst case is a few listeners for the length of one dictation, instead of one
 * per request for the life of the app.
 */
const disposeAfterBodyRead = (
  response: Response,
  dispose: () => void,
): Response => {
  let disposed = false;
  const disposeOnce = (): void => {
    if (disposed) return;
    disposed = true;
    dispose();
  };
  // Typed loosely on purpose: indexing `Response` by a union of method names
  // produces an intersection of every overload, which nothing can be assigned
  // to. Each entry is a same-arity, same-arity-returning passthrough.
  const target = response as unknown as Record<string, unknown>;
  for (const reader of BODY_READERS) {
    const original = (
      target[reader] as (...args: unknown[]) => Promise<unknown>
    ).bind(response);
    target[reader] = async (...args: unknown[]) => {
      try {
        return await original(...args);
      } finally {
        disposeOnce();
      }
    };
  }
  return response;
};

/**
 * Wraps a provider fetch so every request it makes (including SDK retries)
 * is cancelled by `signal`. Returns `fetchImpl` unchanged without one.
 */
export const withAbortSignal = (
  fetchImpl: CustomFetch,
  signal: AbortSignal | undefined,
): CustomFetch => {
  if (!signal) return fetchImpl;
  return async (input, init) => {
    const combined = combineAbortSignals(init?.signal, signal);
    if (!combined) return fetchImpl(input, init);
    let response: Response;
    try {
      response = await fetchImpl(input, { ...init, signal: combined.signal });
    } catch (error) {
      // No body to wait for, so this request really is over.
      combined.dispose();
      throw error;
    }
    return disposeAfterBodyRead(response, combined.dispose);
  };
};
