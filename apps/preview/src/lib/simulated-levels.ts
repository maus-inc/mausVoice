import { useCallback, useEffect, useRef, useState } from "react";

export const simulatedLevels = (count: number, frame: number): number[] =>
  Array.from({ length: count }, (_, sample) =>
    Math.abs(Math.sin((sample + frame) * 0.73) * Math.cos(frame * 0.19)),
  );

export const useSimulatedLevels = (
  count: number,
  intervalMs: number,
  durationMs: number,
) => {
  const [levels, setLevels] = useState<number[]>([]);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const feed = useCallback(() => {
    cleanup.current?.();
    let frame = 0;
    const interval = setInterval(() => {
      setLevels(simulatedLevels(count, frame++));
    }, intervalMs);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      setLevels([]);
    }, durationMs);
    cleanup.current = () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [count, intervalMs, durationMs]);

  return { levels, feed };
};
