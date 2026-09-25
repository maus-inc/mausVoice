import type { CustomFetch } from "@maus-inc/voice-ai";

/**
 * Signal that aborts when either input aborts. Uses `AbortSignal.any` where
 * the webview has it (older WebKit does not) and links manually otherwise.
 */
export const combineAbortSignals = (
  first: AbortSignal | null | undefined,
  second: AbortSignal | null | undefined,
): AbortSignal | undefined => {
  if (!first || !second) return first ?? second ?? undefined;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([first, second]);
  }
  const controller = new AbortController();
  const forward = (source: AbortSignal) => () =>
    controller.abort(source.reason);
  for (const source of [first, second]) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    source.addEventListener("abort", forward(source), { once: true });
  }
  return controller.signal;
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
  return (input, init) =>
    fetchImpl(input, {
      ...init,
      signal: combineAbortSignals(init?.signal, signal),
    });
};
