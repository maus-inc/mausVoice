import {
  info as tauriInfo,
  warn as tauriWarn,
  error as tauriError,
  debug as tauriDebug,
  attachConsole,
} from "@tauri-apps/plugin-log";
type Logger = {
  info(...args: unknown[]): void;
  warning(...args: unknown[]): void;
  error(...args: unknown[]): void;
  verbose(...args: unknown[]): void;
  stopwatch<T>(label: string, fn: () => Promise<T>): Promise<T>;
};

/**
 * Redacts the values of the named query parameters in a URL before it is
 * logged. Vocabulary parameters such as Deepgram `keyterm` and ElevenLabs
 * `keyterms` carry the user's dictionary terms, and auth tokens must never
 * reach the log either. Parameters without a value keep their name only.
 */
export const redactQueryParamValues = (
  url: string,
  paramNames: string[],
): string => {
  try {
    const parsed = new URL(url);
    for (const name of paramNames) {
      const count = parsed.searchParams.getAll(name).length;
      if (count > 0) {
        parsed.searchParams.delete(name);
        for (let i = 0; i < count; i++) {
          parsed.searchParams.append(name, "***");
        }
      }
    }
    return parsed.href;
  } catch {
    return url;
  }
};

const stringify = (args: unknown[]): string =>
  args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack ?? arg.message;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");

const writeSafely = (
  write: (message: string) => Promise<void>,
  args: unknown[],
): void => {
  try {
    // Logging is best-effort. In particular, a failure in the native sink must
    // not trigger onunhandledrejection and recursively log to the same sink.
    void write(stringify(args)).catch(() => undefined);
  } catch {
    // Argument coercion or a synchronous sink failure must not break the app.
    // Do not use console here: attachConsole can route it back to this sink.
  }
};

const logger: Logger = {
  info(...args: unknown[]) {
    writeSafely(tauriInfo, args);
  },
  warning(...args: unknown[]) {
    writeSafely(tauriWarn, args);
  },
  error(...args: unknown[]) {
    writeSafely(tauriError, args);
  },
  verbose(...args: unknown[]) {
    writeSafely(tauriDebug, args);
  },
  stopwatch<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    return fn()
      .then((result) => {
        const duration = Date.now() - start;
        this.info(`${label} completed in ${duration}ms`);
        return result;
      })
      .catch((error) => {
        const duration = Date.now() - start;
        this.error(`${label} failed in ${duration}ms`, error);
        throw error;
      });
  },
};

export const getLogger = (): Logger => logger;

export const initLogging = async (): Promise<void> => {
  await attachConsole();

  window.onerror = (_event, source, lineno, colno, error) => {
    logger.error(
      `Uncaught error: ${error?.message ?? "unknown"} at ${source}:${lineno}:${colno}`,
    );
  };

  window.onunhandledrejection = (event) => {
    logger.error(`Unhandled rejection: ${event.reason}`);
  };
};
