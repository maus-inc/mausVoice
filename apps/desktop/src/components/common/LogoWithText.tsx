import { Stack, Typography, type StackProps } from "@mui/material";
import { Logo } from "./Logo";
import {
  COMPACT_LOGO_WORDMARK_GAP,
  LOGO_WORDMARK_GAP,
} from "../root/titleBarGeometry";

/**
 * Default rule for the wordmark: hidden on the smallest breakpoint, shown above
 * it. Used only when neither `hideWordmark` nor `compact` is supplied.
 */
const WORDMARK_BREAKPOINT_DISPLAY = { xs: "none", sm: "block" } as const;

/**
 * Resolve the wordmark's display rule.
 *
 * `hideWordmark` controls visibility directly from measured horizontal space,
 * decoupled from `compact` spacing density so narrowing into compact chrome
 * keeps `"mausVoice"` visible until space genuinely runs out. When neither prop
 * is supplied, standalone callers retain the viewport breakpoint fallback.
 */
const wordmarkDisplayFor = (
  hideWordmark: boolean | undefined,
  compact: boolean | undefined,
) => {
  if (hideWordmark !== undefined) {
    return hideWordmark ? "none" : "block";
  }
  if (compact !== undefined) {
    return "block";
  }
  return WORDMARK_BREAKPOINT_DISPLAY;
};

export type LogoWithTextProps = StackProps & {
  /**
   * Tighten spacing between the mark and wordmark for compact chrome without
   * hiding the `"mausVoice"` text.
   */
  compact?: boolean;
  /**
   * Explicitly hide or show the `"mausVoice"` wordmark based on measured
   * horizontal space rather than a viewport breakpoint.
   */
  hideWordmark?: boolean;
};

export const LogoWithText = ({
  sx,
  compact,
  hideWordmark,
  ...rest
}: LogoWithTextProps) => {
  const wordmarkDisplay = wordmarkDisplayFor(hideWordmark, compact);
  const gapPx = compact ? COMPACT_LOGO_WORDMARK_GAP : LOGO_WORDMARK_GAP;
  return (
    <Stack
      direction="row"
      sx={{
        display: "flex",
        alignItems: "center",
        minWidth: 0,
        gap: `${gapPx}px`,
        userSelect: "none",
        ...sx,
      }}
      {...rest}
    >
      <Logo sx={{ flexShrink: 0 }} width="1.4rem" height="1.4rem" />
      <Typography
        component="span"
        sx={{
          fontFamily: "var(--font-display)",
          fontWeight: 400,
          fontSize: "0.85rem",
          letterSpacing: "0.01em",
          lineHeight: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          userSelect: "none",
          // Explicit so the wordmark tracks the text ramp on both schemes
          // instead of inheriting whatever surface it happens to sit on.
          color: "text.primary",
          display: wordmarkDisplay,
        }}
      >
        mausVoice
      </Typography>
    </Stack>
  );
};
