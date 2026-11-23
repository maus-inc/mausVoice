import { useEffect, useMemo, useState, type RefObject } from "react";
import {
  buildWaveformOutline,
  DEFAULT_WAVEFORM_BAR_COUNT,
  MAX_COMPUTED_BAR_COUNT,
  MIN_COMPUTED_BAR_COUNT,
  MIN_WAVEFORM_BAR_VALUE,
  WAVEFORM_BAR_GAP,
  WAVEFORM_BAR_MAX_WIDTH,
  WAVEFORM_BAR_MIN_WIDTH,
} from "../../utils/audio-playback.utils";

const getDesiredBarCount = (width: number): number => {
  if (width <= 0) {
    return DEFAULT_WAVEFORM_BAR_COUNT;
  }

  const approximateCount = Math.floor(
    (width + WAVEFORM_BAR_GAP) / (WAVEFORM_BAR_MIN_WIDTH + WAVEFORM_BAR_GAP),
  );
  return Math.max(
    MIN_COMPUTED_BAR_COUNT,
    Math.min(MAX_COMPUTED_BAR_COUNT, approximateCount),
  );
};

const getWaveformBars = (
  values: number[],
  barCount: number,
): number[] =>
  values.length
    ? values
    : Array.from({ length: barCount }, () => MIN_WAVEFORM_BAR_VALUE);

const getBarWidth = (width: number, barCount: number): number => {
  if (width <= 0 || barCount === 0) {
    return WAVEFORM_BAR_MIN_WIDTH;
  }

  const totalGaps = WAVEFORM_BAR_GAP * Math.max(barCount - 1, 0);
  const availableForBars = Math.max(width - totalGaps, 0);
  return Math.max(
    WAVEFORM_BAR_MIN_WIDTH,
    Math.min(WAVEFORM_BAR_MAX_WIDTH, availableForBars / barCount),
  );
};

/** Bars are a seeded silhouette sized to the track, not live PCM. */
export const useWaveformLayout = ({
  transcriptionId,
  durationMs,
  containerRef,
}: {
  transcriptionId: string;
  durationMs: number | null | undefined;
  containerRef: RefObject<HTMLDivElement | null>;
}): { bars: number[]; barWidth: number } => {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const updateWidth = () => {
      setWidth(element.getBoundingClientRect().width);
    };
    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      if (typeof window !== "undefined") {
        window.addEventListener("resize", updateWidth);
        return () => window.removeEventListener("resize", updateWidth);
      }
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [transcriptionId, containerRef]);

  const barCount = useMemo(() => getDesiredBarCount(width), [width]);
  const values = useMemo(
    () => buildWaveformOutline(transcriptionId, durationMs, barCount),
    [barCount, durationMs, transcriptionId],
  );
  const bars = useMemo(
    () => getWaveformBars(values, barCount),
    [barCount, values],
  );
  const barWidth = useMemo(
    () => getBarWidth(width, bars.length),
    [bars.length, width],
  );

  return { bars, barWidth };
};
