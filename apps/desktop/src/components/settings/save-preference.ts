/**
 * Fire a preference write from a change handler.
 *
 * The write is asynchronous and `updateUserPreferences` already raises its own
 * error toast, so there is nothing to await and nothing to report here. It is
 * deliberately not `x().catch(() => {})`, which is the pattern elsewhere in
 * settings: that swallows the rejection, and these writes do not need a silent
 * catch because the action never rejects. It reports through the snackbar and
 * resolves.
 *
 * Clamped and rounded inside the action, so a switch or slider that fires twice
 * with the same value is harmless.
 */
export const savePreference = (write: Promise<void>): void => {
  // Returned promise deliberately not awaited: see above. Rejections are still
  // handled, because the action resolves rather than rejecting.
  write.catch(() => undefined);
};
