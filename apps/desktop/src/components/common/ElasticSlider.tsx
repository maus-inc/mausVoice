import {
  Box,
  Slider as MuiSlider,
  type SliderProps,
  useTheme,
} from "@mui/material";
import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

export type ElasticSliderProps = {
  /**
   * The persisted value. The thumb follows this until the user starts
   * dragging; while dragging, the local drag value owns the thumb so it
   * tracks the pointer 1:1 (persisting on every `onChange` was what made the
   * thumb lag behind the cursor on loaded machines).
   */
  value: number;
  /** Called once when the drag commits (release / keyboard change). */
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  valueLabelDisplay?: SliderProps["valueLabelDisplay"];
  valueLabelFormat?: (value: number) => string;
  ariaLabel?: string;
  disabled?: boolean;
  /** Optional live display callback, fired during the drag only. */
  onChangeDisplay?: (value: number) => void;
  sx?: SliderProps["sx"];
};

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
  const draggingRef = useRef(false);

  const blue = theme.vars?.palette.blue ?? theme.palette.blue;
  const rail = theme.vars?.palette.level3 ?? theme.palette.level3;

  useEffect(() => {
    if (!draggingRef.current) {
      setDragValue(value);
    }
  }, [value]);

  const handleChange: SliderProps["onChange"] = (_event, next) => {
    const nextValue = typeof next === "number" ? next : (next[0] ?? value);
    draggingRef.current = true;
    setDragValue(nextValue);
    onChangeDisplay?.(nextValue);
  };

  const handleCommit: SliderProps["onChangeCommitted"] = (_event, next) => {
    const nextValue = typeof next === "number" ? next : (next[0] ?? value);
    draggingRef.current = false;
    setDragValue(nextValue);
    if (nextValue !== value) {
      onCommit(nextValue);
    }
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
        aria-label={ariaLabel}
        sx={{
          "& .MuiSlider-rail": {
            height: 4,
            borderRadius: 99,
            backgroundColor: rail,
            opacity: 1,
            transition: "height 160ms cubic-bezier(0.23, 1, 0.32, 1)",
          },
          "& .MuiSlider-track": {
            height: 4,
            borderRadius: 99,
            border: "none",
            backgroundColor: blue,
            transition: "height 160ms cubic-bezier(0.23, 1, 0.32, 1)",
          },
          "& .MuiSlider-thumb": {
            width: 16,
            height: 16,
            backgroundColor: "#FFFFFF",
            border: `2px solid ${blue}`,
            boxShadow: "0 1px 3px rgba(0, 0, 0, 0.25)",
            transition:
              "transform 160ms cubic-bezier(0.23, 1, 0.32, 1), box-shadow 160ms cubic-bezier(0.23, 1, 0.32, 1)",
            "&:hover": {
              transform: "scale(1.15)",
              boxShadow: `0 1px 4px rgba(0, 0, 0, 0.3), 0 0 0 6px color-mix(in srgb, ${blue} 14%, transparent)`,
            },
            "&.Mui-active": {
              transform: "scale(1.25)",
              boxShadow: `0 1px 4px rgba(0, 0, 0, 0.3), 0 0 0 8px color-mix(in srgb, ${blue} 18%, transparent)`,
            },
            "&.Mui-focusVisible": {
              boxShadow: `0 0 0 3px color-mix(in srgb, ${blue} 40%, transparent)`,
            },
          },
          "&:hover .MuiSlider-rail, &:hover .MuiSlider-track": {
            height: 6,
          },
        }}
      />
    </Box>
  );
};
