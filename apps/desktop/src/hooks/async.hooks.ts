import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DependencyList,
} from "react";
import { AsyncData } from "../types/async.types";

/** Default safety timeout for async data loads, in milliseconds. */
const ASYNC_DATA_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Load async data for a component with lifecycle safety:
 *
 * - Concurrent calls to `refresh` (or rapid dep changes) cancel previous
 *   in-flight promises: only the most recent call may update state, so we
 *   cannot surface stale data from an older request that resolved late.
 * - Unmounting cancels any pending state update — React strict mode,
 *   component teardown, and route changes cannot leak setState calls on
 *   unmounted components (which produce the "can't perform a React state
 *   update on an unmounted component" warning and hide logic bugs).
 * - The safety timeout is tied to each individual call and is cleared on
 *   completion *and* on cancel/unmount, so a stale timeout from an earlier
 *   call cannot flip a newer call into an error state.
 */
export const useAsyncData = <T>(
  promise: () => Promise<T>,
  deps: DependencyList,
  opts: { timeoutMs?: number } = {},
): AsyncData<T> => {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const timeoutMs = opts.timeoutMs ?? ASYNC_DATA_DEFAULT_TIMEOUT_MS;

  // Monotonic generation counter. Each in-flight load captures its own
  // generation and only updates state if it still matches the latest
  // generation at settle time. This is the standard "stale closure" fix
  // for async effects (see e.g. the React docs on fetching with effects).
  const generationRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingTimeout = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  // Cancel any in-flight call without touching state. Used by cleanup
  // and by re-entry so a newer call supersedes an older one.
  const cancelInFlight = useCallback(() => {
    generationRef.current += 1;
    clearPendingTimeout();
  }, []);

  const refresh = useCallback(async () => {
    const myGeneration = ++generationRef.current;
    clearPendingTimeout();

    setLoading(true);
    setError("");

    // Per-call safety timeout. Timed-out calls bump the generation so a
    // late-resolving promise from this same call cannot resurrect state.
    timeoutRef.current = setTimeout(() => {
      if (generationRef.current !== myGeneration) return;
      generationRef.current += 1;
      setError("Request timed out");
      setLoading(false);
    }, timeoutMs);

    let settled = false;
    try {
      const result = await promise();
      if (generationRef.current !== myGeneration) return;
      setData(result);
      settled = true;
    } catch (err) {
      if (generationRef.current !== myGeneration) return;
      setError(String(err));
      settled = true;
    }
    // We only reach this point if this generation is still the active one,
    // because both branches above return early on a stale generation. So
    // it is safe to clear the timeout and flip loading off without any
    // control flow inside a `finally` block.
    if (settled && generationRef.current === myGeneration) {
      clearPendingTimeout();
      setLoading(false);
    }
    // Intentionally omit `timeoutMs` from dep list: it's an options knob
    // that is intended to be a constant per call-site; dynamic values
    // should be passed via deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    refresh();

    return () => {
      // Cancel: bump generation so any in-flight promise / timeout cannot
      // mutate state after the effect tears down.
      cancelInFlight();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  if (loading) {
    return { state: "loading", refresh };
  } else if (error) {
    return { state: "error", error, refresh };
  }

  return { state: "success", data: data as T, refresh };
};

export const useAsyncEffect = (
  effect: () => Promise<(() => void) | void>,
  deps: DependencyList,
): void => {
  const cleanupRef = useRef<(() => void) | void>(undefined);
  const runningRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      // Wait for any previous effect to complete before running cleanup
      if (runningRef.current) {
        await runningRef.current;
      }

      // Run the previous cleanup if it exists
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = undefined;
      }

      if (cancelled) return;

      // Run the new effect and store its cleanup
      const cleanup = await effect();
      if (!cancelled) {
        cleanupRef.current = cleanup;
      } else if (cleanup) {
        // If cancelled while effect was running, clean up immediately
        cleanup();
      }
    };

    runningRef.current = run();

    return () => {
      cancelled = true;
      // Schedule cleanup to run after current effect completes
      runningRef.current?.then(() => {
        if (cleanupRef.current) {
          cleanupRef.current();
          cleanupRef.current = undefined;
        }
      });
    };
  }, deps);
};
