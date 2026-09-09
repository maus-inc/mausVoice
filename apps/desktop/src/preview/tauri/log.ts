const write = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
): Promise<void> => {
  console[level](`[mausVoice preview] ${message}`);
  return Promise.resolve();
};

export const debug = (message: string): Promise<void> =>
  write("debug", message);
export const info = (message: string): Promise<void> => write("info", message);
export const warn = (message: string): Promise<void> => write("warn", message);
export const error = (message: string): Promise<void> =>
  write("error", message);
export const attachConsole = async (): Promise<() => void> => () => undefined;
