import { Box, type BoxProps } from "@mui/material";
import appLogo32 from "../../assets/app-logo-32.png";
import appLogo64 from "../../assets/app-logo-64.png";
import appLogo192 from "../../assets/app-logo-192.png";
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
  // Provide 1x/2x/3x sources so the logo stays sharp at 125%, 150% and 200%
  // Windows display scaling instead of upscaling the 32px source bitmap.
  const srcSet = `${appLogo32} 32w, ${appLogo64} 64w, ${appLogo192} 192w`;

  return (
    <Box
      component="img"
      src={appLogo64}
      srcSet={srcSet}
      alt="mausVoice"
      draggable={false}
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
