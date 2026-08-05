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
      <Logo sx={{ mr: 1.1 }} />
      <Typography
        component="span"
        sx={{
          fontFamily: "var(--font-display)",
          fontWeight: 400,
          fontSize: "1.15rem",
          letterSpacing: "0.01em",
          lineHeight: 1,
          userSelect: "none",
          display: { xs: "none", sm: "block" },
        }}
      >
        mausVoice
      </Typography>
    </Stack>
  );
};
