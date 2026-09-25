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

/**
 * Wraps a provider fetch so every request it makes (including SDK retries)
 * is also cancelled by `signal`. Returns `fetchImpl` unchanged without one.
 */
export const withAbortSignal = (
  fetchImpl: CustomFetch,
  signal: AbortSignal | undefined,
): CustomFetch => {
  if (!signal) return fetchImpl;
  return async (input, init) => {
    const combined = combineAbortSignals(init?.signal, signal);
    if (!combined) return fetchImpl(input, init);
    try {
      return await fetchImpl(input, { ...init, signal: combined.signal });
    } finally {
      combined.dispose();
    }
  };
};
