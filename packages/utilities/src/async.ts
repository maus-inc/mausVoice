import { chunkify } from "./collections";
import { HttpError, isTerminalHttpStatus, readHttpStatus } from "./http-error";

export const delayed = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
}): Promise<T> => {
  const {
    fn,
    retries = 3,
    delay = 20,
    isRetryable,
    retryTerminalStatuses = false,
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
      await delayed(getRetryDelayMs(error, delay));
      // Re-check after the wait. The caller may abort during the delay, and
      // isRetryable often reads signal.aborted. Skipping this check would
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
