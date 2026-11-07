import { getLogger } from "./log.utils";

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
        getLogger().warning(
          `${context} failed after its own error UI: ${error}`,
        );
      } catch {
        // The native log bridge is unavailable (tests, shutdown): stay silent
        // rather than converting a handled failure into a new rejection.
      }
    })
    .catch(() => undefined);
};
