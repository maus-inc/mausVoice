import {
  info as tauriInfo,
  warn as tauriWarn,
  error as tauriError,
  debug as tauriDebug,
  attachConsole,
} from "@tauri-apps/plugin-log";
import { redactObjectSync } from "./redaction.utils";
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

/**
 * Stands in for an object argument when masking faults. The value is withheld
 * because the masker stopped part way through and cannot say which of its
 * fields were sensitive, and the line is still written so the caller sees the
 * failure instead of losing the record. A logger must not throw either, since
 * that would take down the error the caller was trying to report.
 */
const REDACTION_FAILED = "[redaction-failed]";

/**
 * Only a top level record is masked. A primitive, null, or a top level array
 * is rendered by JSON.stringify as it stands, so a top level array keeps its
 * elements unmasked. That is what the logger did before the masker existed,
 * and masking a top level array is tracked as a follow up. An array nested
 * inside a record is masked by the traversal itself.
 */
const isMaskableObject = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === "object" && !Array.isArray(value);
};

const serializeForLog = (value: unknown): string => {
  // JSON.stringify of the raw value is the pre-existing gate for a throwing
  // toJSON and for a circular graph. It has to run before the masker, which
  // reads own enumerable properties only and would otherwise turn a hostile
  // shape into an empty object that then gets logged.
  const raw = JSON.stringify(value);
  if (!isMaskableObject(value)) return raw;
  try {
    return JSON.stringify(redactObjectSync(value));
  } catch {
    return REDACTION_FAILED;
  }
};

const stringify = (args: unknown[]): string =>
  args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack ?? arg.message;
      try {
        return serializeForLog(arg);
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
