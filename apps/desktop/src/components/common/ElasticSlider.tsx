import {
  Box,
  Slider as MuiSlider,
  type SliderProps,
  type SxProps,
  type Theme,
  useTheme,
} from "@mui/material";
import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import {
  type SliderCommitQueue,
  createSliderCommitQueue,
} from "./slider-commit-queue";

export type ElasticSliderProps = {
  /**
   * The persisted value. The thumb follows this until the user starts
   * dragging; while dragging, the local drag value owns the thumb so it
   * tracks the pointer 1:1 (persisting on every `onChange` was what made the
   * thumb lag behind the cursor on loaded machines).
   */
  value: number;
  /** Called once when the drag commits (release / keyboard change). */
  onCommit: (value: number) => void | Promise<void>;
  min?: number;
  max?: number;
  step?: number;
  valueLabelDisplay?: SliderProps["valueLabelDisplay"];
  valueLabelFormat?: (value: number) => string;
  ariaLabel?: string;
  disabled?: boolean;
  /**
   * Mirrors the displayed value during interaction and when it synchronizes
   * with persisted state, including after a failed commit or on mount.
   */
  onChangeDisplay?: (value: number) => void;
  sx?: SliderProps["sx"];
};

/**
 * MUI centers the horizontal thumb with `translate(-50%, -50%)`. A state
 * transform that omits it (e.g. a bare `scale`) replaces the centering
 * translate and drops the thumb down-right of its track anchor, so every
 * thumb state transform must re-compose it to keep the geometric center fixed.
 */
export const THUMB_CENTER_TRANSFORM = "translate(-50%, -50%)";

/**
 * The colour the track and the thumb ring are drawn with.
 *
 * `chrome`, not `primary`. The thumb is `#FFFFFF` in both schemes, and in dark
 * mode `primary.main` is white too, so a `primary.main` ring was white-on-white
 * and the slider lost the silver accent it is drawn with.
 */
export const elasticSliderAccent = (theme: {
  vars?: { palette?: { chrome?: string } };
  palette: { chrome: string };
}): string => theme.vars?.palette?.chrome ?? theme.palette.chrome;

/** Builds the MUI Slider `sx` for the ElasticSlider look. */
export const buildElasticSliderSx = (
  fill: string,
  rail: string,
): SxProps<Theme> => ({
  "& .MuiSlider-rail": {
    height: 4,
    borderRadius: 99,
    backgroundColor: rail,
    opacity: 1,
    transition: "height 160ms var(--ease-out-quint)",
  },
  "& .MuiSlider-track": {
    height: 4,
    borderRadius: 99,
    border: "none",
    backgroundColor: fill,
    transition: "height 160ms var(--ease-out-quint)",
  },
  "& .MuiSlider-thumb": {
    width: 16,
    height: 16,
    backgroundColor: "#FFFFFF",
    border: `2px solid ${fill}`,
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.25)",
    transition:
      "transform 160ms var(--ease-out-quint), box-shadow 160ms var(--ease-out-quint)",
    "&:hover": {
      transform: `${THUMB_CENTER_TRANSFORM} scale(1.15)`,
      boxShadow: `0 1px 4px rgba(0, 0, 0, 0.3), 0 0 0 6px color-mix(in srgb, ${fill} 14%, transparent)`,
    },
    "&.Mui-active": {
      transform: `${THUMB_CENTER_TRANSFORM} scale(1.25)`,
      boxShadow: `0 1px 4px rgba(0, 0, 0, 0.3), 0 0 0 8px color-mix(in srgb, ${fill} 18%, transparent)`,
    },
    "&.Mui-focusVisible": {
      boxShadow: `0 0 0 3px color-mix(in srgb, ${fill} 40%, transparent)`,
    },
  },
  "&:hover .MuiSlider-rail, &:hover .MuiSlider-track": {
    height: 6,
  },
});

/**
 * ElasticSlider — the ElasticSlider look (reactbits.dev) adapted to MUI and
 * the Maus Voice palette: flat rounded track with the accent fill, circular
 * white thumb with an accent ring that blooms on hover/drag, subtle spring
 * press feedback via framer-motion (static under reduced motion).
 *
 * Interaction contract: local state during drag, `onCommit` on release.
 */
export const ElasticSlider = ({
  value,
  onCommit,
  min = 0,
  max = 100,
  step = 1,
  valueLabelDisplay = "auto",
  valueLabelFormat,
  ariaLabel,
  disabled = false,
  onChangeDisplay,
  sx,
}: ElasticSliderProps) => {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const [dragValue, setDragValue] = useState(value);
  const [settled, setSettled] = useState(0);
  const draggingRef = useRef(false);
  const mountedRef = useRef(true);
  // Keep the latest callbacks and saved value available to queued handlers.
  const savedValueRef = useRef(value);
  const onCommitRef = useRef(onCommit);
  const onChangeDisplayRef = useRef(onChangeDisplay);
  const interactionRef = useRef(0);
  const commitQueueRef = useRef<SliderCommitQueue | null>(null);
  savedValueRef.current = value;
  onCommitRef.current = onCommit;
  onChangeDisplayRef.current = onChangeDisplay;

  const getCommitQueue = () => {
    commitQueueRef.current ??= createSliderCommitQueue({
      runCommit: (nextValue) => onCommitRef.current(nextValue),
      onRollback: (interaction) => {
        if (
          !mountedRef.current ||
          interaction !== interactionRef.current ||
          draggingRef.current
        ) {
          return;
        }
        const saved = savedValueRef.current;
        setDragValue(saved);
        onChangeDisplayRef.current?.(saved);
      },
      onSettled: () => {
        if (mountedRef.current) {
          setSettled((count) => count + 1);
        }
      },
    });
    return commitQueueRef.current;
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const accentFill = elasticSliderAccent(theme);
  const rail = theme.vars?.palette.level3 ?? theme.palette.level3;

  useEffect(() => {
    if (!draggingRef.current && getCommitQueue().getPendingCount() === 0) {
      setDragValue(value);
      onChangeDisplay?.(value);
    }
  }, [value, settled, onChangeDisplay]);

  const handleChange: SliderProps["onChange"] = (_event, next) => {
    const nextValue = typeof next === "number" ? next : (next[0] ?? value);
    draggingRef.current = true;
    interactionRef.current += 1;
    setDragValue(nextValue);
    onChangeDisplay?.(nextValue);
  };

  const handleCommit: SliderProps["onChangeCommitted"] = (_event, next) => {
    const nextValue = typeof next === "number" ? next : (next[0] ?? value);
    draggingRef.current = false;
    setDragValue(nextValue);
    const commitQueue = getCommitQueue();
    // A return to the old value still needs saving if an earlier change is
    // in flight; otherwise that earlier change would win after it completes.
    if (nextValue === value && commitQueue.getPendingCount() === 0) return;
    commitQueue.submit(nextValue, interactionRef.current);
  };

  return (
    <Box
      component={reduceMotion ? "div" : motion.div}
      {...(reduceMotion
        ? {}
        : {
            whileTap: { scale: 1.015 },
            transition: { type: "spring", stiffness: 500, damping: 30 },
          })}
      sx={{ flex: 1, ...sx }}
    >
      <MuiSlider
        value={dragValue}
        onChange={handleChange}
        onChangeCommitted={handleCommit}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        valueLabelDisplay={valueLabelDisplay}
        valueLabelFormat={valueLabelFormat}
        getAriaValueText={valueLabelFormat}
        aria-label={ariaLabel}
        sx={buildElasticSliderSx(accentFill, rail)}
      />
    </Box>
  );
};
