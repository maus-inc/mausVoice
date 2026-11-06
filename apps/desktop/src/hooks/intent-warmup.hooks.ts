import { useCallback, useEffect, useRef } from "react";

export const INTENT_DELAY_MS = 150;

export const useIntentWarmup = (warm: () => Promise<unknown>, key: string) => {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const start = useCallback(() => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void warm().catch(() => undefined);
    }, INTENT_DELAY_MS);
  }, [cancel, warm]);
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
