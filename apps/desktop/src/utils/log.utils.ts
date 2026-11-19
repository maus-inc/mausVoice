import {
  info as tauriInfo,
  warn as tauriWarn,
  error as tauriError,
  debug as tauriDebug,
  attachConsole,
} from "@tauri-apps/plugin-log";
import { redactObjectSync, redactStringValue } from "./redaction.utils";
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
 * A primitive and null are rendered as they stand. Every other value is masked,
 * a top level array included, so a sensitive key at any depth inside one is
 * masked by the same rules that already reach an array nested in a record.
 * A value that renders itself through toJSON stays a leaf, and the traversal
 * resolves and redacts that rendered form rather than walking own properties.
 */
const isMaskable = (value: unknown): value is object => {
  return value !== null && typeof value === "object";
};

const serializeForLog = (value: unknown): string => {
  // JSON.stringify of the raw value is the pre-existing gate for a throwing
  // toJSON and for a circular graph. It has to run before the masker, which
  // reads own enumerable properties only and would otherwise turn a hostile
  // shape into an empty object that then gets logged.
  const raw = JSON.stringify(value);
  if (!isMaskable(value)) return raw;
  try {
    // redactObjectSync types its argument as a record, the shape a caller
    // hands it most often. Its traversal reaches an array through the same
    // branch and returns the shape it was given, so a top level array still
    // renders as a JSON array and the assertion matches how the call runs.
    return JSON.stringify(redactObjectSync(value as Record<string, unknown>));
  } catch {
    return REDACTION_FAILED;
  }
};

const stringify = (args: unknown[]): string =>
  args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      // An Error reaches the sink as its own stack, so it skips `serializeForLog`
      // and therefore skipped the masker entirely: the same secret that is
      // `[redacted-secret]` inside an object was logged verbatim whenever a caller
      // passed the failure itself. Scrub the text in place so the stack survives.
      if (arg instanceof Error)
        return redactStringValue(arg.stack ?? arg.message);
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
    // The message can carry a provider key in a fetch failure, and this handler is
    // the one place an uncaught error is rendered without going through `stringify`,
    // so it is scrubbed here too. Scope worth stating: `redactStringValue` matches
    // prefixed key shapes (`sk-`, `gsk-`, `ghp_`, ...), so a credential carried in a
    // query parameter or a header is still not matched. Widening that pattern is a
    // change to the shared scrubber, not to this call site.
    logger.error(
      `Uncaught error: ${redactStringValue(error?.message ?? "unknown")} at ${source}:${lineno}:${colno}`,
    );
  };

  window.onunhandledrejection = (event) => {
    // `String(reason)` is evaluated while the argument is being built, and it
    // throws for an object whose `toString` throws. That escape would leave this
    // handler and surface as an unhandled error in the error handler, so the
    // rendering is done first and on its own terms.
    let rendered: string;
    try {
      rendered =
        event.reason instanceof Error
          ? (event.reason.stack ?? event.reason.message)
          : String(event.reason);
    } catch {
      rendered = "[reason could not be rendered]";
    }
    logger.error(`Unhandled rejection: ${redactStringValue(rendered)}`);
  };
};
