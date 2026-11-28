let enabled = false;

// The real autostart plugin resolves after the OS confirms the change; the
// shim resolves immediately but keeps the same promise-returning signatures.
export const enable = (): Promise<void> => {
  enabled = true;
  return Promise.resolve();
};
export const disable = (): Promise<void> => {
  enabled = false;
  return Promise.resolve();
};
export const isEnabled = (): Promise<boolean> => Promise.resolve(enabled);
