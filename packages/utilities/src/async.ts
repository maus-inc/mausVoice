import { chunkify } from "./collections";
import { HttpError, isTerminalHttpStatus, readHttpStatus } from "./http-error";

/**
 * The caller's abort reason, or a plain error for a runtime that leaves
 * `AbortSignal.reason` undefined. The reason is passed through unchanged so the
 * caller still sees its own abort value.
 */
const readAbortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new Error("The retry wait was aborted.");

/**
 * Wait `ms` milliseconds.
 *
 * When a caller supplies `signal`, the wait rejects with the signal's abort
 * reason the moment it fires, so a cancelled rate-limited request stops
 * waiting instead of sitting out a hint the caller no longer wants.
 *
 * Blast radius: the `signal` parameter is optional and additive. Every
 * existing call site passes only `ms` and keeps the unconditional resolve, and
 * a caller that passes an already-aborted signal is the only new behaviour
 * besides the abort listener.
 */
export const delayed = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (!signal) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    return Promise.reject(readAbortReason(signal));
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(readAbortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

/** True when another attempt would repeat the same rejected request. */
const isTerminalFailure = (error: unknown): boolean => {
  const status = readHttpStatus(error);
  return status !== undefined && isTerminalHttpStatus(status);
};

/**
 * A server that sent `Retry-After` sets the pace, but never faster than the
 * caller's own delay, and never below zero.
 */
const getRetryDelayMs = (error: unknown, fallbackMs: number): number => {
  const hintedMs = error instanceof HttpError ? error.retryAfterMs : null;
  return hintedMs === null ? fallbackMs : Math.max(fallbackMs, hintedMs);
};

export const retry = async <T>(args: {
  fn: () => Promise<T>;
  retries?: number;
  delay?: number;
  /**
   * Return false for failures another attempt cannot fix. This narrows the
   * default policy; it cannot widen it, because a terminal HTTP status is
   * rejected before the predicate is consulted.
   */
  isRetryable?: (error: unknown) => boolean;
  /**
   * Retry statuses the helper otherwise treats as terminal. Only for a caller
   * that genuinely expects a 4xx to clear on its own.
   */
  retryTerminalStatuses?: boolean;
  /**
   * Aborts the wait between attempts, which is where a rate-limited retry can
   * otherwise sit for the whole server-provided `Retry-After` hint after the
   * caller has already given up. Optional and additive: a caller that omits it
   * keeps the old unconditional wait. The attempt itself is still `fn`'s
   * responsibility, so a caller that cancels mid-request should pass the same
   * signal to its own call.
   */
  signal?: AbortSignal;
}): Promise<T> => {
  const {
    fn,
    retries = 3,
    delay = 20,
    isRetryable,
    retryTerminalStatuses = false,
    signal,
  } = args;
  const shouldRetry = (error: unknown): boolean => {
    if (!retryTerminalStatuses && isTerminalFailure(error)) {
      return false;
    }
    return isRetryable ? isRetryable(error) : true;
  };
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (!shouldRetry(error)) {
        throw error;
      }
      if (i >= retries - 1) {
        throw error;
      }
      await delayed(getRetryDelayMs(error, delay), signal);
      // Re-check after the wait. A caller that passed `signal` above has
      // already left the loop if it aborted, so this covers a caller that
      // signals through its own predicate instead. Skipping this check would
      // still run the next fn() after the deadline.
      if (!shouldRetry(error)) {
        throw error;
      }
    }
  }

  throw new Error("Retry limit exceeded");
};

export const batchAsync = async <T = void>(
  size: number,
  promises: (() => Promise<T>)[],
): Promise<T[]> => {
  const chunked = chunkify(promises, size);
  const results: T[] = [];
  for (const chunk of chunked) {
    const chunkResults = await Promise.all(chunk.map((fn) => fn()));
    results.push(...chunkResults);
  }
  return results;
};
