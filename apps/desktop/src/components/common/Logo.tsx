import { Box, type BoxProps } from "@mui/material";
import appLogo from "../../assets/app-logo.png";
import { darkInk, highlight } from "../../styles/palette";

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
      draggable={false}
      {...rest}
      sx={[
        {
          width: width,
          height: height,
        },
        {
          display: "block",
          objectFit: "contain",
          userSelect: "none",
          flexShrink: 0,
        },
        (theme) =>
          theme.applyStyles("dark", {
            // The mark is a dark charcoal tile, so on the onyx canvas its
            // silhouette dissolves into the background. A hairline halo traced
            // from the artwork's own alpha edge lifts it back off the surface
            // without recolouring or inverting the brand.
            filter: `drop-shadow(0 0 1px ${highlight(0.22)}) drop-shadow(0 1px 3px ${darkInk(0.55)})`,
          }),
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
      {...rest}
    />
  );
};
