import { Box, type BoxProps } from "@mui/material";
import appLogo from "../../assets/app-logo.png";

export type LogoProps = BoxProps & {
  width?: number | string;
  height?: number | string;
};

export const Logo = ({
  sx,
  width = "2.2rem",
  height = "2.2rem",
  ...rest
}: LogoProps) => {
  return (
    <Box
      component="img"
      src={appLogo}
      alt="mausVoice"
      width={width}
      height={height}
      draggable={false}
      sx={{
        display: "block",
        objectFit: "contain",
        userSelect: "none",
        flexShrink: 0,
        ...sx,
      }}
      {...rest}
    />
  );
};
