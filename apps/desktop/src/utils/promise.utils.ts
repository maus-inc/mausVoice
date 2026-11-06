import { getLogger } from "./log.utils";

/**
 * Start `start` on this tick and hand back the promise it produces, converting
 * a synchronous throw into a rejection so callers have a single failure path.
 *
 * The async arrow body runs synchronously up to `start()`'s first `await`
 * boundary, so the work still begins here -- unlike `Promise.resolve()
 * .then(start)`, which pushes it to a later microtask and can reorder it behind
 * state written by the caller.
 */
export const startAsPromise = <T>(start: () => Promise<T>): Promise<T> =>
  (async () => start())();

/**
 * Fire-and-forget for action promises that already surface their own error UI
 * (snackbar/toast) and log. The action contract rethrows so explicit awaiters
 * can handle failures; UI event handlers that intentionally `void` the call
 * would otherwise leak an unhandled rejection. This wrapper converts the
 * rejection into a plain log line.
 *
 * Do NOT use this to hide failures from code that needs the error; it is for
 * "the snackbar already told the user" call sites.
 */
export const logOnRejection = (
  promise: Promise<unknown>,
  context: string,
): void => {
  // Both catches: promise.catch's handler rejects again if the logger itself
  // throws (that secondary rejection would be unhandled). Guard the log call
  // and clear the chain so this helper can never manufacture a rejection.
  void promise
    .catch((error: unknown) => {
      try {
        getLogger().warning(`${context} failed: ${error}`);
      } catch {
        // The native log bridge is unavailable (tests, shutdown): stay silent
        // rather than converting a handled failure into a new rejection.
      }
    })
    .catch(() => undefined);
};

/**
 * Capture a synchronous throw from `start` so a call site can branch on it
 * without a `try` block. Nothing is awaited and no tick is added: `start` runs
 * exactly when this is called, which matters where the caller must undo state
 * synchronously (releasing a lease before a reentrant successor can observe it).
 */
export const captureSyncThrow = <T>(
  start: () => T,
): { ok: true; value: T } | { ok: false; error: unknown } => {
  try {
    return { ok: true, value: start() };
  } catch (error) {
    return { ok: false, error };
  }
};
