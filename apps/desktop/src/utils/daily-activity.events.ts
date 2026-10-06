type Listener = () => void;

const listeners = new Set<Listener>();

/** Refresh the Home heatmap after a successful idempotent word-meter write. */
export const requestDailyActivityRefresh = (): void => {
  for (const listener of listeners) listener();
};

export const subscribeToDailyActivityRefresh = (
  listener: Listener,
): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
