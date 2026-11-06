import { type DependencyList, useEffect, useRef, useState } from "react";

import { getLogger } from "../utils/log.utils";

export const useOnExit = (callback: () => void) => {
  useEffect(() => {
    return () => {
      callback();
    };
  }, []);
};

export const useKeyDownHandler = (args: {
  keys?: string[];
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  callback?: (event: KeyboardEvent) => void;
}): void => {
  const { keys, shift, ctrl, meta, alt, callback: downHandler } = args;

  const downRef = useRef<typeof downHandler>(downHandler);
  const lastMatchRef = useRef<string | null>(null);

  useEffect(() => {
    downRef.current = downHandler;
  }, [downHandler]);

  useEffect(() => {
    const matchesKey = (e: KeyboardEvent) =>
      keys ? keys.some((k) => k.toLowerCase() === e.key.toLowerCase()) : true;

    const modifiersMatch = (e: KeyboardEvent) => {
      if (shift !== undefined && e.shiftKey !== shift) return false;
      if (ctrl !== undefined && e.ctrlKey !== ctrl) return false;
      if (meta !== undefined && e.metaKey !== meta) return false;
      if (alt !== undefined && e.altKey !== alt) return false;
      return true;
    };

    const keydownListener = (e: KeyboardEvent) => {
      if (!matchesKey(e)) return;
      if (!modifiersMatch(e)) return;
      lastMatchRef.current = e.key;
      downRef.current?.(e);
    };

    if (downRef.current) {
      window.addEventListener("keydown", keydownListener);
    }

    return () => {
      window.removeEventListener("keydown", keydownListener);
    };
  }, [keys, shift, ctrl, meta, alt]);
};

type IntervalCallback = () => void;

const useInterval = (
  delay: number,
  callback: IntervalCallback,
  dependencies: DependencyList,
) => {
  const savedCallback = useRef<IntervalCallback>(null);
  const intervalIdRef = useRef<NodeJS.Timeout>(null);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    // Every consumer of this hook is a background refresh (config, tokens,
    // permissions, heartbeats, countdowns). None of it is observable while the
    // window is hidden, so ticking then only burns CPU and wakes IPC for
    // nothing — skip the tick and fire once immediately when the app returns.
    const isHidden = () =>
      typeof document !== "undefined" && document.visibilityState === "hidden";

    function tick() {
      if (isHidden()) {
        return;
      }
      if (savedCallback.current) {
        savedCallback.current();
      }
    }

    tick();

    if (intervalIdRef.current) clearInterval(intervalIdRef.current);
    intervalIdRef.current = setInterval(tick, delay);

    const onVisibilityChange = () => {
      if (!isHidden()) {
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      if (intervalIdRef.current) clearInterval(intervalIdRef.current);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [delay, ...dependencies]);
};

/**
 * Run an async callback on an interval, never overlapping runs.
 *
 * A rejection is caught and logged here rather than left to escape. `tick` is
 * invoked synchronously on mount and again from `setInterval`, and neither
 * awaits, so a rejecting callback produced an unhandled rejection: on mount, and
 * then once per interval for the life of the component. That is not theoretical
 * for the session heartbeat, whose callback awaits a Firebase write that rejects
 * when the backend refuses or is unreachable -- so an offline machine produced a
 * periodic unhandled rejection, while the very similar write a few lines above it
 * in the same file already had a `.catch`.
 *
 * Catching centrally is what makes that class safe for every caller rather than
 * something each one has to remember; swallowing silently is not the
 * alternative, hence the log.
 */
export const useIntervalAsync = (
  delay: number,
  callback: () => Promise<void>,
  dependencies: DependencyList,
) => {
  const running = useRef(false);
  useInterval(
    delay,
    async () => {
      if (running.current) return;
      running.current = true;
      try {
        await callback();
      } catch (error) {
        getLogger().warning(`useIntervalAsync callback failed: ${error}`);
      } finally {
        running.current = false;
      }
    },
    dependencies,
  );
};

type EffectCallback = () => void | (() => void);

export const useEffectDebounced = (
  delay: number,
  effect: () => void | (() => void),
  deps: DependencyList,
): void => {
  const callback = useRef<EffectCallback>(effect);
  const timer = useRef<NodeJS.Timeout>(null);

  useEffect(() => {
    callback.current = effect;
  }, [effect]);

  useEffect(() => {
    const execute = () => {
      callback.current();
    };

    if (timer.current) {
      clearTimeout(timer.current);
    }

    timer.current = setTimeout(execute, delay);

    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    };
  }, [delay, ...deps]);
};

export function useWindowSize() {
  const [windowSize, setWindowSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  useEffect(() => {
    function handleResize() {
      setWindowSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return windowSize;
}
