import { Stack, Typography, type StackProps } from "@mui/material";
import { Logo } from "./Logo";

export type LogoWithTextProps = StackProps;

export const LogoWithText = ({ sx, ...rest }: LogoWithTextProps) => {
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
          display: { xs: "none", sm: "block" },
        }}
      >
        mausVoice
      </Typography>
    </Stack>
  );
};
