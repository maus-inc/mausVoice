import { Stack, Typography, type StackProps } from "@mui/material";
import { Logo } from "./Logo";

/**
 * Default rule for the wordmark: hidden on the smallest breakpoint, shown above
 * it. Used only when no `compact` prop is supplied.
 */
const WORDMARK_BREAKPOINT_DISPLAY = { xs: "none", sm: "block" } as const;

/**
 * Resolve the wordmark's display rule.
 *
 * An explicit `compact` wins outright, so passing `false` shows the wordmark at
 * every width rather than falling back to the viewport breakpoint. With no
 * prop, the breakpoint stays the default for every other call site.
 *
 * Written as a guard rather than a nested ternary so the two cases stay
 * readable side by side.
 */
const wordmarkDisplayFor = (compact: boolean | undefined) => {
  if (compact === undefined) {
    return WORDMARK_BREAKPOINT_DISPLAY;
  }
  return compact ? "none" : "block";
};

export type LogoWithTextProps = StackProps & {
  /**
   * Hide the wordmark and keep only the mark.
   *
   * The title bar sets this from its own measured width rather than a MUI
   * breakpoint, because MUI breakpoints follow the CSS viewport while a
   * desktop window can be any width inside it. A breakpoint answer was wrong
   * for exactly the case it was meant for: a narrow window on a wide screen.
   */
  compact?: boolean;
};

export const LogoWithText = ({ sx, compact, ...rest }: LogoWithTextProps) => {
  const wordmarkDisplay = wordmarkDisplayFor(compact);
  return (
    <Stack
      direction="row"
      sx={{
        display: "flex",
        alignItems: "center",
        userSelect: "none",
        ...sx,
      }}
      {...rest}
    >
      <Logo sx={{ mr: 0.75 }} width="1.4rem" height="1.4rem" />
      <Typography
        component="span"
        sx={{
          fontFamily: "var(--font-display)",
          fontWeight: 400,
          fontSize: "0.85rem",
          letterSpacing: "0.01em",
          lineHeight: 1,
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
