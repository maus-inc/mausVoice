import { Stack, Typography, type StackProps } from "@mui/material";
import { Logo } from "./Logo";

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
          // An explicit `compact` wins outright, so passing `false` shows the
          // wordmark at every width rather than falling back to the breakpoint.
          // Without the prop, the breakpoint stays the default for every other
          // call site.
          display:
            compact === undefined
              ? { xs: "none", sm: "block" }
              : compact
                ? "none"
                : "block",
        }}
      >
        mausVoice
      </Typography>
    </Stack>
  );
};
