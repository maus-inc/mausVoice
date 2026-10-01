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
// The real plugin resolves with a detach function; there is no console bridge
// to attach in the browser, but the async shape is kept for parity.
export const attachConsole = (): Promise<() => void> =>
  Promise.resolve(() => undefined);
