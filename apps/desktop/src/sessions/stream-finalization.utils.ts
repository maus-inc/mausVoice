import { getLogger } from "../utils/log.utils";

export type StreamFinalizationState = {
  resolver: ((text: string) => void) | null;
  timeout: ReturnType<typeof setTimeout> | null;
};

/** Complete a pending stream exactly once, even if cleanup synchronously closes it. */
export const completeStreamFinalization = (
  state: StreamFinalizationState,
  cleanup: () => void,
  getText: () => string,
  loggerPrefix: string,
): void => {
  if (state.timeout !== null) {
    clearTimeout(state.timeout);
    state.timeout = null;
  }
  const resolve = state.resolver;
  if (!resolve) return;
  getLogger().verbose(
    `[${loggerPrefix}] Completing finalize with transcript length:`,
    getText().length,
  );
  // Cleanup may synchronously dispatch a close callback, so take ownership of
  // the resolver before closing rather than settling it twice recursively.
  state.resolver = null;
  cleanup();
  resolve(getText());
};
