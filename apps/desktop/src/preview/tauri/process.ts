/** Native process lifecycle is deliberately unavailable in a browser tab. */
export const relaunch = async (): Promise<void> => undefined;
export const exit = async (_code = 0): Promise<void> => undefined;
