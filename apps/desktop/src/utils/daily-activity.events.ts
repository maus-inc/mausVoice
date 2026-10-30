export const DAILY_ACTIVITY_CHANGED_EVENT = "mausvoice:daily-activity-changed";

/** Notify mounted dashboard surfaces after a usage event commits. */
export const notifyDailyActivityChanged = (): void => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(DAILY_ACTIVITY_CHANGED_EVENT));
};

export const subscribeToDailyActivityChanges = (
  listener: () => void,
): (() => void) => {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(DAILY_ACTIVITY_CHANGED_EVENT, listener);
  return () =>
    window.removeEventListener(DAILY_ACTIVITY_CHANGED_EVENT, listener);
};
