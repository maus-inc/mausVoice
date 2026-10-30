/** Native process lifecycle is deliberately unavailable in a browser tab. */
// `relaunch` and `exit` resolve only after the OS acts in the real plugin, so
// these keep their promise signatures.
export const relaunch = (): Promise<void> => Promise.resolve();
export const exit = (_code = 0): Promise<void> => Promise.resolve();
