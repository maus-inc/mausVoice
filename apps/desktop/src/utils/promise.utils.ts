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
  void promise.catch((error: unknown) => {
    getLogger().warning(`${context} failed after its own error UI: ${error}`);
  });
};
