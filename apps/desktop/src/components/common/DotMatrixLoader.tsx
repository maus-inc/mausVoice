import { Box } from "@mui/material";
import { useMemo } from "react";

const SIZE = 5;
const CENTER = 2;

export const DOT_MATRIX_MODES = [
  "ripple",
  "spiral",
  "column",
  "diagonal",
  "ring",
  "core",
] as const;

export type DotMatrixMode = (typeof DOT_MATRIX_MODES)[number];

export type DotMatrixLoaderProps = {
  seed?: string;
  mode?: DotMatrixMode;
  size?: number;
  dotSize?: number;
  "aria-label"?: string;
};

const hashSeed = (seed: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const spiralOrder = (row: number, col: number): number => {
  const layer = Math.max(Math.abs(row - CENTER), Math.abs(col - CENTER));
  if (layer === 0) return 24;
  const dim = layer * 2;
  const min = CENTER - layer;
  const max = CENTER + layer;
  if (row === min) return (layer - 1) * 8 + (col - min);
  if (col === max) return (layer - 1) * 8 + dim + (row - min);
  if (row === max) return (layer - 1) * 8 + dim * 2 + (max - col);
  return (layer - 1) * 8 + dim * 3 + (max - row);
};

const delayFor = (
  mode: DotMatrixMode,
  row: number,
  col: number,
): { delay: number; off: boolean } => {
  const dx = col - CENTER;
  const dy = row - CENTER;
  const manhattan = Math.abs(dx) + Math.abs(dy);
  const radius = Math.hypot(dx, dy);
  switch (mode) {
    case "ripple":
      return { delay: manhattan, off: false };
    case "spiral":
      return { delay: spiralOrder(row, col), off: false };
    case "column":
      return { delay: col, off: false };
    case "diagonal":
      return { delay: row + col, off: false };
    case "ring":
      return {
        delay:
          (row === 0
            ? col
            : row === 4
              ? 4 + (4 - col)
              : col === 4
                ? 4 + row
                : 12 + (4 - row)) % 16,
        off: !(row === 0 || row === 4 || col === 0 || col === 4),
      };
    case "core":
      return { delay: radius, off: false };
  }
};

export const DotMatrixLoader = ({
  seed,
  mode,
  size = 18,
  dotSize = 2.5,
  "aria-label": ariaLabel = "Loading",
}: DotMatrixLoaderProps) => {
  const resolvedMode = useMemo<DotMatrixMode>(() => {
    if (mode) return mode;
    if (!seed) return "ripple";
    return DOT_MATRIX_MODES[hashSeed(seed) % DOT_MATRIX_MODES.length];
  }, [mode, seed]);

  const cells = useMemo(() => {
    const next: Array<{ key: string; delay: number; off: boolean }> = [];
    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        const { delay, off } = delayFor(resolvedMode, row, col);
        next.push({ key: `${row}-${col}`, delay, off });
      }
    }
    return next;
  }, [resolvedMode]);

  const gap = Math.max(1, (size - SIZE * dotSize) / (SIZE - 1));

  return (
    <Box
      className={`mv-dmx mv-dmx-${resolvedMode}`}
      role="status"
      aria-label={ariaLabel}
      sx={{
        width: size,
        height: size,
        gap: `${gap}px`,
        flexShrink: 0,
        color: "text.secondary",
      }}
    >
      {cells.map((cell) => (
        <Box
          key={cell.key}
          className={cell.off ? "mv-dmx-dot mv-dmx-off" : "mv-dmx-dot"}
          sx={{
            width: dotSize,
            height: dotSize,
            "--mv-dmx-delay": cell.delay,
          }}
        />
      ))}
    </Box>
  );
};
