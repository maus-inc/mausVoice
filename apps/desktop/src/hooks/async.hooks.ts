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

export type AsyncDataSink<T> = {
  setLoading: (loading: boolean) => void;
  setError: (error: string) => void;
  setData: (data: T) => void;
};

/**
 * Generation + timeout state machine used by `useAsyncData`. Extracted so
 * the real control flow can be unit-tested without mounting React.
 */
export class AsyncDataController<T> {
  generation = 0;
  private timeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sink: AsyncDataSink<T>,
    private readonly defaultTimeoutMs: number,
  ) {}

  clearPendingTimeout(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  cancelInFlight(): void {
    this.generation += 1;
    this.clearPendingTimeout();
  }

  /**
   * Run `promise`, guarded by `timeoutMs` (defaults to the timeout given at
   * construction). The timeout is taken per call so a caller whose option
   * changes is not stuck with the value it first passed.
   */
  async run(
    promise: () => Promise<T>,
    timeoutMs: number = this.defaultTimeoutMs,
  ): Promise<void> {
    const myGeneration = ++this.generation;
    this.clearPendingTimeout();

    this.sink.setLoading(true);
    this.sink.setError("");

    this.timeout = setTimeout(() => {
      if (this.generation !== myGeneration) return;
      this.generation += 1;
      this.sink.setError("Request timed out");
      this.sink.setLoading(false);
    }, timeoutMs);

    let settled = false;
    try {
      const result = await promise();
      if (this.generation !== myGeneration) return;
      this.sink.setData(result);
      settled = true;
    } catch (err) {
      if (this.generation !== myGeneration) return;
      this.sink.setError(String(err));
      settled = true;
    }
    if (settled && this.generation === myGeneration) {
      this.clearPendingTimeout();
      this.sink.setLoading(false);
    }
  }
}

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

  // `useState` setters keep a stable identity for the component's whole
  // lifetime, so the controller can hold them directly. No sink ref — and
  // therefore no ref write during render, which React disallows.
  const controllerRef = useRef<AsyncDataController<T> | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new AsyncDataController(
      { setLoading, setError, setData },
      timeoutMs,
    );
  }
  const controller = controllerRef.current;

  const refresh = useCallback(async () => {
    await controller.run(promise, timeoutMs);
    // `timeoutMs` is part of the dep list so a changed option applies to the
    // next load instead of being frozen at mount. The effect below still
    // reruns on `deps` only, so changing the timeout does not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, timeoutMs]);

  useEffect(() => {
    refresh();

    return () => {
      controller.cancelInFlight();
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
