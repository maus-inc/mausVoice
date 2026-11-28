import { useCallback, useEffect, useRef } from "react";

export const INTENT_DELAY_MS = 150;

/**
 * Hover-intent delay for sidebar route warmup, in milliseconds.
 *
 * 150ms is right for cheap, throttled audio warmup on the pill itself. Route
 * warmup runs while the pointer travels across the sidebar, so the threshold
 * has to outlast incidental flyovers. 400ms is the value the native contract
 * spec measures against (event after a 400ms hover, silence after a brief
 * flyover); revisit against ResourceTiming data if route chunks change.
 */
export const ROUTE_WARMUP_DELAY_MS = 400;

/**
 * Returns pointer/focus handlers that run `warm` after a dwell long enough to
 * signal intent. Leaving, blurring, unmounting, or changing `key` (the
 * sidebar's location key — so navigating away) cancels a pending timer before
 * it fires. Touch pointers never warm: there is no hover intent on touch.
 */
export const useIntentWarmup = (
  warm: () => Promise<unknown>,
  key: string,
  delayMs: number = INTENT_DELAY_MS,
) => {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const start = useCallback(() => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = undefined;
      warm().catch(() => undefined);
    }, delayMs);
  }, [cancel, warm, delayMs]);
  useEffect(() => cancel, [cancel, key, warm]);
  return {
    onPointerEnter: (event: React.PointerEvent) => {
      if (event.pointerType !== "touch") start();
    },
    onPointerLeave: cancel,
    onFocus: start,
    onBlur: cancel,
  };
};
